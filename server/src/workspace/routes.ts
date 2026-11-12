import { linearMatcher } from '../linear.js';
import { posix } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  absPath,
  replaceInput,
  saveInput,
  TEXT_SAVE_BODY_LIMIT,
  workspaceSearchInput,
  workspaceInput,
  type GitStatus,
  type ReplaceResult,
  type SearchResult,
  type Workspace,
} from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { workspaces } from '../db/schema.js';
import type { FileAccessGuard } from '../files/access.js';
import type { SftpPool } from '../files/pool.js';
import * as fs from '../files/service.js';
import { getHost, hostPassword } from '../hosts/service.js';
import { actor, HttpError, idParam, noContent, parse, requireAuth } from '../http.js';
import { exec } from '../ssh/connect.js';
import { git, needsIdentity, parseStatus, statusCommand, parseRepos, reposCommand, unsafeSetting } from './git.js';
import { filesCommand, insideRoot, parseFiles, parseSearch, replaceAll, searchCommand } from './search.js';
import { sudoList, sudoRead, sudoWrite } from './sudo.js';

// Workspaces (phase 7): a folder on a host as a project. The editor itself
// is the one files already have; this adds the saved workspaces, quick
// open, search and replace across the folder, basic git, and reading and
// saving root's files through sudo.

type Row = typeof workspaces.$inferSelect;

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool, access: FileAccessGuard): void {
  const toWorkspace = (r: Row): Workspace => {
    let hostName = String(r.hostId);
    try {
      hostName = getHost(ctx, r.hostId).name;
    } catch {
      // Host gone: the row cascades away soon.
    }
    return {
      id: r.id,
      hostId: r.hostId,
      hostName,
      root: r.root,
      folders: r.folders ? (JSON.parse(r.folders) as string[]) : [],
      name: r.name,
      gitName: r.gitName,
      gitEmail: r.gitEmail,
      lastOpenedAt: r.lastOpenedAt ? new Date(r.lastOpenedAt).toISOString() : null,
    };
  };
  const row = (id: number) => {
    const r = ctx.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  };
  const hostOf = (req: FastifyRequest) => {
    const id = idParam(req, 'hostId');
    getHost(ctx, id);
    return id;
  };
  const run = async (hostId: number, command: string, timeoutMs = 30_000, maxBytes = 4 << 20, input?: string) =>
    pool.with(hostId, ({ client }) => exec(client, command, timeoutMs, maxBytes, input));
  /** The folder as this person may open it: its real path for an operator, refused outside their folders (A3-SRV-01). */
  const rootFor = (req: FastifyRequest, hostId: number, root: string) => pool.with(hostId, (conn) => access.check(req, hostId, conn, root));
  /** Paths below a root (relative to it) that this person may open. */
  const openBelow = async (req: FastifyRequest, hostId: number, root: string, rel: string[], deep = true) => {
    const full = rel.map((p) => posix.join(root, p));
    const ok = new Set(await pool.with(hostId, (conn) => access.filter(req, hostId, conn, root, full, deep)));
    return rel.filter((_, i) => ok.has(full[i]!));
  };

  // ------------------------------------------------------------ workspaces

  // An operator's: those whose folder they may open (A3-SRV-01).
  app.get('/api/workspaces', { config: { auth: 'user' } }, async (req) =>
    ctx.db
      .select()
      .from(workspaces)
      .orderBy(desc(workspaces.lastOpenedAt), workspaces.name)
      .all()
      .filter((w) => access.shown(req, w.hostId, w.root))
      .map(toWorkspace),
  );

  app.post('/api/workspaces', async (req) => {
    const b = parse(workspaceInput, req.body);
    getHost(ctx, b.hostId);
    const root = posix.normalize(b.root).replace(/(.)\/+$/, '$1');
    const existing = ctx.db.select().from(workspaces).where(and(eq(workspaces.hostId, b.hostId), eq(workspaces.root, root))).get();
    if (existing) return toWorkspace(existing);
    const st = await pool.with(b.hostId, ({ sftp }) => fs.stat(sftp, root));
    if (!st || (st.mode & 0o170000) !== 0o040000) throw new HttpError(400, 'not_a_dir', `${root} is not a folder on the host.`);
    const r = ctx.db
      .insert(workspaces)
      .values({ hostId: b.hostId, root, name: b.name ?? (posix.basename(root) || root), createdAt: ctx.now(), lastOpenedAt: ctx.now() })
      .returning()
      .get();
    audit(ctx, actor(req), 'workspace.create', r.name, { hostId: r.hostId, root });
    return toWorkspace(r);
  });

  app.get('/api/workspaces/:id', { config: { auth: 'user' } }, async (req) => {
    const r = row(idParam(req));
    if (!access.shown(req, r.hostId, r.root)) throw new HttpError(404, 'not_found');
    // Opened by an operator: not the admins' "last opened" (it changes nothing, A3-SRV-11).
    if (requireAuth(req).user.role !== 'admin') return toWorkspace(r);
    ctx.db.update(workspaces).set({ lastOpenedAt: ctx.now() }).where(eq(workspaces.id, r.id)).run();
    return toWorkspace({ ...r, lastOpenedAt: ctx.now() });
  });

  app.put('/api/workspaces/:id', async (req) => {
    const r = row(idParam(req));
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        gitName: z.string().trim().max(120).nullable().optional(),
        gitEmail: z.string().trim().max(200).nullable().optional(),
        folders: z.array(z.string().min(1).max(4096).startsWith('/')).max(20).optional(),
      }),
      req.body,
    );
    // More folders: each a folder on the same host, none twice, not the root itself.
    let folders = r.folders;
    if (b.folders) {
      const list = [...new Set(b.folders.map((f) => posix.normalize(f).replace(/(.)\/+$/, '$1')))].filter((f) => f !== r.root);
      for (const f of list) {
        // Inside the root it is there already (twice in the tree otherwise).
        if (f.startsWith(`${r.root}/`)) throw new HttpError(400, 'inside_root', `${f} is inside the workspace already.`);
        const st = await pool.with(r.hostId, ({ sftp }) => fs.stat(sftp, f));
        if (!st || (st.mode & 0o170000) !== 0o040000) throw new HttpError(400, 'not_a_dir', `${f} is not a folder on the host.`);
      }
      folders = list.length ? JSON.stringify(list) : null;
    }
    const out = ctx.db
      .update(workspaces)
      .set({ name: b.name ?? r.name, gitName: b.gitName === undefined ? r.gitName : b.gitName || null, gitEmail: b.gitEmail === undefined ? r.gitEmail : b.gitEmail || null, folders })
      .where(eq(workspaces.id, r.id))
      .returning()
      .get();
    return toWorkspace(out!);
  });

  app.delete('/api/workspaces/:id', async (req, reply) => {
    const r = row(idParam(req));
    ctx.db.delete(workspaces).where(eq(workspaces.id, r.id)).run();
    audit(ctx, actor(req), 'workspace.delete', r.name, { hostId: r.hostId });
    return noContent(reply);
  });

  // ------------------------------------------------------------ files and search

  app.get('/api/workspace/:hostId/files', { config: { auth: 'user' } }, async (req) => {
    const { root: asked } = parse(z.object({ root: absPath }), req.query);
    const hostId = hostOf(req);
    const root = await rootFor(req, hostId, asked);
    const r = await run(hostId, filesCommand(root), 30_000, 8 << 20);
    if (r.code === 3) throw new HttpError(400, 'not_readable', r.stderr.trim().split('\n').pop() || `${root} cannot be read.`);
    // No exit code: the connection went halfway, not "these are all its files".
    if (r.code === null) throw new HttpError(502, 'host_failed', 'The listing ended without an exit code (the connection to the host was lost).');
    const found = parseFiles(r.stdout);
    return { files: await openBelow(req, hostId, root, found.files), truncated: found.truncated, slow: found.slow };
  });

  app.post('/api/workspace/:hostId/search', { config: { auth: 'user' } }, async (req): Promise<SearchResult> => {
    const b = parse(workspaceSearchInput, req.body);
    const hostId = hostOf(req);
    const root = await rootFor(req, hostId, b.root);
    const r = await run(hostId, searchCommand(root, b.query, b.regex, b.caseSensitive), 30_000, 8 << 20);
    // rg and grep exit 1 for "nothing found", 2 for a real error (bad regex); 3 is the folder.
    if (r.code === 2 && r.stderr.trim()) throw new HttpError(400, 'search_failed', r.stderr.trim().split('\n').pop()!);
    if (r.code === 3) throw new HttpError(400, 'not_readable', r.stderr.trim().split('\n').pop() || `${root} cannot be read.`);
    // Anything else (no exit code: the connection went; a shell that could not run it) is no "no matches" (audit 2026-11-05).
    if (r.code !== 0 && r.code !== 1 && r.code !== 2) throw new HttpError(502, 'search_failed', r.stderr.trim().split('\n').pop() || (r.code === null ? 'The search ended without an exit code (the connection to the host was lost).' : `The search ended with exit code ${r.code}.`));
    const result = parseSearch(r.stdout, !!r.truncated);
    // What an operator may not open is not shown, its lines neither (a key below a granted folder).
    const open = new Set(await openBelow(req, hostId, root, [...new Set(result.matches.map((m) => m.path))]));
    return { ...result, matches: result.matches.filter((m) => open.has(m.path)) };
  });

  // Replace in the chosen files, each read and saved like the editor does
  // (atomic, and skipped when it changed in between).
  app.post('/api/workspace/:hostId/replace', async (req): Promise<ReplaceResult[]> => {
    const b = parse(replaceInput, req.body);
    const hostId = hostOf(req);
    if (b.regex) {
      const ok = linearMatcher(b.query);
      if (ok instanceof Error) throw new HttpError(400, 'bad_regex', ok.message);
    }
    const results = await pool.with(hostId, async (conn) => {
      const { sftp } = conn;
      const out: ReplaceResult[] = [];
      for (const rel of b.paths) {
        const full = insideRoot(b.root, rel);
        if (!full) {
          out.push({ path: rel, count: 0, error: 'outside the workspace' });
          continue;
        }
        // A file that grants a shell: a step-up first, as when it is saved on its own (A3-SRV-08).
        await access.check(req, hostId, conn, full, 'write');
        try {
          const f = await fs.readText(sftp, full);
          const { text, count } = replaceAll(f.content, b.query, b.regex, b.caseSensitive, b.replacement);
          if (count) {
            const w = await fs.writeText(sftp, full, text, f.hash, hostOf(req));
            if (!w.ok) throw new Error('changed while replacing');
          }
          out.push({ path: rel, count });
        } catch (err) {
          out.push({ path: rel, count: 0, error: (err as Error).message });
        }
      }
      return out;
    });
    audit(ctx, actor(req), 'workspace.replace', b.root, { hostId, files: results.filter((r) => r.count).length });
    return results;
  });

  // ------------------------------------------------------------ git

  // Who commits: the identity of the workspace this folder is the root of, or else one of its
  // other folders; set once for the workspace, a commit in an added folder asked again and again (AUDIT2 UI-13).
  const identity = (req: FastifyRequest, root: string) => {
    const all = ctx.db.select().from(workspaces).where(eq(workspaces.hostId, hostOf(req))).all().filter((w) => w.gitName && w.gitEmail);
    const folders = (w: (typeof all)[number]) => (w.folders ? (JSON.parse(w.folders) as string[]) : []);
    const w = all.find((x) => x.root === root) ?? all.find((x) => folders(x).includes(root));
    return w ? { name: w.gitName!, email: w.gitEmail! } : null;
  };
  /** A repository whose own settings run commands: git is not run there (A3-SRV-04). */
  const refuseUnsafe = (r: { code: number | null; stderr: string }) => {
    const setting = unsafeSetting(r.code, r.stderr);
    if (setting) throw new HttpError(409, 'git_unsafe_config', `This repository's own settings run commands (${setting}); Burrow does not run git in it.`);
  };
  const gitRun = async (req: FastifyRequest, root: string, args: string[], timeoutMs = 30_000) => {
    const r = await run(hostOf(req), git(root, args, identity(req, root)), timeoutMs);
    refuseUnsafe(r);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim();
      if (needsIdentity(msg)) throw new HttpError(400, 'git_identity', 'git does not know who you are on this host.');
      throw new HttpError(400, 'git_failed', msg.split('\n').slice(-3).join('\n') || `git exited with ${r.code}`);
    }
    return r.stdout;
  };
  const rootQ = z.object({ root: absPath });
  const pathsBody = z.object({ root: absPath, paths: z.array(z.string().min(1).max(4096)).min(1).max(1000) });

  /** Repositories below a folder, to work in one of them (report 91e73c). */
  app.get('/api/workspace/:hostId/git/repos', { config: { auth: 'user' } }, async (req): Promise<string[]> => {
    const { root: asked } = parse(rootQ, req.query);
    const hostId = hostOf(req);
    const root = await rootFor(req, hostId, asked);
    const r = await run(hostId, reposCommand(root));
    const repos = parseRepos(r.stdout, root);
    const open = new Set(await openBelow(req, hostId, root, repos.map((d) => posix.relative(root, d)), false));
    return repos.filter((d) => open.has(posix.relative(root, d)));
  });

  app.get('/api/workspace/:hostId/git/status', { config: { auth: 'user' } }, async (req): Promise<GitStatus> => {
    const { root: asked } = parse(rootQ, req.query);
    const hostId = hostOf(req);
    const root = await rootFor(req, hostId, asked);
    const r = await run(hostId, statusCommand(root));
    refuseUnsafe(r);
    if (r.code !== 0) {
      if (/not a git repository/i.test(r.stderr)) return { repo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
      if (/command not found|git: not found/i.test(r.stderr)) throw new HttpError(400, 'git_missing', 'git is not installed on the host.');
      throw new HttpError(400, 'git_failed', r.stderr.trim().split('\n').pop() || 'git status failed');
    }
    const st = parseStatus(r.stdout);
    const open = new Set(await openBelow(req, hostId, root, st.files.map((f) => f.path), false));
    return { ...st, files: st.files.filter((f) => open.has(f.path)) };
  });

  /**
   * A file as the last commit has it, or as staged (rev=index), for the diff
   * (empty when it is not there). A staged change is the commit against the
   * index, an unstaged one the index against the disk; both against the
   * commit showed what is on disk as what the commit would write (AUDIT2 UI-11).
   */
  app.get('/api/workspace/:hostId/git/head', { config: { auth: 'user' } }, async (req) => {
    const { root: asked, path, rev } = parse(z.object({ root: absPath, path: z.string().min(1).max(4096), rev: z.enum(['HEAD', 'index']).default('HEAD') }), req.query);
    const hostId = hostOf(req);
    const root = await rootFor(req, hostId, asked);
    const full = insideRoot(root, path);
    if (!full) throw new HttpError(400, 'outside');
    // The file itself too: a key or a denied folder below the root (A3-SRV-01).
    await pool.with(hostId, (conn) => access.check(req, hostId, conn, full));
    const r = await run(hostId, git(root, ['show', rev === 'index' ? `:./${path}` : `HEAD:./${path}`]), 20_000, fs.MAX_TEXT_BYTES + 1);
    refuseUnsafe(r);
    if (r.code === 0) return { exists: true, content: r.stdout };
    // Not in the last commit (a new file, no commit yet) is "not there";
    // git failing otherwise is an error, not an empty old version (AUDIT2 FS-17).
    if (/does not exist in|does not exist \(neither|exists on disk, but not in|bad revision|unknown revision|invalid object name 'HEAD'|ambiguous argument 'HEAD/i.test(r.stderr)) return { exists: false, content: '' };
    throw new HttpError(400, 'git_failed', r.stderr.trim().split('\n').pop() || `git show exited with ${r.code}`);
  });

  app.post('/api/workspace/:hostId/git/stage', async (req) => {
    const b = parse(pathsBody, req.body);
    await gitRun(req, b.root, ['add', '-A', '--', ...b.paths]);
    return { ok: true };
  });

  app.post('/api/workspace/:hostId/git/unstage', async (req) => {
    const b = parse(pathsBody, req.body);
    // Back to what HEAD has. Before the first commit there is no HEAD:
    // only then out of the index. "rm --cached" first staged the deletion
    // of a tracked file.
    const head = await run(hostOf(req), git(b.root, ['rev-parse', '--verify', '-q', 'HEAD']), 20_000);
    refuseUnsafe(head);
    const hasHead = head.code === 0;
    if (hasHead) await gitRun(req, b.root, ['reset', '-q', '--', ...b.paths]);
    else await gitRun(req, b.root, ['rm', '--cached', '-r', '-q', '--', ...b.paths]);
    return { ok: true };
  });

  /**
   * Changes thrown away (VS Code's Discard Changes): a changed file back as staged (or committed),
   * a new one deleted. A delete on the host, so a fresh step-up, as Files' delete.
   */
  app.post('/api/workspace/:hostId/git/discard', { config: { stepUp: true } }, async (req) => {
    const b = parse(pathsBody, req.body);
    const untracked = new Set((await gitRun(req, b.root, ['ls-files', '-o', '--exclude-standard', '--', ...b.paths])).split('\n').filter(Boolean));
    const tracked = b.paths.filter((p) => !untracked.has(p));
    if (untracked.size) await gitRun(req, b.root, ['clean', '-f', '-q', '--', ...untracked]);
    if (tracked.length) await gitRun(req, b.root, ['checkout', '-q', '--', ...tracked]);
    audit(ctx, actor(req), 'git.discard', b.root, { hostId: hostOf(req), files: b.paths.length });
    return { ok: true };
  });

  /** The repository's own branches, and the one checked out (null: none yet, or a detached HEAD). */
  app.get('/api/workspace/:hostId/git/branches', { config: { auth: 'user' } }, async (req) => {
    const { root: asked } = parse(rootQ, req.query);
    const root = await rootFor(req, hostOf(req), asked);
    const out = await gitRun(req, root, ['branch', '--format=%(HEAD) %(refname:short)']);
    const lines = out.split('\n').filter((l) => /^[* ] \S/.test(l));
    return { current: lines.find((l) => l.startsWith('*'))?.slice(2).replace(/^\(.*\)$/, '') || null, branches: lines.map((l) => l.slice(2)).filter((x) => !x.startsWith('(')) };
  });

  /** Another branch checked out; git refuses itself when a change here would be lost. */
  app.post('/api/workspace/:hostId/git/checkout', async (req) => {
    const b = parse(z.object({ root: absPath, branch: z.string().min(1).max(200).regex(/^(?!-)[\w./-]+$/) }), req.body);
    await gitRun(req, b.root, ['checkout', '-q', b.branch]);
    audit(ctx, actor(req), 'git.checkout', b.root, { hostId: hostOf(req), branch: b.branch });
    return { ok: true };
  });

  app.post('/api/workspace/:hostId/git/commit', async (req) => {
    const b = parse(z.object({ root: absPath, message: z.string().trim().min(1).max(10_000) }), req.body);
    const out = await gitRun(req, b.root, ['commit', '-m', b.message]);
    audit(ctx, actor(req), 'git.commit', b.root, { hostId: hostOf(req) });
    return { output: out.trim() };
  });

  for (const op of ['pull', 'push'] as const) {
    app.post(`/api/workspace/:hostId/git/${op}`, async (req) => {
      const b = parse(z.object({ root: absPath }), req.body);
      // Non-interactive: a remote that asks for a password fails instead of hanging.
      const out = await gitRun(req, b.root, op === 'pull' ? ['-c', 'credential.interactive=never', 'pull', '--ff-only'] : ['-c', 'credential.interactive=never', 'push'], 120_000);
      audit(ctx, actor(req), `git.${op}`, b.root, { hostId: hostOf(req) });
      return { output: out.trim() };
    });
  }

  // ------------------------------------------------------------ sudo

  // Reading and saving as root: as powerful as a shell, so step-up; the sudo
  // password, if any, is the one given now or the host's stored password.
  const sudoPassword = (hostId: number, given: string | undefined) => (given !== undefined ? given : hostPassword(ctx, hostId));

  app.post('/api/files/:hostId/sudo/read', { config: { stepUp: true } }, async (req) => {
    const b = parse(z.object({ path: absPath, password: z.string().max(500).optional() }), req.body);
    const hostId = hostOf(req);
    const f = await pool.with(hostId, ({ client }) => sudoRead(client, b.path, sudoPassword(hostId, b.password)));
    audit(ctx, actor(req), 'file.sudo_read', b.path, { hostId });
    return f;
  });

  // A folder only root may read, to look in and open its files through sudo (report 4d30e6).
  app.post('/api/files/:hostId/sudo/list', { config: { stepUp: true } }, async (req) => {
    const b = parse(z.object({ path: absPath, password: z.string().max(500).optional() }), req.body);
    const hostId = hostOf(req);
    const path = posix.normalize(b.path).replace(/(.)\/+$/, '$1');
    const l = await pool.with(hostId, ({ client, home }) => sudoList(client, home, path, sudoPassword(hostId, b.password)));
    audit(ctx, actor(req), 'file.sudo_list', path, { hostId });
    return l;
  });

  app.put('/api/files/:hostId/sudo/text', { bodyLimit: TEXT_SAVE_BODY_LIMIT, config: { stepUp: true } }, async (req, reply) => {
    const b = parse(saveInput.extend({ password: z.string().max(500).optional() }), req.body);
    if (b.baseHash === null) throw new HttpError(400, 'no_base', 'Open the file first.');
    const hostId = hostOf(req);
    const r = await pool.with(hostId, ({ client, sftp }) => sudoWrite(client, sftp, b.path, b.content, b.baseHash!, sudoPassword(hostId, b.password), hostId));
    if (!r.ok) return reply.code(409).send({ error: 'conflict', message: 'The file changed on the host since you opened it.', current: r.current });
    audit(ctx, actor(req), 'file.sudo_save', b.path, { hostId, bytes: r.file.size });
    return r.file;
  });
}
