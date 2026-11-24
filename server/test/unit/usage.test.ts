import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageSummary } from '@burrow/shared';
import { auditLog, usageDays } from '../../src/db/schema.js';
import { pruneOld } from '../../src/retention.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Settings -> Usage: pages and dialogs opened, per day, by name only.

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => t.close());

const DAY = 86_400_000;
const row = (s: UsageSummary, key: string) => s.rows.find((r) => r.key === key);

describe('usage counts', () => {
  it('adds what browsers send, per day; the summary has every page, the unopened ones at 0, the most used first', async () => {
    await t.request('POST', '/api/usage', { 'page:hosts': 2, 'dialog:processes': 1 });
    await t.request('POST', '/api/usage', { 'page:hosts': 3 });
    t.clock.now += DAY;
    await t.request('POST', '/api/usage', { 'page:hosts': 1, 'page:settings/ai': 1 });
    const s = await t.json<UsageSummary>('GET', '/api/usage?days=7');
    expect(s.on).toBe(true);
    expect(s.days).toBe(7);
    expect(s.since).toBe('2026-01-01');
    expect(s.rows[0]).toEqual({ key: 'page:hosts', n: 6, last: '2026-01-02' });
    expect(row(s, 'dialog:processes')).toEqual({ key: 'dialog:processes', n: 1, last: '2026-01-01' });
    expect(row(s, 'page:settings/ai')?.n).toBe(1);
    // A page or dialog never opened is there, at 0: what is not used shows (a dialog last opened
    // before the period was in neither list).
    expect(row(s, 'page:hosts/:id/journal')).toEqual({ key: 'page:hosts/:id/journal', n: 0, last: null });
    expect(row(s, 'dialog:alert-rule')).toEqual({ key: 'dialog:alert-rule', n: 0, last: null });
    // Only the days asked for: a week later, yesterday's day only.
    t.clock.now += 6 * DAY;
    expect(row(await t.json<UsageSummary>('GET', '/api/usage?days=7'), 'page:hosts')?.n).toBe(1);
  });

  it('keeps nothing of names it does not know (a container or file in an address, a made-up dialog), and the known ones of the same batch', async () => {
    const r = await t.request('POST', '/api/usage', { 'page:containers/3/nginx': 1, 'dialog:made-up': 9, 'page:alerts': 2 });
    expect(r.statusCode).toBe(200);
    // The answer says whether it counts: a browser stops sending while it is off.
    expect(r.json()).toEqual({ on: true });
    expect(t.ctx.db.select().from(usageDays).all().map((x) => [x.key, x.n])).toEqual([['page:alerts', 2]]);
    expect((await t.request('GET', '/api/usage?days=12')).statusCode).toBe(400);
  });

  it('turned off: nothing counted, until on again; cleared: nothing left, both in the audit log', async () => {
    await t.request('POST', '/api/usage', { 'page:hosts': 1 });
    expect(await t.json('PUT', '/api/usage/settings', { on: false })).toEqual({ on: false });
    expect((await t.request('POST', '/api/usage', { 'page:hosts': 5 })).json()).toEqual({ on: false });
    const off = await t.json<UsageSummary>('GET', '/api/usage');
    expect(off.on).toBe(false);
    expect(row(off, 'page:hosts')?.n).toBe(1);
    await t.json('PUT', '/api/usage/settings', { on: true });
    await t.request('POST', '/api/usage', { 'page:hosts': 2 });
    expect(row(await t.json<UsageSummary>('GET', '/api/usage'), 'page:hosts')?.n).toBe(3);
    expect((await t.request('DELETE', '/api/usage')).statusCode).toBe(204);
    const cleared = await t.json<UsageSummary>('GET', '/api/usage');
    expect(cleared.since).toBeNull();
    expect(cleared.rows.every((x) => x.n === 0)).toBe(true);
    expect(t.ctx.db.select().from(auditLog).all().map((a) => a.action)).toEqual(expect.arrayContaining(['usage.settings', 'usage.cleared']));
  });

  it('kept 180 days (today among them, as the page says), then gone with the other old entries', async () => {
    // 2026-01-01 is today; the oldest day kept is 179 days back (181 days were kept).
    t.ctx.db.insert(usageDays).values([{ day: '2025-07-06', key: 'page:hosts', n: 1 }, { day: '2025-07-05', key: 'page:alerts', n: 1 }, { day: '2026-01-01', key: 'page:apps', n: 1 }]).run();
    pruneOld(t.ctx);
    expect(t.ctx.db.select().from(usageDays).all().map((x) => x.key)).toEqual(['page:hosts', 'page:apps']);
    t.clock.now += DAY;
    pruneOld(t.ctx);
    expect(t.ctx.db.select().from(usageDays).all().map((x) => x.key)).toEqual(['page:apps']);
  });
});
