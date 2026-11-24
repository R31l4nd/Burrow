import { eq, gte, lt, max, min, sql, sum } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { USAGE_KEYS, usageCounts, type UsageSummary } from '@burrow/shared';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { appSettings, usageDays } from './db/schema.js';
import { actor, noContent, parse } from './http.js';

// Settings -> Usage: how often each page and dialog was opened, per day, by
// name only (shared/src/usage.ts), on this Burrow only. The browser counts and
// sends its counts now and then; an admin sees which parts are used and which
// are dead weight. On by default (it never leaves the instance), can be turned
// off, and cleared. Kept 180 days.

const ON_KEY = 'usage.on';
export const KEEP_USAGE_DAYS = 180;
const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function usageOn(ctx: Ctx): boolean {
  return ctx.db.select().from(appSettings).where(eq(appSettings.key, ON_KEY)).get()?.value !== 'false';
}

/** Counts from a browser, added to today's in one write. Nothing kept while it is off; says which. */
export function countUsage(ctx: Ctx, counts: Record<string, number>): boolean {
  if (!usageOn(ctx)) return false;
  const day = dayOf(ctx.now());
  ctx.db.transaction((tx) => {
    for (const [key, n] of Object.entries(counts)) {
      tx.insert(usageDays)
        .values({ day, key, n })
        .onConflictDoUpdate({ target: [usageDays.day, usageDays.key], set: { n: sql`${usageDays.n} + ${n}` } })
        .run();
    }
  });
  return true;
}

/** The last `days` days (today among them): every page, opened or not, and the dialogs opened. */
export function usageSummary(ctx: Ctx, days: number): UsageSummary {
  const from = dayOf(ctx.now() - (days - 1) * DAY);
  const rows = ctx.db
    .select({ key: usageDays.key, n: sum(usageDays.n).mapWith(Number), last: max(usageDays.day) })
    .from(usageDays)
    .where(gte(usageDays.day, from))
    .groupBy(usageDays.key)
    .all();
  const seen = new Set(rows.map((r) => r.key));
  const all = [...rows, ...USAGE_KEYS.filter((k) => !seen.has(k)).map((key) => ({ key, n: 0, last: null }))];
  all.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const first = ctx.db.select({ day: min(usageDays.day) }).from(usageDays).get()?.day ?? null;
  return { on: usageOn(ctx), since: first, days, rows: all };
}

/** Days older than kept (retention.ts): 180 of them, today among them. */
export function pruneUsage(ctx: Ctx): number {
  return ctx.db.delete(usageDays).where(lt(usageDays.day, dayOf(ctx.now() - (KEEP_USAGE_DAYS - 1) * DAY))).run().changes;
}

export function registerUsageRoutes(app: FastifyInstance, ctx: Ctx): void {
  // Any signed-in person's browser sends what it opened; only an admin reads it. The answer says
  // whether it counts, so a browser stops sending while it is off. Not in the log at info: a line a
  // minute for every open tab buried the rest.
  app.post('/api/usage', { config: { auth: 'user' }, logLevel: 'warn' }, async (req) => ({ on: countUsage(ctx, parse(usageCounts, req.body)) }));

  app.get('/api/usage', async (req): Promise<UsageSummary> => {
    const { days } = parse(z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90, KEEP_USAGE_DAYS].includes(d)).default(30) }), req.query);
    return usageSummary(ctx, days);
  });

  app.put('/api/usage/settings', async (req) => {
    const { on } = parse(z.object({ on: z.boolean() }), req.body);
    ctx.db
      .insert(appSettings)
      .values({ key: ON_KEY, value: String(on), updatedAt: ctx.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: String(on), updatedAt: ctx.now() } })
      .run();
    audit(ctx, actor(req), 'usage.settings', null, { on });
    return { on };
  });

  // What was counted, gone: it cannot be had back.
  app.delete('/api/usage', { config: { stepUp: true } }, async (req, reply) => {
    const removed = ctx.db.delete(usageDays).run().changes;
    audit(ctx, actor(req), 'usage.cleared', null, { removed });
    return noContent(reply);
  });
}
