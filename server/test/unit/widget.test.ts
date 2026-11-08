import { createECDH, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Host, WidgetSummary } from '@burrow/shared';
import { alerts, devices, hostPackages, pushSubscriptions } from '../../src/db/schema.js';
import { widgetMessage } from '../../src/android/widget.js';
import { makeApp, setupAdmin } from '../helpers.js';

// The Android app's widget (2.11.0): counts only; pushed to the devices that
// asked, when they change.

describe("the widget's numbers", () => {
  it('counts hosts, unseen alerts and package updates; pushed when they change, once, to the devices that asked', async () => {
    const posts: { url: string }[] = [];
    const t = await makeApp({ fetch: (async (url: string | URL) => (posts.push({ url: String(url) }), new Response(null, { status: 201 }))) as unknown as typeof fetch });
    await setupAdmin(t);
    const a = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: '192.0.2.10' });
    await t.json<Host>('POST', '/api/hosts', { name: 'pi', address: '192.0.2.11' });
    const report = (security: number, total: number) => JSON.stringify({ hostId: a.id, checkedAt: new Date(t.ctx.now()).toISOString(), state: 'ok', manager: 'apt', listAt: null, updates: Array.from({ length: total }, (_, i) => ({ name: `p${i}`, from: '1', to: '2', security: i < security })), security, reboot: false, message: null });
    t.ctx.db.insert(hostPackages).values({ hostId: a.id, checkedAt: t.ctx.now(), report: report(2, 3) }).run();
    const w = await t.json<WidgetSummary>('GET', '/api/widget');
    expect(w).toMatchObject({ hosts: { total: 2, up: 0, down: 0 }, alerts: 0, updates: { hosts: 1, security: 2 } });

    // Only a device of this person that gets notifications can ask for it.
    expect((await t.request('PUT', '/api/widget/push', { endpoint: 'https://push.example.com/nope', on: true })).json()).toMatchObject({ error: 'no_push_device' });
    const e = createECDH('prime256v1');
    e.generateKeys();
    const endpoint = 'https://push.example.com/phone';
    t.ctx.db.insert(pushSubscriptions).values({ userId: 1, kind: 'unifiedpush', label: 'phone', endpoint, p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url'), lang: 'en', createdAt: t.ctx.now() }).run();
    t.ctx.db.insert(pushSubscriptions).values({ userId: 1, kind: 'webpush', label: 'browser', endpoint: 'https://push.example.com/browser', p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url'), lang: 'en', createdAt: t.ctx.now() }).run();
    await t.widget.tick();
    expect(posts).toEqual([]);
    expect(await t.json('PUT', '/api/widget/push', { endpoint, on: true })).toEqual({ on: true });
    await t.widget.tick();
    expect(posts.map((p) => p.url)).toEqual([endpoint]);
    // The same numbers: nothing sent again.
    await t.widget.tick();
    expect(posts).toHaveLength(1);
    // A new alert: sent again.
    t.ctx.db.insert(alerts).values({ ruleId: null, ruleName: 'Host health', hostId: a.id, container: '@disk /', title: 'disk 95% full', detail: null, at: new Date(t.ctx.now()).toISOString(), count: 1, read: false, pushed: 'no', createdAt: t.ctx.now() + 1000, updatedAt: t.ctx.now() + 1000 }).run();
    expect((await t.json<WidgetSummary>('GET', '/api/widget')).alerts).toBe(1);
    await t.widget.tick();
    expect(posts).toHaveLength(2);
    // Turned off: no more.
    await t.json('PUT', '/api/widget/push', { endpoint, on: false });
    t.ctx.db.insert(hostPackages).values({ hostId: a.id, checkedAt: t.ctx.now(), report: report(0, 1) }).onConflictDoUpdate({ target: hostPackages.hostId, set: { report: report(0, 1) } }).run();
    await t.widget.tick();
    expect(posts).toHaveLength(2);
    await t.close();
  });

  it('each host on a line of its own: down first, then not known yet, then up, by name; with its updates (report 05a818)', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const nas = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: '192.0.2.10' });
    const pi = await t.json<Host>('POST', '/api/hosts', { name: 'pi', address: '192.0.2.11' });
    const db = await t.json<Host>('POST', '/api/hosts', { name: 'db', address: '192.0.2.12' });
    // Up: a port that answers; down: one that refuses; db not checked yet.
    const open = createServer().listen(0, '127.0.0.1');
    await once(open, 'listening');
    await t.status.checkOne(nas.id, '127.0.0.1', (open.address() as AddressInfo).port);
    await t.status.checkOne(pi.id, '127.0.0.1', 1);
    open.close();
    const report = JSON.stringify({ hostId: nas.id, checkedAt: new Date(t.ctx.now()).toISOString(), state: 'ok', manager: 'apt', listAt: null, updates: [{ name: 'a', from: '1', to: '2', security: true }, { name: 'b', from: '1', to: '2', security: false }], security: 1, reboot: false, message: null });
    t.ctx.db.insert(hostPackages).values({ hostId: nas.id, checkedAt: t.ctx.now(), report }).run();
    const w = await t.json<WidgetSummary>('GET', '/api/widget');
    expect(w.list).toEqual([
      { id: pi.id, name: 'pi', state: 'down', updates: 0, security: 0 },
      { id: db.id, name: 'db', state: 'unknown', updates: 0, security: 0 },
      { id: nas.id, name: 'nas', state: 'up', updates: 2, security: 1 },
    ]);
    expect(w.hosts).toEqual({ total: 3, up: 1, down: 1 });
    await t.close();
  });

  it("from the phone's background with the widget's own key: the counts, each moment once; nothing else", async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const d = t.ctx.db.insert(devices).values({ userId: 1, name: 'Pixel', publicKey: spki, createdAt: t.ctx.now(), widgetKey: spki }).returning().get();
    const header = (ts: number, id = d.id) => `${id}.${ts}.${sign('sha256', Buffer.from(widgetMessage(t.ctx.config.origin, id, ts)), { key: privateKey, dsaEncoding: 'der' }).toString('base64')}`;
    const ask = (h: string) => t.app.inject({ method: 'GET', url: '/api/widget/device', headers: { 'x-burrow-widget': h } });
    const now = t.ctx.now();
    const ok = await ask(header(now));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ hosts: { total: 0 }, alerts: 0 });
    // The same moment again (a copy of the request), one too old, another phone's, a wrong signature: refused.
    expect((await ask(header(now))).statusCode).toBe(401);
    expect((await ask(header(now - 10 * 60_000))).statusCode).toBe(401);
    expect((await ask(header(now + 1, d.id + 1))).statusCode).toBe(401);
    expect((await ask(`${d.id}.${now + 2}.${'A'.repeat(88)}`)).statusCode).toBe(401);
    expect((await ask(header(now + 3))).statusCode).toBe(200);
    // Not a sign-in: the rest of the API stays closed to it.
    expect((await t.app.inject({ method: 'GET', url: '/api/hosts', headers: { 'x-burrow-widget': header(now + 4) } })).statusCode).toBe(401);
    // The key is set by the phone itself, signed in with its device key: not from a password session.
    expect((await t.request('PUT', `/api/account/devices/${d.id}/widget-key`, { publicKey: spki })).json()).toMatchObject({ error: 'wrong_device' });
    await t.close();
  });

  it('a paired phone gives its widget key itself, signed in with its device key; another phone cannot use it', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const key = () => {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      return { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
    };
    const pair = async () => {
      const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
      const browser = t.cookie;
      t.cookie = null;
      const r = await t.json<{ deviceId: number }>('POST', '/api/auth/pair', { code, name: 'Pixel', publicKey: key().spki });
      const phone = t.cookie;
      t.cookie = browser;
      return { id: r.deviceId, cookie: phone };
    };
    const one = await pair();
    const two = await pair();
    const widget = key();
    const header = (id: number, ts: number) => `${id}.${ts}.${sign('sha256', Buffer.from(widgetMessage(t.ctx.config.origin, id, ts)), { key: widget.privateKey, dsaEncoding: 'der' }).toString('base64')}`;
    const ask = (h: string) => t.app.inject({ method: 'GET', url: '/api/widget/device', headers: { 'x-burrow-widget': h } });
    // Before the phone gives it: no key, refused.
    expect((await ask(header(one.id, t.ctx.now()))).statusCode).toBe(401);
    t.cookie = one.cookie;
    expect((await t.request('PUT', `/api/account/devices/${one.id}/widget-key`, { publicKey: 'not a key' })).statusCode).toBe(400);
    expect((await t.json<{ ok: boolean }>('PUT', `/api/account/devices/${one.id}/widget-key`, { publicKey: widget.spki })).ok).toBe(true);
    // Nor for the other phone of the same account.
    expect((await t.request('PUT', `/api/account/devices/${two.id}/widget-key`, { publicKey: widget.spki })).json()).toMatchObject({ error: 'wrong_device' });
    t.cookie = null;
    expect((await ask(header(one.id, t.ctx.now()))).statusCode).toBe(200);
    expect((await ask(header(two.id, t.ctx.now() + 1))).statusCode).toBe(401);
    await t.close();
  });
});

