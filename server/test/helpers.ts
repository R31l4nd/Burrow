import { Writable } from 'node:stream';
import { generate } from 'otplib';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@burrow/shared';
import { buildApp, type BurrowApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SecretBox } from '../src/crypto.js';
import { openDb } from '../src/db/index.js';

export const ORIGIN = 'http://localhost:8080';

export interface TestApp extends BurrowApp {
  clock: { now: number };
  advance(ms: number): void;
  cookie: string | null;
  request(method: string, url: string, body?: unknown, opts?: { origin?: string | null; cookie?: string | null }): Promise<LightMyRequestResponse>;
  json<T = unknown>(method: string, url: string, body?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface MakeAppOptions {
  // A database file instead of :memory:, to simulate a restart with two apps.
  dbFile?: string;
  fetch?: import('../src/apps/probe.js').Fetcher;
  env?: Record<string, string>;
  updater?: import('../src/app.js').AppDeps['updater'];
  updateScope?: (image: string) => boolean;
  send?: import('../src/notify/channels.js').SendDeps;
  freeBytes?: (dir: string) => number | null;
}

export async function makeApp(opts: MakeAppOptions = {}): Promise<TestApp> {
  const config = loadConfig({ NODE_ENV: 'test', BURROW_ORIGIN: ORIGIN, LOG_LEVEL: 'silent', STATUS_INTERVAL_SECONDS: '0', BURROW_IGNORE_LABEL: 'burrow.test-ignore', ...opts.env });
  const clock = { now: Date.UTC(2026, 0, 1, 12, 0, 0) };
  const built = await buildApp({
    config,
    db: openDb(opts.dbFile ?? ':memory:'),
    box: new SecretBox('test-secret-that-is-long-enough-for-hkdf'),
    now: () => clock.now,
    // At warn into nothing: what Burrow warns about goes through its logger as it does live (kept in log_events, OPS-W-13), not into the test's output.
    logger: process.env.TEST_LOG ? { level: 'error' } : { level: 'warn', stream: new Writable({ write: (_c, _e, done) => done() }) },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.updater ? { updater: opts.updater } : {}),
    ...(opts.updateScope ? { updateScope: opts.updateScope } : {}),
    ...(opts.send ? { send: opts.send } : {}),
    ...(opts.freeBytes ? { freeBytes: opts.freeBytes } : {}),
  });
  built.gate.announce(() => {});
  const t: TestApp = {
    ...built,
    clock,
    cookie: null,
    advance(ms) {
      clock.now += ms;
    },
    async request(method, url, body, opts = {}) {
      const origin = opts.origin === undefined ? ORIGIN : opts.origin;
      const cookie = opts.cookie === undefined ? t.cookie : opts.cookie;
      const res = await built.app.inject({
        method: method as 'GET',
        url,
        headers: {
          ...(origin ? { origin } : {}),
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
      const set = res.cookies.find((c) => c.name === 'burrow');
      if (set) t.cookie = set.value ? `burrow=${set.value}` : null;
      return res;
    },
    async json(method, url, body) {
      const res = await t.request(method, url, body);
      if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
      return (res.body ? res.json() : undefined) as never;
    },
    async close() {
      await built.app.close();
    },
  };
  return t;
}

export const totpNow = (secret: string, t: TestApp, offsetSteps = 0) =>
  generate({ secret, epoch: Math.floor(t.clock.now / 1000) + offsetSteps * 30 });

export const PASSWORD = 'correct horse battery staple';

/**
 * Run the setup wizard with password + TOTP (passkeys are covered by the
 * Playwright tests, which have a virtual authenticator).
 */
export async function setupAdmin(t: TestApp, username = 'admin') {
  await t.json('POST', '/api/setup/begin', { token: t.gate.token, username });
  await t.json('PUT', '/api/account/password', { password: PASSWORD });
  const { secret } = await t.json<{ secret: string }>('POST', '/api/account/totp/setup');
  await t.json('POST', '/api/account/totp/confirm', { code: await totpNow(secret, t) });
  const { recoveryCodes } = await t.json<{ recoveryCodes: string[] }>('POST', '/api/setup/finish');
  // The confirm step consumed the current time step.
  t.advance(30_000);
  return { secret, recoveryCodes };
}

export interface WsClient {
  messages: ServerMessage[];
  send(msg: ClientMessage): void;
  /** Resolves with the first message matching `pred` (also one already received). */
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  /** Everything the terminal printed so far, snapshot included. */
  text(): string;
  closed: Promise<number>;
  close(): void;
}

export async function openTerminal(t: TestApp, sessionId: string, opts: { origin?: string; cookie?: string | null; watch?: boolean } = {}): Promise<WsClient> {
  // A real socket on a real port: in-process injection does not deliver a
  // client-side close to the server, and closing is what these tests are about.
  if (!t.app.server.listening) await t.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = t.app.server.address() as AddressInfo;
  // `watch`: as someone the session is shared with (F3).
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${opts.watch ? 'shared' : 'sessions'}/${sessionId}/ws`, {
    headers: { origin: opts.origin ?? ORIGIN, ...(opts.cookie !== null ? { cookie: opts.cookie ?? t.cookie ?? '' } : {}) },
  });
  const messages: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  // Only now wait for open: the snapshot can arrive in the same chunk as the
  // upgrade response, and a listener added after 'open' would miss it.
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
  const text = () =>
    messages.map((m) => (m.t === 'snapshot' ? m.data : m.t === 'output' ? m.d : '')).join('');
  return {
    messages,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 10_000) {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout; got: ${text().slice(-500)}`)), timeoutMs);
        waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    text,
    closed,
    close: () => ws.close(),
  } as WsClient;
}

/** Wait until the terminal output contains `needle`. */
export async function waitForText(c: WsClient, needle: string | RegExp, timeoutMs = 10_000): Promise<void> {
  const hit = () => (typeof needle === 'string' ? c.text().includes(needle) : needle.test(c.text()));
  const until = Date.now() + timeoutMs;
  while (!hit()) {
    if (Date.now() > until) throw new Error(`"${needle}" not seen; got: ${JSON.stringify(c.text().slice(-400))}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
