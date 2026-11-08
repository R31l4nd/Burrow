import { gte, lt } from 'drizzle-orm';
import type { AiUsage, AiUsageSummary } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { aiUsage } from '../db/schema.js';
import { getAiSettings } from './settings.js';

// What the models used, per call, as their providers counted it: shown in
// Settings -> AI with an estimated cost when prices are set (report 18efc8;
// Open WebUI and LibreChat show the same per answer).

export type UsageKind = 'analysis' | 'report' | 'command' | 'filter';

export function recordUsage(ctx: Ctx, kind: UsageKind, provider: string, u: AiUsage | null): void {
  if (!u || (!u.input && !u.output)) return;
  ctx.db.insert(aiUsage).values({ at: ctx.now(), kind, provider, inputTokens: Math.round(u.input), outputTokens: Math.round(u.output) }).run();
  // A year and a bit is plenty for a monthly view.
  ctx.db.delete(aiUsage).where(lt(aiUsage.at, ctx.now() - 400 * 86_400_000)).run();
}

export function usageSummary(ctx: Ctx): AiUsageSummary {
  const now = new Date(ctx.now());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const since30 = ctx.now() - 30 * 86_400_000;
  const rows = ctx.db.select().from(aiUsage).where(gte(aiUsage.at, Math.min(monthStart, since30))).all();
  const zero = () => ({ input: 0, output: 0, calls: 0 });
  const out: AiUsageSummary = { month: zero(), last30: zero(), byKind: { analysis: zero(), report: zero(), command: zero(), filter: zero() }, prices: getAiSettings(ctx).prices };
  const add = (t: AiUsage & { calls: number }, r: typeof aiUsage.$inferSelect) => {
    t.input += r.inputTokens;
    t.output += r.outputTokens;
    t.calls++;
  };
  for (const r of rows) {
    if (r.at >= monthStart) add(out.month, r);
    if (r.at >= since30) {
      add(out.last30, r);
      add(out.byKind[r.kind], r);
    }
  }
  return out;
}
