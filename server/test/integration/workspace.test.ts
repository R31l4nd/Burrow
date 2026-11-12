import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, DirListing, GitStatus, Host, ReplaceResult, SearchResult, TextFile, Workspace } from '@burrow/shared';
import { listLimit } from '../../src/workspace/search.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Workspaces against the test sshd (which has git, ripgrep and sudo): files
// for quick open, search and replace across the folder, git from status to
// commit, and a root-owned file read and saved through sudo.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SSHD_PORT ?? 2299);
const ROOT = '/home/tester/wsproj';

let t: TestApp;
let h: Host;
let ws: Workspace;

const save = (path: string, content: string) => t.json('PUT', `/api/files/${h.id}/text`, { path, content, baseHash: null });
const run = (command: string) => t.json<{ stdout: string; stderr: string; exitCode: number }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'ws-host', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  await run(`rm -rf ${ROOT} && mkdir -p ${ROOT}/sub ${ROOT}/node_modules/x`);
  await save(`${ROOT}/a.txt`, 'one needle\ntwo Needle\n');
  await save(`${ROOT}/sub/b.txt`, 'no match\nneedle at 7\n');
  await save(`${ROOT}/node_modules/x/c.txt`, 'needle hidden\n');
  ws = await t.json<Workspace>('POST', '/api/workspaces', { hostId: h.id, root: `${ROOT}/` });
});
afterAll(async () => {
  await t.close();
});

describe('workspace', () => {
  it('is saved once per folder, with its name', async () => {
    expect(ws).toMatchObject({ hostId: h.id, root: ROOT, name: 'wsproj' });
    expect((await t.json<Workspace>('POST', '/api/workspaces', { hostId: h.id, root: ROOT })).id).toBe(ws.id);
    expect((await t.request('POST', '/api/workspaces', { hostId: h.id, root: `${ROOT}/a.txt` })).json()).toMatchObject({ error: 'not_a_dir' });
  });

  it('takes more folders of the same host: real folders, not inside the root, none twice', async () => {
    await run(`mkdir -p ${ROOT}-extra`);
    const w = await t.json<Workspace>('PUT', `/api/workspaces/${ws.id}`, { folders: [`${ROOT}-extra/`, `${ROOT}-extra`, ROOT] });
    expect(w.folders).toEqual([`${ROOT}-extra`]);
    expect((await t.request('PUT', `/api/workspaces/${ws.id}`, { folders: [`${ROOT}/sub`] })).json()).toMatchObject({ error: 'inside_root' });
    expect((await t.request('PUT', `/api/workspaces/${ws.id}`, { folders: [`${ROOT}/a.txt`] })).json()).toMatchObject({ error: 'inside_root' });
    expect((await t.request('PUT', `/api/workspaces/${ws.id}`, { folders: ['/no/such/folder'] })).json()).toMatchObject({ error: 'not_a_dir' });
    expect((await t.json<Workspace>('GET', `/api/workspaces/${ws.id}`)).folders).toEqual([`${ROOT}-extra`]);
    expect((await t.json<Workspace>('PUT', `/api/workspaces/${ws.id}`, { folders: [] })).folders).toEqual([]);
  });

  it('lists files for quick open, without node_modules', async () => {
    const r = await t.json<{ files: string[] }>('GET', `/api/workspace/${h.id}/files?root=${encodeURIComponent(ROOT)}`);
    expect(r.files.sort()).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('a listing that takes too long on the host gives what it found by then, said so, not a 500 (live log 2026-10-19)', async () => {
    const was = listLimit.seconds;
    // A limit no listing makes: as a folder of millions of files would.
    listLimit.seconds = 0.0001;
    try {
      const res = await t.request('GET', `/api/workspace/${h.id}/files?root=${encodeURIComponent(ROOT)}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ slow: true, truncated: true });
      expect(res.json<{ files: string[] }>().files).not.toContain('@@burrow-slow');
    } finally {
      listLimit.seconds = was;
    }
    expect(await t.json('GET', `/api/workspace/${h.id}/files?root=${encodeURIComponent(ROOT)}`)).toMatchObject({ slow: false, truncated: false });
  });

  it('searches all files: text, case, regex', async () => {
    const find = (body: object) => t.json<SearchResult>('POST', `/api/workspace/${h.id}/search`, { root: ROOT, ...body });
    const plain = await find({ query: 'needle' });
    expect(plain.tool).toBe('rg');
    expect(plain.matches.map((m) => `${m.path}:${m.line}:${m.col}`).sort()).toEqual(['a.txt:1:5', 'a.txt:2:5', 'sub/b.txt:2:1']);
    expect((await find({ query: 'Needle', caseSensitive: true })).matches).toHaveLength(1);
    expect((await find({ query: 'needle at \\d', regex: true })).matches.map((m) => m.path)).toEqual(['sub/b.txt']);
    expect((await t.request('POST', `/api/workspace/${h.id}/search`, { root: ROOT, query: '(', regex: true })).statusCode).toBe(400);
  });

  it('replaces in the chosen files, and nothing outside the workspace', async () => {
    const r = await t.json<ReplaceResult[]>('POST', `/api/workspace/${h.id}/replace`, { root: ROOT, query: 'needle', replacement: 'pin', paths: ['a.txt', '../evil.txt'] });
    expect(r).toEqual([
      { path: 'a.txt', count: 2 },
      { path: '../evil.txt', count: 0, error: 'outside the workspace' },
    ]);
    expect((await t.json<TextFile>('GET', `/api/files/${h.id}/text?path=${encodeURIComponent(`${ROOT}/a.txt`)}`)).content).toBe('one pin\ntwo pin\n');
  });
  it('a folder that is not there is said, not listed as empty (AUDIT2 FS-17)', async () => {
    expect((await t.request('GET', `/api/workspace/${h.id}/files?root=${encodeURIComponent('/nonexistent-burrow-dir')}`)).json()).toMatchObject({ error: 'not_readable' });
    expect((await t.request('GET', `/api/files/${h.id}/search?dir=${encodeURIComponent('/nonexistent-burrow-dir')}&name=a`)).json()).toMatchObject({ error: 'command_failed' });
    // Searched: said too, not "no matches" (exit 1 of a failed cd under bash; audit 2026-11-05).
    expect((await t.request('POST', `/api/workspace/${h.id}/search`, { root: '/nonexistent-burrow-dir', query: 'needle' })).json()).toMatchObject({ error: 'not_readable' });
  });

  it('is removed from the list; the folder stays', async () => {
    const extra = await t.json<Workspace>('POST', '/api/workspaces', { hostId: h.id, root: `${ROOT}/sub` });
    expect((await t.request('DELETE', `/api/workspaces/${extra.id}`)).statusCode).toBe(204);
    expect((await t.json<Workspace[]>('GET', '/api/workspaces')).map((w) => w.id)).not.toContain(extra.id);
    expect((await t.request('GET', `/api/workspaces/${extra.id}`)).statusCode).toBe(404);
    expect((await run(`test -f ${ROOT}/sub/b.txt && echo there`))[0]!.stdout.trim()).toBe('there');
  });
});

describe('git', () => {
  const g = (op: string, body: object) => t.request('POST', `/api/workspace/${h.id}/git/${op}`, { root: ROOT, ...body });
  const status = () => t.json<GitStatus>('GET', `/api/workspace/${h.id}/git/status?root=${encodeURIComponent(ROOT)}`);

  it('says when the folder is no repository', async () => {
    expect(await status()).toMatchObject({ repo: false });
  });

  it('stages and commits, asking for an identity when git has none', async () => {
    await run(`cd ${ROOT} && git init -q -b main && printf 'node_modules/\\n' > .gitignore`);
    let s = await status();
    expect(s).toMatchObject({ repo: true, branch: 'main' });
    expect(s.files.map((f) => `${f.index}${f.worktree} ${f.path}`).sort()).toEqual(['?? .gitignore', '?? a.txt', '?? sub/b.txt']);
    expect((await g('stage', { paths: ['a.txt', '.gitignore'] })).statusCode).toBe(200);
    s = await status();
    expect(s.files.find((f) => f.path === 'a.txt')).toMatchObject({ index: 'A', worktree: ' ' });
    expect((await g('unstage', { paths: ['.gitignore'] })).statusCode).toBe(200);
    expect((await status()).files.find((f) => f.path === '.gitignore')).toMatchObject({ index: '?' });

    expect((await g('commit', { message: 'first' })).json()).toMatchObject({ error: 'git_identity' });
    await t.json('PUT', `/api/workspaces/${ws.id}`, { gitName: 'Burrow Test', gitEmail: 'test@example.com' });
    expect((await g('commit', { message: 'first' })).statusCode).toBe(200);
    expect((await status()).files.map((f) => f.path).sort()).toEqual(['.gitignore', 'sub/b.txt']);
    const head = await t.json<{ exists: boolean; content: string }>('GET', `/api/workspace/${h.id}/git/head?root=${encodeURIComponent(ROOT)}&path=a.txt`);
    expect(head).toEqual({ exists: true, content: 'one pin\ntwo pin\n' });
  });

  it('unstaging a change to a tracked file leaves it changed, never a staged deletion', async () => {
    await run(`printf 'three pin\\n' >> ${ROOT}/a.txt`);
    expect((await g('stage', { paths: ['a.txt'] })).statusCode).toBe(200);
    expect((await status()).files.find((f) => f.path === 'a.txt')).toMatchObject({ index: 'M' });
    expect((await g('unstage', { paths: ['a.txt'] })).statusCode).toBe(200);
    // "git rm --cached" first staged the file's deletion ("D", and "??" beside it).
    expect((await status()).files.filter((f) => f.path === 'a.txt')).toEqual([expect.objectContaining({ index: ' ', worktree: 'M' })]);
    await run(`cd ${ROOT} && git checkout -q -- a.txt`);
  });

  it('changes thrown away: a changed file back as staged, a new one gone; branches listed and switched (review 2026-10-24)', async () => {
    await run(`printf 'junk\\n' >> ${ROOT}/a.txt && printf 'new\\n' > ${ROOT}/fresh.txt`);
    expect((await g('discard', { paths: ['a.txt', 'fresh.txt'] })).statusCode).toBe(200);
    expect((await run(`cat ${ROOT}/a.txt; test -e ${ROOT}/fresh.txt && echo still-there`))[0]!.stdout).toBe('one pin\ntwo pin\n');
    expect((await status()).files.map((f) => f.path)).not.toContain('a.txt');
    await run(`cd ${ROOT} && git branch other`);
    const branches = () => t.json<{ current: string | null; branches: string[] }>('GET', `/api/workspace/${h.id}/git/branches?root=${encodeURIComponent(ROOT)}`);
    expect(await branches()).toEqual({ current: 'main', branches: ['main', 'other'] });
    expect((await g('checkout', { branch: 'other' })).statusCode).toBe(200);
    expect((await status()).branch).toBe('other');
    expect((await g('checkout', { branch: 'no such' })).statusCode).toBe(400);
    expect((await g('checkout', { branch: 'main' })).statusCode).toBe(200);
    expect((await branches()).current).toBe('main');
  });

  it('a staged rename unstaged: neither the new name nor the old one stays staged (AUDIT2 FS-06)', async () => {
    await run(`cd ${ROOT} && git mv a.txt moved.txt`);
    const renamed = (await status()).files.find((f) => f.path === 'moved.txt')!;
    expect(renamed).toMatchObject({ index: 'R', oldPath: 'a.txt' });
    expect((await g('unstage', { paths: [renamed.path, renamed.oldPath!] })).statusCode).toBe(200);
    const staged = (await run(`cd ${ROOT} && git diff --cached --name-only`))[0]!.stdout.trim();
    expect(staged).toBe('');
    await run(`cd ${ROOT} && mv moved.txt a.txt && git status --porcelain`);
  });

  it('a file named like a pattern is only that file (AUDIT2 FS-07)', async () => {
    await run(`cd ${ROOT} && printf x > '*.md' && printf y > other.md`);
    expect((await g('stage', { paths: ['*.md'] })).statusCode).toBe(200);
    expect((await run(`cd ${ROOT} && git diff --cached --name-only`))[0]!.stdout.trim().split('\n')).toEqual(['*.md']);
    expect((await g('unstage', { paths: ['*.md'] })).statusCode).toBe(200);
    await run(`cd ${ROOT} && rm -f '*.md' other.md`);
  });

  it('three versions of a file: the last commit, what is staged and what is on disk, each read as itself (AUDIT2 UI-11)', async () => {
    await run(`printf 'staged\\n' > ${ROOT}/a.txt && cd ${ROOT} && git add a.txt && printf 'on disk\\n' > a.txt`);
    try {
      const at = (rev: string) => t.json<{ exists: boolean; content: string }>('GET', `/api/workspace/${h.id}/git/head?root=${encodeURIComponent(ROOT)}&path=a.txt&rev=${rev}`);
      expect(await at('HEAD')).toEqual({ exists: true, content: 'one pin\ntwo pin\n' });
      expect(await at('index')).toEqual({ exists: true, content: 'staged\n' });
      // Not staged at all: no version in the index.
      await run(`printf new > ${ROOT}/only-here.txt`);
      expect(await t.json('GET', `/api/workspace/${h.id}/git/head?root=${encodeURIComponent(ROOT)}&path=only-here.txt&rev=index`)).toEqual({ exists: false, content: '' });
    } finally {
      await run(`cd ${ROOT} && git reset -q -- a.txt && git checkout -q -- a.txt && rm -f only-here.txt`);
    }
  });

  it('a file new since the last commit has no old version; git failing is an error, not an empty one (AUDIT2 FS-17)', async () => {
    await run(`printf new > ${ROOT}/brand-new.txt`);
    expect(await t.json('GET', `/api/workspace/${h.id}/git/head?root=${encodeURIComponent(ROOT)}&path=brand-new.txt`)).toEqual({ exists: false, content: '' });
    // A broken repository: git cannot read HEAD.
    await run(`cd ${ROOT} && cp .git/HEAD /tmp/burrow-head && printf 'garbage' > .git/HEAD`);
    try {
      expect((await t.request('GET', `/api/workspace/${h.id}/git/head?root=${encodeURIComponent(ROOT)}&path=a.txt`)).json()).toMatchObject({ error: 'git_failed' });
    } finally {
      await run(`cd ${ROOT} && cp /tmp/burrow-head .git/HEAD && rm -f brand-new.txt`);
    }
  });

  it('reports a push without a remote clearly', async () => {
    expect((await g('push', {})).json()).toMatchObject({ error: 'git_failed' });
  });
  it('pushes to a remote and pulls what another clone pushed', async () => {
    const REMOTE = '/home/tester/wsproj-remote.git';
    const OTHER = '/home/tester/wsproj-other';
    await run(`rm -rf ${REMOTE} ${OTHER} && git init -q --bare -b main ${REMOTE} && cd ${ROOT} && git remote add origin ${REMOTE} && git push -q -u origin main`);
    await run(`printf 'pushed\\n' > ${ROOT}/a.txt`);
    expect((await g('stage', { paths: ['a.txt'] })).statusCode).toBe(200);
    expect((await g('commit', { message: 'second' })).statusCode).toBe(200);
    expect((await g('push', {})).statusCode).toBe(200);
    expect((await run(`git -C ${REMOTE} log --format=%s -1`))[0]!.stdout.trim()).toBe('second');
    // Someone else pushes; pull brings it here.
    await run(`git clone -q ${REMOTE} ${OTHER} && cd ${OTHER} && echo pulled > a.txt && git -c user.name=o -c user.email=o@example.com commit -qam third && git push -q`);
    expect((await g('pull', {})).statusCode).toBe(200);
    expect((await t.json<TextFile>('GET', `/api/files/${h.id}/text?path=${encodeURIComponent(`${ROOT}/a.txt`)}`)).content).toBe('pulled\n');
    await run(`rm -rf ${REMOTE} ${OTHER}`);
  });

  it("a repository in one of the workspace's other folders commits as the identity set once for the workspace (AUDIT2 UI-13)", async () => {
    const second = `${ROOT}-second`;
    await run(`mkdir -p ${second} && cd ${second} && git init -q -b main && printf x > x.txt`);
    try {
      await t.json('PUT', `/api/workspaces/${ws.id}`, { folders: [second] });
      expect((await t.request('POST', `/api/workspace/${h.id}/git/stage`, { root: second, paths: ['x.txt'] })).statusCode).toBe(200);
      const r = await t.request('POST', `/api/workspace/${h.id}/git/commit`, { root: second, message: 'in the other folder' });
      expect(r.json()).not.toMatchObject({ error: 'git_identity' });
      expect(r.statusCode).toBe(200);
      expect((await run(`cd ${second} && git log -1 --format=%an`))[0]!.stdout.trim()).toBe('Burrow Test');
    } finally {
      await t.json('PUT', `/api/workspaces/${ws.id}`, { folders: [] });
      await run(`rm -rf ${second}`);
    }
  });
});

describe('a repository planted on the host (A3-SRV-04)', () => {
  const PLANTED = '/home/tester/planted';
  const ran = async () => (await run('cat /tmp/burrow-planted-ran 2>/dev/null; rm -f /tmp/burrow-planted-ran; true'))[0]!.stdout.trim();

  it("git status, the old version and a commit run nothing of the repository's own: not its settings, not its hooks", async () => {
    await run(`rm -rf ${PLANTED} && mkdir -p ${PLANTED} && cd ${PLANTED} && git init -q -b main && git config user.name x && git config user.email x@example.com && printf 'a\\n' > a.txt && git -c user.name=x -c user.email=x@example.com commit -qm one --allow-empty`);
    const q = (path: string) => `/api/workspace/${h.id}/git/${path}root=${encodeURIComponent(PLANTED)}`;
    // An fsmonitor is switched off on every call: status works, nothing runs.
    await run(`cd ${PLANTED} && git config core.fsmonitor 'id > /tmp/burrow-planted-ran; false' && touch a.txt`);
    expect((await t.request('GET', q('status?'))).statusCode).toBe(200);
    expect(await ran()).toBe('');
    await run(`cd ${PLANTED} && git config --unset core.fsmonitor`);
    for (const setting of ["filter.x.clean 'id > /tmp/burrow-planted-ran; cat'", "diff.x.textconv 'id > /tmp/burrow-planted-ran; cat'", "credential.helper '!id > /tmp/burrow-planted-ran'", "credential.helper 'x; id > /tmp/burrow-planted-ran #'", "credential.helper \"$(printf 'store\\nid > /tmp/burrow-planted-ran')\"", "gpg.ssh.defaultKeyCommand 'id > /tmp/burrow-planted-ran'"]) {
      await run(`cd ${PLANTED} && git config ${setting} && printf '* filter=x diff=x\\n' > .gitattributes && touch a.txt`);
      const r = await t.request('GET', q('status?'));
      expect(r.statusCode, setting).toBe(409);
      expect(r.json(), setting).toMatchObject({ error: 'git_unsafe_config' });
      expect((await t.request('GET', `${q('head?')}&path=a.txt`)).statusCode, setting).toBe(409);
      expect((await t.request('POST', `/api/workspace/${h.id}/git/stage`, { root: PLANTED, paths: ['a.txt'] })).statusCode, setting).toBe(409);
      expect(await ran(), setting).toBe('');
      await run(`cd ${PLANTED} && git config --unset ${setting.split(' ')[0]} && rm -f .gitattributes`);
    }
    // An include that brings such a setting in counts too.
    await run(`printf '[filter \\"y\\"]\\n\\tclean = id > /tmp/burrow-planted-ran\\n' > /tmp/burrow-planted-inc && cd ${PLANTED} && git config include.path /tmp/burrow-planted-inc`);
    expect((await t.request('GET', q('status?'))).statusCode).toBe(409);
    await run(`cd ${PLANTED} && git config --unset include.path && rm -f /tmp/burrow-planted-inc`);
    // A hook the repository brings does not run on a commit from Burrow (husky's own hooks folder neither).
    await run(`cd ${PLANTED} && git config core.hooksPath .husky && mkdir -p .husky && printf '#!/bin/sh\\nid > /tmp/burrow-planted-ran\\n' > .husky/pre-commit && chmod +x .husky/pre-commit`);
    await run(`printf '#!/bin/sh\\nid > /tmp/burrow-planted-ran\\n' > ${PLANTED}/.git/hooks/pre-commit && chmod +x ${PLANTED}/.git/hooks/pre-commit && printf 'b\\n' > ${PLANTED}/a.txt`);
    expect((await t.request('GET', q('status?'))).statusCode).toBe(200);
    expect((await t.request('POST', `/api/workspace/${h.id}/git/stage`, { root: PLANTED, paths: ['a.txt'] })).statusCode).toBe(200);
    const c = await t.request('POST', `/api/workspace/${h.id}/git/commit`, { root: PLANTED, message: 'two' });
    expect(c.statusCode, c.body).toBe(200);
    expect(await ran()).toBe('');
    await run(`rm -rf ${PLANTED}`);
  });
});

describe('sudo', () => {
  const path = '/etc/burrowtest.conf';

  it('cannot read root files normally, can through sudo with the stored password', async () => {
    expect((await t.request('GET', `/api/files/${h.id}/text?path=${encodeURIComponent(path)}`)).statusCode).toBe(403);
    const f = await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path });
    expect(f).toMatchObject({ content: 'listen 80;\n', mode: 0o600 });
    const saved = await t.json<TextFile>('PUT', `/api/files/${h.id}/sudo/text`, { path, content: 'listen 8080;\n', baseHash: f.hash });
    expect(saved.content).toBe('listen 8080;\n');
    // Owner and mode kept.
    const ls = await run(`stat -c '%U %a' ${path}`);
    expect(ls[0]!.stdout.trim()).toBe('root 600');
  });

  it('a folder only root may read: refused as the host user, listed through sudo with its links (report 4d30e6)', async () => {
    const dir = '/srv/burrowtest-root';
    expect((await t.request('GET', `/api/files/${h.id}/list?path=${encodeURIComponent(dir)}`)).statusCode).toBe(403);
    const l = await t.json<DirListing>('POST', `/api/files/${h.id}/sudo/list`, { path: `${dir}/` });
    expect(l).toMatchObject({ path: dir, parent: '/srv' });
    const by = (n: string) => l.entries.find((e) => e.name === n);
    expect(l.entries.map((e) => e.name).sort()).toEqual(['conf.d', 'current.conf', 'db.conf']);
    expect(by('db.conf')).toMatchObject({ path: `${dir}/db.conf`, type: 'file', size: 10, mode: 0o600, owner: 'root', group: 'root' });
    expect(by('conf.d')).toMatchObject({ type: 'dir' });
    expect(by('current.conf')).toMatchObject({ type: 'link', target: 'db.conf', targetType: 'file' });
    expect(Date.parse(by('db.conf')!.mtime)).toBeGreaterThan(0);
    // Its files open through sudo as any other root file.
    expect((await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path: `${dir}/current.conf` })).content).toBe('port 5432\n');
    // A wrong password said as such, a file is no folder.
    expect((await t.request('POST', `/api/files/${h.id}/sudo/list`, { path: dir, password: 'wrong' })).statusCode).toBe(401);
    expect((await t.request('POST', `/api/files/${h.id}/sudo/list`, { path: `${dir}/db.conf` })).statusCode).toBe(400);
  });

  it('a sudo save replaces the file in one step (never truncated first), through a symlink to its target', async () => {
    const before = (await run(`stat -c '%i' ${path}`))[0]!.stdout.trim();
    let f = await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path });
    await t.json('PUT', `/api/files/${h.id}/sudo/text`, { path, content: 'listen 8081;\n', baseHash: f.hash });
    // A new file renamed into place (another inode): "cat > file" truncated it first, and a failure left it empty.
    expect((await run(`stat -c '%i %U %a' ${path}`))[0]!.stdout.trim()).not.toBe(`${before} root 600`);
    expect((await run(`stat -c '%U %a' ${path}`))[0]!.stdout.trim()).toBe('root 600');
    const link = '/etc/burrowtest-link.conf';
    await run(`echo burrow-test-password | sudo -S -p '' ln -sf ${path} ${link}`);
    f = await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path: link });
    await t.json('PUT', `/api/files/${h.id}/sudo/text`, { path: link, content: 'listen 8082;\n', baseHash: f.hash });
    expect((await run(`test -L ${link} && echo link; echo burrow-test-password | sudo -S -p '' cat ${path}`))[0]!.stdout).toBe('link\nlisten 8082;\n');
    // No staging file left beside it.
    expect((await run(`ls -a /etc | grep -c burrow- || true`))[0]!.stdout.trim()).toBe('0');
  });

  it('a link to a file too large for the editor is refused through sudo too, not opened cut off (AUDIT2 FS-03)', async () => {
    const big = '/etc/burrowtest-big.txt';
    const link = '/etc/burrowtest-big-link.txt';
    await run(`echo burrow-test-password | sudo -S -p '' sh -c 'head -c 6000000 /dev/zero | tr "\\0" a > ${big} && chmod 600 ${big} && ln -sf ${big} ${link}'`);
    const r = await t.request('POST', `/api/files/${h.id}/sudo/read`, { path: link });
    expect(r.statusCode).toBe(413);
    // A save over it is refused as well (it cannot be read whole to compare).
    expect((await t.request('PUT', `/api/files/${h.id}/sudo/text`, { path: link, content: 'short\n', baseHash: 'a'.repeat(64) })).statusCode).toBe(413);
    expect((await run(`echo burrow-test-password | sudo -S -p '' stat -c %s ${big}`))[0]!.stdout.trim()).toBe('6000000');
    await run(`echo burrow-test-password | sudo -S -p '' rm -f ${big} ${link}`);
  });

  it('a sudo save with a NUL or over 5 MB of bytes is refused before the file changes (AUDIT2 FS-08)', async () => {
    const f = await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path });
    expect((await t.request('PUT', `/api/files/${h.id}/sudo/text`, { path, content: 'x\u0000y', baseHash: f.hash })).statusCode).toBe(415);
    expect((await t.request('PUT', `/api/files/${h.id}/sudo/text`, { path, content: 'é'.repeat(3_000_000), baseHash: f.hash })).statusCode).toBe(413);
    expect((await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path })).hash).toBe(f.hash);
  });

  it("a sudo save through a link that root does not own is refused; root's own links are followed (A3-SRV-21)", async () => {
    const link = '/home/tester/burrowtest-userlink.conf';
    const dir = '/home/tester/burrowtest-userdir';
    await run(`rm -rf ${link} ${dir} && ln -s ${path} ${link} && ln -s /etc ${dir}`);
    const f = await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path: link });
    for (const p of [link, `${dir}/burrowtest.conf`]) {
      const r = await t.request('PUT', `/api/files/${h.id}/sudo/text`, { path: p, content: 'listen 6666;\n', baseHash: f.hash });
      expect(r.statusCode, p).toBe(409);
      expect(r.json(), p).toMatchObject({ error: 'sudo_link' });
    }
    expect((await t.json<TextFile>('POST', `/api/files/${h.id}/sudo/read`, { path })).hash).toBe(f.hash);
    await run(`rm -f ${link} ${dir}`);
  });

  it('says so when the sudo password is wrong', async () => {
    expect((await t.request('POST', `/api/files/${h.id}/sudo/read`, { path, password: 'wrong' })).json()).toMatchObject({ error: 'sudo_wrong_password' });
  });
});
