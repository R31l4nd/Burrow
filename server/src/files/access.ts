import { posix } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Client, SFTPWrapper } from 'ssh2';
import { accessFolders, fileAccessInput, folderAllowed, insideFolder, type FileAccessRule } from '@burrow/shared';
import { audit } from '../audit.js';
import { requireStepUp } from '../auth/sessions.js';
import type { Ctx } from '../context.js';
import { fileAccess, users } from '../db/schema.js';
import { getHost } from '../hosts/service.js';
import { actor, HttpError, idParam, parse, requireAuth } from '../http.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { realTarget } from './service.js';

// Which files a person may open (A3-SRV-01). An operator ("looks, changes nothing") read every
// file the host's SSH user could: private keys, .env files, /etc/shadow as root, and Burrow's
// own master key and database on the host that runs it. Now an admin grants folders per operator
// and host (an allowed and a denied list; the longest folder that holds a path decides, a
// denied one on a tie); without a grant an operator opens no file on that host. Paths are
// judged as they really are (links resolved on the host). Keys and Burrow's own secrets stay
// closed to operators whatever is granted. Admins open everything; writing a file that grants
// a shell (keys, shell start-up files, cron, sudoers, units) asks them for a fresh step-up
// (A3-SRV-08).

/** Names and places no operator opens, whatever was granted. */
const CLOSED_NAMES = new Set(['secret.key', 'backup_encryption_key']);
const CLOSED_FILES = new Set(['/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-']);

export function closedToOperators(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  return (
    // The SSH user's keys, and everyone else's.
    parts.includes('.ssh') ||
    /^ssh_host_.*_key$/.test(base) ||
    // Burrow's master key, database (with its journal) and backups.
    CLOSED_NAMES.has(base) ||
    /^burrow\.db(-wal|-shm|-journal)?$/.test(base) ||
    /^burrow-.*\.tar\.gz\.enc$/.test(base) ||
    CLOSED_FILES.has(path) ||
    // Every process's environment (Burrow's own too) and the like.
    insideFolder(path, '/proc')
  );
}

const SHELL_FILES = new Set(['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.kshrc', '.cshrc', '.tcshrc', '.mkshrc', '.bash_aliases']);
const SHELL_FOLDERS = ['/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly', '/etc/cron.weekly', '/etc/cron.monthly', '/var/spool/cron', '/etc/sudoers.d', '/etc/profile.d', '/etc/zsh', '/etc/systemd', '/lib/systemd', '/usr/lib/systemd', '/etc/init.d', '/etc/ssh', '/etc/pam.d', '/etc/update-motd.d', '/etc/logrotate.d', '/etc/apt/apt.conf.d', '/etc/ld.so.conf.d'];
const SHELL_PATHS = new Set(['/etc/crontab', '/etc/anacrontab', '/etc/sudoers', '/etc/profile', '/etc/bash.bashrc', '/etc/environment', '/etc/rc.local', '/etc/ld.so.preload', '/etc/ld.so.conf', '/etc/logrotate.conf', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gitconfig']);

/**
 * A repository's own config and hooks: what git runs when the SSH user runs it there. The .git
 * folder itself and a submodule's folder in it too, for a folder renamed onto one.
 */
function gitRuns(parts: string[]): boolean {
  const g = parts.lastIndexOf('.git');
  if (g < 1) return false;
  const below = parts.slice(g + 1);
  return !below.length || /^config(\.worktree)?$/.test(below.at(-1)!) || below.includes('hooks') || (below[0] === 'modules' && below.length === 2);
}

/**
 * A file whose new content gives a shell or runs as someone (authorized_keys, a shell's start-up
 * file, cron, sudoers, a unit): written only after a fresh step-up, like deleting (A3-SRV-08).
 * What Burrow or git runs later counts too: the shell integration a .bashrc sources, git's own
 * config and a repository's (its credential helper, its fsmonitor), its hooks. And the folders
 * that hold such files where they may not be there yet (~/.config, ~/.burrow, a .git): a folder
 * renamed onto one brought its files along (audit 2026-11-05).
 */
export function grantsAShell(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  return (
    parts.includes('.ssh') ||
    parts.includes('.burrow') ||
    SHELL_FILES.has(base) ||
    base === '.gitconfig' ||
    /\/\.config\/(fish|systemd\/user|autostart|git)(\/|$)/.test(path) ||
    /\/\.config(\/systemd)?$/.test(path) ||
    gitRuns(parts) ||
    SHELL_PATHS.has(path) ||
    SHELL_FOLDERS.some((f) => insideFolder(path, f))
  );
}

interface Conn {
  sftp: SFTPWrapper;
  client: Client;
}

const CACHE_MS = 5 * 60_000;
/** How long "could not tell where Burrow's own folder is" is kept before asking again. */
const UNKNOWN_MS = 10_000;

/** The compose folder of every Burrow found (its own and any other install), and the hosts whose containers could not be read (one may be there). */
export interface OwnFolder {
  found: { hostId: number; dir: string }[];
  unreadable: number[];
}

/** The folders an operator may open, per host; for an admin null (everything). */
export function accessRule(ctx: Ctx, user: { id: number; role: string }, hostId: number): FileAccessRule | null {
  if (user.role === 'admin') return null;
  const r = ctx.db.select().from(fileAccess).where(and(eq(fileAccess.userId, user.id), eq(fileAccess.hostId, hostId))).get();
  return { hostId, allow: r ? (JSON.parse(r.allow) as string[]) : [], deny: r ? (JSON.parse(r.deny) as string[]) : [] };
}

export class FileAccessGuard {
  /** A rule's folder as it really is on the host (links resolved), or null when it is not there. */
  readonly #real = new Map<string, { at: number; path: string | null }>();
  /** Folders that hold a Burrow database: Burrow's data, wherever it is mounted. */
  readonly #data = new Map<string, { at: number; yes: boolean }>();
  #own: { at: number; answer: OwnFolder | null } | null = null;

  constructor(
    private readonly ctx: Ctx,
    /** The compose folders of Burrow (its .env, secrets, backups) and the hosts they are on; and the hosts where that could not be told. */
    private readonly burrowDir: () => Promise<OwnFolder> = async () => ({ found: [], unreadable: [] }),
  ) {}

  rule(req: FastifyRequest, hostId: number): FileAccessRule | null {
    return accessRule(this.ctx, requireAuth(req).user, hostId);
  }

  /** Judged by the path as written, without asking the host: what lists show (bookmarks, workspaces). */
  shown(req: FastifyRequest, hostId: number, path: string): boolean {
    const rule = this.rule(req, hostId);
    return !rule || (!closedToOperators(path) && folderAllowed(posix.normalize(path), rule));
  }

  /**
   * Before a path is read, listed or written: its real path on the host, or refused (403
   * no_file_access) when this person may not. A write that grants a shell asks for a fresh
   * step-up, whoever writes.
   */
  async check(req: FastifyRequest, hostId: number, conn: Conn, path: string, how: 'read' | 'write' = 'read'): Promise<string> {
    const rule = this.rule(req, hostId);
    if (!rule && how === 'read') return path;
    const real = await realTarget(conn.sftp, path);
    if (how === 'write' && (grantsAShell(path) || grantsAShell(real))) requireStepUp(this.ctx, req);
    if (!rule) return path;
    if (!(await this.#allowed(hostId, conn, rule, real))) throw refused(path, rule);
    return real;
  }

  /**
   * Paths below a root that was checked (a folder's entries, search results, quick open): those
   * this person may open. `deep`: also look below the root for Burrow's data (a search reads
   * inside it; a folder's own entries are checked when opened).
   */
  async filter(req: FastifyRequest, hostId: number, conn: Conn, root: string, paths: string[], deep = true): Promise<string[]> {
    const rule = this.rule(req, hostId);
    if (!rule) return paths;
    const resolved = await this.#resolve(hostId, conn.sftp, rule);
    const own = await this.#ownDirs(hostId);
    const data = deep ? await this.#dataBelow(hostId, conn.client, root) : [];
    return paths.filter((p) => !closedToOperators(p) && folderAllowed(p, resolved) && !own.some((d) => insideFolder(p, d)) && !data.some((d) => insideFolder(p, d)));
  }

  async #allowed(hostId: number, conn: Conn, rule: FileAccessRule, real: string): Promise<boolean> {
    if (closedToOperators(real)) return false;
    if (!folderAllowed(real, await this.#resolve(hostId, conn.sftp, rule))) return false;
    if ((await this.#ownDirs(hostId)).some((d) => insideFolder(real, d))) return false;
    return !(await this.#inData(hostId, conn.sftp, real));
  }

  /** The rule with each folder also as it really is: a grant of /srv/media covers its target when it is a link. */
  async #resolve(hostId: number, sftp: SFTPWrapper, rule: FileAccessRule): Promise<{ allow: string[]; deny: string[] }> {
    const real = async (f: string) => {
      const key = `${hostId}:${f}`;
      const hit = this.#real.get(key);
      if (hit && this.ctx.now() - hit.at < CACHE_MS) return hit.path;
      const path = await new Promise<string | null>((resolve) => sftp.realpath(f, (err, p) => resolve(err ? null : p)));
      this.#real.set(key, { at: this.ctx.now(), path });
      return path;
    };
    const both = async (list: string[]) => [...new Set([...list, ...(await Promise.all(list.map(real))).filter((p): p is string => !!p)])];
    return { allow: await both(rule.allow), deny: await both(rule.deny) };
  }

  /** Whether the path is in a folder that holds a Burrow database (its data folder), or is one. */
  async #inData(hostId: number, sftp: SFTPWrapper, real: string): Promise<boolean> {
    for (let d = real; ; d = posix.dirname(d)) {
      const key = `${hostId}:${d}`;
      let hit = this.#data.get(key);
      if (!hit || this.ctx.now() - hit.at >= CACHE_MS) {
        const yes = await new Promise<boolean>((resolve) => sftp.stat(posix.join(d, 'burrow.db'), (err) => resolve(!err)));
        hit = { at: this.ctx.now(), yes };
        this.#data.set(key, hit);
      }
      if (hit.yes) return true;
      if (d === '/') return false;
    }
  }

  /**
   * Data folders of Burrow below a root (by its database), for the results of a search there. Not
   * looked for (the command failed): refused, not an empty list that let every result through.
   */
  async #dataBelow(hostId: number, client: Client, root: string): Promise<string[]> {
    const r = await exec(client, `find ${shellQuote(root)} -name burrow.db 2>/dev/null | head -n 50`, 60_000).catch((err: Error) => {
      throw new HttpError(502, 'host_failed', `Could not check what lies below ${root} on this host: ${err.message}`);
    });
    const dirs = r.stdout.split('\n').filter(Boolean).map((f) => posix.dirname(f));
    for (const d of dirs) this.#data.set(`${hostId}:${d}`, { at: this.ctx.now(), yes: true });
    return dirs;
  }

  /**
   * The compose folders of Burrow on this host: its own and any other install's. Not known (the
   * containers there could not be read, or the look failed): refused, never taken for "none
   * here", and asked again after a few seconds rather than five minutes.
   */
  async #ownDirs(hostId: number): Promise<string[]> {
    const keep = this.#own?.answer && !this.#own.answer.unreadable.length ? CACHE_MS : UNKNOWN_MS;
    if (!this.#own || this.ctx.now() - this.#own.at >= keep) {
      this.#own = { at: this.ctx.now(), answer: await this.burrowDir().catch(() => null) };
    }
    const a = this.#own.answer;
    if (!a || a.unreadable.includes(hostId)) {
      throw new HttpError(503, 'own_folder_unknown', "Burrow could not read the containers on this host, so it cannot tell whether its own folder (with its secrets) is here. Try again in a moment.");
    }
    return a.found.filter((f) => f.hostId === hostId && f.dir).map((f) => f.dir);
  }
}

function refused(path: string, rule: FileAccessRule): HttpError {
  const open = rule.allow.filter((f) => !rule.deny.includes(f));
  return new HttpError(403, 'no_file_access', `No access to ${path} on this host. ${open.length ? `Folders you may open here: ${open.join(', ')}.` : 'An admin can grant folders (Users).'}`);
}

const toRule = (r: typeof fileAccess.$inferSelect): FileAccessRule => ({ hostId: r.hostId, allow: JSON.parse(r.allow) as string[], deny: JSON.parse(r.deny) as string[] });

export function registerFileAccessRoutes(app: FastifyInstance, ctx: Ctx): void {
  const userOf = (id: number) => {
    const u = ctx.db.select().from(users).where(eq(users.id, id)).get();
    if (!u) throw new HttpError(404, 'not_found');
    return u;
  };

  /** An operator's folders, every host with a rule. */
  app.get('/api/users/:id/file-access', async (req): Promise<FileAccessRule[]> => {
    const u = userOf(idParam(req));
    return ctx.db.select().from(fileAccess).where(eq(fileAccess.userId, u.id)).all().map(toRule);
  });

  // Who reads what on a host is as weighty as who signs in: a fresh step-up.
  app.put('/api/users/:id/file-access/:hostId', { config: { stepUp: true } }, async (req): Promise<FileAccessRule> => {
    const u = userOf(idParam(req));
    const hostId = idParam(req, 'hostId');
    const host = getHost(ctx, hostId);
    const b = parse(fileAccessInput, req.body);
    const allow = accessFolders(b.allow);
    const deny = accessFolders(b.deny);
    if (!allow.length && !deny.length) ctx.db.delete(fileAccess).where(and(eq(fileAccess.userId, u.id), eq(fileAccess.hostId, hostId))).run();
    else
      ctx.db
        .insert(fileAccess)
        .values({ userId: u.id, hostId, allow: JSON.stringify(allow), deny: JSON.stringify(deny), updatedAt: ctx.now() })
        .onConflictDoUpdate({ target: [fileAccess.userId, fileAccess.hostId], set: { allow: JSON.stringify(allow), deny: JSON.stringify(deny), updatedAt: ctx.now() } })
        .run();
    audit(ctx, actor(req), 'user.file_access', u.username, { host: host.name, allow, deny });
    return { hostId, allow, deny };
  });

  /** The signed-in person's own folders: null for an admin (everything). */
  app.get('/api/files/access', { config: { auth: 'user' } }, async (req): Promise<{ rules: FileAccessRule[] | null }> => {
    const me = requireAuth(req).user;
    if (me.role === 'admin') return { rules: null };
    return { rules: ctx.db.select().from(fileAccess).where(eq(fileAccess.userId, me.id)).all().map(toRule) };
  });
}
