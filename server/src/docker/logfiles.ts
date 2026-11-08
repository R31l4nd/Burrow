import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CONTAINER_NAME, LOG_FILE_PATH, validLogSource, type LogFile } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { logFiles } from '../db/schema.js';
import type { SftpPool } from '../files/pool.js';
import { getHost } from '../hosts/service.js';
import { actor, HttpError, idParam, parse } from '../http.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';

// The log files that go with a container (or a host, and the host's units'
// journals): kept here so the log
// view, the analysis, the alert rules and the reports read them beside the
// container's own output. Suggestions come from the container's mounts (on
// the host's side) and its /var/log.

const MAX_SUGGESTIONS = 50;

// An absolute path without ".." in it, or (the host's own) a unit's journal ("journal:nginx.service").
const fileInput = z
  .object({ container: z.union([z.literal(''), z.string().regex(CONTAINER_NAME)]), path: z.string().max(1100) })
  .refine((b) => validLogSource(b.container, b.path), { message: 'A log file is an absolute path without ".." in it, or journal:<unit> for the host itself.' });

export function logFilesOf(ctx: Ctx, hostId: number, container?: string): LogFile[] {
  const where = container === undefined ? eq(logFiles.hostId, hostId) : and(eq(logFiles.hostId, hostId), eq(logFiles.container, container));
  return ctx.db
    .select()
    .from(logFiles)
    .where(where)
    .orderBy(logFiles.path)
    .all()
    .map((r) => ({ id: r.id, hostId: r.hostId, container: r.container, path: r.path }));
}

/** One of a container's mounts, as docker inspect gives it. */
interface Mount {
  Source?: string;
  Destination?: string;
}

export function registerLogFileRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool): void {
  app.get('/api/docker/:hostId/logfiles', { config: { auth: 'user' } }, async (req) => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    const { container } = parse(z.object({ container: z.union([z.literal(''), z.string().regex(CONTAINER_NAME)]).optional() }), req.query);
    return logFilesOf(ctx, hostId, container);
  });

  app.post('/api/docker/:hostId/logfiles', { config: { auth: 'admin' } }, async (req) => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    const body = parse(fileInput, req.body);
    const exists = ctx.db
      .select()
      .from(logFiles)
      .where(and(eq(logFiles.hostId, hostId), eq(logFiles.container, body.container), eq(logFiles.path, body.path)))
      .get();
    if (exists) throw new HttpError(409, 'exists', 'That log file is there already.');
    const row = ctx.db.insert(logFiles).values({ hostId, container: body.container, path: body.path, createdAt: ctx.now() }).returning().get();
    audit(ctx, actor(req), 'logfile.add', `${hostId}:${body.container}:${body.path}`);
    return { id: row.id, hostId, container: row.container, path: row.path } satisfies LogFile;
  });

  app.delete('/api/docker/:hostId/logfiles/:id', { config: { auth: 'admin' } }, async (req) => {
    const hostId = idParam(req, 'hostId');
    const id = idParam(req, 'id');
    const row = ctx.db
      .select()
      .from(logFiles)
      .where(and(eq(logFiles.id, id), eq(logFiles.hostId, hostId)))
      .get();
    if (!row) throw new HttpError(404, 'not_found');
    ctx.db.delete(logFiles).where(eq(logFiles.id, id)).run();
    audit(ctx, actor(req), 'logfile.remove', `${hostId}:${row.container}:${row.path}`);
    return { ok: true };
  });

  // Files that look like logs: *.log under the container's mounts (found on
  // the host's side, named as the container sees them) and in its /var/log.
  app.get('/api/docker/:hostId/containers/:name/logfile-suggestions', { config: { auth: 'admin' } }, async (req) => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    const name = String((req.params as { name: string }).name);
    if (!CONTAINER_NAME.test(name)) throw new HttpError(400, 'invalid_container');
    return pool.with(hostId, async ({ client }) => {
      const r = await exec(client, `docker inspect --format '{{json .Mounts}} {{.State.Running}}' -- ${name}`, 15_000, 1 << 20);
      if (r.code !== 0) throw new HttpError(404, 'not_found', (r.stderr || r.stdout).trim().split('\n').pop() || 'No such container.');
      const sp = r.stdout.trim().lastIndexOf(' ');
      let mounts: Mount[];
      try {
        mounts = JSON.parse(r.stdout.trim().slice(0, sp)) as Mount[];
      } catch {
        mounts = [];
      }
      const running = r.stdout.trim().slice(sp + 1) === 'true';
      const found = new Set<string>();
      for (const m of mounts.filter((x) => x.Source && x.Destination).slice(0, 20)) {
        const find = (dir: string) => `find ${shellQuote(dir)} -maxdepth 3 -type f -name '*.log' 2>/dev/null | head -n ${MAX_SUGGESTIONS}`;
        const list = await exec(client, `[ -r ${shellQuote(m.Source!)} ] && ${find(m.Source!)}`, 15_000, 1 << 20).catch(() => null);
        if (list?.code === 0) {
          for (const f of list.stdout.split('\n').filter(Boolean)) {
            const inContainer = m.Destination!.replace(/\/+$/, '') + f.slice(m.Source!.replace(/\/+$/, '').length);
            if (LOG_FILE_PATH.test(inContainer)) found.add(inContainer);
          }
        } else if (running && LOG_FILE_PATH.test(m.Destination!)) {
          // The host's side is not this user's to read (a Docker volume): looked for inside, where it is read too (AUDIT2 DO-18).
          const inside = await exec(client, `docker exec -- ${name} sh -c ${shellQuote(find(m.Destination!))}`, 15_000, 1 << 20).catch(() => null);
          for (const f of (inside?.stdout ?? '').split('\n').filter(Boolean)) if (LOG_FILE_PATH.test(f)) found.add(f);
        }
      }
      if (running) {
        // Files only: not a link to the container's own output (nginx's error.log is /dev/stderr), report 71d6c5.
        const inside = await exec(
          client,
          `docker exec -- ${name} sh -c 'for f in /var/log/*.log /var/log/*/*.log; do [ -f "$f" ] || continue; case "$(readlink -f -- "$f" 2>/dev/null)" in /dev/*|/proc/*) continue;; esac; echo "$f"; done 2>/dev/null | head -n ${MAX_SUGGESTIONS}'`,
          15_000,
          1 << 20,
        ).catch(() => null);
        for (const f of (inside?.stdout ?? '').split('\n').filter(Boolean)) if (LOG_FILE_PATH.test(f)) found.add(f);
      }
      const known = new Set(logFilesOf(ctx, hostId, name).map((f) => f.path));
      return [...found].filter((f) => !known.has(f)).sort().slice(0, MAX_SUGGESTIONS);
    });
  });
}
