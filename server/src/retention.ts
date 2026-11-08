import { and, count, desc, eq, gt, lt, lte } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { alertCounts, alerts, auditLog, reports, stackUpdates } from './db/schema.js';
import { pruneLogEvents } from './logevents.js';
import { pruneRecordings } from './terminal/recordings.js';

// What Burrow keeps, so the database does not grow for ever: the audit log a
// year, alerts 90 days after they last happened (their counts per minute 90
// days too: one that keeps recurring is never pruned itself), the newest 100
// reports, the newest 100 updates of each stack.
// Terminal recordings as long as an admin chose (30 days by default), Burrow's own warnings
// 30 days after a kind was last seen. (Analyses, host samples and problem reports
// have their own limits.)

const DAY = 86_400_000;
export const KEEP_AUDIT_MS = 365 * DAY;
export const KEEP_ALERTS_MS = 90 * DAY;
export const KEEP_REPORTS = 100;
export const KEEP_STACK_UPDATES = 100;

export function pruneOld(ctx: Ctx): { audit: number; alerts: number; reports: number } {
  const now = ctx.now();
  const audit = ctx.db.delete(auditLog).where(lt(auditLog.at, now - KEEP_AUDIT_MS)).run().changes;
  const old = ctx.db.delete(alerts).where(lt(alerts.updatedAt, now - KEEP_ALERTS_MS)).run().changes;
  const cut = ctx.db.select({ id: reports.id }).from(reports).orderBy(desc(reports.id)).limit(1).offset(KEEP_REPORTS).get();
  const reportsGone = cut ? ctx.db.delete(reports).where(lte(reports.id, cut.id)).run().changes : 0;
  // A row a minute for an alert that recurs for months: they grew without bound (audit 2026-11-05).
  const counts = ctx.db.delete(alertCounts).where(lt(alertCounts.minute, Math.floor((now - KEEP_ALERTS_MS) / 60_000))).run().changes;
  let updates = 0;
  for (const g of ctx.db.select({ hostId: stackUpdates.hostId, project: stackUpdates.project }).from(stackUpdates).groupBy(stackUpdates.hostId, stackUpdates.project).having(gt(count(), KEEP_STACK_UPDATES)).all()) {
    const stack = and(eq(stackUpdates.hostId, g.hostId), eq(stackUpdates.project, g.project));
    const last = ctx.db.select({ id: stackUpdates.id }).from(stackUpdates).where(stack).orderBy(desc(stackUpdates.id)).limit(1).offset(KEEP_STACK_UPDATES).get();
    if (last) updates += ctx.db.delete(stackUpdates).where(and(stack, lte(stackUpdates.id, last.id))).run().changes;
  }
  const recordingsGone = pruneRecordings(ctx);
  pruneLogEvents(ctx);
  if (audit || old || reportsGone || recordingsGone || counts || updates) ctx.log.info({ audit, alerts: old, reports: reportsGone, recordings: recordingsGone, alertCounts: counts, stackUpdates: updates }, 'retention: old entries removed');
  return { audit, alerts: old, reports: reportsGone };
}
