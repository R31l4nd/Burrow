import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { appSettings } from '../db/schema.js';

// A host's own alert limits (CPU and disk temperature, disk full), kept in
// the settings as { hostId: limits }; what is not set there is the default.

const KEY = 'host_limits';

export interface OwnLimits {
  cpuCelsius: number | null;
  diskCelsius: number | null;
  diskPercent: number | null;
}

function all(ctx: Ctx): Record<string, Partial<Record<keyof OwnLimits, number>>> {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, KEY)).get();
  return row ? JSON.parse(row.value) : {};
}

function save(ctx: Ctx, value: Record<string, unknown>): void {
  const v = JSON.stringify(value);
  ctx.db
    .insert(appSettings)
    .values({ key: KEY, value: v, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: v, updatedAt: ctx.now() } })
    .run();
}

export function ownLimits(ctx: Ctx, hostId: number): OwnLimits {
  const o = all(ctx)[String(hostId)] ?? {};
  return { cpuCelsius: o.cpuCelsius ?? null, diskCelsius: o.diskCelsius ?? null, diskPercent: o.diskPercent ?? null };
}

export function setOwnLimits(ctx: Ctx, hostId: number, own: OwnLimits): void {
  const a = all(ctx);
  const set = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== null));
  if (Object.keys(set).length) a[String(hostId)] = set;
  else delete a[String(hostId)];
  save(ctx, a);
}

/** A deleted host's limits go with it (a later host may get its id). */
export function forgetLimits(ctx: Ctx, hostId: number): void {
  const a = all(ctx);
  if (!(String(hostId) in a)) return;
  delete a[String(hostId)];
  save(ctx, a);
}
