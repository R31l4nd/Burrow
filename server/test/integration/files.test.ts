import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, DirListing, Host, TextFile, UploadState } from '@burrow/shared';
import type { JobView } from '../../src/files/jobs.js';
import { archive, copyLocal, sourcesUnchanged, treeChecksums, untarCommand } from '../../src/files/service.js';
import { createHash } from 'node:crypto';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';
import { shellQuote } from '../../src/ssh/quote.js';

// File management against two throwaway sshd hosts.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT_A = Number(process.env.SSHD_PORT ?? 2299);
const PORT_B = Number(process.env.SSHD2_PORT ?? 2298);
const HOME = '/home/tester';

let t: TestApp;
let a: Host;
let b: Host;

async function addHost(name: string, port: number): Promise<Host> {
  const h = await t.json<Host>('POST', '/api/hosts', { name, address: SSHD_HOST, port, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  return h;
}

const ls = (h: Host, path: string) => t.json<DirListing>('GET', `/api/files/${h.id}/list?path=${encodeURIComponent(path)}`);
const names = async (h: Host, path: string) => (await ls(h, path)).entries.map((e) => e.name).sort();
/** A shell command on host a (to set up and look at files). */
const run = (command: string) => t.json<{ exitCode: number; stdout: string; stderr: string }[]>('POST', '/api/snippets/run', { hostIds: [a.id], command });

async function waitJob(job: JobView): Promise<JobView> {
  for (let i = 0; i < 200; i++) {
    const j = await t.json<JobView>('GET', `/api/files/jobs/${job.id}`);
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job did not finish: ${JSON.stringify(await t.json('GET', `/api/files/jobs/${job.id}`))}`);
}

// On disk: one test starts a second Burrow on the same database (a restart).
const dbFile = join(mkdtempSync(join(tmpdir(), 'burrow-files-')), 'burrow.db');

beforeAll(async () => {
  t = await makeApp({ dbFile });
  await setupAdmin(t);
  a = await addHost('host-a', PORT_A);
  b = await addHost('host-b', PORT_B);
});
afterAll(async () => {
  await t.close();
});

describe('browsing and editing', () => {
  it('lists the home directory with types, sizes and owners', async () => {
    const l = await ls(a, '~');
    expect(l).toMatchObject({ path: HOME, home: HOME, parent: '/home' });
    const bashrc = l.entries.find((e) => e.name === '.bashrc')!;
    expect(bashrc).toMatchObject({ type: 'file', owner: 'tester', group: 'tester' });
    expect(bashrc.size).toBeGreaterThan(0);
  });

  it('creates, renames and refuses to overwrite', async () => {
    await t.json('POST', `/api/files/${a.id}/create`, { path: `${HOME}/work`, kind: 'dir' });
    await t.json('POST', `/api/files/${a.id}/create`, { path: `${HOME}/work/notes.txt`, kind: 'file' });
    expect((await t.request('POST', `/api/files/${a.id}/create`, { path: `${HOME}/work/notes.txt`, kind: 'file' })).json()).toMatchObject({ error: 'exists' });
    await t.json('POST', `/api/files/${a.id}/rename`, { from: `${HOME}/work/notes.txt`, to: `${HOME}/work/readme.txt` });
    expect(await names(a, `${HOME}/work`)).toEqual(['readme.txt']);
  });

  it("says whether the SSH user may save a file it reads: root's /etc/passwd not, its own yes (W-FUNC-01)", async () => {
    const root = await t.json<TextFile>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent('/etc/passwd')}`);
    expect(root.writable).toBe(false);
    expect(root.content).toContain('tester');
    const own = await t.json<TextFile>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(`${HOME}/.bashrc`)}`);
    expect(own.writable).toBe(true);
  });

  it('saves atomically, keeps the mode and detects a conflict', async () => {
    const path = `${HOME}/work/script.sh`;
    const created = await t.json<TextFile>('PUT', `/api/files/${a.id}/text`, { path, content: '#!/bin/sh\necho one\n', baseHash: null });
    await t.json('POST', `/api/files/${a.id}/chmod`, { path, mode: 0o750 });
    const first = await t.json<TextFile>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(path)}`);
    expect(first).toMatchObject({ content: '#!/bin/sh\necho one\n', hash: created.hash, mode: 0o750 });

    const saved = await t.json<TextFile>('PUT', `/api/files/${a.id}/text`, { path, content: '#!/bin/sh\necho two\n', baseHash: first.hash });
    expect(saved.mode).toBe(0o750);
    // No temporary file is left behind.
    expect((await names(a, `${HOME}/work`)).filter((n) => n.includes('burrow'))).toEqual([]);

    // Someone else saved in between: 409 with the current text for a diff.
    const r = await t.request('PUT', `/api/files/${a.id}/text`, { path, content: 'mine\n', baseHash: first.hash });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'conflict', current: { content: '#!/bin/sh\necho two\n' } });
  });

  it('saves what it opens: a file of a few MB too (the request was refused above 1 MB)', async () => {
    const path = `${HOME}/work/big.txt`;
    const content = 'x'.repeat(99) + '\n';
    const big = content.repeat(30_000); // 3 MB
    const saved = await t.json<{ hash: string; size: number }>('PUT', `/api/files/${a.id}/text`, { path, content: big, baseHash: null });
    expect(saved.size).toBe(big.length);
    expect((await t.json<{ content: string }>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(path)}`)).content.length).toBe(big.length);
  });

  it('saving through a symlink writes its target and keeps the link', async () => {
    await run(`printf 'old\\n' > ${HOME}/work/real.conf && ln -sf ${HOME}/work/real.conf ${HOME}/work/link.conf`);
    const f = await t.json<{ hash: string; content: string }>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(`${HOME}/work/link.conf`)}`);
    expect(f.content).toBe('old\n');
    await t.json('PUT', `/api/files/${a.id}/text`, { path: `${HOME}/work/link.conf`, content: 'new\n', baseHash: f.hash });
    // The link was replaced by a plain file, and the target kept the old text.
    expect((await run(`test -L ${HOME}/work/link.conf && echo link; cat ${HOME}/work/real.conf`))[0]!.stdout).toBe('link\nnew\n');
  });

  it('a save too large in bytes or with a NUL in it is refused before the file changes (AUDIT2 FS-08)', async () => {
    const path = `${HOME}/work/bytes.txt`;
    await run(`printf 'keep me\\n' > ${path}`);
    const f = await t.json<TextFile>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(path)}`);
    // Within the character limit, over the 5 MB of bytes the editor opens (two bytes a character).
    const wide = await t.request('PUT', `/api/files/${a.id}/text`, { path, content: 'é'.repeat(3_000_000), baseHash: f.hash });
    expect(wide.statusCode).toBe(413);
    const nul = await t.request('PUT', `/api/files/${a.id}/text`, { path, content: 'a\u0000b\n', baseHash: f.hash });
    expect(nul.statusCode).toBe(415);
    // The file as it was, and it opens.
    const after = await t.json<TextFile>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(path)}`);
    expect(after).toMatchObject({ content: 'keep me\n', hash: f.hash });
  });

  it('two saves of one file by two spellings (a linked folder) at once: one is saved, the other told of the conflict (AUDIT2 FS-02)', async () => {
    await run(`mkdir -p ${HOME}/work/realdir && printf 'base\\n' > ${HOME}/work/realdir/f.txt && ln -sfn ${HOME}/work/realdir ${HOME}/work/aliasdir`);
    const f = await t.json<TextFile>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(`${HOME}/work/realdir/f.txt`)}`);
    const [x, y] = await Promise.all(
      [`${HOME}/work/realdir/f.txt`, `${HOME}/work/aliasdir/f.txt`].map((path, i) => t.request('PUT', `/api/files/${a.id}/text`, { path, content: `edit ${i}\n`, baseHash: f.hash })),
    );
    expect([x!.statusCode, y!.statusCode].sort()).toEqual([200, 409]);
  });

  it('two saves from the same version at once: one is saved, the other told of the conflict', async () => {
    const path = `${HOME}/work/race.txt`;
    await run(`printf 'base\\n' > ${path}`);
    const f = await t.json<{ hash: string }>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(path)}`);
    const [x, y] = await Promise.all(['one\n', 'two\n'].map((content) => t.request('PUT', `/api/files/${a.id}/text`, { path, content, baseHash: f.hash })));
    expect([x!.statusCode, y!.statusCode].sort()).toEqual([200, 409]);
    // A new file the same way: one creates it, the other is told it exists now.
    const fresh = `${HOME}/work/race-new.txt`;
    const [n1, n2] = await Promise.all(['a\n', 'b\n'].map((content) => t.request('PUT', `/api/files/${a.id}/text`, { path: fresh, content, baseHash: null })));
    expect([n1!.statusCode, n2!.statusCode].sort()).toEqual([200, 409]);
  });

  it('serves ranges, and never a host file as a page', async () => {
    await t.json('PUT', `/api/files/${a.id}/text`, { path: `${HOME}/work/page.html`, content: '<script>alert(1)</script>', baseHash: null });
    const html = await t.request('GET', `/api/files/${a.id}/raw?path=${encodeURIComponent(`${HOME}/work/page.html`)}`);
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(html.headers['content-disposition']).toMatch(/^attachment/);
    expect(html.headers['x-content-type-options']).toBe('nosniff');

    const txt = `${HOME}/work/readme.txt`;
    await t.json('PUT', `/api/files/${a.id}/text`, { path: txt, content: '0123456789', baseHash: (await t.json<TextFile>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(txt)}`)).hash });
    const res = await t.app.inject({ method: 'GET', url: `/api/files/${a.id}/raw?path=${encodeURIComponent(txt)}`, headers: { cookie: t.cookie!, range: 'bytes=2-5' } });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('names a download so a phone keeps its name: an ASCII filename before filename* (report 1fb877)', async () => {
    const dir = `${HOME}/names`;
    await t.json('POST', `/api/files/${a.id}/create`, { path: dir, kind: 'dir' });
    const plain = `${dir}/notes.bin`;
    const odd = `${dir}/caf\u00e9 "x".bin`;
    for (const p of [plain, odd]) await t.json('POST', `/api/files/${a.id}/create`, { path: p, kind: 'file' });
    const disposition = async (p: string) => (await t.request('GET', `/api/files/${a.id}/raw?path=${encodeURIComponent(p)}&download=1`)).headers['content-disposition'];
    // Android's URLUtil.guessFileName reads only filename="...": without it the file was saved as "raw.bin".
    expect(await disposition(plain)).toBe('attachment; filename="notes.bin"');
    expect(await disposition(odd)).toBe(`attachment; filename="caf_ _x_.bin"; filename*=UTF-8''caf%C3%A9%20%22x%22.bin`);
  });

  it('changes the owner, and says so when that is not allowed', async () => {
    const path = `${HOME}/work/owned.txt`;
    await t.json('POST', `/api/files/${a.id}/create`, { path, kind: 'file' });
    expect(await t.json('POST', `/api/files/${a.id}/chown`, { path, owner: 'tester', group: 'tester' })).toEqual({ ok: true });
    expect((await ls(a, `${HOME}/work`)).entries.find((e) => e.name === 'owned.txt')).toMatchObject({ owner: 'tester', group: 'tester' });
    // Not root: another owner is refused with a reason, not a crash.
    const r = await t.request('POST', `/api/files/${a.id}/chown`, { path, owner: 'root' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('refuses to open binaries in the editor', async () => {
    const r = await t.request('GET', `/api/files/${a.id}/text?path=${encodeURIComponent('/usr/bin/tmux')}`);
    expect(r.json()).toMatchObject({ error: 'binary' });
  });
});

describe('uploads', () => {
  it('uploads in chunks, resumes after an interruption and renames into place', async () => {
    const data = Buffer.alloc(300_000, 7);
    data.write('start', 0);
    const init = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'photo.bin', size: data.length });
    const put = (offset: number, chunk: Buffer) =>
      t.app.inject({ method: 'PUT', url: `/api/files/uploads/${init.id}?offset=${offset}`, headers: { cookie: t.cookie!, origin: 'http://localhost:8080', 'content-type': 'application/octet-stream' }, payload: chunk });
    expect((await put(0, data.subarray(0, 100_000))).statusCode).toBe(200);
    // "Connection lost": ask where to resume.
    const state = await t.json<UploadState>('GET', `/api/files/uploads/${init.id}`);
    expect(state.offset).toBe(100_000);
    // A chunk beyond what arrived is refused.
    expect((await put(200_000, data.subarray(200_000))).statusCode).toBe(409);
    expect((await put(100_000, data.subarray(100_000))).statusCode).toBe(200);
    await t.json('POST', `/api/files/uploads/${init.id}/finish`);
    const got = await t.app.inject({ method: 'GET', url: `/api/files/${a.id}/raw?path=${encodeURIComponent(`${HOME}/work/photo.bin`)}&download=1`, headers: { cookie: t.cookie! } });
    expect(got.rawPayload.equals(data)).toBe(true);
    expect((await names(a, `${HOME}/work`)).filter((n) => n.includes('burrow-upload'))).toEqual([]);
  });
  it('"do not overwrite" holds at the end too, and a replaced file keeps its mode', async () => {
    const put = (id: string, chunk: Buffer) =>
      t.app.inject({ method: 'PUT', url: `/api/files/uploads/${id}?offset=0`, headers: { cookie: t.cookie!, origin: 'http://localhost:8080', 'content-type': 'application/octet-stream' }, payload: chunk });
    // Two uploads of one new name, both "do not overwrite": the second must not replace the first.
    const one = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'twice.txt', size: 5 });
    const two = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'twice.txt', size: 5 });
    await put(one.id, Buffer.from('first'));
    await put(two.id, Buffer.from('other'));
    await t.json('POST', `/api/files/uploads/${one.id}/finish`);
    expect((await t.request('POST', `/api/files/uploads/${two.id}/finish`)).statusCode).toBe(409);
    expect((await t.json<{ content: string }>('GET', `/api/files/${a.id}/text?path=${encodeURIComponent(`${HOME}/work/twice.txt`)}`)).content).toBe('first');
    // That upload is over, and its temporary file gone.
    expect((await names(a, `${HOME}/work`)).filter((n) => n.includes('burrow-upload'))).toEqual([]);
    // Overwriting a secret (0600) or a script (0755): the mode stays, it was 0644 after.
    for (const mode of ['600', '755']) {
      await t.json('POST', `/api/files/${a.id}/chmod`, { path: `${HOME}/work/twice.txt`, mode: parseInt(mode, 8) });
      const up = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'twice.txt', size: 3, overwrite: true });
      await put(up.id, Buffer.from('new'));
      await t.json('POST', `/api/files/uploads/${up.id}/finish`);
      const listing = await t.json<{ entries: { name: string; mode: number }[] }>('GET', `/api/files/${a.id}/list?path=${encodeURIComponent(`${HOME}/work`)}`);
      expect((listing.entries.find((e) => e.name === 'twice.txt')!.mode & 0o777).toString(8)).toBe(mode);
    }
  });

  it('goes on after Burrow restarted, where it was (audit BE-14)', async () => {
    const data = Buffer.alloc(120_000, 3);
    const init = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'across.bin', size: data.length });
    const put = (app: TestApp, offset: number, chunk: Buffer) =>
      app.app.inject({ method: 'PUT', url: `/api/files/uploads/${init.id}?offset=${offset}`, headers: { cookie: t.cookie!, origin: 'http://localhost:8080', 'content-type': 'application/octet-stream' }, payload: chunk });
    expect((await put(t, 0, data.subarray(0, 60_000))).statusCode).toBe(200);
    // Burrow restarted: another one on the same database, the same sign-in.
    const after = await makeApp({ dbFile });
    try {
      after.cookie = t.cookie;
      after.clock.now = t.clock.now;
      expect(await after.json<UploadState>('GET', `/api/files/uploads/${init.id}`)).toMatchObject({ offset: 60_000 });
      expect((await put(after, 60_000, data.subarray(60_000))).statusCode).toBe(200);
      await after.json('POST', `/api/files/uploads/${init.id}/finish`);
      const got = await after.app.inject({ method: 'GET', url: `/api/files/${a.id}/raw?path=${encodeURIComponent(`${HOME}/work/across.bin`)}&download=1`, headers: { cookie: t.cookie! } });
      expect(got.rawPayload.equals(data)).toBe(true);
    } finally {
      await after.close();
    }
  });

  it('a cancelled upload leaves nothing behind', async () => {
    const init = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'half.bin', size: 200_000 });
    await t.app.inject({ method: 'PUT', url: `/api/files/uploads/${init.id}?offset=0`, headers: { cookie: t.cookie!, origin: 'http://localhost:8080', 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(50_000, 1) });
    expect((await names(a, `${HOME}/work`)).filter((n) => n.includes('half.bin'))).toHaveLength(1);
    expect((await t.request('DELETE', `/api/files/uploads/${init.id}`)).statusCode).toBe(204);
    expect((await names(a, `${HOME}/work`)).filter((n) => n.includes('half.bin'))).toEqual([]);
    expect((await t.request('GET', `/api/files/uploads/${init.id}`)).statusCode).toBe(404);
  });
  it('one left alone for a day is given up, its temporary file removed', async () => {
    const init = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'left.bin', size: 200_000 });
    await t.app.inject({ method: 'PUT', url: `/api/files/uploads/${init.id}?offset=0`, headers: { cookie: t.cookie!, origin: 'http://localhost:8080', 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(50_000, 1) });
    t.clock.now += 25 * 60 * 60_000;
    // The next upload started sweeps the old one away.
    const next = await t.json<UploadState>('POST', `/api/files/${a.id}/uploads`, { dir: `${HOME}/work`, name: 'next.bin', size: 10 });
    await expect.poll(async () => (await names(a, `${HOME}/work`)).filter((n) => n.includes('left.bin'))).toEqual([]);
    expect((await t.request('GET', `/api/files/uploads/${init.id}`)).statusCode).toBe(404);
    await t.request('DELETE', `/api/files/uploads/${next.id}`);
    t.clock.now -= 25 * 60 * 60_000;
  });
});

describe('copy, move, archives', () => {
  it('copies a folder within a host and between hosts', async () => {
    await t.json('POST', `/api/files/${a.id}/create`, { path: `${HOME}/work/sub`, kind: 'dir' });
    await t.json('PUT', `/api/files/${a.id}/text`, { path: `${HOME}/work/sub/deep.txt`, content: 'deep\n', baseHash: null });

    const local = await waitJob(await t.json<JobView>('POST', '/api/files/transfer', { fromHostId: a.id, toHostId: a.id, paths: [`${HOME}/work`], toDir: '/tmp' }));
    expect(local.status).toBe('done');
    expect(await names(a, '/tmp/work')).toEqual(expect.arrayContaining(['sub', 'script.sh', 'photo.bin']));

    // The phase 3 criterion: a folder from host A to host B.
    const cross = await waitJob(await t.json<JobView>('POST', '/api/files/transfer', { fromHostId: a.id, toHostId: b.id, paths: [`${HOME}/work`], toDir: HOME }));
    expect(cross).toMatchObject({ status: 'done', phase: null, unverified: null });
    expect(cross.bytes).toBeGreaterThan(300_000);
    // Every file's sha256 the same on both hosts (N8): each of the folder's files counted.
    expect(cross.verified).toBe(Number((await run(`find ${HOME}/work -type f | wc -l`))[0]!.stdout.trim()));
    expect(await names(b, `${HOME}/work/sub`)).toEqual(['deep.txt']);
    const onB = await t.json<TextFile>('GET', `/api/files/${b.id}/text?path=${encodeURIComponent(`${HOME}/work/script.sh`)}`);
    expect(onB).toMatchObject({ content: '#!/bin/sh\necho two\n', mode: 0o750 });

    // Again without overwrite: a clash is reported, nothing is touched.
    const clash = await waitJob(await t.json<JobView>('POST', '/api/files/transfer', { fromHostId: a.id, toHostId: b.id, paths: [`${HOME}/work`], toDir: HOME }));
    expect(clash).toMatchObject({ status: 'failed', error: expect.stringContaining('Already in the destination') });
  });

  it('a name taken at the destination: both kept as "name (1)", skipped, or replaced, as asked (report dfda31)', async () => {
    const go = async (body: Record<string, unknown>) => waitJob(await t.json<JobView>('POST', '/api/files/transfer', { fromHostId: a.id, toHostId: a.id, toDir: '/tmp/clash/to', ...body }));
    const cat = async (f: string) => (await run(`cat ${shellQuote(f)}`))[0]!.stdout;
    await run(`rm -rf /tmp/clash && mkdir -p /tmp/clash/src/dir /tmp/clash/to/dir && cd /tmp/clash && echo new > src/a.txt && echo arch > src/b.tar.gz && echo in > src/dir/in && echo m > src/m.txt && echo n > src/new.txt && echo old > to/a.txt && echo old1 > 'to/a (1).txt' && echo oldm > to/m.txt && echo oldb > to/b.tar.gz`);
    const src = (n: string) => `/tmp/clash/src/${n}`;

    // A copy into its own folder: beside it, as "a (1).txt".
    expect(await go({ paths: [src('a.txt')], toDir: '/tmp/clash/src', clash: 'rename' })).toMatchObject({ status: 'done' });
    expect(await cat('/tmp/clash/src/a (1).txt')).toBe('new\n');
    // Into another: the next free number, a .tar.gz kept together, a folder's whole name; nothing replaced.
    expect(await go({ paths: [src('a.txt'), src('b.tar.gz'), src('dir')], clash: 'rename' })).toMatchObject({ status: 'done' });
    expect(await cat('/tmp/clash/to/a (2).txt')).toBe('new\n');
    expect(await cat('/tmp/clash/to/b (1).tar.gz')).toBe('arch\n');
    expect(await cat('/tmp/clash/to/dir (1)/in')).toBe('in\n');
    expect([await cat('/tmp/clash/to/a.txt'), await cat('/tmp/clash/to/a (1).txt'), await cat('/tmp/clash/to/b.tar.gz')]).toEqual(['old\n', 'old1\n', 'oldb\n']);
    // A move: the source gone, the one there kept.
    expect(await go({ paths: [src('m.txt')], move: true, clash: 'rename' })).toMatchObject({ status: 'done' });
    expect([await cat('/tmp/clash/to/m.txt'), await cat('/tmp/clash/to/m (1).txt')]).toEqual(['oldm\n', 'm\n']);
    expect((await run('ls /tmp/clash/src/m.txt 2>/dev/null | wc -l'))[0]!.stdout.trim()).toBe('0');
    // Skipped: the rest copied, the one there untouched, and said how many.
    expect(await go({ paths: [src('a.txt'), src('new.txt')], clash: 'skip' })).toMatchObject({ status: 'done', skipped: 1 });
    expect([await cat('/tmp/clash/to/a.txt'), await cat('/tmp/clash/to/new.txt')]).toEqual(['old\n', 'n\n']);
    // Replaced.
    expect(await go({ paths: [src('a.txt')], clash: 'replace' })).toMatchObject({ status: 'done' });
    expect(await cat('/tmp/clash/to/a.txt')).toBe('new\n');
    // No folder of its own left behind.
    expect((await run('ls -a /tmp/clash/to /tmp/clash/src | grep -c burrow-copy || true'))[0]!.stdout.trim()).toBe('0');

    // Between hosts: beside it, checked like any copy.
    await t.json('PUT', `/api/files/${b.id}/text`, { path: `${HOME}/clash.txt`, content: 'on b\n', baseHash: null });
    await run(`echo from-a > ${HOME}/clash.txt`);
    expect(await waitJob(await t.json<JobView>('POST', '/api/files/transfer', { fromHostId: a.id, toHostId: b.id, paths: [`${HOME}/clash.txt`], toDir: HOME, clash: 'rename' }))).toMatchObject({ status: 'done', verified: 1 });
    const onB = async (n: string) => (await t.json<TextFile>('GET', `/api/files/${b.id}/text?path=${encodeURIComponent(`${HOME}/${n}`)}`)).content;
    expect([await onB('clash.txt'), await onB('clash (1).txt')]).toEqual(['on b\n', 'from-a\n']);
  });

  it('two copies, moves or archives to one new name at once: one is made, the other refused, nothing replaced (AUDIT2 FS-01)', async () => {
    for (let round = 0; round < 3; round++) {
      await run(`rm -rf /tmp/race && mkdir -p /tmp/race/x /tmp/race/y /tmp/race/to && echo from-x > /tmp/race/x/f.txt && echo from-y > /tmp/race/y/f.txt && mkdir /tmp/race/x/d /tmp/race/y/d && echo x > /tmp/race/x/d/in && echo y > /tmp/race/y/d/in`);
      await t.files.with(a.id, async ({ client }) => {
        for (const [what, go] of [
          ['copy', (from: string) => copyLocal(client, [`/tmp/race/${from}/f.txt`], '/tmp/race/to', false, false)],
          ['move', (from: string) => copyLocal(client, [`/tmp/race/${from}/d`], '/tmp/race/to', true, false)],
          ['archive', (from: string) => archive(client, [`/tmp/race/${from}/f.txt`], '/tmp/race/to/a.tar.gz')],
        ] as const) {
          const res = await Promise.allSettled(['x', 'y'].map((from) => go(from)));
          expect(res.map((r) => r.status).sort(), `${what} round ${round}`).toEqual(['fulfilled', 'rejected']);
          expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
        }
      });
      // The copy is the winner's, whole; the moved folder is one of them, the other still where it was.
      const winner = (await run('cat /tmp/race/to/f.txt'))[0]!.stdout.trim();
      expect(['from-x', 'from-y']).toContain(winner);
      const inside = (await run('cat /tmp/race/to/d/in; ls /tmp/race/to/d; ls -d /tmp/race/x/d /tmp/race/y/d 2>/dev/null | wc -l'))[0]!.stdout.trim().split('\n');
      expect(inside[1]).toBe('in');
      expect(inside[2]).toBe('1');
      expect((await run('ls -a /tmp/race/to | grep -c burrow || true'))[0]!.stdout.trim()).toBe('0');
    }
  });

  it("between hosts the destination, as root, unpacks only what was asked for, its own, without set-user-id bits (audit 2026-11-05)", async () => {
    // What a source that is not to be trusted sends: the folder asked for with someone else's
    // set-user-id program in it, and a .ssh beside it. Unpacked as root, as on a host whose SSH user is root.
    const script = Buffer.from(untarCommand('/tmp/evilto', ['photos'], true)).toString('base64');
    const sudo = (cmd: string) => run(`echo burrow-test-password | sudo -S -p '' sh -c '${cmd}'`);
    await sudo('rm -rf /tmp/evilsrc /tmp/evilto && mkdir -p /tmp/evilsrc/photos /tmp/evilsrc/.ssh /tmp/evilto && echo b > /tmp/evilsrc/photos/run && chown 4242:4242 /tmp/evilsrc/photos/run && chmod 4755 /tmp/evilsrc/photos/run && echo evil > /tmp/evilsrc/.ssh/authorized_keys');
    await run(`echo ${script} | base64 -d > /tmp/untar.sh`);
    const r = await sudo('tar -C /tmp/evilsrc -cf - photos .ssh | sh /tmp/untar.sh; echo "exit $?"; ls -A /tmp/evilto; stat -c "%u %a" /tmp/evilto/photos/run');
    expect(r[0]!.stdout.trim().split('\n')).toEqual(['exit 0', 'photos', '0 755']);
    await sudo('rm -rf /tmp/evilsrc /tmp/evilto /tmp/untar.sh');
  });

  it('moves between hosts: the source goes only after the copy', async () => {
    await t.json('PUT', `/api/files/${a.id}/text`, { path: '/tmp/moveme.txt', content: 'x\n', baseHash: null });
    const j = await waitJob(await t.json<JobView>('POST', '/api/files/transfer', { fromHostId: a.id, toHostId: b.id, paths: ['/tmp/moveme.txt'], toDir: '/tmp', move: true }));
    expect(j).toMatchObject({ status: 'done', verified: 1 });
    expect(await names(b, '/tmp')).toContain('moveme.txt');
    expect(await names(a, '/tmp')).not.toContain('moveme.txt');
  });

  it('checksums: a listing that fails is not an empty list, and a source changed after the check is reported (AUDIT2 FS-11, FS-05)', async () => {
    await run('rm -rf /tmp/sumtest && mkdir -p /tmp/sumtest/d && echo one > /tmp/sumtest/d/a.txt && echo two > /tmp/sumtest/d/b.txt');
    await t.files.with(a.id, async ({ client }) => {
      // A name that is not there: find fails; that failure is not "no files".
      await expect(treeChecksums(client, '/tmp/sumtest', ['d', 'missing'])).rejects.toThrow(/^checksums: find: .*missing/);
      const checked = await treeChecksums(client, '/tmp/sumtest', ['d']);
      expect([...checked!.keys()]).toEqual(['./d/a.txt', './d/b.txt']);
      expect(await sourcesUnchanged(client, ['/tmp/sumtest/d'], new Map([['/tmp/sumtest', checked!]]))).toEqual([]);
    });
    // Changed and added after the check: both named, so a move keeps the sources.
    await run('echo changed > /tmp/sumtest/d/a.txt && echo new > /tmp/sumtest/d/c.txt');
    await t.files.with(a.id, async ({ client }) => {
      const before = new Map([['./d/a.txt', createHash('sha256').update('one\n').digest('hex')], ['./d/b.txt', createHash('sha256').update('two\n').digest('hex')]]);
      expect((await sourcesUnchanged(client, ['/tmp/sumtest/d'], new Map([['/tmp/sumtest', before]]))).sort()).toEqual(['d/a.txt', 'd/c.txt']);
    });
    await run('rm -rf /tmp/sumtest');
  });

  it('two items of one name in one move: refused, nothing lost (the second replaced the first, then both sources went)', async () => {
    await run('rm -rf /tmp/dup1 /tmp/dup2 && mkdir -p /tmp/dup1 /tmp/dup2 && echo first > /tmp/dup1/config.txt && echo second > /tmp/dup2/config.txt');
    for (const toHostId of [b.id, a.id]) {
      const toDir = `/tmp/dupto-${toHostId}`;
      await t.json('POST', `/api/files/${toHostId}/create`, { path: toDir, kind: 'dir' });
      const r = await t.request('POST', '/api/files/transfer', { fromHostId: a.id, toHostId, paths: ['/tmp/dup1/config.txt', '/tmp/dup2/config.txt'], toDir, move: true });
      expect(r.json()).toMatchObject({ error: 'same_name', message: expect.stringContaining('config.txt') });
      await new Promise((w) => setTimeout(w, 500));
      expect((await run('cat /tmp/dup1/config.txt /tmp/dup2/config.txt'))[0]!.stdout).toBe('first\nsecond\n');
    }
  });

  it('archives and extracts zip and tar.gz', async () => {
    for (const ext of ['zip', 'tar.gz']) {
      const dest = `/tmp/bundle.${ext}`;
      expect((await waitJob(await t.json<JobView>('POST', `/api/files/${a.id}/archive`, { paths: [`${HOME}/work/sub`], dest }))).status).toBe('done');
      await t.json('POST', `/api/files/${a.id}/create`, { path: `/tmp/out-${ext}`, kind: 'dir' });
      expect((await waitJob(await t.json<JobView>('POST', `/api/files/${a.id}/extract`, { path: dest, toDir: `/tmp/out-${ext}` }))).status).toBe('done');
      expect(await names(a, `/tmp/out-${ext}/sub`)).toEqual(['deep.txt']);
    }
  });

  it('reports folder size, with how many files and folders are in it (report 1b1aa2), and finds files by name', async () => {
    const { bytes, files, dirs } = await t.json<{ bytes: number; files: number; dirs: number }>('GET', `/api/files/${a.id}/du?path=${encodeURIComponent(`${HOME}/work`)}`);
    expect(bytes).toBeGreaterThan(300_000);
    // Everything below, not the folder itself: sub/ and its deep.txt among them.
    const [d, f] = (await run(`find ${HOME}/work -mindepth 1 -type d | wc -l; find ${HOME}/work -mindepth 1 ! -type d | wc -l`))[0]!.stdout.trim().split(/\s+/).map(Number);
    expect({ files, dirs }).toEqual({ files: f, dirs: d });
    expect(dirs).toBeGreaterThanOrEqual(1);
    expect(files).toBeGreaterThanOrEqual(1);
    expect(await t.json<string[]>('GET', `/api/files/${a.id}/search?dir=${encodeURIComponent(HOME)}&name=DEEP`)).toEqual([`${HOME}/work/sub/deep.txt`]);
  });
});

describe('deleting', () => {
  it('takes only absolute paths: a find option as the folder deletes nothing', async () => {
    await t.json('POST', `/api/files/${a.id}/create`, { path: `${HOME}/keep-me.txt`, kind: 'file' });
    // "-delete" as the folder was a find expression: it deleted files below the home folder.
    for (const dir of ['-delete', 'work', '~/work'])
      expect((await t.request('GET', `/api/files/${a.id}/search?dir=${encodeURIComponent(dir)}&name=nothing-matches-this`)).statusCode).toBe(400);
    for (const path of ['-a', 'keep-me.txt']) expect((await t.request('GET', `/api/files/${a.id}/du?path=${encodeURIComponent(path)}`)).statusCode).toBe(400);
    expect(await t.json<string[]>('GET', `/api/files/${a.id}/search?dir=${encodeURIComponent(HOME)}&name=keep-me`)).toEqual([`${HOME}/keep-me.txt`]);
  });

  it('needs step-up, refuses / and the home folder, and is audited', async () => {
    for (const path of ['/', HOME]) {
      expect((await t.request('POST', `/api/files/${a.id}/delete`, { paths: [path] })).json()).toMatchObject({ error: 'refused' });
    }
    await t.json('POST', `/api/files/${a.id}/delete`, { paths: [`${HOME}/work`, '/tmp/work'] });
    expect(await names(a, HOME)).not.toContain('work');
    t.advance(16 * 60_000);
    expect((await t.request('POST', `/api/files/${b.id}/delete`, { paths: [`${HOME}/work`] })).json()).toMatchObject({ error: 'step_up_required' });
    // Replacing a file by an upload cannot be undone either, as copying over it (audit 2026-10-30); a new file needs none.
    expect((await t.request('POST', `/api/files/${b.id}/uploads`, { dir: HOME, name: 'keep-me.txt', size: 1, overwrite: true })).json()).toMatchObject({ error: 'step_up_required' });
    expect((await t.request('POST', `/api/files/${b.id}/uploads`, { dir: HOME, name: 'new-after-step-up.txt', size: 1 })).statusCode).toBe(200);
    const audit = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['file.delete', 'file.copy', 'file.move', 'file.upload', 'file.save', 'file.rename']));
  });
});

describe('bookmarks', () => {
  it('keeps one bookmark per path', async () => {
    await t.json('POST', `/api/files/${a.id}/bookmarks`, { path: '/etc', name: 'config' });
    await t.json('POST', `/api/files/${a.id}/bookmarks`, { path: '/etc', name: 'etc' });
    expect(await t.json('GET', `/api/files/${a.id}/bookmarks`)).toEqual([{ id: expect.any(Number), hostId: a.id, path: '/etc', name: 'etc' }]);
  });
});
