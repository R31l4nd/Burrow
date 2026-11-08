import { describe, expect, it } from 'vitest';
import type { AppTab } from '@burrow/shared';
import type { Notifier } from '../../src/notify/channels.js';
import { makeApp, setupAdmin } from '../helpers.js';

describe('app uptime', () => {
  it('is down after two misses, back at once, and says so once each', async () => {
    let answer: number | 'none' = 200;
    const fetch = async () => {
      if (answer === 'none') throw new Error('connection refused');
      return new Response('', { status: answer });
    };
    const t = await makeApp({ fetch });
    await setupAdmin(t);
    const sent: { title: string }[] = [];
    t.uptime.notifier = { notify: async (n: { title: string }) => void sent.push(n) } as unknown as Notifier;
    const a = await t.json<AppTab>('POST', '/api/apps', { name: 'Radarr', url: 'http://radarr.lan:7878/' });
    // Checked at once when added.
    expect(a).toMatchObject({ monitor: true, up: true });
    let now = (await t.json<AppTab[]>('GET', '/api/apps'))[0]!;
    expect(now).toMatchObject({ up: true, uptime: 1 });

    // A login page (401) is up; one miss is not down yet; two are.
    answer = 401;
    await t.uptime.check(a.id);
    answer = 'none';
    await t.uptime.check(a.id);
    expect((await t.json<AppTab[]>('GET', '/api/apps'))[0]!.up).toBe(true);
    expect(sent).toHaveLength(0);
    await t.uptime.check(a.id);
    now = (await t.json<AppTab[]>('GET', '/api/apps'))[0]!;
    expect(now.up).toBe(false);
    expect(now.downSince).not.toBeNull();
    expect(now.uptime).toBe(0.5);
    await t.uptime.check(a.id);
    expect(sent.map((s) => s.title)).toEqual(['Radarr is down']);

    // Back: at once, told once.
    answer = 200;
    await t.uptime.check(a.id);
    expect((await t.json<AppTab[]>('GET', '/api/apps'))[0]!).toMatchObject({ up: true, downSince: null });
    expect(sent.map((s) => s.title)).toEqual(['Radarr is down', 'Radarr is back (0 min)']);

    // Not watched: no state shown.
    const off = await t.json<AppTab>('PUT', `/api/apps/${a.id}`, { name: 'Radarr', url: 'http://radarr.lan:7878/', monitor: false });
    expect(off).toMatchObject({ monitor: false, up: null, uptime: null });
    await t.close();
  });
});

describe('all apps failing at once', () => {
  it("is Burrow's own reach: not counted for any app, told once, and once when it is back", async () => {
    let answer: 'all-fail' | 'ok' = 'ok';
    const fetch = async () => {
      if (answer === 'all-fail') throw Object.assign(new Error('fetch failed'), { cause: { code: 'EAI_AGAIN' } });
      return new Response('', { status: 200 });
    };
    const t = await makeApp({ fetch });
    await setupAdmin(t);
    const sent: { title: string; body: string }[] = [];
    t.uptime.notifier = { notify: async (n: { title: string; body: string }) => void sent.push(n) } as unknown as Notifier;
    for (const n of ['Radarr', 'Sonarr', 'Jellyfin']) await t.json('POST', '/api/apps', { name: n, url: `http://${n.toLowerCase()}.lan/` });
    answer = 'all-fail';
    for (let i = 0; i < 4; i++) await t.uptime.checkAll();
    const list = await t.json<AppTab[]>('GET', '/api/apps');
    // No app down, every uptime still whole; one message, with why.
    expect(list.map((a) => [a.up, a.uptime])).toEqual([[true, 1], [true, 1], [true, 1]]);
    expect(sent.map((x) => x.title)).toEqual(['Burrow cannot reach the apps']);
    expect(sent[0]!.body).toContain('EAI_AGAIN');
    answer = 'ok';
    await t.uptime.checkAll();
    expect(sent.map((x) => x.title)).toEqual(['Burrow cannot reach the apps', 'Burrow reaches the apps again']);
    await t.close();
  });

  it('an app removed while it is being asked: nothing written for it, nothing thrown', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = false;
    const fetch = async () => {
      if (hold) await held;
      return new Response('', { status: 200 });
    };
    const t = await makeApp({ fetch });
    await setupAdmin(t);
    const a = await t.json<AppTab>('POST', '/api/apps', { name: 'Gone', url: 'http://gone.lan/' });
    hold = true;
    const round = t.uptime.checkAll();
    await t.request('DELETE', `/api/apps/${a.id}`);
    release();
    await expect(round).resolves.toBeUndefined();
    await t.close();
  });
});

describe('apps that answer with an error', () => {
  it('all of them failing with 500 are down, not Burrow blind (AUDIT2 MON-17)', async () => {
    const fetch = async () => new Response('', { status: 500 });
    const t = await makeApp({ fetch });
    await setupAdmin(t);
    const sent: { title: string }[] = [];
    t.uptime.notifier = { notify: async (n: { title: string }) => void sent.push(n) } as unknown as Notifier;
    for (const n of ['Radarr', 'Sonarr', 'Jellyfin']) await t.json('POST', '/api/apps', { name: n, url: `http://${n.toLowerCase()}.lan/` });
    for (let i = 0; i < 2; i++) await t.uptime.checkAll();
    expect((await t.json<AppTab[]>('GET', '/api/apps')).map((a) => a.up)).toEqual([false, false, false]);
    expect(sent.map((x) => x.title).sort()).toEqual(['Jellyfin is down', 'Radarr is down', 'Sonarr is down']);
    await t.close();
  });

  it('an answer for an address that changed meanwhile, or after watching stopped, is not kept (AUDIT2 MON-18)', async () => {
    const { appChecks } = await import('../../src/db/schema.js');
    let release!: () => void;
    let hold = false;
    const fetch = async (url: string | URL) => {
      if (hold && String(url).includes('old.lan')) await new Promise<void>((r) => (release = r));
      return new Response('', { status: 500 });
    };
    const t = await makeApp({ fetch });
    await setupAdmin(t);
    const a = await t.json<AppTab>('POST', '/api/apps', { name: 'Moved', url: 'http://old.lan/' });
    const checks = () => t.ctx.db.select().from(appChecks).all().length;
    const before = checks();
    hold = true;
    const round = t.uptime.check(a.id);
    await new Promise((r) => setTimeout(r, 20));
    await t.json('PUT', `/api/apps/${a.id}`, { name: 'Moved', url: 'http://new.lan/', monitor: true });
    release();
    await round;
    // Only the check of the new address that the change made itself.
    expect(checks()).toBe(before + 1);
    await t.close();
  });
});

describe("an app's certificate", () => {
  it('is read from the handshake, and a message comes at 14 days and again at 3, once each', async () => {
    const tls = await import('node:tls');
    const { selfSigned } = await import('../tlscert.js');
    const t = await makeApp({ fetch: async () => new Response('', { status: 200 }) });
    await setupAdmin(t);
    const sent: { title: string; nl?: { title: string } }[] = [];
    t.uptime.notifier = { notify: async (n: { title: string }) => void sent.push(n) } as unknown as Notifier;
    // A server whose certificate runs out in 10 days (and 2.5 hours).
    const end = new Date(t.ctx.now() + 10 * 86_400_000 + 9_000_000);
    end.setUTCMilliseconds(0);
    const server = tls.createServer(selfSigned(end), (s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const a = await t.json<AppTab>('POST', '/api/apps', { name: 'Vault', url: `https://127.0.0.1:${port}/` });
      await t.uptime.checkCert(a.id);
      expect((await t.json<AppTab[]>('GET', '/api/apps'))[0]!.certExpiresAt).toBe(end.toISOString());
      await t.uptime.checkCert(a.id);
      expect(sent.map((s) => s.title)).toEqual(['Vault: its certificate runs out in 10 days']);
      // Eight days on: within three, told again; then not again.
      t.advance(8 * 86_400_000);
      await t.uptime.checkCert(a.id);
      await t.uptime.checkCert(a.id);
      expect(sent.map((s) => s.title)).toEqual(['Vault: its certificate runs out in 10 days', 'Vault: its certificate runs out in 2 days']);
      expect(sent[1]!.nl?.title).toBe('Vault: het certificaat verloopt over 2 dagen');
      // Run out: told once more, that it has (review 2026-10-24: nothing came after "in 2 days").
      t.advance(3 * 86_400_000);
      await t.uptime.checkCert(a.id);
      await t.uptime.checkCert(a.id);
      expect(sent.map((s) => s.title).slice(2)).toEqual(['Vault: its certificate has run out']);
    } finally {
      server.close();
      await t.close();
    }
  });

  it('plain http has none, and an answer that is no TLS is none too', async () => {
    const { certExpiry } = await import('../../src/apps/cert.js');
    expect(await certExpiry('http://radarr.lan:7878/')).toBeNull();
    const net = await import('node:net');
    const plain = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\n\r\n'));
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    expect(await certExpiry(`https://127.0.0.1:${(plain.address() as { port: number }).port}/`)).toBeNull();
    plain.close();
  });

  it('fetches the icons again: a new logo replaces the old one, none found keeps it', async () => {
    // Reported (5866c2): Burrow's own tile kept its old logo; icons were fetched only when an app was added.
    let logo: Buffer | null = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const fetch = async (input: string | URL | Request) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.pathname === '/favicon.ico') return logo ? new Response(new Uint8Array(logo), { headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 });
      return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    };
    const t = await makeApp({ fetch });
    await setupAdmin(t);
    const a = await t.json<AppTab>('POST', '/api/apps', { name: 'Burrow', url: 'https://burrow.lan/' });
    const icon = async () => (await t.request('GET', `/api/apps/${a.id}/icon`)).rawPayload;
    expect((await icon()).equals(logo)).toBe(true);
    expect(await t.uptime.refreshIcons()).toBe(0);
    logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
    expect(await t.uptime.refreshIcons()).toBe(1);
    expect((await icon()).equals(logo)).toBe(true);
    const kept = logo;
    logo = null;
    expect(await t.uptime.refreshIcons()).toBe(0);
    expect((await icon()).equals(kept)).toBe(true);
    await t.close();
  });
});
