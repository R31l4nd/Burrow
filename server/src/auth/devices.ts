import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { humanCode, normalizeCode } from '../crypto.js';
import { devices, sessions, users } from '../db/schema.js';
import { removeDeviceEverywhere } from '../android/direct.js';
import { actor, HttpError, idParam, parse, requireAuth } from '../http.js';
import { makeRoom } from './passkeys.js';
import type { SessionEvents } from './routes.js';
import { authState } from './routes.js';
import { createSession, markStepUp } from './sessions.js';
import type { SetupGate } from './setup.js';
import * as throttle from './throttle.js';

// Paired Android devices. Pairing: a signed-in browser shows a one-time code;
// the app sends it with the public half of a key it just made in the Android
// Keystore. That key can only be used after a fingerprint (or the screen
// lock), so a signature from it is proof of the phone *and* its owner - the
// app's replacement for a passkey, for signing in and for step-up.
//
// What gets signed is a message Burrow composes; it names its purpose and
// the origin, so a signature cannot be replayed for anything else.

const CODE_TTL_MS = 5 * 60_000;
const CHALLENGE_TTL_MS = 2 * 60_000;
export const MESSAGE_PREFIX = 'burrow-device-v1';

interface PendingCode {
  userId: number;
  /** The account's own moment of creation: a number alone came back for a new account after a deletion (AUDIT2 AUTH-02). */
  userCreatedAt: number;
  expiresAt: number;
}

interface PendingChallenge {
  message: string;
  purpose: 'login' | 'step-up';
  deviceId: number;
  sessionHash: string | null;
  expiresAt: number;
}

/** SPKI (X.509 SubjectPublicKeyInfo, base64) of an EC P-256 key, or an error. */
export function parseDeviceKey(b64: string) {
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new HttpError(400, 'invalid_key', 'Not a public key.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new HttpError(400, 'invalid_key', 'The device key must be EC P-256.');
  }
  return key;
}

export function verifyDeviceSignature(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    return verify('sha256', Buffer.from(message, 'utf8'), { key: parseDeviceKey(publicKeyB64), dsaEncoding: 'der' }, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function registerDeviceRoutes(app: FastifyInstance, ctx: Ctx, gate: SetupGate, events: SessionEvents): void {
  const codes = new Map<string, PendingCode>();
  const challenges = new Map<string, PendingChallenge>();
  const prune = () => {
    const now = ctx.now();
    for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
    for (const [k, v] of challenges) if (v.expiresAt < now) challenges.delete(k);
  };
  const keys = (req: FastifyRequest) => [`ip:${throttle.addressKey(ctx, req)}`];

  // A pairing code hands out a new login method: fresh step-up required.
  app.post('/api/account/devices/pair-code', { config: { auth: 'user', stepUp: true } }, async (req) => {
    prune();
    const { user } = requireAuth(req);
    const code = humanCode(2, 4);
    makeRoom(codes);
    codes.set(normalizeCode(code), { userId: user.id, userCreatedAt: user.createdAt, expiresAt: ctx.now() + CODE_TTL_MS });
    audit(ctx, actor(req), 'device.pair_code');
    return { code, expiresAt: new Date(ctx.now() + CODE_TTL_MS).toISOString() };
  });

  app.post('/api/auth/pair', { config: { auth: 'public' } }, async (req, reply) => {
    const body = parse(z.object({ code: z.string().max(40), name: z.string().trim().min(1).max(60), publicKey: z.string().max(500) }), req.body);
    const k = keys(req);
    const t = throttle.check(ctx, k);
    if (t.blockedUntil) throw new HttpError(429, 'blocked');
    if (t.delayMs) await throttle.timing.sleep(t.delayMs);
    prune();
    const pending = codes.get(normalizeCode(body.code));
    if (!pending) {
      throttle.fail(ctx, k);
      audit(ctx, { userId: null, username: null, ip: req.ip }, 'device.pair_failed');
      throw new HttpError(401, 'invalid_code', 'This code is wrong or has expired.');
    }
    codes.delete(normalizeCode(body.code));
    parseDeviceKey(body.publicKey);
    const user = ctx.db.select().from(users).where(eq(users.id, pending.userId)).get();
    // The same account, not one that got its number after it was deleted.
    if (!user || user.createdAt !== pending.userCreatedAt) throw new HttpError(401, 'invalid_code');
    const device = ctx.db
      .insert(devices)
      .values({ userId: user.id, name: body.name, publicKey: body.publicKey, createdAt: ctx.now(), lastUsedAt: ctx.now() })
      .returning()
      .get();
    throttle.succeed(ctx, k);
    const session = createSession(ctx, user.id, req, reply, device.id);
    req.auth = { user, session };
    audit(ctx, actor(req), 'device.paired', device.name, { deviceId: device.id });
    return { deviceId: device.id, state: authState(ctx, gate, req) };
  });

  /** A message for the device to sign: to sign in, or to confirm (step-up). */
  app.post('/api/auth/device/challenge', { config: { auth: 'public' } }, async (req) => {
    prune();
    const body = parse(z.object({ deviceId: z.number().int().positive(), purpose: z.enum(['login', 'step-up']) }), req.body);
    const device = ctx.db.select().from(devices).where(eq(devices.id, body.deviceId)).get();
    let sessionHash: string | null = null;
    if (body.purpose === 'step-up') {
      const a = requireAuth(req);
      if (a.session.deviceId !== body.deviceId) throw new HttpError(403, 'wrong_device');
      sessionHash = a.session.idHash;
    }
    // An unknown device gets a challenge too: no hint whether an id exists.
    const id = randomBytes(12).toString('base64url');
    const message = [MESSAGE_PREFIX, body.purpose, ctx.config.origin, randomBytes(32).toString('base64url')].join('\n');
    if (device) {
      makeRoom(challenges);
      challenges.set(id, { message, purpose: body.purpose, deviceId: device.id, sessionHash, expiresAt: ctx.now() + CHALLENGE_TTL_MS });
    }
    return { challengeId: id, message };
  });

  app.post('/api/auth/device/verify', { config: { auth: 'public' } }, async (req, reply) => {
    const body = parse(z.object({ challengeId: z.string().max(40), signature: z.string().max(400) }), req.body);
    const k = keys(req);
    const t = throttle.check(ctx, k);
    if (t.blockedUntil) throw new HttpError(429, 'blocked');
    const ch = challenges.get(body.challengeId);
    challenges.delete(body.challengeId);
    const device = ch ? ctx.db.select().from(devices).where(eq(devices.id, ch.deviceId)).get() : undefined;
    if (!ch || !device || ch.expiresAt < ctx.now() || !verifyDeviceSignature(device.publicKey, ch.message, body.signature)) {
      throttle.fail(ctx, k);
      audit(ctx, { userId: device?.userId ?? null, username: null, ip: req.ip }, ch?.purpose === 'step-up' ? 'auth.step_up_failed' : 'auth.login_failed', device?.name ?? null, { method: 'device' });
      throw new HttpError(401, 'invalid_signature');
    }
    throttle.succeed(ctx, k);
    ctx.db.update(devices).set({ lastUsedAt: ctx.now() }).where(eq(devices.id, device.id)).run();
    const user = ctx.db.select().from(users).where(eq(users.id, device.userId)).get()!;
    if (ch.purpose === 'step-up') {
      const a = requireAuth(req);
      if (a.session.idHash !== ch.sessionHash) throw new HttpError(403, 'wrong_session');
      markStepUp(ctx, a.session);
      audit(ctx, actor(req), 'auth.step_up', null, { method: 'device', deviceId: device.id });
      return authState(ctx, gate, req);
    }
    if (req.auth) {
      ctx.db.delete(sessions).where(eq(sessions.idHash, req.auth.session.idHash)).run();
      events.revoked(req.auth.session.idHash);
    }
    const session = createSession(ctx, user.id, req, reply, device.id);
    req.auth = { user, session };
    audit(ctx, actor(req), 'auth.login', null, { method: 'device', deviceId: device.id });
    return authState(ctx, gate, req);
  });

  app.get('/api/account/devices', { config: { auth: 'user' } }, async (req) =>
    ctx.db
      .select()
      .from(devices)
      .where(eq(devices.userId, requireAuth(req).user.id))
      .all()
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: new Date(d.createdAt).toISOString(),
        lastUsedAt: d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : null,
        current: requireAuth(req).session.deviceId === d.id,
        hasSshKey: !!d.sshPublicKey,
      })),
  );

  // A phone's name is the model the app sent when it paired: two of the
  // same model (or the same phone paired again) could not be told apart
  // (UIA-15). Its owner renames it; a change to devices asks a step-up.
  app.patch('/api/account/devices/:id', { config: { auth: 'user', stepUp: true } }, async (req) => {
    const { user } = requireAuth(req);
    const id = idParam(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    const d = ctx.db.select().from(devices).where(and(eq(devices.id, id), eq(devices.userId, user.id))).get();
    if (!d) throw new HttpError(404, 'not_found');
    ctx.db.update(devices).set({ name: body.name }).where(eq(devices.id, id)).run();
    audit(ctx, actor(req), 'device.renamed', body.name, { deviceId: id, from: d.name });
    return { id, name: body.name };
  });

  // Unpairing ends the device's sessions too (foreign key cascade), and
  // takes its direct-route key off every host. A host that cannot be
  // reached is reported: its key stays there until removed by hand.
  app.delete('/api/account/devices/:id', { config: { auth: 'user', stepUp: true } }, async (req) => {
    const { user } = requireAuth(req);
    const id = idParam(req);
    const d = ctx.db.select().from(devices).where(and(eq(devices.id, id), eq(devices.userId, user.id))).get();
    if (!d) throw new HttpError(404, 'not_found');
    const leftOn = await removeDeviceEverywhere(ctx, id);
    for (const s of ctx.db.select({ h: sessions.idHash }).from(sessions).where(eq(sessions.deviceId, id)).all()) events.revoked(s.h);
    ctx.db.delete(devices).where(eq(devices.id, id)).run();
    audit(ctx, actor(req), 'device.unpaired', d.name, { deviceId: id, keyLeftOn: leftOn.map((r) => r.hostId) });
    return { leftOn };
  });
}
