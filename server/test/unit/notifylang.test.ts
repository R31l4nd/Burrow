import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Notifier } from '../../src/notify/channels.js';
import { channels, pushSubscriptions } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// The language of texts made before sending (a report's summary): that of
// the channels for the topic, else of the other channels, else of the
// devices that get push. A report read only in Burrow was always English.

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => {
  await t.close();
});

const channel = (topics: string[], lang: 'en' | 'nl') =>
  t.ctx.db.insert(channels).values({ kind: 'ntfy', name: `c${Math.random()}`, enabled: true, topics: JSON.stringify(topics), lang, config: '{}', createdAt: t.ctx.now() } as typeof channels.$inferInsert).run();

describe('the language of a notice', () => {
  it("the topic's channels decide; without one the other channels; without any the push devices; else English", () => {
    const n = new Notifier(t.ctx);
    expect(n.lang('reports')).toBe('en');
    t.ctx.db.insert(pushSubscriptions).values({ userId: 1, kind: 'webpush', label: 'phone', endpoint: 'https://push.example.com/1', p256dh: 'x', auth: 'y', lang: 'nl', createdAt: t.ctx.now() }).run();
    expect(n.lang('reports')).toBe('nl');
    channel(['alerts'], 'en');
    expect(n.lang('reports')).toBe('en');
    channel(['reports'], 'nl');
    expect(n.lang('reports')).toBe('nl');
  });
});

describe('who gets a push', () => {
  it('a problem report goes to the admins devices only (AUDIT2 MON-06)', async () => {
    const { createECDH, randomBytes } = await import('node:crypto');
    const { users } = await import('../../src/db/schema.js');
    const { sendPush } = await import('../../src/notify/push.js');
    const admin = t.ctx.db.select().from(users).get()!;
    const op = t.ctx.db.insert(users).values({ username: 'op', role: 'operator', totpConfirmed: false, incomplete: false, createdAt: t.ctx.now() }).returning().get();
    const device = (userId: number, endpoint: string) => {
      const e = createECDH('prime256v1');
      e.generateKeys();
      t.ctx.db.insert(pushSubscriptions).values({ userId, kind: 'webpush', label: endpoint, endpoint, p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url'), lang: 'en', createdAt: t.ctx.now() }).run();
    };
    device(admin.id, 'https://push.example.com/admin');
    device(op.id, 'https://push.example.com/operator');
    const sent: string[] = [];
    const f = (async (url: string) => {
      sent.push(url);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    await sendPush(t.ctx, { topic: 'problems', title: 'Problem report', body: 'my words', page: '/settings/report', priority: 3 }, f);
    expect(sent).toEqual(['https://push.example.com/admin']);
    sent.length = 0;
    await sendPush(t.ctx, { topic: 'alerts', title: 'Alert', body: 'x', page: '/alerts', priority: 3 }, f);
    expect(sent.sort()).toEqual(['https://push.example.com/admin', 'https://push.example.com/operator']);
  });
});

describe('push addresses a person gives (AUDIT BE-08, ST-18)', () => {
  const keys = async () => {
    const { createECDH, randomBytes } = await import('node:crypto');
    const e = createECDH('prime256v1');
    e.generateKeys();
    return { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  };

  it('a redirect is not followed: the POST stays at the address given', async () => {
    const { users } = await import('../../src/db/schema.js');
    const { sendPush } = await import('../../src/notify/push.js');
    const admin = t.ctx.db.select().from(users).get()!;
    t.ctx.db.insert(pushSubscriptions).values({ userId: admin.id, kind: 'webpush', label: 'phone', endpoint: 'https://push.example.com/x', ...(await keys()), lang: 'en', createdAt: t.ctx.now() }).run();
    const asked: (RequestRedirect | undefined)[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      asked.push(init.redirect);
      return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:8080/api/x' } });
    }) as unknown as typeof fetch;
    const r = await sendPush(t.ctx, { topic: 'alerts', title: 'Alert', body: 'x', page: '/alerts', priority: 3 }, f);
    expect(asked).toEqual(['manual']);
    expect(r.ok).toBe(0);
    expect(r.errors.join()).toContain('307');
  });

  it('so many devices a person, not without end', async () => {
    const k = await keys();
    for (let i = 0; i < 20; i++) expect((await t.request('POST', '/api/push/devices', { kind: 'webpush', label: `d${i}`, endpoint: `https://push.example.com/${i}`, ...k })).statusCode).toBe(200);
    const r = await t.request('POST', '/api/push/devices', { kind: 'webpush', label: 'one more', endpoint: 'https://push.example.com/21', ...k });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('too_many_devices');
    // The same address again is the same device: still fine.
    expect((await t.request('POST', '/api/push/devices', { kind: 'webpush', label: 'd0 again', endpoint: 'https://push.example.com/0', ...k })).statusCode).toBe(200);
  });
});

describe('testing a channel', () => {
  it('a channel that is not there is no test that went well (AUDIT2 MON-26)', async () => {
    expect((await t.request('POST', '/api/channels/9999/test', {})).json()).toMatchObject({ error: 'not_found' });
  });
});

describe('a channel that fails (2026-11-07)', () => {
  it('is kept as failing, since its first failure, until a send through it works again', async () => {
    const t0 = t.ctx.now();
    let up = false;
    const n = new Notifier(t.ctx, { fetch: async () => (up ? new Response('ok') : new Response('nope', { status: 401 })) });
    t.ctx.db.insert(channels).values({ kind: 'ntfy', name: 'Phone', enabled: true, topics: JSON.stringify(['alerts']), lang: 'en', config: JSON.stringify({ url: 'https://ntfy.example.com', topic: 'x' }), createdAt: t0 } as typeof channels.$inferInsert).run();
    const notice = { topic: 'alerts' as const, title: 't', body: 'b', page: '/', priority: 3 };
    expect((await n.notify(notice)).sent).toBe(0);
    t.advance(60_000);
    await n.notify(notice);
    expect(n.failing.get('Phone')).toMatchObject({ since: t0 });
    expect(n.failing.get('Phone')!.error).toMatch(/401/);
    up = true;
    expect((await n.notify(notice)).sent).toBe(1);
    expect(n.failing.size).toBe(0);
  });
});
