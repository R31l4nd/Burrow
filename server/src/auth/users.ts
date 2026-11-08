import { and, desc, eq, gt, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Invite, UserSummary } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { randomToken, sha256 } from '../crypto.js';
import { removeDeviceEverywhere, removeKeys, takeGrants } from '../android/direct.js';
import { devices, invites, passkeys, sessions, users } from '../db/schema.js';
import { actor, HttpError, idParam, noContent, parse, requireAuth } from '../http.js';
import type { SessionEvents } from './routes.js';

// More than one user: an admin invites people with a role (admin, or
// operator: logs, containers, reports and files to read, no shell and no
// changes), manages roles and removes accounts. An invite is a one-time link,
// valid for a week; only its hash is stored.

const INVITE_DAYS = 7;

export function openInvite(ctx: Ctx, token: string): typeof invites.$inferSelect {
  const inv = ctx.db
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.usedAt), gt(invites.expiresAt, ctx.now())))
    .get();
  if (!inv) throw new HttpError(404, 'invite_invalid', 'This invite link is used, expired or wrong.');
  return inv;
}

/**
 * An account that is no longer an admin (demoted or removed) keeps no way
 * onto the hosts: its phones' direct-route keys come off every host. The
 * hosts where that failed (unreachable) are returned, for the audit log.
 */
async function dropDirectRoutes(ctx: Ctx, userId: number): Promise<number[]> {
  const left: number[] = [];
  for (const d of ctx.db.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId)).all()) {
    for (const r of await removeDeviceEverywhere(ctx, d.id)) left.push(r.hostId);
  }
  if (left.length) ctx.log.warn({ userId, hostIds: left }, 'direct-route keys left on unreachable hosts');
  return left;
}

function summaries(ctx: Ctx): UserSummary[] {
  const last = new Map(
    ctx.db
      .select({ userId: sessions.userId, at: max(sessions.lastSeenAt) })
      .from(sessions)
      .groupBy(sessions.userId)
      .all()
      .map((r) => [r.userId, r.at]),
  );
  return ctx.db
    .select()
    .from(users)
    .all()
    .map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      incomplete: u.incomplete,
      passkeys: ctx.db.select().from(passkeys).where(eq(passkeys.userId, u.id)).all().length,
      password: u.passwordHash !== null && u.totpConfirmed,
      sso: u.oidcSub !== null,
      email: u.email,
      createdAt: new Date(u.createdAt).toISOString(),
      lastSeenAt: last.get(u.id) ? new Date(last.get(u.id)!).toISOString() : null,
    }));
}

export function registerUserRoutes(app: FastifyInstance, ctx: Ctx, events: SessionEvents): void {
  app.get('/api/users', async (): Promise<UserSummary[]> => summaries(ctx));

  const admins = () => ctx.db.select().from(users).where(and(eq(users.role, 'admin'), eq(users.incomplete, false))).all();

  app.put('/api/users/:id', { config: { stepUp: true } }, async (req) => {
    const id = idParam(req);
    const { role, email } = parse(z.object({ role: z.enum(['admin', 'operator']), email: z.email().max(200).nullable().optional() }), req.body);
    const u = ctx.db.select().from(users).where(eq(users.id, id)).get();
    if (!u) throw new HttpError(404, 'not_found');
    // Only a finished admin counts: demoting an invited one that never finished leaves the others (A3-SRV-15).
    if (u.role === 'admin' && !u.incomplete && role !== 'admin' && admins().length <= 1) throw new HttpError(409, 'last_admin', 'There must be at least one admin.');
    ctx.db
      .update(users)
      .set({ role, ...(email !== undefined ? { email } : {}) })
      .where(eq(users.id, id))
      .run();
    // An operator has no shell: open terminals (on the hosts too) and direct routes end now.
    let keyLeftOn: number[] = [];
    if (u.role === 'admin' && role !== 'admin') {
      for (const s of ctx.db.select().from(sessions).where(eq(sessions.userId, id)).all()) events.revoked(s.idHash);
      await events.userEnded(id, actor(req), 'user_demoted');
      keyLeftOn = await dropDirectRoutes(ctx, id);
    }
    audit(ctx, actor(req), 'user.update', u.username, { role, ...(keyLeftOn.length ? { keyLeftOn } : {}) });
    return summaries(ctx).find((x) => x.id === id);
  });

  // A provider changed (another issuer, or its accounts made again): the old link cannot match
  // any more and an account linked once is not linked again by itself. Unlinked here, the next
  // sign-in through the provider links it by the claim Settings -> Single sign-on names, as a new
  // account would be (AUDIT2 AUTH-06). Passkeys and a password stay as they are.
  app.delete('/api/users/:id/sso', { config: { stepUp: true } }, async (req) => {
    const id = idParam(req);
    const u = ctx.db.select().from(users).where(eq(users.id, id)).get();
    if (!u) throw new HttpError(404, 'not_found');
    ctx.db.update(users).set({ oidcSub: null, oidcIss: null }).where(eq(users.id, id)).run();
    audit(ctx, actor(req), 'user.sso_unlinked', u.username, { issuer: u.oidcIss });
    return summaries(ctx).find((x) => x.id === id);
  });

  app.delete('/api/users/:id', { config: { stepUp: true } }, async (req, reply) => {
    const id = idParam(req);
    if (id === requireAuth(req).user.id) throw new HttpError(409, 'self', 'You cannot remove your own account here.');
    const u = ctx.db.select().from(users).where(eq(users.id, id)).get();
    if (!u) throw new HttpError(404, 'not_found');
    const lastAdmin = (rows: { role: string; incomplete: boolean }[]) => u.role === 'admin' && !u.incomplete && rows.filter((x) => x.role === 'admin' && !x.incomplete).length <= 1;
    if (lastAdmin(ctx.db.select().from(users).all())) throw new HttpError(409, 'last_admin', 'There must be at least one admin.');
    // Their terminals end first, tmux on the hosts too: the rows cascade away with the account
    // and left the shells running where nobody could see or close them (A3-SRV-09).
    await events.userEnded(id, actor(req), 'user_deleted');
    // Checked and gone in one step, before anything is awaited: while the
    // keys came off the hosts, the other admin could be demoted and no admin
    // was left (AUDIT2 AUTH-04).
    const grants = ctx.db.transaction((tx) => {
      if (lastAdmin(tx.select().from(users).all())) throw new HttpError(409, 'last_admin', 'There must be at least one admin.');
      const own = tx.select({ id: devices.id }).from(devices).where(eq(devices.userId, id)).all().map((d) => d.id);
      const rows = takeGrants(ctx, own);
      // Every session of the account ends now, sockets included.
      for (const s of tx.select().from(sessions).where(eq(sessions.userId, id)).all()) events.revoked(s.idHash);
      tx.delete(users).where(eq(users.id, id)).run();
      return rows;
    });
    const keyLeftOn: number[] = [];
    for (const deviceId of new Set(grants.map((g) => g.deviceId))) {
      for (const r of await removeKeys(ctx, deviceId, grants.filter((g) => g.deviceId === deviceId))) keyLeftOn.push(r.hostId);
    }
    if (keyLeftOn.length) ctx.log.warn({ userId: id, hostIds: keyLeftOn }, 'direct-route keys left on unreachable hosts');
    audit(ctx, actor(req), 'user.delete', u.username, keyLeftOn.length ? { keyLeftOn } : undefined);
    return noContent(reply);
  });

  app.get('/api/invites', async (): Promise<Invite[]> =>
    ctx.db
      .select()
      .from(invites)
      .where(and(isNull(invites.usedAt), gt(invites.expiresAt, ctx.now())))
      .orderBy(desc(invites.createdAt))
      .all()
      .map((i) => ({ id: i.id, role: i.role, createdAt: new Date(i.createdAt).toISOString(), expiresAt: new Date(i.expiresAt).toISOString(), url: null })),
  );

  /** A new invite: the link is shown once. */
  app.post('/api/invites', { config: { stepUp: true } }, async (req): Promise<Invite> => {
    const { role } = parse(z.object({ role: z.enum(['admin', 'operator']) }), req.body);
    const token = randomToken(24);
    const now = ctx.now();
    const row = ctx.db
      .insert(invites)
      .values({ tokenHash: sha256(token), role, createdBy: requireAuth(req).user.id, createdAt: now, expiresAt: now + INVITE_DAYS * 86_400_000 })
      .returning()
      .get();
    audit(ctx, actor(req), 'invite.create', null, { role });
    return { id: row.id, role, createdAt: new Date(now).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(), url: `${ctx.config.origin}/#/invite/${token}` };
  });

  app.delete('/api/invites/:id', async (req, reply) => {
    ctx.db.delete(invites).where(eq(invites.id, idParam(req))).run();
    audit(ctx, actor(req), 'invite.delete');
    return noContent(reply);
  });
}
