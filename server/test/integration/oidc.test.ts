import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthState, Invite, OidcSettings, UserSummary } from '@burrow/shared';
import { startIdp } from '../fake-idp.js';
import { makeApp, PASSWORD, setupAdmin, totpNow, type TestApp } from '../helpers.js';

// Phase 11: single sign-on against a small OpenID Connect provider
// (server/test/fake-idp.ts): sign-in for a linked account only, linking by
// name the first time, an invite accepted through the provider, and step-up
// through the provider.
// A random port; another is tried when it is taken (it once was).
let PORT = 18_200 + Math.floor(Math.random() * 500);
let ISSUER = `http://127.0.0.1:${PORT}`;

let t: TestApp;
let idp: Server;
let admin: string | null = null;
let adminSecret = '';

/** Start at Burrow, sign in at the provider as `user`, and come back: Burrow's answer. */
async function viaProvider(start: string, user: string, cookie: string | null, opts: { otherBrowser?: boolean; between?: () => Promise<void> } = {}) {
  const r1 = await t.request('GET', start, undefined, { cookie });
  expect(r1.statusCode, r1.body).toBe(302);
  // The cookie that ties the flow to this browser (Lax: it comes back from the provider).
  const flow = r1.cookies.find((c) => c.name === 'burrow_sso');
  expect(flow).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/auth/oidc' });
  const authorize = new URL(r1.headers.location as string);
  expect(authorize.origin).toBe(ISSUER);
  const p = authorize.searchParams;
  const form = new URLSearchParams({ user, redirect_uri: p.get('redirect_uri')!, state: p.get('state')!, nonce: p.get('nonce')!, code_challenge: p.get('code_challenge')! });
  const r2 = await fetch(`${ISSUER}/login`, { method: 'POST', body: form, redirect: 'manual' });
  const cb = new URL(r2.headers.get('location')!);
  expect(cb.pathname).toBe('/api/auth/oidc/callback');
  await opts.between?.();
  // Coming back from another site: the SameSite cookie does not come along.
  const r3 = await t.request('GET', cb.pathname + cb.search, undefined, { cookie: opts.otherBrowser ? null : `burrow_sso=${flow!.value}` });
  return { prompt: p.get('prompt'), location: r3.headers.location as string, status: r3.statusCode };
}

beforeAll(async () => {
  for (let n = 0; ; n++) {
    try {
      idp = await startIdp(PORT, ISSUER, 'burrow', 'burrow-secret');
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'EADDRINUSE' || n >= 5) throw err;
      PORT = 18_200 + Math.floor(Math.random() * 500);
      ISSUER = `http://127.0.0.1:${PORT}`;
    }
  }
  t = await makeApp();
  ({ secret: adminSecret } = await setupAdmin(t));
  admin = t.cookie;
});
afterAll(async () => {
  await t.close();
  idp.close();
});

describe('single sign-on', () => {
  it('an admin sets up the provider; it must answer', async () => {
    const bad = await t.request('PUT', '/api/settings/oidc', { enabled: true, issuer: 'http://127.0.0.1:9', clientId: 'burrow', clientSecret: 'x', label: 'Test IdP', claim: 'preferred_username' });
    expect(bad.json().error).toBe('oidc_unreachable');
    const s = await t.json<OidcSettings>('PUT', '/api/settings/oidc', { enabled: true, issuer: ISSUER, clientId: 'burrow', clientSecret: 'burrow-secret', label: 'Test IdP', claim: 'preferred_username' });
    expect(s).toMatchObject({ enabled: true, hasSecret: true, redirectUri: 'http://localhost:8080/api/auth/oidc/callback' });
    expect(JSON.stringify(s)).not.toContain('burrow-secret');
    expect(await t.json('GET', '/api/auth/oidc')).toEqual({ enabled: true, label: 'Test IdP' });
  });

  it('nobody gets in on the provider alone', async () => {
    const r = await viaProvider('/api/auth/oidc/start', 'alice', null);
    expect(r.location).toBe('http://localhost:8080/#/?sso=unknown');
  });

  it('an invite accepted through the provider: an account, signed in', async () => {
    t.cookie = admin;
    const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
    admin = t.cookie;
    const token = inv.url!.split('/').pop()!;
    const r = await viaProvider(`/api/auth/oidc/start?purpose=invite&invite=${token}`, 'newbie', null);
    expect(r.location).toBe('http://localhost:8080/#/');
    const state = await t.json<AuthState>('GET', '/api/auth/state');
    expect(state.user).toMatchObject({ username: 'newbie', role: 'operator', incomplete: false, hasSso: true });

    // Step-up through the provider: a fresh sign-in there (prompt=login).
    t.advance(60 * 60_000);
    const mine = t.cookie;
    expect((await t.request('POST', '/api/account/devices/pair-code', {})).json().error).toBe('step_up_required');
    const s = await viaProvider('/api/auth/oidc/start?purpose=stepup', 'newbie', mine);
    expect(s.prompt).toBe('login');
    expect(s.location).toBe('http://localhost:8080/#/?sso=stepped_up');
    t.cookie = mine;
    expect((await t.request('POST', '/api/account/devices/pair-code', {})).statusCode).toBe(200);
    // Back to the page it started on; never to another site.
    t.advance(60 * 60_000);
    expect((await viaProvider('/api/auth/oidc/start?purpose=stepup&next=%2Fcontainers%2F1%2Fweb', 'newbie', mine)).location).toBe('http://localhost:8080/#/containers/1/web?sso=stepped_up');
    expect((await t.request('GET', '/api/auth/oidc/start?next=%2F%2Fevil.example', undefined, { cookie: null })).statusCode).toBe(400);
    // Someone else at the provider cannot confirm this session.
    t.advance(60 * 60_000);
    expect((await viaProvider('/api/auth/oidc/start?purpose=stepup', 'alice', mine)).location).toBe('http://localhost:8080/#/?sso=wrong_user');
  });

  it('an existing account is linked by its name the first time', async () => {
    // Olivia joined with a password; the provider knows her by the same name.
    // The admin's step-up expired meanwhile: confirm again.
    t.cookie = admin;
    t.advance(30_000);
    await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(adminSecret, t) });
    const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
    t.cookie = null;
    await t.json('POST', `/api/invites/${inv.url!.split('/').pop()}/accept`, { username: 'olivia' });
    await t.json('PUT', '/api/account/password', { password: PASSWORD });
    const { secret } = await t.json<{ secret: string }>('POST', '/api/account/totp/setup');
    await t.json('POST', '/api/account/totp/confirm', { code: await totpNow(secret, t) });
    await t.json('POST', '/api/setup/finish');
    t.cookie = null;

    const r = await viaProvider('/api/auth/oidc/start', 'olivia', null);
    expect(r.location).toBe('http://localhost:8080/#/');
    expect((await t.json<AuthState>('GET', '/api/auth/state')).user).toMatchObject({ username: 'olivia', hasSso: true });
    t.cookie = admin;
    const users = await t.json<UserSummary[]>('GET', '/api/users');
    expect(users.find((u) => u.username === 'olivia')).toMatchObject({ sso: true, password: true });
    const audit = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['auth.sso_unknown', 'auth.sso_linked', 'invite.accepted']));
  });

  it('a sign-in started elsewhere does not finish in this browser (login CSRF)', async () => {
    t.cookie = null;
    const r = await viaProvider('/api/auth/oidc/start', 'olivia', null, { otherBrowser: true });
    expect(r.location).toBe('http://localhost:8080/#/?sso=expired');
    expect((await t.json<AuthState>('GET', '/api/auth/state')).user).toBeNull();
  });

  it('an e-mail links only when the provider verified it, and only to the e-mail field', async () => {
    t.cookie = admin;
    t.advance(30_000);
    await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(adminSecret, t) });
    const me = await t.json<UserSummary[]>('GET', '/api/users');
    const adminId = me.find((u) => u.username === 'admin')!.id;
    await t.json('PUT', `/api/users/${adminId}`, { role: 'admin', email: 'admin@example.com' });
    await t.json('PUT', '/api/settings/oidc', { enabled: true, issuer: ISSUER, clientId: 'burrow', label: 'Test IdP', claim: 'email' });
    admin = t.cookie;
    // Mallory typed the admin's e-mail at a provider that does not check it.
    t.cookie = null;
    expect((await viaProvider('/api/auth/oidc/start', 'mallory', null)).location).toBe('http://localhost:8080/#/?sso=unknown');
    expect((await t.json<AuthState>('GET', '/api/auth/state')).user).toBeNull();
    t.cookie = admin;
    expect((await t.json<UserSummary[]>('GET', '/api/users')).find((u) => u.id === adminId)).toMatchObject({ sso: false });
    await t.json('PUT', '/api/settings/oidc', { enabled: true, issuer: ISSUER, clientId: 'burrow', label: 'Test IdP', claim: 'preferred_username' });
    admin = t.cookie;
  });

  it('a link holds for its own provider only: the same subject elsewhere is someone else', async () => {
    // Olivia was linked at this provider; say the link came from another one.
    const { users: usersTable } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    t.ctx.db.update(usersTable).set({ oidcIss: 'https://other-provider.example' }).where(eq(usersTable.username, 'olivia')).run();
    t.cookie = null;
    expect((await viaProvider('/api/auth/oidc/start', 'olivia', null)).location).toBe('http://localhost:8080/#/?sso=unknown');
    t.ctx.db.update(usersTable).set({ oidcIss: ISSUER }).where(eq(usersTable.username, 'olivia')).run();
    expect((await viaProvider('/api/auth/oidc/start', 'olivia', null)).location).toBe('http://localhost:8080/#/');
  });

  it('a sign-in begun before single sign-on was switched off does not finish (AUDIT2 AUTH-08)', async () => {
    const settings = (enabled: boolean) => ({ enabled, issuer: ISSUER, clientId: 'burrow', label: 'Test IdP', claim: 'preferred_username' });
    const r = await viaProvider('/api/auth/oidc/start', 'olivia', null, {
      between: async () => {
        t.cookie = admin;
        await t.json('PUT', '/api/settings/oidc', settings(false));
        t.cookie = null;
      },
    });
    expect(r.location).toBe('http://localhost:8080/#/?sso=expired');
    expect(r.status).toBe(302);
    t.cookie = admin;
    await t.json('PUT', '/api/settings/oidc', settings(true));
    t.cookie = null;
    expect((await viaProvider('/api/auth/oidc/start', 'olivia', null)).location).toBe('http://localhost:8080/#/');
  });
});
