import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import argon2 from 'argon2';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  password as passwordSchema,
  recoveryCode,
  totpCode,
  username as usernameSchema,
  type AuthState,
} from '@burrow/shared';
import { audit, listAudit, type Actor } from '../audit.js';
import type { Ctx } from '../context.js';
import { randomToken } from '../crypto.js';
import { invites, passkeys, sessions, users } from '../db/schema.js';
import { openInvite } from './users.js';
import { registerOidcRoutes, ssoUsable } from './oidc.js';
import { actor, HttpError, idParam, noContent, parse, requireAuth } from '../http.js';
import {
  authenticationOptions,
  ChallengeStore,
  countPasskeys,
  listPasskeys,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from './passkeys.js';
import { regenerateRecoveryCodes, remainingRecoveryCodes, useRecoveryCode } from './recovery.js';
import {
  clearSessionCookie,
  createSession,
  isSteppedUp,
  listSessions,
  markStepUp,
  revokeOtherSessions,
  revokeSession,
  stepUpUntil,
  type User,
} from './sessions.js';
import type { SetupGate } from './setup.js';
import * as throttle from './throttle.js';
import { newTotpSecret, totpUri, verifyTotp } from './totp.js';

// argon2id with the library defaults (64 MiB, t=3, p=4): OWASP-compliant and
// about 50-100 ms on a small server.
const ARGON_OPTS = { type: argon2.argon2id } as const;
// Verified against when the username does not exist, so a missing account
// costs the same time as a wrong password.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= argon2.hash(randomToken(16), ARGON_OPTS));

const TICKET_TTL_MS = 5 * 60_000;
const TOTP_CONTEXT = 'users.totp_secret';

export interface SessionEvents {
  // Fired when a session is revoked, so open WebSockets of it can be closed.
  revoked(idHash: string): void;
  // A person removed or no longer an admin: their terminals end (A3-SRV-09).
  userEnded(userId: number, actor: Actor, reason: 'user_deleted' | 'user_demoted'): Promise<void>;
}

export function authState(ctx: Ctx, gate: SetupGate, req: FastifyRequest): AuthState {
  const a = req.auth;
  const until = a ? stepUpUntil(a.session) : null;
  return {
    setupRequired: !gate.isComplete(),
    user: a
      ? {
          id: a.user.id,
          username: a.user.username,
          role: a.user.role,
          hasPasskey: countPasskeys(ctx, a.user.id) > 0,
          hasTotp: a.user.totpConfirmed,
          hasPassword: a.user.passwordHash !== null,
          hasSso: a.user.oidcSub !== null,
          incomplete: a.user.incomplete,
        }
      : null,
    stepUpUntil: until && until > ctx.now() ? new Date(until).toISOString() : null,
    deviceId: a?.session.deviceId ?? null,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  gate: SetupGate,
  events: SessionEvents,
): void {
  const challenges = new ChallengeStore();
  // Signed-in user routes. Changes to login methods need a fresh step-up,
  // except while the setup wizard is still registering the first one.
  const account = { auth: 'user' } as const;
  const accountStepUp = { auth: 'user', stepUp: true } as const;
  const accountChange = { auth: 'user', allowIncomplete: true, stepUp: true } as const;
  // Password step passed, waiting for the TOTP code.
  const tickets = new Map<string, { userId: number; expiresAt: number }>();
  // TOTP secret shown to the user but not yet confirmed with a code.
  const pendingTotp = new Map<number, { secret: string; expiresAt: number }>();

  const throttleKeys = (req: FastifyRequest, name?: string | null) => [
    `ip:${throttle.addressKey(ctx, req)}`,
    ...(name ? [`user:${name.toLowerCase()}`] : []),
  ];
  // A step-up is counted for its own sign-in session: failed passwords for the same name from
  // elsewhere blocked a signed-in admin's step-up, from any address (A3-SRV-02).
  const stepUpKeys = (a: { session: { idHash: string } }) => [`session:${a.session.idHash}`];

  // One attempt at a time per key (audit 2026-11-09): a failure is counted only after the check,
  // so attempts sent together all passed the block while the first ones waited out their delay.
  const inFlight = new Set<string>();
  const held = new WeakMap<FastifyRequest, string[]>();
  const release = (req: FastifyRequest) => {
    for (const k of held.get(req) ?? []) inFlight.delete(k);
    held.delete(req);
  };
  app.addHook('onResponse', async (req) => release(req));
  app.addHook('onRequestAbort', async (req) => release(req));

  /**
   * Wait for another attempt on these keys to be checked first (two people behind one router
   * sign in at the same moment: the second was refused, and the page called it a block,
   * 2026-11-13), then wait out the delay, or refuse when blocked. Each is checked after the one
   * before has counted, so attempts sent together still get no further than the block allows.
   */
  async function gateAttempt(req: FastifyRequest, keys: string[]) {
    const mine = held.get(req) ?? [];
    const waitUntil = Date.now() + 10_000;
    while (keys.some((k) => inFlight.has(k) && !mine.includes(k))) {
      if (Date.now() > waitUntil) throw new HttpError(429, 'busy', 'Another attempt is still being checked. Try again in a moment.');
      await new Promise((r) => setTimeout(r, 25));
    }
    const t = throttle.check(ctx, keys);
    if (t.blockedUntil) {
      throw new HttpError(429, 'blocked', `Too many failed attempts. Try again after ${new Date(t.blockedUntil).toISOString()}.`);
    }
    for (const k of keys) inFlight.add(k);
    held.set(req, [...new Set([...mine, ...keys])]);
    if (t.delayMs) await throttle.timing.sleep(t.delayMs);
  }

  function failAttempt(req: FastifyRequest, keys: string[], action: string, username: string | null) {
    const blocked = throttle.fail(ctx, keys);
    audit(ctx, { userId: null, username, ip: req.ip }, action);
    for (const key of blocked) {
      audit(ctx, { userId: null, username, ip: req.ip }, 'auth.blocked', key, {
        minutes: throttle.BLOCK_MS / 60_000,
      });
    }
  }

  /** Replace whatever session this browser had: no session survives a sign-in (fixation). */
  function freshSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
    if (req.auth) {
      ctx.db.delete(sessions).where(eq(sessions.idHash, req.auth.session.idHash)).run();
      events.revoked(req.auth.session.idHash);
    }
    return createSession(ctx, userId, req, reply);
  }

  function signIn(req: FastifyRequest, reply: FastifyReply, user: User, method: string) {
    throttle.succeed(ctx, throttleKeys(req, user.username));
    const session = freshSession(req, reply, user.id);
    req.auth = { user, session };
    audit(ctx, { userId: user.id, username: user.username, ip: req.ip }, 'auth.login', null, { method });
    return authState(ctx, gate, req);
  }

  registerOidcRoutes(app, ctx, {
    signIn: (req, reply, user, method) => {
      signIn(req, reply, user, method);
    },
  });

  const findUser = (name: string) =>
    ctx.db.select().from(users).where(eq(users.username, name)).get();

  /** A user always keeps at least one way to sign in. */
  function assertKeepsLoginMethod(userId: number, change: { passkeys?: number; password?: boolean; totp?: boolean }) {
    const u = ctx.db.select().from(users).where(eq(users.id, userId)).get();
    if (!u) throw new HttpError(404, 'not_found');
    const pk = change.passkeys ?? countPasskeys(ctx, userId);
    const pw = change.password ?? u.passwordHash !== null;
    const totp = change.totp ?? u.totpConfirmed;
    // Single sign-on counts only while it signs this account in: switched
    // off, or linked to an earlier provider, it is no way in (AUDIT2 AUTH-07).
    if (pk === 0 && !(pw && totp) && !ssoUsable(ctx, u)) {
      throw new HttpError(409, 'last_login_method', 'This would leave the account without a way to sign in.');
    }
  }

  // ---------------------------------------------------------------- state

  app.get('/api/auth/state', { config: { auth: 'public' } }, async (req) => authState(ctx, gate, req));

  // ---------------------------------------------------------------- setup

  app.post('/api/setup/begin', { config: { auth: 'public' } }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().max(100), username: usernameSchema }), req.body);
    const keys = throttleKeys(req);
    await gateAttempt(req, keys);
    if (gate.isComplete()) throw new HttpError(409, 'already_set_up');
    if (!gate.check(body.token)) {
      failAttempt(req, keys, 'setup.token_rejected', null);
      throw new HttpError(403, 'invalid_setup_token');
    }
    // A previous attempt that never finished is discarded.
    ctx.db.delete(users).where(eq(users.incomplete, true)).run();
    const user = ctx.db
      .insert(users)
      .values({
        username: body.username,
        role: 'admin',
        totpConfirmed: false,
        incomplete: true,
        createdAt: ctx.now(),
      })
      .returning()
      .get();
    throttle.succeed(ctx, keys);
    const session = freshSession(req, reply, user.id);
    req.auth = { user, session };
    audit(ctx, actor(req), 'setup.begin');
    return authState(ctx, gate, req);
  });

  app.post('/api/setup/finish', { config: { auth: 'user', allowIncomplete: true } }, async (req) => {
    const { user } = requireAuth(req);
    if (!user.incomplete) throw new HttpError(409, 'already_set_up');
    assertKeepsLoginMethod(user.id, {});
    ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, user.id)).run();
    user.incomplete = false;
    const codes = regenerateRecoveryCodes(ctx, user.id);
    gate.close();
    audit(ctx, actor(req), 'setup.complete');
    return { recoveryCodes: codes, state: authState(ctx, gate, req) };
  });

  // ---------------------------------------------------------------- invites

  /** What an invite link is for, before accepting it (the page shows it). */
  app.get('/api/invites/:token', { config: { auth: 'public' } }, async (req) => {
    const inv = openInvite(ctx, (req.params as { token: string }).token);
    return { role: inv.role, expiresAt: new Date(inv.expiresAt).toISOString() };
  });

  /**
   * Accepting an invite: a new account with the invite's role, signed in but
   * incomplete until the setup wizard has registered a way to sign in.
   */
  app.post('/api/invites/:token/accept', { config: { auth: 'public' } }, async (req, reply) => {
    const body = parse(z.object({ username: usernameSchema }), req.body);
    const keys = throttleKeys(req);
    await gateAttempt(req, keys);
    let inv;
    try {
      inv = openInvite(ctx, (req.params as { token: string }).token);
    } catch (err) {
      failAttempt(req, keys, 'invite.rejected', null);
      throw err;
    }
    if (ctx.db.select().from(users).where(eq(users.username, body.username)).get()) throw new HttpError(409, 'username_taken', 'That name is taken.');
    const user = ctx.db
      .insert(users)
      .values({ username: body.username, role: inv.role, totpConfirmed: false, incomplete: true, createdAt: ctx.now() })
      .returning()
      .get();
    ctx.db.update(invites).set({ usedAt: ctx.now(), usedBy: user.id }).where(eq(invites.id, inv.id)).run();
    throttle.succeed(ctx, keys);
    const session = freshSession(req, reply, user.id);
    req.auth = { user, session };
    audit(ctx, actor(req), 'invite.accepted', user.username, { role: user.role });
    return authState(ctx, gate, req);
  });

  // ---------------------------------------------------------------- login

  app.post('/api/auth/passkey/options', { config: { auth: 'public' } }, async (req) => {
    await gateAttempt(req, throttleKeys(req));
    return authenticationOptions(ctx, challenges, 'login', null);
  });

  app.post('/api/auth/passkey/verify', { config: { auth: 'public' } }, async (req, reply) => {
    const body = parse(z.object({ challengeId: z.string(), response: z.looseObject({ id: z.string() }) }), req.body);
    const keys = throttleKeys(req);
    await gateAttempt(req, keys);
    const userId = await verifyAuthentication(
      ctx,
      challenges,
      'login',
      body.challengeId,
      body.response as unknown as AuthenticationResponseJSON,
    );
    const user = userId ? ctx.db.select().from(users).where(eq(users.id, userId)).get() : undefined;
    if (!user || user.incomplete) {
      failAttempt(req, keys, 'auth.login_failed', null);
      throw new HttpError(401, 'invalid_credentials');
    }
    return signIn(req, reply, user, 'passkey');
  });

  app.post('/api/auth/password', { config: { auth: 'public' } }, async (req) => {
    const body = parse(z.object({ username: z.string().max(64), password: z.string().max(256) }), req.body);
    const keys = throttleKeys(req, body.username);
    await gateAttempt(req, keys);
    const user = findUser(body.username);
    const ok = await argon2.verify(user?.passwordHash ?? (await getDummyHash()), body.password);
    // Password alone never signs in: TOTP is mandatory once a password is used.
    if (!user || !ok || !user.passwordHash || !user.totpConfirmed || user.incomplete) {
      failAttempt(req, keys, 'auth.login_failed', body.username);
      throw new HttpError(401, 'invalid_credentials');
    }
    const ticket = randomToken(24);
    // Tickets nobody used (the code never typed): gone once expired.
    for (const [k, v] of tickets) if (v.expiresAt <= ctx.now()) tickets.delete(k);
    tickets.set(ticket, { userId: user.id, expiresAt: ctx.now() + TICKET_TTL_MS });
    return { next: 'totp', ticket };
  });

  app.post('/api/auth/totp', { config: { auth: 'public' } }, async (req, reply) => {
    const body = parse(z.object({ ticket: z.string(), code: totpCode }), req.body);
    const t = tickets.get(body.ticket);
    const user = t && t.expiresAt > ctx.now() ? ctx.db.select().from(users).where(eq(users.id, t.userId)).get() : undefined;
    if (!user) throw new HttpError(401, 'ticket_expired');
    const keys = throttleKeys(req, user.username);
    await gateAttempt(req, keys);
    if (!(await checkTotp(user, body.code))) {
      failAttempt(req, keys, 'auth.login_failed', user.username);
      throw new HttpError(401, 'invalid_code');
    }
    tickets.delete(body.ticket);
    return signIn(req, reply, user, 'password+totp');
  });

  app.post('/api/auth/recovery', { config: { auth: 'public' } }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().max(64), code: recoveryCode }), req.body);
    const keys = throttleKeys(req, body.username);
    await gateAttempt(req, keys);
    const user = findUser(body.username);
    if (!user || user.incomplete || !useRecoveryCode(ctx, user.id, body.code)) {
      failAttempt(req, keys, 'auth.login_failed', body.username);
      throw new HttpError(401, 'invalid_credentials');
    }
    const state = signIn(req, reply, user, 'recovery_code');
    audit(ctx, actor(req), 'auth.recovery_code_used', null, { remaining: remainingRecoveryCodes(ctx, user.id) });
    return state;
  });

  app.post('/api/auth/logout', { config: { auth: 'user', allowIncomplete: true } }, async (req, reply) => {
    const a = requireAuth(req);
    ctx.db.delete(sessions).where(eq(sessions.idHash, a.session.idHash)).run();
    events.revoked(a.session.idHash);
    clearSessionCookie(ctx, reply);
    audit(ctx, actor(req), 'auth.logout');
    return noContent(reply);
  });

  async function checkTotp(user: User, code: string): Promise<boolean> {
    if (!user.totpSecretEnc || !user.totpConfirmed) return false;
    const secret = ctx.box.open(user.totpSecretEnc, TOTP_CONTEXT);
    const step = await verifyTotp(secret, code, user.totpLastStep, ctx.now());
    if (step === null) return false;
    // Used up in one step: two requests with the same code at once both
    // passed the check above (it reads the last step from before either).
    const r = ctx.db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
      .run();
    if (r.changes !== 1) return false;
    user.totpLastStep = step;
    return true;
  }

  // ---------------------------------------------------------------- step-up

  app.post('/api/auth/step-up/passkey/options', { config: account }, async (req) => {
    const { user } = requireAuth(req);
    return authenticationOptions(ctx, challenges, 'step-up', user);
  });

  app.post('/api/auth/step-up/passkey/verify', { config: account }, async (req) => {
    const a = requireAuth(req);
    const body = parse(z.object({ challengeId: z.string(), response: z.looseObject({ id: z.string() }) }), req.body);
    const keys = stepUpKeys(a);
    await gateAttempt(req, keys);
    const userId = await verifyAuthentication(
      ctx,
      challenges,
      'step-up',
      body.challengeId,
      body.response as unknown as AuthenticationResponseJSON,
    );
    if (userId !== a.user.id) {
      failAttempt(req, keys, 'auth.step_up_failed', a.user.username);
      throw new HttpError(401, 'invalid_credentials');
    }
    throttle.succeed(ctx, keys);
    markStepUp(ctx, a.session);
    audit(ctx, actor(req), 'auth.step_up', null, { method: 'passkey' });
    return authState(ctx, gate, req);
  });

  app.post('/api/auth/step-up/totp', { config: account }, async (req) => {
    const a = requireAuth(req);
    const body = parse(z.object({ code: totpCode }), req.body);
    const keys = stepUpKeys(a);
    await gateAttempt(req, keys);
    if (!(await checkTotp(a.user, body.code))) {
      failAttempt(req, keys, 'auth.step_up_failed', a.user.username);
      throw new HttpError(401, 'invalid_code');
    }
    throttle.succeed(ctx, keys);
    markStepUp(ctx, a.session);
    audit(ctx, actor(req), 'auth.step_up', null, { method: 'totp' });
    return authState(ctx, gate, req);
  });

  // ---------------------------------------------------------------- account


  app.get('/api/account/passkeys', { config: account }, async (req) => listPasskeys(ctx, requireAuth(req).user.id));

  app.post('/api/account/passkeys/options', { config: accountChange }, async (req) =>
    registrationOptions(ctx, challenges, requireAuth(req).user),
  );

  app.post('/api/account/passkeys/verify', { config: accountChange }, async (req) => {
    const { user } = requireAuth(req);
    const body = parse(
      z.object({
        challengeId: z.string(),
        response: z.looseObject({ id: z.string() }),
        name: z.string().trim().min(1).max(60).default('Passkey'),
      }),
      req.body,
    );
    const pk = await verifyRegistration(
      ctx,
      challenges,
      user,
      body.challengeId,
      body.response as unknown as RegistrationResponseJSON,
      body.name,
    );
    if (!pk) throw new HttpError(400, 'passkey_rejected');
    audit(ctx, actor(req), 'account.passkey_added', pk.name);
    return pk;
  });

  app.delete('/api/account/passkeys/:id', { config: accountStepUp }, async (req, reply) => {
    const { user } = requireAuth(req);
    const id = idParam(req);
    const pk = ctx.db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
      .get();
    if (!pk) throw new HttpError(404, 'not_found');
    assertKeepsLoginMethod(user.id, { passkeys: countPasskeys(ctx, user.id) - 1 });
    ctx.db.delete(passkeys).where(eq(passkeys.id, id)).run();
    audit(ctx, actor(req), 'account.passkey_removed', pk.name);
    return noContent(reply);
  });

  app.put('/api/account/password', { config: accountChange }, async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(z.object({ password: passwordSchema }), req.body);
    const hash = await argon2.hash(body.password, ARGON_OPTS);
    ctx.db.update(users).set({ passwordHash: hash }).where(eq(users.id, user.id)).run();
    user.passwordHash = hash;
    audit(ctx, actor(req), 'account.password_set');
    return noContent(reply);
  });

  app.delete('/api/account/password', { config: accountStepUp }, async (req, reply) => {
    const { user } = requireAuth(req);
    assertKeepsLoginMethod(user.id, { password: false });
    ctx.db.update(users).set({ passwordHash: null }).where(eq(users.id, user.id)).run();
    audit(ctx, actor(req), 'account.password_removed');
    return noContent(reply);
  });

  app.post('/api/account/totp/setup', { config: accountChange }, async (req) => {
    const { user } = requireAuth(req);
    const secret = newTotpSecret();
    pendingTotp.set(user.id, { secret, expiresAt: ctx.now() + 10 * 60_000 });
    return { secret, uri: totpUri(secret, user.username, 'Burrow') };
  });

  app.post('/api/account/totp/confirm', { config: accountChange }, async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(z.object({ code: totpCode }), req.body);
    const pending = pendingTotp.get(user.id);
    if (!pending || pending.expiresAt < ctx.now()) throw new HttpError(409, 'no_pending_totp');
    const step = await verifyTotp(pending.secret, body.code, null, ctx.now());
    if (step === null) throw new HttpError(400, 'invalid_code');
    pendingTotp.delete(user.id);
    ctx.db
      .update(users)
      .set({ totpSecretEnc: ctx.box.seal(pending.secret, TOTP_CONTEXT), totpConfirmed: true, totpLastStep: step })
      .where(eq(users.id, user.id))
      .run();
    audit(ctx, actor(req), 'account.totp_enabled');
    return noContent(reply);
  });

  app.delete('/api/account/totp', { config: accountStepUp }, async (req, reply) => {
    const { user } = requireAuth(req);
    assertKeepsLoginMethod(user.id, { totp: false });
    ctx.db
      .update(users)
      .set({ totpSecretEnc: null, totpConfirmed: false, totpLastStep: null })
      .where(eq(users.id, user.id))
      .run();
    audit(ctx, actor(req), 'account.totp_disabled');
    return noContent(reply);
  });

  app.get('/api/account/recovery-codes', { config: account }, async (req) => ({
    remaining: remainingRecoveryCodes(ctx, requireAuth(req).user.id),
  }));

  app.post('/api/account/recovery-codes', { config: accountStepUp }, async (req) => {
    const { user } = requireAuth(req);
    const codes = regenerateRecoveryCodes(ctx, user.id);
    audit(ctx, actor(req), 'account.recovery_codes_regenerated');
    return { recoveryCodes: codes };
  });

  app.get('/api/account/sessions', { config: account }, async (req) => {
    const a = requireAuth(req);
    return listSessions(ctx, a.user.id, a.session.idHash);
  });

  // Signed in somewhere you no longer are: every other browser at once.
  app.delete('/api/account/sessions', { config: account }, async (req, reply) => {
    const a = requireAuth(req);
    const ended = revokeOtherSessions(ctx, a.user.id, a.session.idHash);
    for (const h of ended) events.revoked(h);
    audit(ctx, actor(req), 'session.revoked_others', null, { count: ended.length });
    return noContent(reply);
  });

  app.delete('/api/account/sessions/:id', { config: account }, async (req, reply) => {
    const a = requireAuth(req);
    const publicId = (req.params as { id: string }).id;
    const idHash = revokeSession(ctx, a.user.id, publicId);
    if (!idHash) throw new HttpError(404, 'not_found');
    events.revoked(idHash);
    audit(ctx, actor(req), 'session.revoked', publicId);
    if (idHash === a.session.idHash) clearSessionCookie(ctx, reply);
    return noContent(reply);
  });

  // ---------------------------------------------------------------- audit

  app.get('/api/audit', { config: { auth: 'admin' } }, async (req) => {
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    return listAudit(ctx, q);
  });
}

/** Access rules for every /api request, driven by the route's `config`. */
export function enforceAccess(ctx: Ctx, req: FastifyRequest): void {
  const cfg = req.routeOptions.config;
  const level = cfg.auth ?? 'admin';
  if (level === 'public') return;
  const a = req.auth;
  if (!a) throw new HttpError(401, 'unauthenticated');
  if (a.user.incomplete && !cfg.allowIncomplete) throw new HttpError(403, 'setup_incomplete');
  if (level === 'admin' && a.user.role !== 'admin') throw new HttpError(403, 'forbidden');
  if (cfg.stepUp && !a.user.incomplete && !isSteppedUp(ctx, a.session)) {
    throw new HttpError(403, 'step_up_required');
  }
}
