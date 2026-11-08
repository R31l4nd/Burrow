import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthState, Bookmark, ConnectResult, DirListing, FileAccessRule, GitStatus, Host, Invite, SearchResult, TextFile, Workspace } from '@burrow/shared';
import { users } from '../../src/db/schema.js';
import { makeApp, setupAdmin, totpNow, type TestApp } from '../helpers.js';

// The folders an operator may open, per host (A3-SRV-01), against the test sshd: an operator read
// every file the SSH user could, keys, .env files and Burrow's own database included. And the
// writes an admin makes without a fresh step-up (A3-SRV-08).
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);
const HOME = '/home/tester';
const S = `${HOME}/granted`;

let t: TestApp;
let h: Host;
let admin: string | null;
let operator: string | null;
let opId = 0;
let secret = '';

const run = (command: string) => t.json<{ stdout: string; exitCode: number }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
const enc = encodeURIComponent;
const as = async <T>(cookie: string | null, fn: () => Promise<T>): Promise<T> => {
  const before = t.cookie;
  t.cookie = cookie;
  try {
    return await fn();
  } finally {
    t.cookie = before;
  }
};
const read = (path: string) => t.request('GET', `/api/files/${h.id}/text?path=${enc(path)}`);

beforeAll(async () => {
  t = await makeApp();
  ({ secret } = await setupAdmin(t));
  admin = t.cookie;
  h = await t.json<Host>('POST', '/api/hosts', { name: 'access-host', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  await run(
    [
      `rm -rf ${S} ${HOME}/app.env`,
      `mkdir -p ${S}/private ${S}/data/recordings ${S}/repo ${HOME}/.ssh`,
      `echo 'DB_PASSWORD=hunter2' > ${HOME}/app.env`,
      `echo 'readme needle' > ${S}/readme.txt`,
      `echo 'private needle' > ${S}/private/secret.txt`,
      `ln -s ../app.env ${S}/link-to-env`,
      `ln -s /etc ${S}/etc-link`,
      // A Burrow data folder below the granted one: its database marks it.
      `echo db > ${S}/data/burrow.db && echo 'cast needle' > ${S}/data/recordings/a.cast`,
      `echo 'key needle' > ${HOME}/.ssh/id_test`,
      `ln -sf ${HOME}/.bashrc ${S}/rc-link`,
      `cd ${S}/repo && git init -q -b main && echo 'repo needle' > r.txt`,
    ].join(' && '),
  );
  await t.json('POST', `/api/files/${h.id}/bookmarks`, { path: S, name: 'granted' });
  await t.json('POST', `/api/files/${h.id}/bookmarks`, { path: '/var/log', name: 'logs' });
  await t.json('POST', '/api/workspaces', { hostId: h.id, root: S, name: 'granted-ws' });
  await t.json('POST', '/api/workspaces', { hostId: h.id, root: '/etc', name: 'etc-ws' });
  const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
  t.cookie = null;
  const state = await t.json<AuthState>('POST', `/api/invites/${inv.url!.split('/').pop()!}/accept`, { username: 'olga' });
  opId = state.user!.id;
  t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, opId)).run();
  operator = t.cookie;
  t.cookie = admin;
}, 60_000);
afterAll(async () => {
  await t.close();
});

describe('an operator and the folders an admin granted (A3-SRV-01)', () => {
  it('opens no file on a host without a grant: not an .env file, not the home folder', async () => {
    await as(operator, async () => {
      const r = await read(`${HOME}/app.env`);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: 'no_file_access' });
      expect((await t.request('GET', `/api/files/${h.id}/list`)).json()).toMatchObject({ error: 'no_file_access' });
      expect((await t.request('GET', `/api/files/${h.id}/raw?path=${enc('/etc/hostname')}`)).statusCode).toBe(403);
      expect(await t.json<{ rules: FileAccessRule[] | null }>('GET', '/api/files/access')).toEqual({ rules: [] });
      expect(await t.json<Bookmark[]>('GET', '/api/files/bookmarks')).toEqual([]);
      expect(await t.json<Workspace[]>('GET', '/api/workspaces')).toEqual([]);
    });
  });

  it('opens what was granted, nothing beside it or below a denied folder, links judged by where they lead', async () => {
    const rule = await t.json<FileAccessRule>('PUT', `/api/users/${opId}/file-access/${h.id}`, { allow: [`${S}/`, `${S}/./`], deny: [`${S}/private`] });
    expect(rule).toEqual({ hostId: h.id, allow: [S], deny: [`${S}/private`] });
    expect(await t.json<FileAccessRule[]>('GET', `/api/users/${opId}/file-access`)).toEqual([rule]);
    await as(operator, async () => {
      expect(await t.json<{ rules: FileAccessRule[] | null }>('GET', '/api/files/access')).toEqual({ rules: [rule] });
      expect((await t.json<TextFile>('GET', `/api/files/${h.id}/text?path=${enc(`${S}/readme.txt`)}`)).content).toBe('readme needle\n');
      const listing = await t.json<DirListing>('GET', `/api/files/${h.id}/list?path=${enc(S)}`);
      expect(listing.entries.map((e) => e.name).sort()).toEqual(['data', 'etc-link', 'link-to-env', 'rc-link', 'readme.txt', 'repo']);
      for (const path of [`${S}/private/secret.txt`, `${S}/link-to-env`, `${S}/../app.env`, `${S}/etc-link/hostname`, `${S}/data/recordings/a.cast`, `${S}/data/burrow.db`, `${HOME}/.ssh/id_test`, '/etc/hostname']) {
        const r = await read(path);
        expect(r.statusCode, path).toBe(403);
        expect(r.json().message, path).toContain(`Folders you may open here: ${S}`);
      }
      expect((await t.request('GET', `/api/files/${h.id}/list?path=${enc(`${S}/private`)}`)).statusCode).toBe(403);
      expect((await t.request('GET', `/api/files/${h.id}/du?path=${enc(`${S}/private`)}`)).statusCode).toBe(403);
      expect((await t.request('GET', `/api/files/${h.id}/du?path=${enc(S)}`)).statusCode).toBe(200);
      // A search finds no names in what is closed.
      const found = await t.json<string[]>('GET', `/api/files/${h.id}/search?dir=${enc(S)}&name=${enc('e')}`);
      expect(found).toContain(`${S}/readme.txt`);
      expect(found.filter((f) => f.includes('/private') || f.includes('/data/'))).toEqual([]);
      // What lists show: only the granted ones.
      expect((await t.json<Bookmark[]>('GET', '/api/files/bookmarks')).map((b) => b.path)).toEqual([S]);
      const ws = await t.json<Workspace[]>('GET', '/api/workspaces');
      expect(ws.map((w) => w.root)).toEqual([S]);
    });
  });

  it('a workspace: quick open, search and git show nothing that is closed', async () => {
    await as(operator, async () => {
      const files = (await t.json<{ files: string[] }>('GET', `/api/workspace/${h.id}/files?root=${enc(S)}`)).files;
      expect(files).toContain('readme.txt');
      expect(files.filter((f) => f.startsWith('private/') || f.startsWith('data/'))).toEqual([]);
      const s = await t.json<SearchResult>('POST', `/api/workspace/${h.id}/search`, { root: S, query: 'needle' });
      expect(s.matches.map((m) => m.path).sort()).toEqual(['readme.txt', 'repo/r.txt']);
      expect((await t.request('POST', `/api/workspace/${h.id}/search`, { root: HOME, query: 'needle' })).statusCode).toBe(403);
      expect((await t.request('GET', `/api/workspace/${h.id}/files?root=${enc('/etc')}`)).statusCode).toBe(403);
      expect((await t.json<GitStatus>('GET', `/api/workspace/${h.id}/git/status?root=${enc(`${S}/repo`)}`)).files.map((f) => f.path)).toEqual(['r.txt']);
      expect(await t.json<string[]>('GET', `/api/workspace/${h.id}/git/repos?root=${enc(S)}`)).toEqual([`${S}/repo`]);
      expect((await t.request('GET', `/api/workspace/${h.id}/git/status?root=${enc(HOME)}`)).statusCode).toBe(403);
      expect((await t.request('GET', `/api/workspace/${h.id}/git/head?root=${enc(S)}&path=${enc('private/secret.txt')}`)).statusCode).toBe(403);
    });
  });

  it("keys and Burrow's own secrets stay closed even with everything granted", async () => {
    await t.json('PUT', `/api/users/${opId}/file-access/${h.id}`, { allow: ['/'], deny: [] });
    await as(operator, async () => {
      expect((await read(`${HOME}/app.env`)).statusCode).toBe(200);
      for (const path of [`${HOME}/.ssh/id_test`, `${S}/data/recordings/a.cast`, '/proc/self/environ', '/proc/1/cmdline']) expect((await read(path)).statusCode, path).toBe(403);
      expect((await t.json<DirListing>('GET', `/api/files/${h.id}/list?path=${enc(HOME)}`)).entries.map((e) => e.name)).not.toContain('.ssh');
      const s = await t.json<SearchResult>('POST', `/api/workspace/${h.id}/search`, { root: HOME, query: 'needle' });
      expect(s.matches.map((m) => m.path).filter((p) => p.startsWith('.ssh') || p.includes('/data/'))).toEqual([]);
    });
    // Taken away: nothing again.
    expect(await t.json<FileAccessRule>('PUT', `/api/users/${opId}/file-access/${h.id}`, { allow: [], deny: [] })).toEqual({ hostId: h.id, allow: [], deny: [] });
    expect(await t.json<FileAccessRule[]>('GET', `/api/users/${opId}/file-access`)).toEqual([]);
    await as(operator, async () => expect((await read(`${HOME}/app.env`)).statusCode).toBe(403));
  });

  it("where Burrow cannot tell whether its own folder is on the host (its containers could not be read): refused, and fine again once read", async () => {
    await t.json('PUT', `/api/users/${opId}/file-access/${h.id}`, { allow: [S], deny: [] });
    // Known as a host with Docker (its facts read): where Burrow's container may be.
    expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok', facts: { hasDocker: true } });
    // What was known of Burrow's folder is five minutes old: asked again.
    t.advance(5 * 60_000);
    const recent = vi.spyOn(t.docker, 'recent').mockRejectedValue(new Error('ssh: handshake timed out'));
    try {
      const r = await as(operator, () => read(`${S}/readme.txt`));
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: 'own_folder_unknown' });
    } finally {
      recent.mockRestore();
    }
    // Not remembered as "not here": a few seconds on, the containers are read and the file opens.
    t.advance(15_000);
    const ok = await as(operator, () => read(`${S}/readme.txt`));
    expect(ok.statusCode).toBe(200);
  });

  it('every Burrow found on the host has its compose folder closed, also when which one is this one is not clear', async () => {
    await t.json('PUT', `/api/users/${opId}/file-access/${h.id}`, { allow: [S], deny: [] });
    expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok', facts: { hasDocker: true } });
    await run(`mkdir -p ${S}/inst1 ${S}/inst2 && echo 'SMTP_PASSWORD=one' > ${S}/inst1/.env && echo 'SMTP_PASSWORD=two' > ${S}/inst2/.env`);
    // Two installs of service "burrow" (a second one for tests, say): neither is known to be this one.
    const box = (id: string, name: string, dir: string) => ({ id, name, service: 'burrow', project: name, workingDir: dir, configFiles: `${dir}/compose.yaml`, state: 'running' });
    t.advance(5 * 60_000);
    const recent = vi.spyOn(t.docker, 'recent').mockResolvedValue({ hostId: h.id, hostName: h.name, at: new Date(t.clock.now).toISOString(), error: null, stats: {}, history: {}, containers: [box('aaa', 'burrow', `${S}/inst1`), box('bbb', 'burrow-test', `${S}/inst2`)] } as never);
    try {
      for (const f of [`${S}/inst1/.env`, `${S}/inst2/.env`]) {
        const r = await as(operator, () => read(f));
        expect(r.statusCode, f).toBe(403);
        expect(r.json()).toMatchObject({ error: 'no_file_access' });
      }
      expect((await as(operator, () => read(`${S}/readme.txt`))).statusCode).toBe(200);
    } finally {
      recent.mockRestore();
      await run(`rm -rf ${S}/inst1 ${S}/inst2`);
    }
  });

  it('a grant needs a fresh step-up, and is the admins\' to give', async () => {
    t.advance(60 * 60_000);
    const r = await t.request('PUT', `/api/users/${opId}/file-access/${h.id}`, { allow: ['/'], deny: [] });
    expect(r.json()).toMatchObject({ error: 'step_up_required' });
    await as(operator, async () => expect((await t.request('GET', `/api/users/${opId}/file-access`)).statusCode).toBe(403));
    await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
  });
});

describe('what an admin writes without a fresh step-up (A3-SRV-08)', () => {
  it('a file that grants a shell, a copy over files and unpacking ask for one; ordinary saves do not', async () => {
    t.advance(60 * 60_000);
    const save = (path: string) => t.request('PUT', `/api/files/${h.id}/text`, { path, content: 'x\n', baseHash: null });
    for (const path of [`${HOME}/.ssh/authorized_keys2`, `${HOME}/.bashrc`, `${HOME}/.config/systemd/user/evil.service`]) {
      const r = await save(path);
      expect(r.statusCode, path).toBe(403);
      expect(r.json().error, path).toBe('step_up_required');
    }
    expect((await save(`${S}/notes.txt`)).statusCode).toBe(200);
    // Through a link to the same file, too.
    expect((await save(`${S}/rc-link`)).json().error).toBe('step_up_required');
    expect((await t.request('POST', `/api/files/${h.id}/rename`, { from: `${S}/notes.txt`, to: `${HOME}/.ssh/authorized_keys2` })).json().error).toBe('step_up_required');
    expect((await t.request('POST', '/api/files/transfer', { fromHostId: h.id, toHostId: h.id, paths: [`${S}/notes.txt`], toDir: `${S}/repo`, move: true, overwrite: true })).json().error).toBe('step_up_required');
    expect((await t.request('POST', '/api/files/transfer', { fromHostId: h.id, toHostId: h.id, paths: [`${S}/notes.txt`], toDir: `${HOME}/.ssh`, move: false, overwrite: false })).json().error).toBe('step_up_required');
    expect((await t.request('POST', `/api/files/${h.id}/extract`, { path: `${S}/a.tar.gz`, toDir: S })).json().error).toBe('step_up_required');
    expect((await t.json<DirListing>('GET', `/api/files/${h.id}/list?path=${enc(`${HOME}/.ssh`)}`)).entries.map((e) => e.name)).not.toContain('authorized_keys2');
  });
});
