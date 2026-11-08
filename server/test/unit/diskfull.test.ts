import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Burrow's data disk full (OPS-W-02): every write answered a bare
// "500 internal", step-up too, while /healthz stayed green and nobody was
// told. SQLite's max_page_count makes the database "full" as a full disk
// would (SQLITE_FULL).

let t: TestApp;
afterEach(async () => {
  await t.close();
});

const fill = (app: TestApp) => {
  const db = app.ctx.db.$client;
  db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true }) as number}`);
};

describe('a full data disk', () => {
  it('a write says the disk is full (507 disk_full), not "internal"; told once on the channels', async () => {
    const hooks: string[] = [];
    t = await makeApp({ send: { fetch: async (_url: string, init?: RequestInit) => (hooks.push(String(init?.body)), new Response('ok')) } });
    await setupAdmin(t);
    await t.json('POST', '/api/channels', { kind: 'webhook', name: 'Alerts', enabled: true, topics: ['alerts'], lang: 'en', webhook: { url: 'https://hooks.example.com/a' } });
    fill(t);
    const big = 'x'.repeat(8000);
    for (let i = 0; i < 3; i++) {
      const r = await t.request('POST', '/api/snippets', { name: `s${i}`, command: big });
      expect(r.statusCode).toBe(507);
      expect(r.json()).toEqual({ error: 'disk_full', message: 'Burrow cannot save anything: its data disk is full. Free space on the host where Burrow keeps its data.' });
    }
    await expect.poll(() => hooks.length).toBe(1);
    expect(hooks[0]).toContain("Burrow's data disk is full");
    // Unwell while it lasts.
    const h = await t.request('GET', '/healthz');
    expect(h.statusCode).toBe(503);
    expect(h.json()).toMatchObject({ ok: false, hints: ['disk_full'] });
  });

  it('/healthz turns unwell when the data disk has under 50 MB free, and well again with room', async () => {
    let free = 10 << 20;
    t = await makeApp({ freeBytes: () => free });
    expect((await t.request('GET', '/healthz')).statusCode).toBe(503);
    free = 5 << 30;
    const h = await t.request('GET', '/healthz');
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ ok: true });
  });
});
