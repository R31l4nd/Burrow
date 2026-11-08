import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  CONTAINER_ACTIONS,
  CONTAINER_NAME,
  createSessionInput,
  STACK_PROJECT,
  stackOpInput,
  stackSettingsInput,
  updateSettingsInput,
  type Activity,
  type ComposeCheck,
  type ContainerAction,
  type OpServerMessage,
  type UpdatesOverview,
} from '@burrow/shared';
import { audit } from '../audit.js';
import { sha256 } from '../crypto.js';
import type { Ctx } from '../context.js';
import type { FileAccessGuard } from '../files/access.js';
import type { SftpPool } from '../files/pool.js';
import { getHost } from '../hosts/service.js';
import { actor, boundedSender, HttpError, idParam, parse, requireAuth } from '../http.js';
import { exec, type ExecResult } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { Updater } from './autoupdate.js';
import { releaseImage } from './changelog.js';
import type { DockerMonitor } from './monitor.js';
import { composeArgs, opScript, prelude, type OpRunner, type StackTarget } from './ops.js';
import type { SessionSockets } from './routes.js';
import { parseCron } from '../reports/schedule.js';
import { downStacks, readStack, readStackOrDown, rememberDown, saveStackRow, stackHistory, stackInfo, isSelf } from './stacks.js';
import { getUpdateSettings, getUpdateState, nextWindow, setUpdateSettings, setUpdateState, validTimeZone, type UpdateChecker } from './updates.js';

// Phase 8: changing containers and stacks. Every change needs a fresh
// step-up and is audited; the docker CLI runs over SSH as the host's user.

/** A container's shell: bash when it has one. */

/**
 * A `docker compose config` run as a review: valid, and its digest. The
 * configuration itself stays here (it can hold interpolated secrets);
 * warnings are shown. Cut off at the size limit it is no review: its
 * digest was of the first part only, and a change past it went unseen
 * (AUDIT2 DO-13).
 */
export function composeCheckOf(r: ExecResult): ComposeCheck {
  if (r.truncated) return { ok: false, output: 'The compose configuration is larger than Burrow reads (4 MB): it cannot be reviewed.', digest: null };
  const ok = r.code === 0 && r.stdout.trim() !== '';
  return ok ? { ok, output: r.stderr.trim(), digest: sha256(r.stdout) } : { ok, output: `${r.stdout}${r.stderr}`.trim(), digest: null };
}

/** The services' configuration hashes as compose has them now (H) and as their containers run (R), one per line. */
export function driftScript(t: StackTarget): string {
  return [
    prelude(t),
    `dc ${composeArgs(t)} config --hash '*' 2>/dev/null | sed 's/^/H /'`,
    `docker ps -a --filter ${shellQuote(`label=com.docker.compose.project=${t.project}`)} --format '{{.Label "com.docker.compose.service"}} {{.Label "com.docker.compose.config-hash"}} {{.Label "com.docker.compose.oneoff"}}' | sed 's/^/R /'`,
  ].join('\n');
}

/**
 * Which services a deploy would recreate, by compose's own hashes: the file
 * may say nothing changed since Burrow's last deploy while what runs was
 * started from another file (W-FUNC-04). Undefined when the hashes cannot be read.
 */
export function driftOf(out: string): ComposeCheck['recreate'] {
  const want = new Map<string, string>();
  const runs = new Map<string, Set<string>>();
  for (const line of out.split('\n')) {
    const m = /^([HR]) (\S+) (\S*)(?: (\S+))?$/.exec(line.trim());
    // Left by `compose run`: no replica of the service.
    if (!m || m[4] === 'True') continue;
    if (m[1] === 'H') want.set(m[2]!, m[3]!);
    else runs.set(m[2]!, (runs.get(m[2]!) ?? new Set()).add(m[3]!));
  }
  if (!want.size) return undefined;
  const out2: NonNullable<ComposeCheck['recreate']> = [];
  for (const [service, hash] of want) {
    const r = runs.get(service);
    if (!r) out2.push({ service, why: 'missing' });
    else if (!r.has(hash) || r.size > 1) out2.push({ service, why: 'differs' });
  }
  return out2;
}

export const shellCommand = (name: string) => `docker exec -it ${name} sh -c ${shellQuote('if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi')}`;

export function registerManageRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  deps: { monitor: DockerMonitor; pool: SftpPool; runner: OpRunner; checker: UpdateChecker; updater: Updater; terminals: TerminalManager; sockets: SessionSockets; access: FileAccessGuard },
): void {
  const { monitor, pool, runner, checker, updater, terminals, sockets, access } = deps;

  const containerParams = (req: { params: unknown }) => {
    const p = req.params as { hostId: string; name: string };
    const hostId = idParam(req as never, 'hostId');
    if (!CONTAINER_NAME.test(p.name)) throw new HttpError(400, 'invalid_container');
    return { hostId, name: p.name, host: getHost(ctx, hostId) };
  };
  const stackParams = (req: { params: unknown }) => {
    const p = req.params as { hostId: string; project: string };
    const hostId = idParam(req as never, 'hostId');
    if (!STACK_PROJECT.test(p.project)) throw new HttpError(400, 'invalid_stack');
    return { hostId, project: p.project, host: getHost(ctx, hostId) };
  };

  // ---- containers

  app.post('/api/docker/:hostId/containers/:name/action', { config: { stepUp: true } }, async (req) => {
    const { hostId, name, host } = containerParams(req);
    const { action } = parse(z.object({ action: z.enum(CONTAINER_ACTIONS as [ContainerAction, ...ContainerAction[]]) }), req.body);
    // What is on screen is known from a moment ago; a fresh look (without
    // docker stats, which takes seconds on a busy host) only when it is not there.
    const find = async (fresh: boolean) => (fresh ? await monitor.poll(hostId, false) : await monitor.recent(hostId, 60_000, false)).containers.find((x) => x.name === name);
    const c = (await find(false)) ?? (await find(true));
    if (!c) throw new HttpError(404, 'container_not_found');
    if (isSelf([c]) && action !== 'restart') throw new HttpError(409, 'self', 'This is the container Burrow runs in.');
    const cmd = action === 'remove' ? `docker rm -f -- ${name}` : `docker ${action} -- ${name}`;
    const r = await pool.with(hostId, ({ client }) => exec(client, cmd, 120_000));
    const ok = r.code === 0;
    audit(ctx, actor(req), ok ? `container.${action}` : `container.${action}_failed`, `${host.name}/${name}`);
    if (!ok) throw new HttpError(502, 'docker_error', (r.stderr || r.stdout).trim() || `docker exited with ${r.code}`);
    return { ok };
  });

  // Inspect shows environment variables, which often hold passwords: step-up.
  app.post('/api/docker/:hostId/containers/:name/inspect', { config: { stepUp: true } }, async (req) => {
    const { hostId, name, host } = containerParams(req);
    const r = await pool.with(hostId, ({ client }) => exec(client, `docker inspect -- ${name}`, 30_000, 4 << 20));
    if (r.code !== 0) throw new HttpError(404, 'container_not_found', r.stderr.trim());
    audit(ctx, actor(req), 'container.inspect', `${host.name}/${name}`);
    return { json: r.stdout };
  });

  app.post('/api/docker/:hostId/containers/:name/shell', { config: { stepUp: true } }, async (req) => {
    const a = requireAuth(req);
    const { hostId, name } = containerParams(req);
    const size = parse(createSessionInput.pick({ cols: true, rows: true }), req.body ?? {});
    return terminals.create({ ...actor(req), userId: a.user.id }, hostId, size.cols, size.rows, undefined, { command: shellCommand(name), title: name });
  });

  // ---- stacks

  app.get('/api/docker/:hostId/stacks/:project', { config: { auth: 'user' } }, async (req) => {
    const { hostId, project } = stackParams(req);
    const info = stackInfo(ctx, runner, await readStackOrDown(ctx, monitor, hostId, project));
    // The compose file as last deployed is a file's content: an operator's only from a folder they may open (A3-SRV-01).
    return info.deployed && !access.shown(req, hostId, info.deployed.file) ? { ...info, deployed: null } : info;
  });

  app.get('/api/docker/:hostId/stacks/:project/history', { config: { auth: 'user' } }, async (req) => {
    const { hostId, project } = stackParams(req);
    return stackHistory(ctx, hostId, project);
  });

  app.put('/api/docker/:hostId/stacks/:project/settings', { config: { stepUp: true } }, async (req) => {
    const { hostId, project, host } = stackParams(req);
    const body = parse(stackSettingsInput, req.body);
    const s = await readStackOrDown(ctx, monitor, hostId, project);
    if (body.autoUpdate && isSelf(s.containers)) throw new HttpError(409, 'self', 'Burrow cannot update its own stack automatically.');
    saveStackRow(ctx, hostId, project, { autoUpdate: body.autoUpdate });
    audit(ctx, actor(req), 'stack.settings', `${host.name}/${project}`, body);
    return stackInfo(ctx, runner, s);
  });

  /**
   * What holds this stack's automatic update: the newer images' releases with
   * a breaking change, and whether a person released them after reading.
   */
  app.get('/api/docker/:hostId/stacks/:project/hold', { config: { auth: 'user' } }, async (req) => {
    const { hostId, project } = stackParams(req);
    const held = await updater.breakingIn(hostId, (await readStackOrDown(ctx, monitor, hostId, project)).containers);
    return { held, released: held.length > 0 && updater.isReleased(hostId, project, held) };
  });

  /** Read: these releases may update by themselves (a later breaking one holds again). */
  app.post('/api/docker/:hostId/stacks/:project/hold/release', { config: { stepUp: true } }, async (req) => {
    const { hostId, project, host } = stackParams(req);
    const { held } = parse(z.object({ held: z.array(z.string().max(600)).min(1).max(100) }), req.body);
    updater.release(hostId, project, held);
    audit(ctx, actor(req), 'stack.release', `${host.name}/${project}`, { held });
    return { held, released: true };
  });

  // "Update anyway" without readable release notes: asked once per stack, not at every update (decision 9).
  // A breaking change in notes that can be read is always asked.
  const waivedKey = (hostId: number, project: string) => `${hostId} ${project}`;
  app.get('/api/docker/:hostId/stacks/:project/notes', { config: { auth: 'user' } }, async (req) => {
    const { hostId, project } = stackParams(req);
    return { waived: (getUpdateState(ctx).notesWaived ?? []).includes(waivedKey(hostId, project)) };
  });

  app.post('/api/docker/:hostId/stacks/:project/notes/waive', async (req) => {
    const { hostId, project, host } = stackParams(req);
    const key = waivedKey(hostId, project);
    const rest = (getUpdateState(ctx).notesWaived ?? []).filter((k) => k !== key);
    setUpdateState(ctx, { notesWaived: [...rest, key].slice(-500) });
    audit(ctx, actor(req), 'stack.notes_waived', `${host.name}/${project}`);
    return { waived: true };
  });

  /** `docker compose config` on the stack as it is now: valid, and what exactly (the digest). */
  async function composeConfig(hostId: number, target: StackTarget): Promise<ComposeCheck> {
    const cmd = `${prelude(target)}\ndc ${composeArgs(target)} config`;
    return composeCheckOf(await pool.with(hostId, ({ client }) => exec(client, cmd, 60_000, 4 << 20)));
  }

  /** Is the compose file (as saved) valid, and what would a deploy recreate? */
  app.post('/api/docker/:hostId/stacks/:project/check', async (req): Promise<ComposeCheck> => {
    const { hostId, project } = stackParams(req);
    const { target } = await readStackOrDown(ctx, monitor, hostId, project);
    const check = await composeConfig(hostId, target);
    if (!check.ok) return check;
    const drift = await pool.with(hostId, ({ client }) => exec(client, driftScript(target), 60_000)).then((r) => driftOf(r.stdout), () => undefined);
    return drift ? { ...check, recreate: drift } : check;
  });

  app.post('/api/docker/:hostId/stacks/:project/ops', { config: { stepUp: true } }, async (req) => {
    const { hostId, project, host } = stackParams(req);
    // A deploy from the review: `reviewed` is the check's digest of what was shown.
    const body = parse(stackOpInput.extend({ deployFile: z.string().max(4096).optional(), reviewed: z.string().regex(/^[0-9a-f]{64}$/).optional() }), req.body);
    const who = actor(req);
    if (body.op === 'update') {
      const op = await updater.update(who, hostId, project, false, body.services);
      return op.info;
    }
    // Brought down from Burrow: up from its kept files; nothing else runs on a stack that is down.
    const stack = body.op === 'up' ? await readStackOrDown(ctx, monitor, hostId, project) : await readStack(monitor, hostId, project);
    const { target } = stack;
    if (body.deployFile && !target.configFiles.includes(body.deployFile)) throw new HttpError(400, 'not_stack_file', 'That file is not one of this stack.');
    let deployed: string | null = null;
    const extra: Record<string, string> = {};
    if (body.deployFile) {
      if (body.op !== 'up' || !body.reviewed) throw new HttpError(400, 'not_reviewed', 'A deploy of a compose file needs its review.');
      // Changed since the review (an editor, another person, a .env): not what was approved.
      if ((await composeConfig(hostId, target)).digest !== body.reviewed) throw new HttpError(409, 'review_stale', 'The compose files changed since the review. Review again.');
      // What compose reads (the file, its other files, the .env), kept to put back after a deploy that does not run well.
      // One that is there but could not be read whole: not deployed, as there would be nothing to put back (audit 2026-10-30).
      const keep = async (f: string): Promise<string | null> => {
        const e = await pool.with(hostId, ({ client }) => exec(client, `if [ -e ${shellQuote(f)} ]; then cat -- ${shellQuote(f)}; else exit 3; fi`, 20_000, 2 << 20)).catch(() => null);
        if (e?.code === 3) return null;
        if (!e || e.code !== 0 || e.truncated) throw new HttpError(502, 'not_kept', `Could not keep a copy of ${f} to put back if the deploy does not run well. Nothing was deployed.`);
        return e.stdout;
      };
      deployed = await keep(body.deployFile);
      for (const f of [...target.configFiles.filter((x) => x !== body.deployFile), ...(target.workingDir ? [`${target.workingDir.replace(/\/+$/, '')}/.env`] : [])]) {
        const kept = await keep(f);
        if (kept !== null) extra[f] = kept;
      }
    }
    audit(ctx, who, `stack.${body.op}`, `${host.name}/${project}`, body.services ? { services: body.services } : undefined);
    // A deploy is watched like an update, and the previous deployment put back when it does not run well (decision 11).
    if (body.op === 'up') {
      const op = updater.deploy(who, stack, { ...(body.services ? { services: body.services } : {}), ...(body.deployFile ? { file: body.deployFile, reviewed: body.reviewed!, content: deployed, extra } : {}) });
      // Up again: no longer listed as down.
      void op.done.then((code) => code === 0 && saveStackRow(ctx, hostId, project, { downAt: null }), () => {});
      return op.info;
    }
    const op = runner.start(target, body.op, async (ctl) => {
      const code = await ctl.run(opScript(target, body.op, body.services));
      // Down for good (the whole stack): kept, to be listed and brought up again.
      if (body.op === 'down' && code === 0 && !body.services?.length) rememberDown(ctx, target);
      return code;
    });
    return op.info;
  });

  app.get('/api/docker/stacks/down', { config: { auth: 'user' } }, async () => downStacks(ctx));

  // What runs now, on any stack or as an update check: the "busy" pill.
  app.get('/api/docker/activity', async (): Promise<Activity> => ({ ops: runner.list(), check: checker.checking ? (checker.progress ?? { done: 0, total: 0 }) : null }));

  app.get('/api/docker/ops/:id/ws', { websocket: true }, (socket: WebSocket, req) => {
    const a = requireAuth(req);
    const send = boundedSender<OpServerMessage>(socket);
    const op = runner.get((req.params as { id: string }).id);
    if (!op) {
      send({ t: 'error', message: 'This operation is not known (any more).' });
      socket.close(4404, 'not found');
      return;
    }
    const untrack = sockets.add(a.session.idHash, socket);
    const stop = op.listen((m) => {
      send(m);
      if (m.t === 'exit') setTimeout(() => socket.close(1000, 'done'), 50);
    });
    socket.on('close', () => {
      stop();
      untrack();
    });
  });

  // ---- updates

  const overview = (): UpdatesOverview => {
    const settings = getUpdateSettings(ctx);
    const st = getUpdateState(ctx);
    const next = settings.enabled ? nextWindow(ctx.now(), settings) : null;
    return {
      settings,
      checks: checker.list(),
      lastCheckAt: st.lastCheckAt ? new Date(st.lastCheckAt).toISOString() : null,
      nextWindowAt: next === null ? null : new Date(next).toISOString(),
      checking: checker.checking,
      windowRunning: updater.windowRunning,
      progress: checker.progress,
    };
  };

  app.get('/api/docker/updates', { config: { auth: 'user' } }, async () => overview());

  /** Release notes of an image's source, after the version on this host. */
  app.get('/api/docker/:hostId/changelog', { config: { auth: 'user' } }, async (req) => {
    const hostId = idParam(req, 'hostId');
    const { image } = parse(z.object({ image: z.string().min(1).max(512) }), req.query);
    const c = checker.list(hostId).find((x) => x.image === image);
    if (!c) throw new HttpError(404, 'not_checked', 'Check this image for updates first.');
    // The same notes an automatic update is held by.
    return updater.notes(c.source, c.version, c.image);
  });

  // A picture in release notes, from GitHub through Burrow (report 64498b):
  // served as an image that can do nothing, even opened on its own.
  app.get('/api/changelog/image', { config: { auth: 'user' } }, async (req, reply) => {
    const { url } = parse(z.object({ url: z.string().min(1).max(2048) }), req.query);
    const img = await releaseImage(url);
    reply.header('Content-Type', img.type);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(img.bytes);
  });

  // What may update itself, and when, unattended: confirmed as the person first (AUDIT2 AUTH-09).
  app.put('/api/docker/updates/settings', { config: { stepUp: true } }, async (req) => {
    const body = parse(updateSettingsInput, req.body);
    if (!validTimeZone(body.timeZone)) throw new HttpError(400, 'invalid_time_zone');
    if (body.kind === 'cron') {
      try {
        parseCron(body.cron ?? '');
      } catch (err) {
        throw new HttpError(400, 'invalid_cron', (err as Error).message);
      }
    }
    setUpdateSettings(ctx, { ...body, cron: body.kind === 'cron' ? body.cron : null });
    audit(ctx, actor(req), 'updates.settings', null, body);
    return overview();
  });

  /** Check the images of these hosts (or all Docker hosts) now. */
  app.post('/api/docker/updates/check', async (req) => {
    const { hostIds, images } = parse(z.object({ hostIds: z.array(z.number().int().positive()).max(100), images: z.array(z.string().max(512)).max(200).optional() }), req.body);
    await checker.check(hostIds, images);
    return overview();
  });

  /** The maintenance window's work now: check, then update the stacks that opted in. */
  app.post('/api/docker/updates/run', { config: { stepUp: true } }, async (req) => {
    // Already running (its schedule, or another tap): said, not "nothing to do".
    if (updater.windowRunning) throw new HttpError(409, 'already_running', 'The maintenance window is running already.');
    audit(ctx, actor(req), 'updates.run');
    return { updates: await updater.runWindow() };
  });
}
