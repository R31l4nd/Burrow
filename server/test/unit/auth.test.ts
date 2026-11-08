import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@burrow/shared';
import { BLOCK_AFTER } from '../../src/auth/throttle.js';
import * as throttle from '../../src/auth/throttle.js';
import { authThrottle, passkeys } from '../../src/db/schema.js';
import { makeApp, PASSWORD, setupAdmin, totpNow, type TestApp } from '../helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function login(secret: string, username = 'admin') {
  const { ticket } = await t.json<{ ticket: string }>('POST', '/api/auth/password', { username, password: PASSWORD });
  return t.json<AuthState>('POST', '/api/auth/totp', { ticket, code: await totpNow(secret, t) });
}

describe('setup wizard', () => {
  it('starts in setup mode and refuses a wrong token', async () => {
    expect((await t.json<AuthState>('GET', '/api/auth/state')).setupRequired).toBe(true);
    const r = await t.request('POST', '/api/setup/begin', { token: 'WRONG-TOKEN', username: 'admin' });
    expect(r.statusCode).toBe(403);
  });

  it('cannot finish without a login method', async () => {
    await t.json('POST', '/api/setup/begin', { token: t.gate.token, username: 'admin' });
    expect((await t.request('POST', '/api/setup/finish')).json()).toMatchObject({ error: 'last_login_method' });
  });

  it('keeps an incomplete account away from everything else', async () => {
    await t.json('POST', '/api/setup/begin', { token: t.gate.token, username: 'admin' });
    expect((await t.request('GET', '/api/hosts')).json()).toMatchObject({ error: 'setup_incomplete' });
  });

  it('password without TOTP is not enough to finish', async () => {
    await t.json('POST', '/api/setup/begin', { token: t.gate.token, username: 'admin' });
    await t.json('PUT', '/api/account/password', { password: PASSWORD });
    expect((await t.request('POST', '/api/setup/finish')).statusCode).toBe(409);
  });

  it('finishes with password + TOTP, hands out 10 recovery codes and closes', async () => {
    const { recoveryCodes } = await setupAdmin(t);
    expect(recoveryCodes).toHaveLength(10);
    const state = await t.json<AuthState>('GET', '/api/auth/state');
    expect(state).toMatchObject({ setupRequired: false, user: { username: 'admin', hasTotp: true, incomplete: false } });
    expect(t.gate.token).toBeNull();
    const again = await t.request('POST', '/api/setup/begin', { token: 'x', username: 'evil' });
    expect(again.statusCode).toBe(409);
  });

  it('a restart during setup discards the unfinished account', async () => {
    await t.json('POST', '/api/setup/begin', { token: t.gate.token, username: 'first' });
    t.cookie = null;
    await t.json('POST', '/api/setup/begin', { token: t.gate.token, username: 'second' });
    const state = await t.json<AuthState>('GET', '/api/auth/state');
    expect(state.user?.username).toBe('second');
  });
});

describe('login', () => {
  it('password + TOTP signs in; logout ends the session', async () => {
    const { secret } = await setupAdmin(t);
    t.cookie = null;
    expect((await t.request('GET', '/api/hosts')).statusCode).toBe(401);
    const state = await login(secret);
    expect(state.user?.username).toBe('admin');
    expect((await t.request('GET', '/api/hosts')).statusCode).toBe(200);
    const cookie = t.cookie;
    await t.request('POST', '/api/auth/logout');
    expect((await t.request('GET', '/api/hosts', undefined, { cookie })).statusCode).toBe(401);
  });

  it('never accepts the same TOTP code twice', async () => {
    const { secret } = await setupAdmin(t);
    t.cookie = null;
    await login(secret);
    t.cookie = null;
    const { ticket } = await t.json<{ ticket: string }>('POST', '/api/auth/password', { username: 'admin', password: PASSWORD });
    const r = await t.request('POST', '/api/auth/totp', { ticket, code: await totpNow(secret, t) });
    expect(r.statusCode).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    await setupAdmin(t);
    const a = await t.request('POST', '/api/auth/password', { username: 'admin', password: 'wrong password!!' });
    const b = await t.request('POST', '/api/auth/password', { username: 'nobody', password: 'wrong password!!' });
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(a.json()).toEqual(b.json());
  });

  it('a recovery code signs in exactly once', async () => {
    const { recoveryCodes } = await setupAdmin(t);
    t.cookie = null;
    const code = recoveryCodes[0]!.toLowerCase();
    expect((await t.request('POST', '/api/auth/recovery', { username: 'admin', code })).statusCode).toBe(200);
    t.cookie = null;
    expect((await t.request('POST', '/api/auth/recovery', { username: 'admin', code })).statusCode).toBe(401);
  });

  it('blocks after too many failures and says so in the audit log', async () => {
    const { secret } = await setupAdmin(t);
    // Drive the counter directly instead of waiting out the growing delays.
    expect(throttle.delayFor(BLOCK_AFTER - 1)).toBeGreaterThan(0);
    for (let i = 0; i < BLOCK_AFTER; i++) throttle.fail(t.ctx, ['user:admin']);
    t.cookie = null;
    const r = await t.request('POST', '/api/auth/password', { username: 'admin', password: PASSWORD });
    expect(r.statusCode).toBe(429);
    t.advance(throttle.BLOCK_MS + 1);
    await login(secret);
    // A block reached through the API is audited.
    t.ctx.db.delete(authThrottle).run();
    t.ctx.db.insert(authThrottle).values({ key: 'ip:127.0.0.1', failures: BLOCK_AFTER - 1, firstAt: t.clock.now }).run();
    const sleep = vi.spyOn(throttle.timing, 'sleep').mockResolvedValue();
    await t.request('POST', '/api/auth/password', { username: 'admin', password: 'wrong password!!' });
    sleep.mockRestore();
    const audit = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(audit.map((e) => e.action)).toContain('auth.blocked');
  });

  it('through a proxy Burrow was not told about, one client cannot lock out the others (A3-SRV-02)', async () => {
    await setupAdmin(t);
    const sleep = vi.spyOn(throttle.timing, 'sleep').mockResolvedValue();
    const via = (client: string, url: string, body: unknown) =>
      t.app.inject({ method: 'POST', url, remoteAddress: '172.18.0.2', headers: { origin: 'http://localhost:8080', 'content-type': 'application/json', 'x-forwarded-for': client }, payload: JSON.stringify(body) });
    try {
      // Ten failures with ten made-up names, all from one client behind the proxy.
      for (let i = 0; i < BLOCK_AFTER; i++) expect((await via('203.0.113.7', '/api/auth/password', { username: `nobody${i}`, password: 'wrong password!!' })).statusCode).toBe(401);
      expect((await via('203.0.113.7', '/api/auth/passkey/options', {})).statusCode).toBe(429);
      // Everyone else behind the same proxy still signs in.
      expect((await via('198.51.100.20', '/api/auth/passkey/options', {})).statusCode).toBe(200);
      expect((await via('198.51.100.20', '/api/auth/recovery', { username: 'admin', code: 'AAAAA-BBBBB-CCCCC-DDDDD' })).statusCode).toBe(401);
    } finally {
      sleep.mockRestore();
    }
    // Said where an admin looks: on /healthz.
    expect((await t.request('GET', '/healthz')).json()).toEqual({ ok: true, hints: ['trust_proxy'] });
  });

  it('a TRUST_PROXY that no longer names the proxy is noticed too, and admins are told what to set (OPS-W-12, decision 12)', async () => {
    await t.close();
    t = await makeApp({ env: { TRUST_PROXY: '172.18.0.9' } });
    await setupAdmin(t);
    const via = (proxy: string) => t.app.inject({ method: 'GET', url: '/api/auth/state', remoteAddress: proxy, headers: { 'x-forwarded-for': '192.168.1.20' } });
    // The proxy named: fine, nothing to say.
    await via('172.18.0.9');
    expect(await t.json('GET', '/api/system/hints')).toEqual({ trustProxy: null, diskFull: false, openReports: 0 });
    // Recreated with another address on its network: the client is not seen any more.
    await via('172.18.0.4');
    expect(await t.json('GET', '/api/system/hints')).toEqual({ trustProxy: { proxies: ['172.18.0.4'], current: '172.18.0.9', suggest: '172.18.0.0/16' }, diskFull: false, openReports: 0 });
    expect((await t.request('GET', '/healthz')).json()).toEqual({ ok: true, hints: ['trust_proxy'] });
  });

  it("failed passwords for an admin's name from elsewhere do not block that admin's step-up (A3-SRV-02)", async () => {
    const { secret } = await setupAdmin(t);
    const admin = t.cookie;
    t.advance(60 * 60_000);
    // Someone else, elsewhere, fails ten passwords for "admin".
    for (let i = 0; i < BLOCK_AFTER; i++) throttle.fail(t.ctx, ['user:admin', 'ip:10.9.9.9']);
    t.cookie = admin;
    const r = await t.request('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('expires a session after 7 idle days and after 30 days regardless', async () => {
    await setupAdmin(t);
    t.advance(6 * 24 * 3600_000);
    expect((await t.request('GET', '/api/hosts')).statusCode).toBe(200);
    t.advance(6 * 24 * 3600_000);
    expect((await t.request('GET', '/api/hosts')).statusCode).toBe(200);
    t.advance(8 * 24 * 3600_000);
    expect((await t.request('GET', '/api/hosts')).statusCode).toBe(401);

    const t2 = await makeApp();
    await setupAdmin(t2);
    for (let d = 0; d < 30; d += 5) {
      t2.advance(5 * 24 * 3600_000);
      await t2.request('GET', '/api/hosts');
    }
    expect((await t2.request('GET', '/api/hosts')).statusCode).toBe(401);
    await t2.close();
  });
});

describe('step-up', () => {
  const host = { name: 'server2', address: '192.168.1.20', username: 'alice' };

  it('is fresh right after login and required 15 minutes later', async () => {
    const { secret } = await setupAdmin(t);
    expect((await t.request('POST', '/api/hosts', host)).statusCode).toBe(200);
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/hosts', host)).json()).toMatchObject({ error: 'step_up_required' });
    // Reading does not need it.
    expect((await t.request('GET', '/api/hosts')).statusCode).toBe(200);
    const state = await t.json<AuthState>('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
    expect(state.stepUpUntil).not.toBeNull();
    expect((await t.request('POST', '/api/hosts', host)).statusCode).toBe(200);
  });
});

describe('a code is good once', () => {
  it('also when two requests bring it at the same moment', async () => {
    const { secret } = await setupAdmin(t);
    t.advance(16 * 60_000);
    const code = await totpNow(secret, t, 1);
    t.advance(30_000);
    // Both checked the code against the last step before either wrote it.
    const [a, b] = await Promise.all([t.request('POST', '/api/auth/step-up/totp', { code }), t.request('POST', '/api/auth/step-up/totp', { code })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
    // And after: the same code again is refused.
    expect((await t.request('POST', '/api/auth/step-up/totp', { code })).statusCode).toBe(401);
  });
});

describe('request hygiene', () => {
  it('rejects state-changing requests from another origin or without one', async () => {
    await setupAdmin(t);
    const body = { name: 'x', address: 'x' };
    expect((await t.request('POST', '/api/hosts', body, { origin: 'https://evil.example' })).json()).toMatchObject({ error: 'bad_origin' });
    expect((await t.request('POST', '/api/hosts', body, { origin: null })).statusCode).toBe(403);
  });

  it('guards the API however its path is spelled', async () => {
    await setupAdmin(t);
    // The router decodes "%61" to "a": these reach the API's routes, and
    // must meet the same session, role and origin checks.
    for (const url of ['/%61pi/hosts', '/%61%70%69/hosts', '/api/host%73']) {
      expect((await t.request('GET', url, undefined, { cookie: null })).statusCode, url).toBe(401);
      expect((await t.request('POST', url, { name: 'x', address: 'x' }, { origin: 'https://evil.example' })).statusCode, url).toBe(403);
      expect((await t.request('GET', url)).headers['cache-control'], url).toBe('no-store');
    }
  });

  it('sets security headers and no-store on the API', async () => {
    const r = await t.request('GET', '/api/auth/state');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('marks the session cookie HttpOnly and SameSite=Strict', async () => {
    const r = await t.request('POST', '/api/setup/begin', { token: t.gate.token, username: 'admin' });
    const c = r.cookies.find((x) => x.name === 'burrow')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: true, path: '/' });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    expect((await t.request('GET', '/api/nope')).json()).toEqual({ error: 'not_found' });
  });
});

describe('sessions and account', () => {
  it('lists and revokes sessions; revoking works immediately', async () => {
    const { secret } = await setupAdmin(t);
    const first = t.cookie;
    t.cookie = null;
    await login(secret);
    const list = await t.json<{ id: string; current: boolean }[]>('GET', '/api/account/sessions');
    expect(list).toHaveLength(2);
    const other = list.find((s) => !s.current)!;
    await t.json('DELETE', `/api/account/sessions/${other.id}`);
    expect((await t.request('GET', '/api/hosts', undefined, { cookie: first })).statusCode).toBe(401);
  });

  it('signs out every other browser at once, this one stays', async () => {
    const { secret } = await setupAdmin(t);
    const first = t.cookie;
    t.cookie = null;
    await login(secret);
    const second = t.cookie;
    t.cookie = null;
    t.advance(30_000); // a code works once
    await login(secret);
    expect((await t.request('DELETE', '/api/account/sessions')).statusCode).toBe(204);
    expect((await t.request('GET', '/api/hosts', undefined, { cookie: first })).statusCode).toBe(401);
    expect((await t.request('GET', '/api/hosts', undefined, { cookie: second })).statusCode).toBe(401);
    expect(await t.json<unknown[]>('GET', '/api/account/sessions')).toHaveLength(1);
  });

  it('refuses to remove the last login method', async () => {
    await setupAdmin(t);
    expect((await t.request('DELETE', '/api/account/totp')).json()).toMatchObject({ error: 'last_login_method' });
    expect((await t.request('DELETE', '/api/account/password')).json()).toMatchObject({ error: 'last_login_method' });
  });

  it('turns TOTP off when a passkey remains to sign in with', async () => {
    await setupAdmin(t);
    const user = (await t.json<AuthState>('GET', '/api/auth/state')).user!;
    t.ctx.db.insert(passkeys).values({ userId: user.id, credentialId: 'cred', publicKey: Buffer.from([1]), counter: 0, name: 'phone', createdAt: t.clock.now }).run();
    expect((await t.request('DELETE', '/api/account/totp')).statusCode).toBe(204);
    expect((await t.json<AuthState>('GET', '/api/auth/state')).user).toMatchObject({ hasTotp: false, hasPasskey: true });
    // Password alone does not sign in: without TOTP the password is no way in.
    t.cookie = null;
    expect((await t.request('POST', '/api/auth/password', { username: 'admin', password: PASSWORD })).statusCode).toBe(401);
  });

  it('writes an audit trail without secrets', async () => {
    await setupAdmin(t);
    const entries = await t.json<{ action: string; details: unknown }[]>('GET', '/api/audit');
    const actions = entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['setup.begin', 'account.password_set', 'account.totp_enabled', 'setup.complete']));
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
  });
});

describe('session fixation', () => {
  it('signing in replaces the session the browser already had', async () => {
    const { secret } = await setupAdmin(t);
    const before = t.cookie;
    await login(secret);
    expect(t.cookie).not.toBe(before);
    expect((await t.request('GET', '/api/hosts', undefined, { cookie: before })).statusCode).toBe(401);
  });
});

describe('rate limit', () => {
  it('caps API requests per client with a JSON 429', async () => {
    let last = await t.request('GET', '/api/auth/state');
    for (let i = 0; i < 600 && last.statusCode !== 429; i++) last = await t.request('GET', '/api/auth/state');
    expect(last.statusCode).toBe(429);
    expect(last.json()).toMatchObject({ error: 'rate_limited' });
    // Static files are not counted.
    expect((await t.request('GET', '/healthz')).statusCode).toBe(200);
  });

  it("one sign-in session that runs away does not lock out the person's other ones (decision 20, OPS-W-08)", async () => {
    const { secret } = await setupAdmin(t);
    const runaway = t.cookie;
    t.cookie = null;
    await login(secret);
    const phone = t.cookie;
    let last = await t.request('GET', '/api/auth/state', undefined, { cookie: runaway });
    for (let i = 0; i < 3100 && last.statusCode !== 429; i++) last = await t.request('GET', '/api/auth/state', undefined, { cookie: runaway });
    expect(last.statusCode).toBe(429);
    expect((await t.request('GET', '/api/auth/state', undefined, { cookie: phone })).statusCode).toBe(200);
    // Alone about 3 s (thousands of requests); beside the other workers on a loaded machine past 30 s (2026-11-06).
  }, 90_000);

  it('gives a signed-in person more room, per person; a made-up cookie does not', async () => {
    await setupAdmin(t);
    // Well past the per-address limit, signed in: still answered.
    let last = await t.request('GET', '/api/auth/state');
    for (let i = 0; i < 700; i++) last = await t.request('GET', '/api/auth/state');
    expect(last.statusCode).toBe(200);
    // The same address with a cookie that is no session: the address's limit.
    let fake = await t.request('GET', '/api/auth/state', undefined, { cookie: 'burrow=made-up' });
    for (let i = 0; i < 600 && fake.statusCode !== 429; i++) fake = await t.request('GET', '/api/auth/state', undefined, { cookie: `burrow=made-up-${i}` });
    expect(fake.statusCode).toBe(429);
    // Alone about 5 s (hundreds of requests); beside the other workers on a loaded machine it went past 30 s.
  }, 90_000);
});
