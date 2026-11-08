import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, requireAuth } from '../http.js';
import type { SessionSockets } from '../docker/routes.js';
import { Decoder, encode, MAX_MESSAGE } from './framing.js';
import { configFor, serverFor, toolEnv, type LanguageId, type ServerDef } from './servers.js';

// WebSocket <-> language server. One process per open editor (identified by
// a client-chosen id), so a phone that reconnects finds its server again.
// After the last socket closes, the process lives on for IDLE_MS, then stops.
//
// The bridge answers the server's configuration requests itself, from
// servers.ts: the browser does not need to know how each server is set up.

const IDLE_MS = 10 * 60_000;
const MAX_PROCESSES_PER_USER = 12;

interface Proc {
  key: string;
  userId: number;
  lang: LanguageId;
  def: ServerDef;
  child: ChildProcess;
  socket: WebSocket | null;
  idleTimer: NodeJS.Timeout | null;
  // Messages from the server while no socket is attached are dropped: the
  // editor re-sends its state when it reconnects.
  initialized: boolean;
  // The id of the editor's initialize request and the server's answer, which
  // is replayed to an editor that reconnects.
  pendingInit?: unknown;
  lastInit?: unknown;
}

const LANGS = ['yaml', 'shellscript', 'dockerfile', 'json', 'toml', 'python'] as const;

/**
 * A message from the editor for the language server, or null when it is not
 * one to pass on: not a JSON object ("null" ended the server), or settings.
 * The settings are the server's own (sent after initialized): a browser's
 * could turn on what Burrow keeps off (bash's background glob analysis).
 */
export function clientMessage(raw: string): { id?: unknown; method?: string } | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const msg = m as { id?: unknown; method?: unknown };
  if (msg.method !== undefined && typeof msg.method !== 'string') return null;
  if (msg.method === 'workspace/didChangeConfiguration') return null;
  return msg as { id?: unknown; method?: string };
}

/**
 * The editor's initialize as it goes to the server: with the server's own
 * initialization options, never the browser's (they reached the server raw,
 * past the settings boundary, AUDIT2 FS-25).
 */
export function serverInitialize(raw: string, options: unknown): string {
  const m = JSON.parse(raw) as { params?: Record<string, unknown> };
  const params = { ...(m.params ?? {}) };
  delete params.initializationOptions;
  if (options !== undefined) params.initializationOptions = options;
  return JSON.stringify({ ...m, params });
}

export class LspBridge {
  readonly #procs = new Map<string, Proc>();

  constructor(private readonly ctx: Ctx) {}

  available(): Record<LanguageId, boolean> {
    return Object.fromEntries(LANGS.map((l) => [l, serverFor(l) !== null])) as Record<LanguageId, boolean>;
  }

  #start(userId: number, lang: LanguageId, key: string): Proc {
    const def = serverFor(lang);
    if (!def) throw new HttpError(404, 'no_language_server', `No language server for ${lang} in this installation.`);
    const mine = [...this.#procs.values()].filter((p) => p.userId === userId);
    if (mine.length >= MAX_PROCESSES_PER_USER) {
      // Oldest idle one goes first.
      const idle = mine.find((p) => !p.socket);
      if (idle) this.#stop(idle);
      else throw new HttpError(429, 'too_many_editors', 'Close an editor first.');
    }
    const child = spawn(def.command, def.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: toolEnv(def.env),
    });
    const proc: Proc = { key, userId, lang, def, child, socket: null, idleTimer: null, initialized: false };
    // Without a listener, a write to a server that already died would throw.
    child.stdin!.on('error', () => {});
    const decoder = new Decoder();
    child.stdout!.on('data', (chunk: Buffer) => {
      let msgs: string[];
      try {
        msgs = decoder.push(chunk);
      } catch (err) {
        // Past the framing limits: stopped, not held in memory (AUDIT2 FS-20).
        this.ctx.log.warn({ lang, err: (err as Error).message }, 'language server stopped');
        return this.#stop(proc);
      }
      for (const msg of msgs) this.#fromServer(proc, msg);
    });
    // Servers log to stderr; keep it out of Burrow's log unless debugging.
    child.stderr!.on('data', (d: Buffer) => this.ctx.log.debug({ lang, out: d.toString('utf8').slice(0, 500) }, 'language server'));
    child.on('exit', (code) => {
      if (this.#procs.get(key) === proc) this.#procs.delete(key);
      proc.socket?.close(1011, 'language server exited');
      this.ctx.log.info({ lang, code }, 'language server exited');
    });
    child.on('error', (err) => this.ctx.log.warn({ err, lang }, 'language server failed to start'));
    this.#procs.set(key, proc);
    return proc;
  }

  #fromServer(proc: Proc, raw: string): void {
    let msg: { id?: number | string; method?: string; result?: unknown; params?: { items?: { section?: string }[] } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    // Requests the bridge answers itself.
    if (msg.method === 'workspace/configuration' && msg.id !== undefined) {
      const result = (Array.isArray(msg.params?.items) ? msg.params.items : []).map((i) => configFor(proc.def, i?.section));
      proc.child.stdin!.write(encode(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })));
      return;
    }
    if ((msg.method === 'client/registerCapability' || msg.method === 'window/workDoneProgress/create') && msg.id !== undefined) {
      proc.child.stdin!.write(encode(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })));
      return;
    }
    if (msg.id !== undefined && msg.id === proc.pendingInit && 'result' in msg) proc.lastInit = msg.result;
    if (proc.socket && proc.socket.readyState === proc.socket.OPEN) proc.socket.send(raw);
  }

  #toServer(proc: Proc, raw: string): void {
    // Too large, or a server that does not take in what it is sent: stopped,
    // not queued without end (AUDIT2 FS-20).
    if (raw.length > MAX_MESSAGE || (proc.child.stdin?.writableLength ?? 0) > MAX_MESSAGE) return this.#stop(proc);
    const msg = clientMessage(raw);
    if (!msg) return;
    // A reconnecting editor initializes again; the server was initialized
    // before and must not see it twice. Answer from memory instead.
    if (msg.method === 'initialize' && proc.initialized) {
      proc.socket?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: proc.lastInit }));
      return;
    }
    if (msg.method === 'initialized' && proc.initialized) return;
    if (msg.method === 'initialize') proc.pendingInit = msg.id;
    proc.child.stdin!.write(encode(msg.method === 'initialize' ? serverInitialize(raw, proc.def.initializationOptions) : raw));
    if (msg.method === 'initialized') {
      proc.initialized = true;
      proc.child.stdin!.write(encode(JSON.stringify({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: proc.def.settings } })));
    }
  }

  #stop(proc: Proc): void {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    // Only while it is still this one: an old process's late stop removed its replacement (AUDIT2 FS-19).
    if (this.#procs.get(proc.key) === proc) this.#procs.delete(proc.key);
    proc.socket?.close(1000, 'stopped');
    proc.child.kill();
  }

  attach(userId: number, lang: LanguageId, editorId: string, socket: WebSocket): void {
    const key = `${userId}:${lang}:${editorId}`;
    let proc = this.#procs.get(key);
    if (proc?.child.exitCode !== null && proc?.child.exitCode !== undefined) {
      // Ended by itself: its idle timer goes with it, not later to stop the new one.
      if (proc.idleTimer) clearTimeout(proc.idleTimer);
      proc = undefined;
    }
    proc ??= this.#start(userId, lang, key);
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = null;
    // A second tab with the same id takes over.
    proc.socket?.close(4000, 'replaced');
    proc.socket = socket;
    const p = proc;
    socket.on('message', (raw) => this.#toServer(p, String(raw)));
    socket.on('close', () => {
      if (p.socket !== socket) return;
      p.socket = null;
      p.idleTimer = setTimeout(() => this.#stop(p), IDLE_MS);
      p.idleTimer.unref();
    });
  }

  stopAll(): void {
    for (const p of [...this.#procs.values()]) this.#stop(p);
  }

  /** For tests. */
  count(): number {
    return this.#procs.size;
  }
}

export function registerLspRoutes(app: FastifyInstance, bridge: LspBridge, sockets: SessionSockets): void {
  app.get('/api/lsp', async () => bridge.available());

  app.get('/api/lsp/:lang/ws', { websocket: true }, (socket: WebSocket, req) => {
    const a = requireAuth(req);
    const lang = z.enum(LANGS).safeParse((req.params as { lang: string }).lang);
    const q = z.object({ editor: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).safeParse(req.query);
    if (!lang.success || !q.success) return socket.close(4400, 'bad request');
    try {
      bridge.attach(a.user.id, lang.data, q.data.editor, socket);
      // Closed with its login session (signed out, revoked, expired) or when its user is no longer an admin.
      const untrack = sockets.add(a.session.idHash, socket, { admin: true });
      socket.on('close', untrack);
    } catch (err) {
      socket.close(4404, err instanceof HttpError ? err.message.slice(0, 100) : 'unavailable');
    }
  });
}

