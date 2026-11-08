import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runSnippetInput, snippetInput, type RunResult, type Snippet } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { hostGroups, hosts, snippets } from '../db/schema.js';
import { getHost, resolveTarget } from '../hosts/service.js';
import { actor, HttpError, idParam, noContent, parse } from '../http.js';
import { exec, openSsh } from '../ssh/connect.js';
import { commandSuggestions, dismissSuggestion } from '../history/service.js';

// Saved commands. Running one in a terminal is just typing it (the client
// sends it as input); running it on several hosts at once happens here, as
// a non-interactive command per host, with output collected per host.

const RUN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 256 * 1024;

const toSnippet = (r: typeof snippets.$inferSelect): Snippet => ({
  id: r.id,
  name: r.name,
  command: r.command,
  description: r.description,
  hostId: r.hostId,
  groupId: r.groupId,
});

function checkScope(ctx: Ctx, input: { hostId?: number | null | undefined; groupId?: number | null | undefined }) {
  if (input.hostId && input.groupId) throw new HttpError(400, 'invalid_scope', 'A snippet belongs to one host or one group, not both.');
  if (input.hostId && !ctx.db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, input.hostId)).get()) {
    throw new HttpError(400, 'unknown_host');
  }
  if (input.groupId && !ctx.db.select({ id: hostGroups.id }).from(hostGroups).where(eq(hostGroups.id, input.groupId)).get()) {
    throw new HttpError(400, 'unknown_group');
  }
}

export async function runOnHost(ctx: Ctx, hostId: number, command: string): Promise<RunResult> {
  const started = performance.now();
  const hostName = getHost(ctx, hostId).name;
  const done = (r: Omit<RunResult, 'hostId' | 'hostName' | 'durationMs'>): RunResult => ({
    hostId,
    hostName,
    durationMs: Math.round(performance.now() - started),
    ...r,
  });
  let target;
  try {
    target = resolveTarget(ctx, hostId);
  } catch (err) {
    return done({ status: 'error', exitCode: null, stdout: '', stderr: (err as Error).message });
  }
  const conn = await openSsh(ctx, target);
  if (!('client' in conn)) {
    return done({ status: 'error', exitCode: null, stdout: '', stderr: 'message' in conn ? conn.message : `host key: ${conn.status}` });
  }
  try {
    const r = await exec(conn.client, command, RUN_TIMEOUT_MS, MAX_OUTPUT);
    return done({ status: r.code === 0 ? 'ok' : 'failed', exitCode: r.code, stdout: r.stdout, stderr: r.stderr });
  } catch (err) {
    return done({ status: 'error', exitCode: null, stdout: '', stderr: (err as Error).message });
  } finally {
    conn.client.end();
  }
}

export function registerSnippetRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/snippets', async () =>
    ctx.db.select().from(snippets).orderBy(snippets.sort, snippets.name).all().map(toSnippet),
  );

  // Commands typed often that could be snippets (report 8f829d).
  app.get('/api/snippets/suggestions', async () =>
    commandSuggestions(
      ctx,
      ctx.db.select({ command: snippets.command }).from(snippets).all().map((r) => r.command),
    ),
  );

  app.post('/api/snippets/suggestions/dismiss', async (req, reply) => {
    const { command } = parse(z.object({ command: z.string().min(1).max(8000) }), req.body);
    dismissSuggestion(ctx, command);
    return noContent(reply);
  });

  app.post('/api/snippets', async (req) => {
    const body = parse(snippetInput, req.body);
    checkScope(ctx, body);
    const now = ctx.now();
    const row = ctx.db
      .insert(snippets)
      .values({
        name: body.name,
        command: body.command,
        description: body.description ?? null,
        hostId: body.hostId ?? null,
        groupId: body.groupId ?? null,
        sort: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    audit(ctx, actor(req), 'snippet.create', row.name, { id: row.id });
    return toSnippet(row);
  });

  app.put('/api/snippets/:id', async (req) => {
    const id = idParam(req);
    const body = parse(snippetInput, req.body);
    checkScope(ctx, body);
    const row = ctx.db
      .update(snippets)
      .set({
        name: body.name,
        command: body.command,
        description: body.description ?? null,
        hostId: body.hostId ?? null,
        groupId: body.groupId ?? null,
        updatedAt: ctx.now(),
      })
      .where(eq(snippets.id, id))
      .returning()
      .get();
    if (!row) throw new HttpError(404, 'not_found');
    audit(ctx, actor(req), 'snippet.update', row.name, { id });
    return toSnippet(row);
  });

  app.delete('/api/snippets/:id', async (req, reply) => {
    const row = ctx.db.delete(snippets).where(eq(snippets.id, idParam(req))).returning().get();
    if (!row) throw new HttpError(404, 'not_found');
    audit(ctx, actor(req), 'snippet.delete', row.name, { id: row.id });
    return noContent(reply);
  });

  // Commands on several hosts at once: as powerful as a shell, so step-up.
  app.post('/api/snippets/run', { config: { stepUp: true } }, async (req) => {
    const body = parse(runSnippetInput, req.body);
    const ids = [...new Set(body.hostIds)];
    for (const id of ids) getHost(ctx, id);
    // Hosts only, not the command: it may contain secrets, and the audit log
    // records who did what where, never content.
    audit(ctx, actor(req), 'snippet.run', null, { hosts: ids });
    return Promise.all(ids.map((id) => runOnHost(ctx, id, body.command)));
  });
}
