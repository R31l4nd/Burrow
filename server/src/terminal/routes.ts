import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { clientMessage, completionRunInput, createSessionInput, recordSessionInput, renameSessionInput, shareSessionInput, type ServerMessage } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { actor, HttpError, noContent, parse, requireAuth } from '../http.js';
import type { TerminalManager } from './manager.js';

const HEARTBEAT_MS = 30_000;

export function registerTerminalRoutes(app: FastifyInstance, ctx: Ctx, manager: TerminalManager): void {
  // A session is its opener's: another admin sees, types into, shares, records and closes only
  // their own (audit 2026-11-05), and watches another's only when it is shared with them.
  const mine = (req: FastifyRequest): string => {
    const id = (req.params as { id: string }).id;
    manager.own(id, requireAuth(req).user.id);
    return id;
  };

  app.get('/api/terminal/sessions', async (req) => manager.list(requireAuth(req).user.id));

  // A new shell on a host is the most powerful thing Burrow does: fresh
  // step-up required. Re-opening an existing session is not.
  app.post('/api/terminal/sessions', { config: { stepUp: true } }, async (req) => {
    const a = requireAuth(req);
    const body = parse(createSessionInput, req.body);
    return manager.create({ ...actor(req), userId: a.user.id }, body.hostId, body.cols, body.rows, body.cwd, undefined, body.tmux);
  });

  app.get('/api/terminal/sessions/:id', async (req) => manager.get(mine(req)));

  // The AI dialog's earlier questions and suggestions in this session (report 411dbe): who
  // may use the dialog (an admin) reads them, on any device; gone with the session.
  app.get('/api/terminal/sessions/:id/ai', async (req) => manager.aiTurns(mine(req)));
  app.delete('/api/terminal/sessions/:id/ai', async (req, reply) => {
    manager.clearAi(mine(req));
    return noContent(reply);
  });

  app.put('/api/terminal/sessions/:id/title', async (req) => {
    const { title } = parse(renameSessionInput, req.body);
    return manager.rename(mine(req), title, actor(req));
  });

  app.delete('/api/terminal/sessions/:id', async (req, reply) => {
    // ?force=1: forgotten even when its tmux session on the host could not be ended (the person was asked).
    await manager.close(mine(req), actor(req), 'closed', (req.query as { force?: string }).force === '1');
    return noContent(reply);
  });

  // Auto-complete helpers. They run on the session's own SSH connection, for a sign-in that has
  // the session open on a screen (one of its listed viewers), so they grant nothing that viewer
  // could not type into it anyway.
  app.post('/api/terminal/sessions/:id/complete/run', async (req) => {
    const body = parse(completionRunInput, req.body);
    return { stdout: await manager.runForCompletion((req.params as { id: string }).id, requireAuth(req).session.idHash, body.script, body.cwd ?? null) };
  });

  app.get('/api/terminal/sessions/:id/complete/ls', async (req) => {
    const q = parse(z.object({ path: z.string().max(4096).default(''), cwd: z.string().max(4096).optional() }), req.query);
    return manager.listPath((req.params as { id: string }).id, requireAuth(req).session.idHash, q.path, q.cwd ?? null);
  });

  const viewer = (watching: boolean) => (socket: WebSocket, req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    const a = requireAuth(req);
    let viewerId: string | null = null;
    let closed = false;
    // Messages can arrive before attach() resolves; keep them in order.
    const early: string[] = [];

    const send = (msg: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));

    const handle = (raw: string) => {
      if (!viewerId) return void early.push(raw);
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      const m = clientMessage.safeParse(data);
      if (!m.success) return;
      const msg = m.data;
      if (msg.t === 'input') manager.input(id, viewerId, msg.d);
      else if (msg.t === 'resize') manager.resize(id, viewerId, msg.cols, msg.rows, msg.active ?? false);
      else if (msg.t === 'password') manager.pastePassword(id, viewerId, actor(req));
      else if (msg.t === 'scroll') manager.scroll(id, viewerId, msg.lines);
      else if (msg.t === 'history') void manager.history(id, viewerId, msg.mouse ?? false);
      else send({ t: 'pong' });
    };

    socket.on('message', (raw) => handle(String(raw)));

    // Phones sleep and networks drop without a FIN: a missed pong ends the
    // socket so the viewer list stays honest.
    let alive = true;
    socket.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);

    socket.on('close', () => {
      closed = true;
      clearInterval(beat);
      if (viewerId) manager.detach(id, viewerId);
    });

    // Someone else's session: only watched, when shared (the watch route below).
    Promise.resolve()
      .then(() => (watching ? undefined : manager.own(id, a.user.id)))
      .then(() => manager.attach(id, socket, { userAgent: req.headers['user-agent'] ?? null, sessionIdHash: a.session.idHash, ...(watching ? { watcher: { userId: a.user.id, username: a.user.username } } : {}) }))
      .then((vid) => {
        if (closed) return manager.detach(id, vid);
        viewerId = vid;
        for (const raw of early.splice(0)) handle(raw);
      })
      .catch((err: unknown) => {
        const message = err instanceof HttpError ? err.message : 'Could not open the session.';
        ctx.log.info({ err, session: id }, 'terminal attach failed');
        send({ t: 'exit', reason: err instanceof HttpError && (err.status === 404 || err.status === 410) ? 'ended' : 'error', message });
        socket.close(4000, 'attach failed');
      });
  };

  app.get('/api/terminal/sessions/:id/ws', { websocket: true }, viewer(false));

  // ---- sharing and recording (F3)

  // Shared with picked Burrow users, to watch: who sees a shell's output is
  // as weighty as who may open one, so a step-up.
  app.put('/api/terminal/sessions/:id/share', { config: { stepUp: true } }, async (req) => {
    const { userIds } = parse(shareSessionInput, req.body);
    return manager.share(mine(req), userIds, actor(req));
  });

  app.put('/api/terminal/sessions/:id/recording', { config: { stepUp: true } }, async (req) => {
    const { on } = parse(recordSessionInput, req.body);
    return manager.setRecording(mine(req), on, actor(req));
  });

  // What was shared with me, and watching it: anyone signed in, an operator
  // too, for the sessions picked for them only; what they send is ignored.
  app.get('/api/terminal/shared', { config: { auth: 'user' } }, async (req) => manager.sharedWith(requireAuth(req).user.id));
  app.get('/api/terminal/shared/:id/ws', { websocket: true, config: { auth: 'user' } }, viewer(true));
}
