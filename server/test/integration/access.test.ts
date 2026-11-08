import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthState, Invite } from '@burrow/shared';
import { makeApp, PASSWORD, setupAdmin, totpNow, type TestApp } from '../helpers.js';

// Every route of the API, one by one, without choosing: who may call it
// (signed out, an operator, an admin without a fresh confirmation) and what
// bad input does (never a 500). A route added later is in here by itself.

let t: TestApp;
let admin: string | null = null;
let operator: string | null = null;

// A route's path with its parameters filled in (a number where an id is
// asked, a word elsewhere), so the request reaches the route itself.
const fill = (url: string, how: 'plain' | 'odd' = 'plain') =>
  url.replace(/:(\w+)/g, (_m, name: string) => (how === 'odd' ? '%00..%2F' : /id$/i.test(name) ? '999999' : 'nothing-here')).replace(/\*$/, 'x');

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  admin = t.cookie;
  // An operator, as an invite makes one.
  const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
  t.cookie = null;
  await t.json<AuthState>('POST', `/api/invites/${inv.url!.split('/').pop()}/accept`, { username: 'olga' });
  await t.json('PUT', '/api/account/password', { password: PASSWORD });
  const { secret } = await t.json<{ secret: string }>('POST', '/api/account/totp/setup');
  await t.json('POST', '/api/account/totp/confirm', { code: await totpNow(secret, t) });
  await t.json('POST', '/api/setup/finish');
  operator = t.cookie;
  t.cookie = admin;
});
afterAll(async () => {
  await t.close();
});

// The catch-all for unknown /api paths (a 404 for every method) is not a route of its own.
const api = () => t.routes.filter((r) => r.url.startsWith('/api/') && !r.websocket && r.url !== '/api/*');

describe('every route', () => {
  it('there are many (the list is complete)', () => {
    expect(api().length).toBeGreaterThan(150);
    // For the gate's count of routes no test used (scripts/route-coverage.mjs).
    const list = process.env.BURROW_ROUTE_LIST;
    if (list) writeFileSync(list, t.routes.map((r) => `${r.method} ${r.url}${r.websocket ? ' ws' : ''}`).join('\n') + '\n');
  });

  it('signed out: refused, unless public', async () => {
    const wrong: string[] = [];
    for (const r of api()) {
      const res = await t.request(r.method, fill(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, { cookie: null });
      if (r.config.auth === 'public') {
        if (res.statusCode >= 500) wrong.push(`${r.method} ${r.url}: ${res.statusCode} (public)`);
      } else if (res.statusCode !== 401 && !(res.statusCode === 403 && res.json().error === 'bad_origin')) {
        wrong.push(`${r.method} ${r.url}: ${res.statusCode}, not 401`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('an operator: refused on what is for admins only', async () => {
    const wrong: string[] = [];
    for (const r of api().filter((x) => (x.config.auth ?? 'admin') === 'admin')) {
      const res = await t.request(r.method, fill(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, { cookie: operator });
      if (res.statusCode !== 403) wrong.push(`${r.method} ${r.url}: ${res.statusCode}, not 403`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

});

describe('bad input on every route', () => {
  it('odd parameters, wrong bodies and broken JSON: an answer, never a 500', async () => {
    // Signed in and confirmed: the input itself is what is tried.
    t.cookie = admin;
    const bodies: unknown[] = [null, [], 'text', 12, { id: 'x', path: '../../etc/passwd', name: 'x'.repeat(5000) }, { hostId: -1, hostIds: ['a'], port: 70000 }];
    const wrong: string[] = [];
    for (const r of api()) {
      // A few routes end the session or the server's state for the rest.
      if (/logout|sign-?out|account\/sessions|setup\/|restart|self-?update|backups\/restore/i.test(r.url)) continue;
      const tries: [string, unknown][] = [[fill(r.url, 'odd'), undefined]];
      if (r.method !== 'GET' && r.method !== 'DELETE') for (const b of bodies) tries.push([fill(r.url), b]);
      for (const [url, body] of tries) {
        const res = await t.request(r.method, url, body);
        if (res.statusCode >= 500 && res.statusCode !== 502 && res.statusCode !== 503) wrong.push(`${r.method} ${url} ${JSON.stringify(body)?.slice(0, 40)}: ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
      // Broken JSON as the body.
      if (r.method !== 'GET' && r.method !== 'DELETE') {
        const res = await t.app.inject({ method: r.method as 'POST', url: fill(r.url), headers: { origin: 'http://localhost:8080', cookie: t.cookie ?? '', 'content-type': 'application/json' }, payload: '{"x":' });
        if (res.statusCode !== 400 && res.statusCode !== 401 && res.statusCode !== 403) wrong.push(`${r.method} ${r.url} broken JSON: ${res.statusCode}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});

// What must ask for a fresh confirmation, written down here and not read
// from the routes' own settings: a route that lost its stepUp would drop
// out of a list made from them (AUDIT ST-08). Acting on a host (terminals,
// commands, containers and stacks, guests, deletes, sudo) and changing
// users, sign-in, devices, hosts or updates. Routes that ask only for part
// of what they do (a phone's new SSH key, A3-SRV-03) are checked by their
// own tests: an empty body never reaches that part.
const MUST_STEP_UP = [
  'POST /api/terminal/sessions',
  'PUT /api/terminal/sessions/:id/share',
  'PUT /api/terminal/sessions/:id/recording',
  // What was recorded, deleted (audit 2026-10-30).
  'PUT /api/recordings/settings',
  'DELETE /api/recordings/:id',
  'POST /api/snippets/run',
  'POST /api/docker/:hostId/containers/:name/action',
  'POST /api/docker/:hostId/containers/:name/shell',
  'POST /api/docker/:hostId/prune',
  'POST /api/docker/:hostId/stacks/:project/ops',
  'POST /api/docker/updates/run',
  'PUT /api/docker/updates/settings',
  'POST /api/files/:hostId/delete',
  'POST /api/files/:hostId/sudo/read',
  'PUT /api/files/:hostId/sudo/text',
  'POST /api/hosts/:id/guests/:kind/:vmid/:action',
  // The package lists refreshed through sudo (report 1f6c0c).
  'POST /api/hosts/:id/packages/refresh',
  'POST /api/hosts',
  'PUT /api/hosts/:id',
  'DELETE /api/hosts/:id',
  'POST /api/hosts/:id/trust',
  'POST /api/hosts/:id/install-key',
  'PUT /api/users/:id',
  'DELETE /api/users/:id',
  'DELETE /api/users/:id/sso',
  'POST /api/invites',
  'PUT /api/settings/oidc',
  'POST /api/account/devices/pair-code',
  'PUT /api/account/devices/:id/hosts',
  'DELETE /api/account/devices/:id',
  'PATCH /api/account/devices/:id',
  'DELETE /api/account/password',
  'DELETE /api/account/totp',
  'DELETE /api/account/passkeys/:id',
  'POST /api/account/recovery-codes',
  'POST /api/system/update',
  // Where alerts and their stored secrets go (A3-SRV-07).
  'POST /api/channels',
  'PUT /api/channels/:id',
  'DELETE /api/channels/:id',
];

describe('confirmation', () => {
  it('an admin without a fresh confirmation: refused where one is asked', async () => {
    // An hour after signing in: still signed in, the confirmation run out.
    t.advance(3600_000);
    expect((await t.request('GET', '/api/hosts', undefined, { cookie: admin })).statusCode).toBe(200);
    const wrong: string[] = [];
    const asked = api().filter((x) => x.config.stepUp);
    expect(asked.length).toBeGreaterThan(20);
    for (const r of asked) {
      const res = await t.request(r.method, fill(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, { cookie: admin });
      if (res.statusCode !== 403 || res.json().error !== 'step_up_required') wrong.push(`${r.method} ${r.url}: ${res.statusCode} ${res.body.slice(0, 60)}`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('what must ask does ask, by the list above and not by the routes\' own settings', async () => {
    t.advance(3600_000);
    const wrong: string[] = [];
    for (const want of MUST_STEP_UP) {
      const [method, url] = want.split(' ') as [string, string];
      if (!api().some((r) => r.method === method && r.url === url)) {
        wrong.push(`${want}: no such route (renamed? update the list)`);
        continue;
      }
      const res = await t.request(method, fill(url), method === 'GET' || method === 'DELETE' ? undefined : {}, { cookie: admin });
      if (res.statusCode !== 403 || res.json().error !== 'step_up_required') wrong.push(`${want}: ${res.statusCode} ${res.body.slice(0, 60)}`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
