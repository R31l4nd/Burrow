import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthState, ConnectResult, Host, Invite, TerminalSessionInfo, UserSummary } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { terminalSessions, users } from '../../src/db/schema.js';
import { exec } from '../../src/ssh/connect.js';
import { makeApp, openTerminal, PASSWORD, setupAdmin, totpNow, type TestApp } from '../helpers.js';

// Phase 11: an admin invites an operator, who sets up a way to sign in and
// then may look (hosts, containers, logs, files, reports) but not change or
// open a shell. The last admin stays an admin.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;
let adminCookie: string | null = null;
let secret = '';

beforeAll(async () => {
  t = await makeApp();
  ({ secret } = await setupAdmin(t));
  h = await t.json<Host>('POST', '/api/hosts', { name: 'test-sshd', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  adminCookie = t.cookie;
});
afterAll(async () => {
  await t.close();
});

async function asAdmin<T>(fn: () => Promise<T>): Promise<T> {
  const mine = t.cookie;
  t.cookie = adminCookie;
  try {
    return await fn();
  } finally {
    adminCookie = t.cookie;
    t.cookie = mine;
  }
}

describe('invites and roles', () => {
  let operatorCookie: string | null = null;
  let operatorId = 0;

  it('a revoked invite no longer works', async () => {
    const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
    const token = inv.url!.split('/').pop()!;
    expect((await t.request('DELETE', `/api/invites/${inv.id}`)).statusCode).toBe(204);
    expect(await t.json<Invite[]>('GET', '/api/invites')).toEqual([]);
    expect((await t.request('GET', `/api/invites/${token}`, undefined, { cookie: null })).statusCode).toBe(404);
    expect((await t.request('POST', `/api/invites/${token}/accept`, { username: 'late' }, { cookie: null })).statusCode).toBe(404);
  });

  it('an admin invites; the link makes an operator account', async () => {
    const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
    expect(inv.url).toMatch(/^http:\/\/localhost:8080\/#\/invite\/[\w-]{32}$/);
    const token = inv.url!.split('/').pop()!;
    expect((await t.json<Invite[]>('GET', '/api/invites')).map((i) => i.url)).toEqual([null]);

    t.cookie = null;
    expect(await t.json('GET', `/api/invites/${token}`)).toMatchObject({ role: 'operator' });
    const state = await t.json<AuthState>('POST', `/api/invites/${token}/accept`, { username: 'olivia' });
    expect(state.user).toMatchObject({ username: 'olivia', role: 'operator', incomplete: true });
    // Once only.
    const again = await t.request('POST', `/api/invites/${token}/accept`, { username: 'other' }, { cookie: null });
    expect(again.statusCode).toBe(404);
    // Sets up a password and an authenticator app, as the wizard does.
    await t.json('PUT', '/api/account/password', { password: PASSWORD });
    const { secret: s2 } = await t.json<{ secret: string }>('POST', '/api/account/totp/setup');
    await t.json('POST', '/api/account/totp/confirm', { code: await totpNow(s2, t) });
    const done = await t.json<{ recoveryCodes: string[]; state: AuthState }>('POST', '/api/setup/finish');
    expect(done.state.user).toMatchObject({ incomplete: false, role: 'operator' });
    operatorCookie = t.cookie;
    operatorId = done.state.user!.id;
  });

  it('an operator may look, not change or open a shell', async () => {
    t.cookie = operatorCookie;
    for (const url of ['/api/hosts', `/api/hosts/${h.id}`, '/api/alerts', '/api/reports', '/api/files/bookmarks']) {
      expect((await t.request('GET', url)).statusCode, url).toBe(200);
    }
    // Files only in the folders an admin granted (A3-SRV-01): none yet.
    expect((await t.request('GET', `/api/files/${h.id}/list?path=%2Fetc`)).json()).toMatchObject({ error: 'no_file_access' });
    await asAdmin(() => t.json('PUT', `/api/users/${operatorId}/file-access/${h.id}`, { allow: ['/etc'], deny: [] }));
    expect((await t.request('GET', `/api/files/${h.id}/list?path=%2Fetc`)).statusCode).toBe(200);
    expect((await t.request('GET', `/api/files/${h.id}/text?path=%2Fetc%2Fhostname`)).statusCode).toBe(200);
    // Nor do they give folders to themselves.
    expect((await t.request('PUT', `/api/users/${operatorId}/file-access/${h.id}`, { allow: ['/'], deny: [] })).statusCode).toBe(403);
    const denied: [string, string, unknown?][] = [
      ['POST', '/api/terminal/sessions', { hostId: h.id }],
      ['PUT', `/api/files/${h.id}/text`, { path: '/tmp/x', content: 'x' }],
      ['POST', '/api/snippets/run', { hostIds: [h.id], command: 'id' }],
      ['POST', '/api/hosts', { name: 'x', address: 'x' }],
      ['GET', '/api/users'],
      ['GET', '/api/audit'],
      // Problem reports can show anyone's screen: the admins' to read.
      ['GET', '/api/bugreports'],
      // Which log files go with a container: the admins' to choose (reading them is everyone's).
      ['POST', `/api/docker/${h.id}/logfiles`, { container: 'web', path: '/var/log/app.log' }],
      ['DELETE', `/api/docker/${h.id}/logfiles/1`],
      ['GET', `/api/docker/${h.id}/containers/web/logfile-suggestions`],
      ['GET', '/api/bugreports/2026-10-04-12-00-00-abcdef'],
      ['DELETE', '/api/bugreports/2026-10-04-12-00-00-abcdef'],
      ['PUT', '/api/bugreports/2026-10-04-12-00-00-abcdef/status', { status: 'closed' }],
      ['GET', '/api/keys'],
      ['POST', '/api/alerts/mutes', { hostId: h.id, container: 'web', minutes: 60 }],
      ['GET', '/api/settings/ai'],
      ['GET', '/api/channels'],
    ];
    for (const [m, url, body] of denied) {
      const r = await t.request(m, url, body);
      expect(r.statusCode, `${m} ${url}`).toBe(403);
      expect(r.json().error).toBe('forbidden');
    }
  });

  it('roles change; the last admin stays; a removed account is signed out', async () => {
    const list = await asAdmin(() => t.json<UserSummary[]>('GET', '/api/users'));
    expect(list.map((u) => [u.username, u.role, u.password])).toEqual([
      ['admin', 'admin', true],
      ['olivia', 'operator', true],
    ]);
    const adminId = list[0]!.id;
    const r = await asAdmin(() => t.request('PUT', `/api/users/${adminId}`, { role: 'operator' }));
    expect(r.json().error).toBe('last_admin');
    // Step-up: fresh after the admin's own sign-in; renew it after an hour.
    await asAdmin(async () => {
      t.advance(60 * 60_000);
      await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
      await t.json('PUT', `/api/users/${operatorId}`, { role: 'admin' });
      await t.json('PUT', `/api/users/${operatorId}`, { role: 'operator' });
      await t.json('DELETE', `/api/users/${operatorId}`);
    });
    t.cookie = operatorCookie;
    expect((await t.request('GET', '/api/hosts')).statusCode).toBe(401);
    const audit = await asAdmin(() => t.json<{ action: string }[]>('GET', '/api/audit'));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['invite.create', 'invite.accepted', 'user.update', 'user.delete']));
  });
});

describe('admins that come and go', () => {
  const invited = async (role: 'admin' | 'operator', username: string) => {
    const inv = await asAdmin(() => t.json<Invite>('POST', '/api/invites', { role }));
    const state = await t.json<AuthState>('POST', `/api/invites/${inv.url!.split('/').pop()!}/accept`, { username });
    return state.user!.id;
  };
  const stepUp = () =>
    asAdmin(async () => {
      t.advance(60_000);
      await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
    });

  it('an invited admin who never finished can be made an operator or removed while one admin is left (A3-SRV-15)', async () => {
    await stepUp();
    const id = await invited('admin', 'ines');
    const r = await asAdmin(() => t.request('PUT', `/api/users/${id}`, { role: 'operator' }));
    expect(r.statusCode, r.body).toBe(200);
    const id2 = await invited('admin', 'ivo');
    const d = await asAdmin(() => t.request('DELETE', `/api/users/${id2}`));
    expect(d.statusCode, d.body).toBe(204);
    await asAdmin(() => t.json('DELETE', `/api/users/${id}`));
  });

  it("another admin's terminal session is not theirs: not listed, not opened, typed into, renamed, shared, recorded or closed (audit 2026-11-05)", async () => {
    await stepUp();
    const id = await invited('admin', 'rosa');
    t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, id)).run();
    const rosa = t.cookie;
    const s = await t.terminals.create({ userId: id, username: 'rosa', ip: null }, h.id, 80, 24, undefined, undefined, 'never');
    // Its owner has it.
    expect((await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions')).map((x) => x.id)).toContain(s.id);
    await asAdmin(async () => {
      expect((await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions')).map((x) => x.id)).not.toContain(s.id);
      await stepUp();
      for (const [method, url, body] of [
        ['GET', `/api/terminal/sessions/${s.id}`],
        ['GET', `/api/terminal/sessions/${s.id}/ai`],
        ['PUT', `/api/terminal/sessions/${s.id}/title`, { title: 'mine now' }],
        ['PUT', `/api/terminal/sessions/${s.id}/share`, { userIds: [] }],
        ['PUT', `/api/terminal/sessions/${s.id}/recording`, { on: true }],
        ['DELETE', `/api/terminal/sessions/${s.id}`],
      ] as const) {
        const r = await t.request(method, url, body);
        expect(r.statusCode, `${method} ${url}`).toBe(404);
      }
      const ws = await openTerminal(t, s.id);
      const exit = await ws.waitFor((m) => m.t === 'exit');
      expect(exit).toMatchObject({ t: 'exit', reason: 'ended' });
      ws.close();
    });
    // Still there and still its owner's.
    t.cookie = rosa;
    expect((await t.json<TerminalSessionInfo>('GET', `/api/terminal/sessions/${s.id}`)).title).toBeNull();
    await asAdmin(() => t.json('DELETE', `/api/users/${id}`));
  }, 30_000);

  it("a removed admin's terminals end, on the host too, instead of running on unseen (A3-SRV-09)", async () => {
    await stepUp();
    const id = await invited('admin', 'rita');
    t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, id)).run();
    const s = await t.terminals.create({ userId: id, username: 'rita', ip: null }, h.id, 80, 24, undefined, undefined, 'always');
    expect(s.mode).toBe('tmux');
    const tmuxList = () => t.files.with(h.id, ({ client }) => exec(client, 'tmux -L burrow ls 2>/dev/null; true')).then((x) => x.stdout);
    const name = t.ctx.db.select().from(terminalSessions).where(eq(terminalSessions.id, s.id)).get()!.tmuxName!;
    // The session's tmux starts on the host right after the shell opened: with SSH's small writes no longer held back (OPS-W-01) it can come after this look.
    await expect.poll(tmuxList).toContain(`${name}:`);
    await asAdmin(() => t.json('DELETE', `/api/users/${id}`));
    expect(t.terminals.list(id).filter((x) => x.id === s.id)).toEqual([]);
    expect(await tmuxList()).not.toContain(`${name}:`);
  }, 30_000);
});

