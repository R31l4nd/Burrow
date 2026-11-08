import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import type { PasskeyInfo } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { randomToken } from '../crypto.js';
import { passkeys } from '../db/schema.js';
import type { User } from './sessions.js';

// WebAuthn with discoverable credentials: the login screen needs no username,
// the authenticator offers the passkeys it has for this site. User
// verification (fingerprint, PIN) is required, which makes a passkey a full
// second factor on its own.

const CHALLENGE_TTL_MS = 5 * 60_000;
const RP_NAME = 'Burrow';

interface PendingChallenge {
  challenge: string;
  purpose: 'register' | 'login' | 'step-up';
  userId: number | null;
  expiresAt: number;
}

/**
 * How many challenges wait for an answer at most, here and the devices' (auth/devices.ts). Asking
 * for one needs no account, and the rate limit counts per address a request names when no proxy
 * is trusted: without a cap a flood grew them without bound (audit 2026-11-05). An object, so a
 * test can lower it.
 */
export const challengeLimit = { max: 10_000 };

/** Room for one more in a map kept in the order things came: the oldest go first. */
export function makeRoom(m: Map<unknown, unknown>, max = challengeLimit.max): void {
  for (const k of m.keys()) {
    if (m.size < max) return;
    m.delete(k);
  }
}

/** Single-use challenges, kept in memory: they only live for five minutes. */
export class ChallengeStore {
  readonly #items = new Map<string, PendingChallenge>();

  constructor(private readonly max?: number) {}

  get size(): number {
    return this.#items.size;
  }

  put(ctx: Ctx, c: Omit<PendingChallenge, 'expiresAt'>): string {
    this.prune(ctx.now());
    makeRoom(this.#items, this.max ?? challengeLimit.max);
    const id = randomToken(16);
    this.#items.set(id, { ...c, expiresAt: ctx.now() + CHALLENGE_TTL_MS });
    return id;
  }

  take(ctx: Ctx, id: string, purpose: PendingChallenge['purpose']): PendingChallenge | null {
    const c = this.#items.get(id);
    this.#items.delete(id);
    if (!c || c.purpose !== purpose || c.expiresAt < ctx.now()) return null;
    return c;
  }

  prune(now: number): void {
    for (const [id, c] of this.#items) if (c.expiresAt < now) this.#items.delete(id);
  }
}

const userHandle = (userId: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(`burrow-user-${userId}`, 'utf8'));

export async function registrationOptions(ctx: Ctx, store: ChallengeStore, user: User) {
  const existing = ctx.db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: ctx.config.rpId,
    userName: user.username,
    userID: userHandle(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      ...(p.transports ? { transports: JSON.parse(p.transports) as string[] } : {}),
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = store.put(ctx, { challenge: options.challenge, purpose: 'register', userId: user.id });
  return { challengeId, options };
}

export async function verifyRegistration(
  ctx: Ctx,
  store: ChallengeStore,
  user: User,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeyInfo | null> {
  const pending = store.take(ctx, challengeId, 'register');
  if (!pending || pending.userId !== user.id) return null;
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: ctx.config.origin,
      expectedRPID: ctx.config.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    ctx.log.info({ err }, 'passkey registration rejected');
    return null;
  }
  if (!result.verified) return null;
  const cred = result.registrationInfo.credential;
  const now = ctx.now();
  const row = ctx.db
    .insert(passkeys)
    .values({
      userId: user.id,
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports ? JSON.stringify(cred.transports) : null,
      name,
      createdAt: now,
    })
    .returning()
    .get();
  return { id: row.id, name: row.name, createdAt: new Date(now).toISOString(), lastUsedAt: null };
}

export async function authenticationOptions(
  ctx: Ctx,
  store: ChallengeStore,
  purpose: 'login' | 'step-up',
  user: User | null,
) {
  const allow = user
    ? ctx.db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, user.id))
        .all()
        .map((p) => ({
          id: p.credentialId,
          ...(p.transports ? { transports: JSON.parse(p.transports) as string[] } : {}),
        }))
    : undefined;
  const options = await generateAuthenticationOptions({
    rpID: ctx.config.rpId,
    userVerification: 'required',
    ...(allow ? { allowCredentials: allow } : {}),
  });
  const challengeId = store.put(ctx, { challenge: options.challenge, purpose, userId: user?.id ?? null });
  return { challengeId, options };
}

/**
 * Verify an assertion. Returns the user id it proves, or null. For step-up
 * the passkey must belong to the user of the session.
 */
export async function verifyAuthentication(
  ctx: Ctx,
  store: ChallengeStore,
  purpose: 'login' | 'step-up',
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<number | null> {
  const pending = store.take(ctx, challengeId, purpose);
  if (!pending) return null;
  const pk = ctx.db
    .select()
    .from(passkeys)
    .where(
      pending.userId !== null
        ? and(eq(passkeys.credentialId, response.id), eq(passkeys.userId, pending.userId))
        : eq(passkeys.credentialId, response.id),
    )
    .get();
  if (!pk) return null;
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: ctx.config.origin,
      expectedRPID: ctx.config.rpId,
      requireUserVerification: true,
      credential: {
        id: pk.credentialId,
        publicKey: new Uint8Array(pk.publicKey),
        counter: pk.counter,
        ...(pk.transports ? { transports: JSON.parse(pk.transports) as string[] } : {}),
      },
    });
  } catch (err) {
    ctx.log.info({ err }, 'passkey assertion rejected');
    return null;
  }
  if (!result.verified) return null;
  ctx.db
    .update(passkeys)
    .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: ctx.now() })
    .where(eq(passkeys.id, pk.id))
    .run();
  return pk.userId;
}

export function listPasskeys(ctx: Ctx, userId: number): PasskeyInfo[] {
  return ctx.db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .all()
    .map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: new Date(p.createdAt).toISOString(),
      lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt).toISOString() : null,
    }));
}

export function countPasskeys(ctx: Ctx, userId: number): number {
  return ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId)).all().length;
}
