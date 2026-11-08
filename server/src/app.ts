import { appendFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { MAX_SOURCE_SUBJECT, type BackgroundJob, type LogEvent, type SystemHints } from '@burrow/shared';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { cookieName, liveSessions, pruneSessions, resolveSession } from './auth/sessions.js';
import { registerDirectRoutes } from './android/direct.js';
import { ContainerHistory } from './docker/history.js';
import { DockerMonitor } from './docker/monitor.js';
import { registerDockerRoutes, SessionSockets } from './docker/routes.js';
import { registerResourceRoutes } from './docker/resources.js';
import { DEFAULT_UPDATER, Updater, type UpdaterOptions } from './docker/autoupdate.js';
import { registerManageRoutes } from './docker/manage.js';
import { registerLogFileRoutes } from './docker/logfiles.js';
import { registerJournalRoutes } from './hosts/journal.js';
import { registerProxmoxRoutes } from './proxmox/routes.js';
import { AlertEngine } from './alerts/engine.js';
import { registerAlertRoutes } from './alerts/routes.js';
import { registerAnalyzeRoutes } from './ai/analyze.js';
import { migrateNtfySetting, Notifier, type SendDeps } from './notify/channels.js';
import { registerChannelRoutes } from './notify/routes.js';
import { Reports } from './reports/generate.js';
import { registerReportRoutes } from './reports/routes.js';
import { HostStatsService } from './hosts/stats.js';
import { registerHostStatsRoutes } from './hosts/stats-routes.js';
import { OpRunner } from './docker/ops.js';
import { UpdateChecker } from './docker/updates.js';
import { registerWorkspaceRoutes } from './workspace/routes.js';
import { openReportCount, registerBugReportRoutes } from './bugreports/routes.js';
import { registerAndroidRoutes } from './android/routes.js';
import { registerDeviceRoutes } from './auth/devices.js';
import { registerUserRoutes } from './auth/users.js';
import { enforceAccess, registerAuthRoutes, type SessionEvents } from './auth/routes.js';
import { SetupGate } from './auth/setup.js';
import { addressKey, pruneThrottle, trustProxySuggestion, viaUnknownProxy } from './auth/throttle.js';
import { pruneOld } from './retention.js';
import { checkBackups, registerBackupRoutes } from './backup.js';
import { diskFullError, DiskWatch, isDiskFull } from './diskspace.js';
import { Jobs } from './jobs.js';
import { LogEvents } from './logevents.js';
import { locateTarget, registerSelfUpdateRoutes } from './selfupdate.js';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import type { SecretBox } from './crypto.js';
import type { Db } from './db/index.js';
import { registerHostRoutes } from './hosts/routes.js';
import { registerWakeRoutes } from './hosts/wake.js';
import { PackageChecks, registerPackageRoutes } from './hosts/packages.js';
import { CommandScheduler, registerCommandScheduleRoutes } from './schedules/commands.js';
import { registerWidgetRoutes, WidgetPusher } from './android/widget.js';
import { StatusMonitor } from './hosts/status.js';
import { HttpError, httpErrorOf } from './http.js';
import { registerAiRoutes } from './ai/routes.js';
import { applySystemSettings, registerSystemRoutes } from './system/settings.js';
import { FileAccessGuard, registerFileAccessRoutes } from './files/access.js';
import { registerFileRoutes } from './files/routes.js';
import { SftpPool } from './files/pool.js';
import { registerLintRoutes } from './lint/routes.js';
import { AppFrames, registerAppRoutes } from './apps/routes.js';
import { UptimeMonitor } from './apps/uptime.js';
import type { Fetcher } from './apps/probe.js';
import { LspBridge, registerLspRoutes } from './lsp/bridge.js';
import { registerHistoryRoutes } from './history/routes.js';
import { registerSnippetRoutes } from './snippets/routes.js';
import { TerminalManager } from './terminal/manager.js';
import { registerTerminalRoutes } from './terminal/routes.js';
import { registerRecordingRoutes } from './terminal/recordings.js';

export interface AppDeps {
  config: Config;
  db: Db;
  box: SecretBox;
  now?: () => number;
  logger?: FastifyServerOptions['logger'];
  /** How the server fetches app pages and icons (tests swap it). */
  fetch?: Fetcher;
  /** Timings of the update watch (tests shorten them). */
  updater?: Partial<UpdaterOptions>;
  /** Which images the update check covers (tests: only their own). */
  updateScope?: (image: string) => boolean;
  /** How channels send (tests: a stand-in mail transport). */
  send?: SendDeps;
  /** Free bytes on the data disk (tests: a disk that runs full). */
  freeBytes?: (dir: string) => number | null;
}

export interface BurrowApp {
  app: FastifyInstance;
  ctx: Ctx;
  uptime: UptimeMonitor;
  gate: SetupGate;
  status: StatusMonitor;
  terminals: TerminalManager;
  files: SftpPool;
  lsp: LspBridge;
  docker: DockerMonitor;
  updates: UpdateChecker;
  updater: Updater;
  ops: OpRunner;
  alerts: AlertEngine;
  reports: Reports;
  notifier: Notifier;
  hostStats: HostStatsService;
  packages: PackageChecks;
  scheduled: CommandScheduler;
  widget: WidgetPusher;
  disk: DiskWatch;
  logEvents: LogEvents;
  /** Every route with its access rules, for the tests that go through all of them. */
  routes: RouteInfo[];
  /** Closes the sockets of login sessions that expired or lost the right (every minute by itself). */
  sweepSockets: () => void;
}

export interface RouteInfo {
  method: string;
  url: string;
  websocket: boolean;
  config: { auth?: string; stepUp?: boolean; allowIncomplete?: boolean };
}

// The page may only load its own scripts and talk to its own origin. Inline
// styles are allowed because Svelte's style: directives set them. Frames:
// only Burrow itself and the app tabs that allow being framed.
const cspWith = (frames: string[]) => [...CSP_BASE, `frame-src 'self'${frames.map((o) => ` ${o}`).join('')}`].join('; ');
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SERVER_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
// Requests per minute: a signed-in person, and an address without a session.
export const USER_LIMIT = 3000;
export const ADDRESS_LIMIT = 600;
// Whether a request is for the API. By the route it matched, not the raw
// URL: the router decodes the path, so "/%61pi/hosts" reaches /api/hosts
// while its raw URL does not start with "/api/" (that skipped the session
// check). Unmatched requests fall back to the raw URL (a 404 either way).
export const isApi = (req: FastifyRequest): boolean => (req.routeOptions.url ?? req.url).startsWith('/api/');
// The error code a request ended with, for its log line ("403 bad_origin").
const errorCodes = new WeakMap<object, string>();

export async function buildApp(deps: AppDeps): Promise<BurrowApp> {
  const { config } = deps;
  // Warnings and errors kept in the database too, grouped (OPS-W-13): the container's log goes with a deploy.
  const logEvents = new LogEvents();
  const logger = deps.logger ?? { level: config.logLevel };
  const app = Fastify({
    logger: typeof logger === 'object' ? { ...logger, hooks: logEvents.hooks() } : logger,
    trustProxy: config.trustProxy ?? false,
    // Fastify's own two lines per request ("incoming request", "request
    // completed") said little; one line below says what happened.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1 << 20,
    // A path parameter can be a log file's subject (a mute's), encoded once more: not cut off at Fastify's 100 (AUDIT2 AI-13).
    routerOptions: { maxParamLength: 3 * MAX_SOURCE_SUBJECT },
  });

  // Every route as it is registered: the tests go through each of them
  // (access rules, bad input), and a test run can say which were never hit.
  const routes: RouteInfo[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (method !== 'HEAD') routes.push({ method, url: r.url, websocket: !!(r as { websocket?: boolean }).websocket, config: (r.config ?? {}) as RouteInfo['config'] });
    }
  });
  const ctx: Ctx = { config, db: deps.db, box: deps.box, log: app.log, now: deps.now ?? Date.now };
  // Settings -> System over the .env's values, before anything reads them.
  applySystemSettings(ctx);
  const gate = new SetupGate(ctx);
  const disk = new DiskWatch(ctx, deps.freeBytes);
  // What the background jobs did, for admins (Settings -> About) and the log (OPS-W-14).
  const jobs = new Jobs(ctx);
  logEvents.attach(ctx);
  const frames = new AppFrames(ctx);
  const status = new StatusMonitor(ctx);
  // Read each time: Settings -> System changes them while Burrow runs.
  const terminals = new TerminalManager(ctx, {
    get maxSessions() {
      return config.terminalMaxSessions;
    },
    get idleMinutes() {
      return config.terminalIdleMinutes;
    },
  });
  // Signing out or revoking a login session closes its sockets (terminals,
  // containers, editors) at once; the terminals themselves keep running. One
  // that expired, or whose user lost the right, is found by the sweep.
  const dockerSockets = new SessionSockets();
  const events: SessionEvents = {
    revoked: (idHash) => {
      terminals.dropViewersOf(idHash);
      dockerSockets.drop(idHash);
    },
    userEnded: (userId, actor, reason) => terminals.closeForUser(userId, actor, reason, reason === 'user_deleted'),
  };

  await app.register(cookie);
  // A coarse ceiling per client against floods and runaway scripts. Sign-in
  // attempts have their own, much stricter throttle (auth/throttle.ts).
  // The session of a request, looked up once (the rate limit asks first).
  const sessionOf = new WeakMap<object, ReturnType<typeof resolveSession>>();
  const authOf = (req: FastifyRequest) => {
    if (!sessionOf.has(req)) sessionOf.set(req, resolveSession(ctx, req.cookies[cookieName(ctx)]));
    return sessionOf.get(req)!;
  };
  await app.register(rateLimit, {
    // Signed in: per sign-in session, and roomy (several tabs that poll,
    // all behind one proxy address): a runaway script or tab no longer
    // locks the person's other devices out with it (decision 20, OPS-W-08).
    // Anyone else: per address, tighter.
    max: (_req, key) => (key.startsWith('session:') ? USER_LIMIT : ADDRESS_LIMIT),
    timeWindow: '1 minute',
    // A valid session only: a made-up cookie counts as the address. req.ip
    // can be undefined for a socket without a peer address (in-process
    // injection); the default key generator would throw on it.
    // Through a proxy Burrow was not told about, per client it names: one address for everyone made the limit global (A3-SRV-02).
    keyGenerator: (req) => {
      const a = isApi(req) ? authOf(req) : null;
      return a ? `session:${a.session.idHash}` : addressKey(ctx, req);
    },
    allowList: (req) => !isApi(req),
    // Thrown, then shaped by the error handler below like every other error.
    errorResponseBuilder: (_req, c) => new HttpError(429, 'rate_limited', `Too many requests; retry in ${Math.ceil(c.ttl / 1000)} s.`),
  });
  app.decorateRequest('auth', null);
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  // Requests that name a client (X-Forwarded-For) through a proxy TRUST_PROXY does not name:
  // the audit log and the throttles see the proxy, not the person. Said once per proxy, and on
  // /healthz (A3-SRV-02).
  const unknownProxies = new Set<string>();
  if (!config.trustProxy) app.log.info('TRUST_PROXY is empty: client addresses are taken from the connection. Behind a reverse proxy, set TRUST_PROXY to its address.');
  app.addHook('onRequest', async (req, reply) => {
    if (viaUnknownProxy(ctx, req) && !unknownProxies.has(req.ip) && unknownProxies.size < 16) {
      unknownProxies.add(req.ip);
      const why = config.trustProxy ? `TRUST_PROXY (${config.trustProxy}) does not name it` : 'TRUST_PROXY is empty';
      app.log.warn(`Requests come through a proxy at ${req.ip} (X-Forwarded-For), but ${why}: the audit log and the sign-in throttle see the proxy, not the client. Set TRUST_PROXY=${trustProxySuggestion(req.ip)} (its network) in .env.`);
    }
    reply.header('Content-Security-Policy', cspWith(frames.origins()));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.secure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

    if (!isApi(req)) return;
    reply.header('Cache-Control', 'no-store');
    // CSRF: SameSite=Strict already keeps the cookie off cross-site requests;
    // the Origin check is the second lock and also covers same-site siblings
    // (another *.local.example.com app) that SameSite does not.
    // A WebSocket upgrade is a GET, but it opens a shell: same Origin rule.
    if (!SAFE_METHODS.has(req.method) || req.headers.upgrade?.toLowerCase() === 'websocket') {
      const origin = req.headers.origin;
      if (origin !== config.origin) throw new HttpError(403, 'bad_origin');
    }
    req.auth = authOf(req);
  });

  // One line per API call: method, path (no query: it can carry paths the
  // user browses), status, time and who. Changes are logged at info; reads
  // only when they fail, or at debug. Never cookies or bodies.
  app.addHook('onResponse', async (req, reply) => {
    if (!isApi(req)) return;
    const status = reply.statusCode;
    const line = {
      user: req.auth?.user.username,
      ip: req.ip,
      ms: Math.round(reply.elapsedTime),
    };
    const code = errorCodes.get(req);
    const msg = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]} ${status}${code ? ` ${code}` : ''}`;
    if (status >= 500) req.log.error(line, msg);
    else if (status >= 400 && status !== 401) req.log.warn(line, msg);
    else if (!SAFE_METHODS.has(req.method)) req.log.info(line, msg);
    else req.log.debug(line, msg);
  });

  app.addHook('preHandler', async (req) => {
    if (!req.routeOptions.url || !isApi(req)) return;
    // A change is judged by the session as it is once its body is in, not
    // as it was when the request began: one revoked or demoted while a slow
    // body came still went through (AUDIT2 AUTH-01).
    if (!SAFE_METHODS.has(req.method)) req.auth = resolveSession(ctx, req.cookies[cookieName(ctx)]);
    enforceAccess(ctx, req);
  });

  // BURROW_ROUTE_LOG=<file>: the routes a test run used successfully (an
  // answer below 400), one per line ("GET /api/hosts/:id"), written as they
  // come. A route only ever refused was not tried for what it does.
  const routeLog = process.env.BURROW_ROUTE_LOG;
  const hits = new Set<string>();
  const hit = (key: string) => {
    if (hits.has(key)) return;
    hits.add(key);
    appendFileSync(routeLog!, `${key}\n`);
  };
  if (routeLog) {
    app.addHook('onResponse', async (req, reply) => {
      if (req.routeOptions.url && reply.statusCode < 400) hit(`${req.method} ${req.routeOptions.url}`);
    });
    // A WebSocket that got past the access rules (after enforceAccess above;
    // an upgrade has no ordinary response).
    app.addHook('preHandler', async (req) => {
      if (req.routeOptions.url && req.headers.upgrade?.toLowerCase() === 'websocket') hit(`${req.method} ${req.routeOptions.url}`);
    });
  }


  app.setErrorHandler((raw: Error & { statusCode?: number; code?: string }, req, reply) => {
    const err = httpErrorOf(raw) ?? raw;
    errorCodes.set(req, err instanceof HttpError ? err.code : (err.code ?? 'error'));
    if (err instanceof HttpError) {
      // The reason, not only the status: "502 sftp_error: connection lost".
      if (err.status >= 500) req.log.warn({ code: err.code }, `${req.method} ${req.routeOptions.url ?? ''}: ${err.message}`);
      return reply.code(err.status).send({ error: err.code, ...(err.message !== err.code ? { message: err.message } : {}) });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    }
    // The data disk full: said, once on the channels, not a bare "internal" (OPS-W-02).
    if (isDiskFull(err)) {
      disk.failed();
      const full = diskFullError();
      errorCodes.set(req, full.code);
      req.log.warn({ code: err.code }, `${req.method} ${req.routeOptions.url ?? ''}: ${err.message}`);
      return reply.code(full.status).send({ error: full.code, message: full.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal' });
  });

  // A hint, not a failure: the container stays healthy (A3-SRV-02).
  // Unwell when the data disk is (nearly) full: every write would fail (OPS-W-02).
  app.get('/healthz', { config: { auth: 'public' } }, async (_req, reply) => {
    const hints = unknownProxies.size ? ['trust_proxy'] : [];
    if (disk.check().full) return reply.code(503).send({ ok: false, hints: ['disk_full', ...hints] });
    return hints.length ? { ok: true, hints } : { ok: true };
  });
  // What an admin should know about how Burrow runs (decision 12): a proxy TRUST_PROXY does not
  // name (empty, or stale), with what to set; the data disk full. A hint, never trusted: a header can be made up.
  app.get('/api/system/hints', async (): Promise<SystemHints> => {
    const proxies = [...unknownProxies];
    return {
      trustProxy: proxies.length ? { proxies, current: config.trustProxy ?? null, suggest: trustProxySuggestion(proxies[0]!) } : null,
      diskFull: disk.check().full,
      openReports: openReportCount(ctx),
    };
  });
  // The background jobs: when each last ran, how long it took, its last failure (OPS-W-14).
  app.get('/api/system/jobs', async (): Promise<BackgroundJob[]> => jobs.list());
  // Burrow's own warnings and errors of the last 30 days, grouped, newest first (OPS-W-13).
  app.get('/api/system/log-events', async (): Promise<LogEvent[]> => logEvents.list());
  // Which Burrow runs (for Settings -> About); signed-in people only.
  app.get('/api/version', { config: { auth: 'user' } }, async () => ({ server: SERVER_VERSION }));

  registerAuthRoutes(app, ctx, gate, events);
  registerDeviceRoutes(app, ctx, gate, events);
  registerUserRoutes(app, ctx, events);
  const files = new SftpPool(ctx);
  const lsp = new LspBridge(ctx);
  registerHostRoutes(app, ctx, status, terminals, files);
  registerSystemRoutes(app, ctx, status);
  registerWakeRoutes(app, ctx, status, files);
  registerTerminalRoutes(app, ctx, terminals);
  registerRecordingRoutes(app, ctx);
  registerSnippetRoutes(app, ctx);
  registerHistoryRoutes(app, ctx);
  registerAiRoutes(app, ctx, terminals);
  // Which files a person may open: an operator, the folders an admin granted (A3-SRV-01).
  const fileGuard = new FileAccessGuard(ctx, async () => {
    const { installs, unreadable } = await locateTarget(ctx, docker);
    return { found: installs, unreadable };
  });
  registerFileAccessRoutes(app, ctx);
  await registerFileRoutes(app, ctx, files, fileGuard);
  registerLspRoutes(app, lsp, dockerSockets);
  registerLintRoutes(app, ctx, files, fileGuard);
  const uptime = new UptimeMonitor(ctx, deps.fetch ?? fetch, null);
  registerAppRoutes(app, ctx, files, frames, deps.fetch, uptime);
  registerAndroidRoutes(app, ctx);
  registerDirectRoutes(app, ctx);
  const docker = new DockerMonitor(ctx, files);
  // Kept CPU and memory per container (report 428102); the list starts with its last hour.
  const containerHistory = new ContainerHistory(ctx, (id) => docker.recent(id, 60_000, true), jobs);
  docker.seed = (id) => containerHistory.recent(id, 3_600_000);
  registerDockerRoutes(app, ctx, docker, dockerSockets, files, containerHistory);
  // Hosts or groups changed (a test reads a host's facts, Docker among them): the pages watching
  // containers on every device read the list again; another device's showed none until a reload (W-FUNC-09).
  const HOST_LIST_ROUTES = /^\/api\/(hosts(\/:id(\/(copy|test|trust|install-key|shell-integration))?)?|groups(\/:id)?|host-defaults|import\/ssh-config\/apply)$/;
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode < 400 && !SAFE_METHODS.has(req.method) && HOST_LIST_ROUTES.test(req.routeOptions.url ?? '')) docker.hostsChanged();
  });
  registerResourceRoutes(app, ctx, files);
  registerLogFileRoutes(app, ctx, files);
  registerJournalRoutes(app, ctx, files);
  registerProxmoxRoutes(app, ctx, files);
  const ops = new OpRunner(ctx, files);
  const updates = new UpdateChecker(ctx, files, (id) => docker.poll(id), undefined, deps.updateScope ?? ((image) => !config.updateCheckExclude?.test(image)));
  const updater = new Updater(ctx, docker, ops, updates, { ...DEFAULT_UPDATER, ...deps.updater });
  registerManageRoutes(app, ctx, { monitor: docker, pool: files, runner: ops, checker: updates, updater, terminals, sockets: dockerSockets, access: fileGuard });
  updater.start();
  migrateNtfySetting(ctx);
  const notifier = new Notifier(ctx, deps.send);
  updater.notifier = notifier;
  disk.notifier = notifier;
  uptime.notifier = notifier;
  registerChannelRoutes(app, ctx, notifier);
  const reports = new Reports(ctx, files, docker, notifier);
  reports.jobs = jobs;
  updates.jobs = jobs;
  registerReportRoutes(app, ctx, reports);
  const alerts = new AlertEngine(ctx, files, docker, notifier);
  alerts.quiet = (hostId, project) => ops.quiet(hostId, project);
  const hostStats = new HostStatsService(ctx, files);
  hostStats.jobs = jobs;
  hostStats.onTrouble = (hostId, trouble, at) => alerts.hostTrouble(hostId, trouble, at);
  // Package updates, checked with the statistics every six hours.
  const packages = new PackageChecks(ctx, files);
  packages.onTrouble = hostStats.onTrouble;
  hostStats.packages = packages;
  reports.packages = packages;
  // Commands on a schedule: a failed run is a Host health alert.
  const scheduled = new CommandScheduler(ctx, files);
  scheduled.onTrouble = hostStats.onTrouble;
  scheduled.jobs = jobs;
  registerCommandScheduleRoutes(app, ctx, scheduled);
  // The Android app's widget: its numbers, asked for or pushed when they change.
  const widget = new WidgetPusher(ctx, status, packages, deps.fetch ?? fetch);
  registerWidgetRoutes(app, ctx, status, packages, widget);
  registerPackageRoutes(app, ctx, packages);
  // The containers Burrow already knows on the host, to name the processes in them.
  hostStats.containerNames = async (hostId) => new Map((await docker.recent(hostId, 60_000, false)).containers.map((c) => [c.id, c.name]));
  registerHostStatsRoutes(app, ctx, hostStats);
  registerAlertRoutes(app, ctx, alerts);
  registerAnalyzeRoutes(app, ctx, docker);
  // Tests start the alert streams themselves, against their own hosts.
  if (config.env !== 'test') {
    // A minute after start: the images still marked "update" once more.
    setTimeout(() => void updates.recheckFlagged(), 60_000).unref();
    alerts.start();
    reports.start();
    uptime.start();
    hostStats.start();
    containerHistory.start();
    scheduled.start();
    widget.start();
  }
  registerWorkspaceRoutes(app, ctx, files, fileGuard);
  registerBugReportRoutes(app, ctx, notifier);
  registerBackupRoutes(app, ctx);
  registerSelfUpdateRoutes(app, ctx, docker, files);

  app.all('/api/*', { config: { auth: 'public' } }, async () => {
    throw new HttpError(404, 'not_found');
  });

  if (config.publicDir && existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      wildcard: false,
      setHeaders: (res, path) => {
        // Hashed assets never change; completion specs change only with a
        // release; index.html must always be revalidated.
        const cache = path.includes(join('assets', '')) ? 'public, max-age=31536000, immutable' : path.includes(join('fig', '')) ? 'public, max-age=86400' : 'no-cache';
        res.header('Cache-Control', cache);
      },
    });
    // Client-side routes all serve the SPA shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }

  const sweepSockets = () => {
    const valid = liveSessions(ctx);
    dockerSockets.sweep(valid);
    terminals.sweepViewers(valid);
  };
  const sweeper = setInterval(sweepSockets, 60_000);
  sweeper.unref();
  const housekeeping = setInterval(() => {
    const started = performance.now();
    let failure: string | null = null;
    try {
      pruneSessions(ctx);
      pruneThrottle(ctx);
      pruneOld(ctx);
      disk.check();
    } catch (err) {
      failure = (err as Error).message;
      ctx.log.warn(`housekeeping: ${failure}`);
    }
    jobs.ran('housekeeping', performance.now() - started, failure);
    void checkBackups(ctx, notifier).catch((err: Error) => ctx.log.warn(`backups: telling failed: ${err.message}`));
  }, 3600_000);
  housekeeping.unref();
  app.addHook('onClose', async () => {
    clearInterval(housekeeping);
    clearInterval(sweeper);
    status.stop();
    terminals.stop();
    files.closeAll();
    lsp.stopAll();
    docker.stop();
    updater.stop();
    alerts.stop();
    reports.stop();
    hostStats.stop();
    scheduled.stop();
    widget.stop();
    uptime.stop();
    logEvents.stop();
  });

  return { app, ctx, uptime, gate, status, terminals, files, lsp, docker, updates, updater, ops, alerts, reports, notifier, hostStats, packages, scheduled, widget, disk, logEvents, routes, sweepSockets };
}
