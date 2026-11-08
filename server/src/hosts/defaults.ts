import { eq } from 'drizzle-orm';
import type { ConnectionDefaults } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { appSettings } from '../db/schema.js';

// What every host gets when neither it nor one of its groups sets a field
// ("All hosts", above the groups): a user, a key, tmux ... once.

const KEY = 'host_defaults';

export function hostDefaults(ctx: Ctx): ConnectionDefaults {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, KEY)).get();
  return row ? (JSON.parse(row.value) as ConnectionDefaults) : {};
}

export function setHostDefaults(ctx: Ctx, d: ConnectionDefaults): ConnectionDefaults {
  // Only what is set is kept: empty means "not set here".
  const clean = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '')) as ConnectionDefaults;
  const value = JSON.stringify(clean);
  ctx.db
    .insert(appSettings)
    .values({ key: KEY, value, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ctx.now() } })
    .run();
  return clean;
}
