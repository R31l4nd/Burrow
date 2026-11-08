import { z } from 'zod';
import { parseEndpoints } from './docker/registry.js';

// All configuration comes from the environment. Invalid values stop the
// process at start-up with a readable message instead of failing later.

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // The public URL the browser uses, e.g. https://burrow.local.example.com.
  // WebAuthn binds passkeys to this hostname, and the Origin check on
  // requests and WebSockets compares against it.
  BURROW_ORIGIN: z.url(),
  BURROW_DATA_DIR: z.string().default('/data'),
  // The backup service's archives, mounted read-only (compose.yaml), for the download in Settings.
  BURROW_BACKUP_DIR: z.string().default('/backups'),
  // Either the secret itself or a file that holds it. Neither set: a random
  // key is generated in the data dir on first start.
  BURROW_SECRET: z.string().min(32).optional(),
  BURROW_SECRET_FILE: z.string().optional(),
  // Address (or CIDR) of the reverse proxy that may set X-Forwarded-For.
  TRUST_PROXY: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Interval of the TCP reachability check in seconds; 0 turns it off.
  STATUS_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
  // Upper bound on open terminal sessions, against runaway tabs or scripts.
  TERMINAL_MAX_SESSIONS: z.coerce.number().int().min(1).max(500).default(20),
  // Close sessions nobody watches after this many idle minutes; 0 = never.
  TERMINAL_IDLE_MINUTES: z.coerce.number().int().min(0).default(0),
  // SHA-256 fingerprints (AA:BB:...) of the Android app's signing
  // certificate(s), comma separated. Published in assetlinks.json; only
  // needed for passkeys inside the app.
  BURROW_ANDROID_CERT_SHA256: z.string().optional(),
  // Fills the * in SWAG's swag_url labels when finding apps. Default: the
  // last two labels of the origin (burrow.local.example.com -> example.com).
  APPS_BASE_DOMAIN: z.string().trim().regex(/^[a-z0-9.-]+$/i).optional(),
  // Where Burrow reaches a registry whose name means something else from
  // inside its container, e.g. a registry on the host's localhost:
  // "localhost:5000=http://172.17.0.1:5000". Comma separated.
  REGISTRY_ENDPOINTS: z.string().optional(),
  // Containers with this label set to "true" get no alerts, update checks or
  // reports. Burrow's own tests label their throwaway containers with the
  // default, and run their Burrow with another name so it does see them.
  BURROW_IGNORE_LABEL: z.string().regex(/^[\w.-]{1,100}$/).default('burrow.ignore'),
  // Images the update check leaves alone (a regular expression on the
  // image name), e.g. ^registry\.example\.com/ for a private registry.
  UPDATE_CHECK_EXCLUDE: z
    .string()
    .refine((s) => {
      try {
        new RegExp(s);
        return true;
      } catch {
        return false;
      }
    }, 'not a valid regular expression')
    .optional(),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  origin: string;
  rpId: string;
  secure: boolean;
  dataDir: string;
  backupDir: string;
  secret: string | undefined;
  secretFile: string | undefined;
  trustProxy: string | undefined;
  logLevel: string;
  statusIntervalSeconds: number;
  terminalMaxSessions: number;
  terminalIdleMinutes: number;
  androidCertSha256: string[];
  appsBaseDomain: string | null;
  registryEndpoints: Record<string, string>;
  updateCheckExclude: RegExp | null;
  ignoreLabel: string;
  // Paths of the static web bundle; absent in tests.
  publicDir: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose passes `VAR=` for every unset optional; treat empty as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const origin = new URL(e.BURROW_ORIGIN);
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('BURROW_ORIGIN must be a bare origin such as https://burrow.example.com');
  }
  const secure = origin.protocol === 'https:';
  // Browsers treat http://localhost as a secure context, so development and
  // the end-to-end tests work without TLS. Anything else must be https.
  if (!secure && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
    throw new Error('BURROW_ORIGIN must use https (only localhost may use http)');
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    origin: origin.origin,
    rpId: origin.hostname,
    secure,
    dataDir: e.BURROW_DATA_DIR,
    backupDir: e.BURROW_BACKUP_DIR,
    secret: e.BURROW_SECRET,
    secretFile: e.BURROW_SECRET_FILE,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    statusIntervalSeconds: e.STATUS_INTERVAL_SECONDS,
    terminalMaxSessions: e.TERMINAL_MAX_SESSIONS,
    terminalIdleMinutes: e.TERMINAL_IDLE_MINUTES,
    appsBaseDomain: e.APPS_BASE_DOMAIN ?? null,
    registryEndpoints: parseEndpoints(e.REGISTRY_ENDPOINTS),
    updateCheckExclude: e.UPDATE_CHECK_EXCLUDE ? new RegExp(e.UPDATE_CHECK_EXCLUDE) : null,
    ignoreLabel: e.BURROW_IGNORE_LABEL,
    androidCertSha256: (e.BURROW_ANDROID_CERT_SHA256 ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s)),
    publicDir: undefined,
  };
}
