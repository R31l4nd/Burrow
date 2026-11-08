import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { linearMatcher } from '../linear.js';
import { alertRuleInput, isAlertSubject, type Alert, type AlertMute, type AlertRule } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { alertMutes, alertReads, alertRules, alerts, users } from '../db/schema.js';
import { getHost } from '../hosts/service.js';
import { actor, HttpError, idParam, noContent, parse, requireAuth } from '../http.js';
import { toAlert, toRule, type AlertEngine } from './engine.js';

// Alerts, their rules and mutes. Channels: notify/routes.ts.

/**
 * Up to when this person has seen the alerts: read state is each person's own. Opening the
 * alerts as an operator cleared the admins' unread badge too (A3-SRV-11).
 */
export function readUpTo(ctx: Ctx, userId: number): number {
  return ctx.db.select({ at: alertReads.readAt }).from(alertReads).where(eq(alertReads.userId, userId)).get()?.at ?? ctx.db.select({ at: users.createdAt }).from(users).where(eq(users.id, userId)).get()?.at ?? 0;
}

export function registerAlertRoutes(app: FastifyInstance, ctx: Ctx, engine: AlertEngine): void {
  app.get('/api/alerts', { config: { auth: 'user' } }, async (req): Promise<Alert[]> => {
    const upTo = readUpTo(ctx, requireAuth(req).user.id);
    return ctx.db
      .select()
      .from(alerts)
      .orderBy(desc(alerts.updatedAt))
      .limit(200)
      .all()
      .map((r) => ({ ...toAlert(r, ctx), read: r.updatedAt <= upTo }));
  });

  /** What is being watched; checks the rules and hosts again first (a host added a moment ago). */
  app.get('/api/alerts/status', { config: { auth: 'user' } }, async () => {
    await engine.reconcile();
    return { hostIds: engine.watching() };
  });

  // Unread for the badge, and all of them: the list shows the latest 200, clearing removes every one (AUDIT2 PAGE-24).
  app.get('/api/alerts/unread', { config: { auth: 'user' } }, async (req) => ({
    n: ctx.db.select({ n: count() }).from(alerts).where(gt(alerts.updatedAt, readUpTo(ctx, requireAuth(req).user.id))).get()?.n ?? 0,
    total: ctx.db.select({ n: count() }).from(alerts).get()?.n ?? 0,
  }));

  // Read for this person only.
  app.post('/api/alerts/read', { config: { auth: 'user' } }, async (req) => {
    const userId = requireAuth(req).user.id;
    const now = ctx.now();
    ctx.db.insert(alertReads).values({ userId, readAt: now }).onConflictDoUpdate({ target: alertReads.userId, set: { readAt: now } }).run();
    return { ok: true };
  });

  app.delete('/api/alerts', async (req, reply) => {
    ctx.db.delete(alerts).run();
    audit(ctx, actor(req), 'alerts.cleared');
    return noContent(reply);
  });

  app.delete('/api/alerts/:id', async (req, reply) => {
    const id = idParam(req);
    const r = ctx.db.select().from(alerts).where(eq(alerts.id, id)).get();
    if (!r) throw new HttpError(404, 'not_found');
    ctx.db.delete(alerts).where(eq(alerts.id, id)).run();
    audit(ctx, actor(req), 'alert.delete', r.container, { title: r.title });
    return noContent(reply);
  });

  // ---- rules

  app.get('/api/alerts/rules', { config: { auth: 'user' } }, async (): Promise<AlertRule[]> => engine.rulesShown());

  // The engine runs patterns with RE2 (linear time): one it cannot run is refused here.
  const checkPattern = (p: string | null) => {
    const m = p ? linearMatcher(p) : null;
    if (m instanceof Error) throw new HttpError(400, 'invalid_pattern', `This pattern cannot be used (no look-around or back-references): ${m.message}`);
  };
  const values = (b: z.infer<typeof alertRuleInput>) => ({
    name: b.name,
    kind: b.kind,
    hostId: b.hostId,
    container: b.container || null,
    project: b.project || null,
    events: JSON.stringify(b.kind === 'event' ? b.events : []),
    pattern: b.kind === 'pattern' ? b.pattern : null,
    threshold: b.kind === 'rate' ? b.threshold : null,
    windowMinutes: b.kind === 'rate' ? b.windowMinutes : null,
    enabled: b.enabled,
  });

  app.post('/api/alerts/rules', async (req): Promise<AlertRule> => {
    const b = parse(alertRuleInput, req.body);
    checkPattern(b.pattern);
    if (b.hostId) getHost(ctx, b.hostId);
    const row = ctx.db
      .insert(alertRules)
      .values({ ...values(b), builtin: false, createdAt: ctx.now() })
      .returning()
      .get();
    audit(ctx, actor(req), 'alert_rule.create', b.name);
    void engine.reconcile();
    return toRule(row);
  });

  app.put('/api/alerts/rules/:id', async (req): Promise<AlertRule> => {
    const id = idParam(req);
    const cur = ctx.db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    if (!cur) throw new HttpError(404, 'not_found');
    const b = parse(alertRuleInput, req.body);
    checkPattern(b.pattern);
    // The built-in rule keeps its shape; it can be switched off and narrowed.
    const v = cur.builtin ? { enabled: b.enabled, events: JSON.stringify(b.events.length ? b.events : JSON.parse(cur.events)) } : values(b);
    const row = ctx.db.update(alertRules).set(v).where(eq(alertRules.id, id)).returning().get();
    audit(ctx, actor(req), 'alert_rule.update', row.name);
    void engine.reconcile();
    return toRule(row);
  });

  app.delete('/api/alerts/rules/:id', async (req, reply) => {
    const id = idParam(req);
    const cur = ctx.db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    if (!cur) throw new HttpError(404, 'not_found');
    if (cur.builtin) throw new HttpError(409, 'builtin', 'The built-in rule can be switched off, not deleted.');
    ctx.db.delete(alertRules).where(eq(alertRules.id, id)).run();
    audit(ctx, actor(req), 'alert_rule.delete', cur.name);
    void engine.reconcile();
    return noContent(reply);
  });

  // ---- mutes

  app.get('/api/alerts/mutes', { config: { auth: 'user' } }, async (): Promise<AlertMute[]> =>
    ctx.db
      .select()
      .from(alertMutes)
      .all()
      .filter((m) => m.until === null || m.until > ctx.now())
      .map((m) => ({ hostId: m.hostId, container: m.container, until: m.until === null ? null : new Date(m.until).toISOString() })),
  );

  app.post('/api/alerts/mutes', async (req): Promise<AlertMute> => {
    const b = parse(z.object({ hostId: z.number().int().positive(), container: z.string().refine(isAlertSubject, 'Not something an alert is about.'), minutes: z.number().int().min(1).max(525_600).nullable() }), req.body);
    const host = getHost(ctx, b.hostId);
    const until = b.minutes === null ? null : ctx.now() + b.minutes * 60_000;
    ctx.db
      .insert(alertMutes)
      .values({ hostId: b.hostId, container: b.container, until })
      .onConflictDoUpdate({ target: [alertMutes.hostId, alertMutes.container], set: { until } })
      .run();
    audit(ctx, actor(req), 'alert.mute', `${host.name}/${b.container}`, { minutes: b.minutes });
    return { hostId: b.hostId, container: b.container, until: until === null ? null : new Date(until).toISOString() };
  });

  app.delete('/api/alerts/mutes/:hostId/:container', async (req, reply) => {
    const hostId = idParam(req, 'hostId');
    const container = (req.params as { container: string }).container;
    ctx.db
      .delete(alertMutes)
      .where(and(eq(alertMutes.hostId, hostId), eq(alertMutes.container, container)))
      .run();
    audit(ctx, actor(req), 'alert.unmute', `${getHost(ctx, hostId).name}/${container}`);
    return noContent(reply);
  });
}
