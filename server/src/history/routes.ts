import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { getHost, resolveTarget } from '../hosts/service.js';
import { actor, HttpError, idParam, noContent, parse } from '../http.js';
import { exec, openSsh } from '../ssh/connect.js';
import { clearHistory, deleteCommand, importHistory, listHistory } from './service.js';

const IMPORT_LINES = 5000;
const SPLIT = '__BURROW_HISTORY_SPLIT__';

export function registerHistoryRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/hosts/:id/history', async (req) => {
    const id = idParam(req);
    getHost(ctx, id);
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(5000).default(2000) }), req.query);
    return listHistory(ctx, id, limit);
  });

  app.post('/api/hosts/:id/history/forget', async (req, reply) => {
    const { command } = parse(z.object({ command: z.string().min(1).max(4000) }), req.body);
    if (!deleteCommand(ctx, idParam(req), command)) throw new HttpError(404, 'not_found');
    return noContent(reply);
  });

  app.delete('/api/hosts/:id/history', async (req, reply) => {
    const id = idParam(req);
    const n = clearHistory(ctx, id);
    audit(ctx, actor(req), 'history.clear', getHost(ctx, id).name, { entries: n });
    return noContent(reply);
  });

  /** Read ~/.bash_history and ~/.zsh_history on the host into Burrow's history. */
  app.post('/api/hosts/:id/history/import', async (req) => {
    const id = idParam(req);
    const conn = await openSsh(ctx, resolveTarget(ctx, id));
    if (!('client' in conn)) throw new HttpError(502, conn.status, 'message' in conn ? conn.message : conn.status);
    let out;
    try {
      out = await exec(
        conn.client,
        `tail -n ${IMPORT_LINES} "\${HISTFILE:-$HOME/.bash_history}" 2>/dev/null; echo ${SPLIT}; tail -n ${IMPORT_LINES} "$HOME/.zsh_history" 2>/dev/null; true`,
        20_000,
        8 << 20,
      );
    } finally {
      conn.client.end();
    }
    const { imported, skipped } = importHistory(ctx, id, out.stdout.split(`${SPLIT}\n`), ctx.now() - 30 * 86_400_000);
    audit(ctx, actor(req), 'history.import', getHost(ctx, id).name, { imported, skipped });
    return { imported, skipped };
  });
}
