import type { GitFile, GitStatus } from '@burrow/shared';
import { shellQuote } from '../ssh/quote.js';

// Basic git on the host, in the workspace folder: status for the tree,
// stage/unstage, commit, pull and push. `git -C` over SSH; nothing is
// installed, the host's own git and credentials are used.

/**
 * Settings in a repository's own config (its .git/config, worktree config and what they include),
 * as "name=value" lines, that make git run a command: a repository anything writing as the SSH
 * user's uid can plant (a container on a bind mount) ran code on the host when its status was
 * asked for, an operator's too (A3-SRV-04). Burrow refuses to run git in such a repository.
 * core.fsmonitor and core.hooksPath are not among them: they are overridden on every call
 * (husky's hooksPath is common and harmless then). A credential helper is a command for the
 * shell whatever it starts with (git runs "git credential-<value>"), so every one counts but
 * those of HELPERS_ALLOWED; gpg.ssh.defaultKeyCommand runs when a commit is signed with ssh
 * (audit 2026-11-05).
 */
const RUNS_COMMANDS = String.raw`^(core\.(sshcommand|gitproxy|askpass|alternaterefscommand)=|filter\.|diff\..*\.(textconv|command)=|diff\.external=|merge\..*\.driver=|credential\.(.*\.)?helper=.|remote\..*\.(uploadpack|receivepack|vcs)=|uploadpack\.packobjectshook=|gpg\.(.*\.)?program=|gpg\.ssh\.defaultkeycommand=)`;

/**
 * git's own helpers by name, which keep credentials in the SSH user's own file or memory: a
 * repository may name these. Not with --file or --socket (someone else's file or daemon).
 */
const HELPERS_ALLOWED = String.raw`^credential\.(.*\.)?helper=(store|cache( --timeout=[0-9]+)?)$`;

/** The exit code of a refused repository; its stderr says which setting. */
export const UNSAFE_CONFIG_EXIT = 97;

/**
 * Exits the shell with UNSAFE_CONFIG_EXIT when the repository at `root` has such a setting. The
 * config is read with -z, one "name=value" line per setting: a value with a newline in it is two
 * commands to the shell, and printed on two lines its second one went unseen.
 */
export const gitGuard = (root: string): string => {
  const r = shellQuote(root);
  return `k=$( { git -C ${r} config --local --includes --list -z; git -C ${r} config --worktree --includes --list -z; } 2>/dev/null | tr '\\n\\0' '=\\n' | grep -Ei ${shellQuote(RUNS_COMMANDS)} | grep -Ev ${shellQuote(HELPERS_ALLOWED)} | head -n 1 ); if [ -n "$k" ]; then echo "@@unsafe-config \${k%%=*}" >&2; exit ${UNSAFE_CONFIG_EXIT}; fi`;
};

// Never a command from the repository, whatever git reads later: no fsmonitor, no hooks (a hook
// is a command the repository brings), no ext:: transport, and never into a submodule (its own
// config, in .git/modules, is not what the guard read).
export const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'push.recurseSubmodules=no'];

export const git = (root: string, args: string[], identity?: { name: string; email: string } | null): string => {
  const who = identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [];
  // Every path a name, never a pattern: a file called "*.txt" or ":(top)"
  // took others along (AUDIT2 FS-07).
  const cmd = ['git', '--literal-pathspecs', '-C', root, ...SAFE_GIT, ...who, ...args].map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : shellQuote(a))).join(' ');
  return `{ ${gitGuard(root)}; ${cmd}; }`;
};

/** The setting a refused repository named (exit UNSAFE_CONFIG_EXIT), or null. */
export const unsafeSetting = (code: number | null, stderr: string): string | null =>
  code === UNSAFE_CONFIG_EXIT ? (/@@unsafe-config (\S+)/.exec(stderr)?.[1] ?? 'a setting that runs commands') : null;

/**
 * `git status --porcelain=v1 -z --branch` plus the path from the repository
 * top to the workspace root (so paths come back relative to the root).
 */
export function statusCommand(root: string): string {
  // Submodules only by the commit the top records: their own work trees (and their own config) are not looked into.
  return `${git(root, ['rev-parse', '--show-prefix'])} && echo '@@status' && ${git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty', '--', '.'])}`;
}

/** Repositories below a workspace folder: up to three levels down, not in node_modules (report 91e73c). */
export function reposCommand(root: string): string {
  return `find ${shellQuote(root)} -mindepth 1 -maxdepth 4 -name node_modules -prune -o -name .git -print -prune 2>/dev/null | head -n ${MAX_REPOS}`;
}

const MAX_REPOS = 50;

/** The folders of `reposCommand`'s .git entries, sorted. */
export function parseRepos(out: string, root: string): string[] {
  const base = root.replace(/\/+$/, '');
  return out
    .split('\n')
    .filter((l) => l.startsWith(`${base}/`) && l.endsWith('/.git'))
    .map((l) => l.slice(0, -'/.git'.length))
    // The folder's own repository is the folder itself (shown already).
    .filter((d) => d !== base)
    .sort();
}

export function parseStatus(out: string): GitStatus {
  const [prefixPart = '', statusPart = ''] = out.split('@@status\n');
  const prefix = prefixPart.trim();
  const entries = statusPart.split('\0');
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!e) continue;
    if (e.startsWith('## ')) {
      // "## main...origin/main [ahead 1, behind 2]", "## No commits yet on main",
      // "## release/1.2...origin/release/1.2": a dot belongs to the name, "..." does not (AUDIT2 FS-28).
      const m = /^## (?:No commits yet on )?(\S+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(e);
      branch = m?.[1] ?? null;
      upstream = m?.[2] ?? null;
      ahead = Number(/ahead (\d+)/.exec(m?.[3] ?? '')?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(m?.[3] ?? '')?.[1] ?? 0);
      continue;
    }
    const x = e[0]!;
    const y = e[1]!;
    const rel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    const path = rel(e.slice(3));
    // A rename or copy has the old name in the next entry: kept, so that
    // unstaging it also takes the old name's deletion out (AUDIT2 FS-06).
    const oldPath = x === 'R' || x === 'C' ? entries[++i] : undefined;
    files.push({ path, index: x === '?' ? '?' : x, worktree: y === '?' ? '?' : y, ...(oldPath && x === 'R' ? { oldPath: rel(oldPath) } : {}) });
  }
  return { repo: true, branch, upstream, ahead, behind, files };
}

/** git's complaint that it does not know who commits. */
export const needsIdentity = (stderr: string) => /Please tell me who you are|empty ident name|unable to auto-detect email/i.test(stderr);
