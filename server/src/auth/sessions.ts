import { and, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionInfo } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { randomToken, sha256 } from '../crypto.js';
import { sessions, users } from '../db/schema.js';
import { HttpError } from '../http.js';

// Server-side sessions. The cookie holds a random token; the database holds
// only its SHA-256, so a leaked database does not yield usable cookies.
// Revocation is a DELETE and takes effect on the next request.

export const IDLE_TIMEOUT_MS = 7 * 24 * 3600_000;
export const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 3600_000;
export const STEP_UP_WINDOW_MS = 15 * 60_000;
// last_seen_at is written at most this often, not on every request.
const TOUCH_INTERVAL_MS = 60_000;

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;

export interface Auth {
  user: User;
  session: Session;
}

export function cookieName(ctx: Ctx): string {
  // The __Host- prefix makes the browser refuse the cookie unless it is
  // Secure, has Path=/ and no Domain, so a sibling subdomain cannot plant or
  // overwrite it. Browsers accept Secure cookies on http://localhost.
  return ctx.config.secure ? '__Host-burrow' : 'burrow';
}

export function createSession(
  ctx: Ctx,
  userId: number,
  req: FastifyRequest,
  reply: FastifyReply,
  deviceId: number | null = null,
): Session {
  const token = randomToken(32);
  const now = ctx.now();
  const row: Session = {
    idHash: sha256(token),
    publicId: randomToken(12),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ABSOLUTE_TIMEOUT_MS,
    // Signing in is itself a fresh confirmation.
    stepUpAt: now,
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    ip: req.ip,
    deviceId,
  };
  ctx.db.insert(sessions).values(row).run();
  reply.setCookie(cookieName(ctx), token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: ABSOLUTE_TIMEOUT_MS / 1000,
  });
  return row;
}

export function clearSessionCookie(ctx: Ctx, reply: FastifyReply): void {
  reply.clearCookie(cookieName(ctx), { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
}

/** Look up the session for a cookie value; expired sessions are deleted. */
export function resolveSession(ctx: Ctx, token: string | undefined): Auth | null {
  if (!token) return null;
  const idHash = sha256(token);
  const row = ctx.db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash))
    .get();
  if (!row) return null;
  const now = ctx.now();
  if (now >= row.session.expiresAt || now - row.session.lastSeenAt >= IDLE_TIMEOUT_MS) {
    ctx.db.delete(sessions).where(eq(sessions.idHash, idHash)).run();
    return null;
  }
  if (now - row.session.lastSeenAt >= TOUCH_INTERVAL_MS) {
    ctx.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.idHash, idHash)).run();
    row.session.lastSeenAt = now;
  }
  return row;
}

export function markStepUp(ctx: Ctx, session: Session): void {
  const now = ctx.now();
  ctx.db.update(sessions).set({ stepUpAt: now }).where(eq(sessions.idHash, session.idHash)).run();
  session.stepUpAt = now;
}

export function stepUpUntil(session: Session): number | null {
  return session.stepUpAt ? session.stepUpAt + STEP_UP_WINDOW_MS : null;
}

export function isSteppedUp(ctx: Ctx, session: Session): boolean {
  const until = stepUpUntil(session);
  return until !== null && ctx.now() < until;
}

/**
 * A fresh step-up asked by a route for part of what it does only (a phone key that changes, a
 * save to a file that grants a shell): the client's step-up dialog answers it like any other.
 */
export function requireStepUp(ctx: Ctx, req: FastifyRequest): void {
  const a = req.auth;
  if (!a) throw new HttpError(401, 'unauthenticated');
  if (!a.user.incomplete && !isSteppedUp(ctx, a.session)) throw new HttpError(403, 'step_up_required');
}

export function listSessions(ctx: Ctx, userId: number, currentHash: string): SessionInfo[] {
  return ctx.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .all()
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((s) => ({
      id: s.publicId,
      current: s.idHash === currentHash,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    }));
}

/** Returns the id_hash of the revoked session, or null if none matched. */
export function revokeSession(ctx: Ctx, userId: number, publicId: string): string | null {
  const row = ctx.db
    .select({ idHash: sessions.idHash })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.publicId, publicId)))
    .get();
  if (!row) return null;
  ctx.db.delete(sessions).where(eq(sessions.idHash, row.idHash)).run();
  return row.idHash;
}

/**
 * Ends every browser session of a user except the given one. Paired phones
 * keep theirs: they are unpaired under Settings -> Android app.
 */
export function revokeOtherSessions(ctx: Ctx, userId: number, keep: string): string[] {
  return ctx.db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.idHash, keep), isNull(sessions.deviceId)))
    .returning({ idHash: sessions.idHash })
    .all()
    .map((r) => r.idHash);
}

export function pruneSessions(ctx: Ctx): number {
  const now = ctx.now();
  return ctx.db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, now - IDLE_TIMEOUT_MS)))
    .run().changes;
}

/**
 * The login sessions that still hold (not expired, not idle too long), with
 * their user's role: what long-lived sockets are checked against.
 */
export function liveSessions(ctx: Ctx): Map<string, string> {
  const now = ctx.now();
  const rows = ctx.db
    .select({ idHash: sessions.idHash, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(gt(sessions.expiresAt, now), gt(sessions.lastSeenAt, now - IDLE_TIMEOUT_MS)))
    .all();
  return new Map(rows.map((r) => [r.idHash, r.role]));
}
