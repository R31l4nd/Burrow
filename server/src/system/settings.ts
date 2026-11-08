import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { parseRegistryEndpoints, systemSettingsInput, type SystemSettings, type SystemSettingsInput, type SystemValues } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';
import { appSettings } from '../db/schema.js';
import { actor, parse } from '../http.js';
import type { StatusMonitor } from '../hosts/status.js';

// Settings that were only in the .env file, now in Settings -> System. Each one not set here is
// the .env's. What applies is written into the config object itself, so every part that reads it
// (the terminal limits, the update check, registries, apps) has the value set here at once.

const KEY = 'system';
const NONE: SystemSettingsInput = { terminalMaxSessions: null, terminalIdleMinutes: null, statusIntervalSeconds: null, updateCheckExclude: null, registryEndpoints: null, appsBaseDomain: null };

// The .env's own values, taken before anything set here changed the config.
const fromEnv = new WeakMap<Config, { values: SystemValues; endpoints: Record<string, string>; exclude: RegExp | null }>();

function envOf(c: Config) {
  let e = fromEnv.get(c);
  if (!e) {
    e = {
      values: {
        terminalMaxSessions: c.terminalMaxSessions,
        terminalIdleMinutes: c.terminalIdleMinutes,
        statusIntervalSeconds: c.statusIntervalSeconds,
        // As typed: .source writes a / as \/, the same to a RegExp.
        updateCheckExclude: c.updateCheckExclude?.source.replace(/\\\//g, '/') ?? '',
        registryEndpoints: Object.entries(c.registryEndpoints)
          .map(([k, v]) => `${k}=${v}`)
          .join(','),
        appsBaseDomain: c.appsBaseDomain ?? '',
      },
      endpoints: c.registryEndpoints,
      exclude: c.updateCheckExclude,
    };
    fromEnv.set(c, e);
  }
  return e;
}

function load(ctx: Ctx): SystemSettingsInput {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, KEY)).get();
  if (!row) return { ...NONE };
  // Stored before a rule here tightened: what no longer passes is the .env's again.
  const r = systemSettingsInput.partial().safeParse(JSON.parse(row.value));
  return { ...NONE, ...(r.success ? r.data : {}) };
}

function apply(c: Config, saved: SystemSettingsInput): SystemValues {
  const env = envOf(c);
  const v: SystemValues = {
    terminalMaxSessions: saved.terminalMaxSessions ?? env.values.terminalMaxSessions,
    terminalIdleMinutes: saved.terminalIdleMinutes ?? env.values.terminalIdleMinutes,
    statusIntervalSeconds: saved.statusIntervalSeconds ?? env.values.statusIntervalSeconds,
    updateCheckExclude: saved.updateCheckExclude ?? env.values.updateCheckExclude,
    registryEndpoints: saved.registryEndpoints ?? env.values.registryEndpoints,
    appsBaseDomain: saved.appsBaseDomain ?? env.values.appsBaseDomain,
  };
  c.terminalMaxSessions = v.terminalMaxSessions;
  c.terminalIdleMinutes = v.terminalIdleMinutes;
  c.statusIntervalSeconds = v.statusIntervalSeconds;
  c.updateCheckExclude = saved.updateCheckExclude === null ? env.exclude : v.updateCheckExclude ? new RegExp(v.updateCheckExclude) : null;
  c.registryEndpoints = saved.registryEndpoints === null ? env.endpoints : (parseRegistryEndpoints(v.registryEndpoints) ?? {});
  c.appsBaseDomain = v.appsBaseDomain || null;
  return v;
}

/** At start-up: what is set here over the .env's values. */
export function applySystemSettings(ctx: Ctx): void {
  apply(ctx.config, load(ctx));
}

export function getSystemSettings(ctx: Ctx): SystemSettings {
  const saved = load(ctx);
  return { saved, env: envOf(ctx.config).values, effective: apply(ctx.config, saved) };
}

export function saveSystemSettings(ctx: Ctx, input: SystemSettingsInput): SystemSettings {
  const value = JSON.stringify(input);
  ctx.db
    .insert(appSettings)
    .values({ key: KEY, value, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ctx.now() } })
    .run();
  return getSystemSettings(ctx);
}

export function registerSystemRoutes(app: FastifyInstance, ctx: Ctx, status: StatusMonitor): void {
  app.get('/api/settings/system', async () => getSystemSettings(ctx));

  // Where Burrow reaches registries is where it sends requests: a fresh step-up, as for the AI's address.
  app.put('/api/settings/system', { config: { stepUp: true } }, async (req) => {
    const before = ctx.config.statusIntervalSeconds;
    const s = saveSystemSettings(ctx, parse(systemSettingsInput, req.body));
    // The online check at its new pace (or off) straight away, not after a restart.
    if (s.effective.statusIntervalSeconds !== before) {
      status.stop();
      status.start(s.effective.statusIntervalSeconds);
    }
    audit(ctx, actor(req), 'settings.system', null, { set: Object.entries(s.saved).filter(([, v]) => v !== null).map(([k]) => k) });
    return s;
  });
}
