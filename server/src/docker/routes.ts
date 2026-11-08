import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { CONTAINER_NAME, dockerClientMessage, parseTarget, type ContainerSample, type DockerServerMessage, type LogServerMessage, type LogTarget } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { getHost } from '../hosts/service.js';
import type { SftpPool } from '../files/pool.js';
import { boundedSender, HttpError, idParam, parse, requireAuth } from '../http.js';
import { exec } from '../ssh/connect.js';
import { logFilesOf } from './logfiles.js';
import { LogStream, MAX_TARGETS, SINCE_START, TIME_ARG } from './logs.js';
import type { ContainerHistory } from './history.js';
import type { DockerMonitor } from './monitor.js';

const HISTORY_RANGES = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;

// Two sockets: the container overview (hosts to watch in, snapshots with
// stats out) and a log view (targets and a time range in the URL, lines
// out). Both close when the login session is revoked.

const HEARTBEAT_MS = 30_000;

/**
 * The live sockets of each login session: closed when it signs out or is
 * revoked, and (sweep) when it expired or its user may no longer use them
 * (an editor's language server is for admins).
 */
export class SessionSockets {
  readonly #bySession = new Map<string, Map<WebSocket, { admin: boolean }>>();
  add(idHash: string, s: WebSocket, opts: { admin?: boolean } = {}): () => void {
    let set = this.#bySession.get(idHash);
    if (!set) this.#bySession.set(idHash, (set = new Map()));
    set.set(s, { admin: opts.admin ?? false });
    return () => set.delete(s);
  }
  drop(idHash: string): void {
    for (const s of this.#bySession.get(idHash)?.keys() ?? []) s.close(4401, 'signed out');
    this.#bySession.delete(idHash);
  }
  /** `valid`: the sessions that still hold, with their user's role. */
  sweep(valid: Map<string, string>): void {
    for (const [idHash, set] of this.#bySession) {
      const role = valid.get(idHash);
      if (!role) {
        this.drop(idHash);
        continue;
      }
      for (const [s, o] of set) {
        if (!o.admin || role === 'admin') continue;
        s.close(4403, 'not allowed');
        set.delete(s);
      }
    }
  }
}

function heartbeat(socket: WebSocket): () => void {
  let alive = true;
  socket.on('pong', () => (alive = true));
  const beat = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, HEARTBEAT_MS);
  return () => clearInterval(beat);
}

const logQuery = z.object({
  // "12:radarr,14:sonarr", log files with their path URL-encoded
  t: z.string().max(12_000),
  // "start": each source since its own last start (report c8d284).
  since: z.union([z.string().regex(TIME_ARG), z.literal(SINCE_START)]).optional(),
  until: z.string().regex(TIME_ARG).optional(),
  // 5001: one more than a log view keeps of a source, so it knows when there were more (decision 3).
  tail: z.coerce.number().int().min(0).max(5001).default(500),
  follow: z.enum(['0', '1']).default('1'),
});

export function parseTargets(t: string): LogTarget[] {
  const targets = t
    .split(',')
    .filter(Boolean)
    .map((part) => {
      // A container ("1:web") or a log file ("1:web:%2Fapp%2Fa.log", "1::%2Fvar%2Flog%2Fsyslog").
      const target = parseTarget(part);
      if (!target) throw new HttpError(400, 'invalid_target', `Not a container or log file: ${part}`);
      return target;
    });
  if (!targets.length || targets.length > MAX_TARGETS) throw new HttpError(400, 'invalid_target', `Between 1 and ${MAX_TARGETS} containers.`);
  return targets;
}

export function registerDockerRoutes(app: FastifyInstance, ctx: Ctx, monitor: DockerMonitor, sockets: SessionSockets, pool: SftpPool, history: ContainerHistory): void {
  /** One look at a host's containers (for pickers; the overview uses the socket). */
  app.get('/api/docker/:hostId/containers', { config: { auth: 'user' } }, async (req) => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    return monitor.poll(hostId);
  });

  /** A container's kept CPU and memory over a day, a week or a month (report 428102). */
  app.get('/api/docker/:hostId/containers/:name/history', { config: { auth: 'user' } }, async (req): Promise<ContainerSample[]> => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    const { name } = parse(z.object({ name: z.string().regex(CONTAINER_NAME) }), req.params);
    const { range } = parse(z.object({ range: z.enum(['day', 'week', 'month']).default('day') }), req.query);
    return history.history(hostId, name, HISTORY_RANGES[range]);
  });

  /**
   * `nginx -t` inside a container (SWAG, nginx): checks the configuration
   * as that nginx sees it, including a file just saved into its bind mount.
   */
  app.post('/api/docker/:hostId/nginx-test', async (req) => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    const { container } = parse(z.object({ container: z.string().regex(CONTAINER_NAME) }), req.body);
    const r = await pool.with(hostId, ({ client }) => exec(client, `docker exec -- ${container} nginx -t`, 30_000));
    return { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() };
  });

  app.get('/api/docker/ws', { websocket: true, config: { auth: 'user' } }, (socket: WebSocket, req) => {
    const a = requireAuth(req);
    const untrack = sockets.add(a.session.idHash, socket);
    const stopBeat = heartbeat(socket);
    const watching = new Map<number, () => void>();
    const send = boundedSender<DockerServerMessage>(socket);
    // A host added or changed on another device: this page reads the list again (W-FUNC-09).
    const offHosts = monitor.onHostsChanged(() => send({ t: 'hosts-changed' }));

    socket.on('message', (raw) => {
      let m: unknown;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      // Valid JSON need not be an object: "null" here ended the server (null.t).
      const w = dockerClientMessage.safeParse(m);
      if (!w.success) return;
      const want = new Set(w.data.hostIds.slice(0, 50));
      for (const [id, stop] of watching) {
        if (want.has(id)) continue;
        stop();
        watching.delete(id);
      }
      for (const id of want) {
        if (watching.has(id)) continue;
        try {
          getHost(ctx, id);
        } catch {
          continue;
        }
        // The whole snapshot first, then only what changed (decision 19, OPS-W-03).
        watching.set(id, monitor.watch(id, (host, d) => send(d ? { t: 'delta', d } : { t: 'host', host })));
      }
      send({ t: 'hosts', hostIds: [...watching.keys()] });
    });
    socket.on('close', () => {
      stopBeat();
      untrack();
      offHosts();
      for (const stop of watching.values()) stop();
    });
  });

  app.get('/api/docker/logs/ws', { websocket: true, config: { auth: 'user' } }, (socket: WebSocket, req) => {
    const a = requireAuth(req);
    const send = boundedSender<LogServerMessage>(socket);
    let q;
    let targets: LogTarget[];
    try {
      q = parse(logQuery, req.query);
      targets = parseTargets(q.t);
      for (const t of targets) getHost(ctx, t.hostId);
      // A file or a journal an admin did not set up as a log source is an
      // admin's to read: an operator's tail inside a container ran as the
      // container's user (/proc/1/environ, secrets), beyond anything else an
      // operator may see (AUDIT2 AUTH-10).
      if (a.user.role !== 'admin') {
        for (const t of targets) {
          if (t.file && !logFilesOf(ctx, t.hostId, t.container).some((f) => f.path === t.file)) throw new HttpError(403, 'not_a_log_source', `${t.file} is not a log source here; an admin can add it.`);
        }
      }
    } catch (err) {
      send({ t: 'error', i: -1, message: (err as Error).message });
      socket.close(4000, 'bad request');
      return;
    }
    const untrack = sockets.add(a.session.idHash, socket);
    const stopBeat = heartbeat(socket);
    const stream = new LogStream(ctx, targets, { since: q.since ?? null, until: q.until ?? null, tail: q.tail, follow: q.follow === '1' }, send);
    void stream.start();
    socket.on('close', () => {
      stopBeat();
      untrack();
      stream.close();
    });
  });
}
