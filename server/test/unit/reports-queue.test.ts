import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reportSchedules } from '../../src/db/schema.js';
import { Reports } from '../../src/reports/generate.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => t.close());

describe('reports waiting their turn', () => {
  it('a schedule switched off while it waited is not made (AUDIT2 MON-21)', async () => {
    const add = (name: string) =>
      t.ctx.db.insert(reportSchedules).values({ name, enabled: true, kind: 'cron', day: 1, time: '00:00', cron: '* * * * *', timeZone: 'UTC', createdAt: t.clock.now }).returning().get().id;
    const first = add('first');
    const second = add('second');
    const reports = new Reports(t.ctx, {} as never, {} as never, { notify: async () => ({ sent: 0, failed: [] }), lang: () => 'en' } as never);
    const made: number[] = [];
    // The first being made, the second is switched off meanwhile.
    reports.run = async (id: number) => {
      made.push(id);
      if (id === first) t.ctx.db.update(reportSchedules).set({ enabled: false }).where(eq(reportSchedules.id, second)).run();
      return {} as never;
    };
    await reports.tick();
    expect(made).toEqual([first]);
  });
});

describe('the clock going back an hour', () => {
  it('each local minute of a schedule runs once, also when it comes round twice (AUDIT2 MON-19)', async () => {
    t.ctx.db.insert(reportSchedules).values({ name: 'night', enabled: true, kind: 'cron', day: 1, time: '00:00', cron: '0,30 2 * * *', timeZone: 'Europe/Amsterdam', createdAt: t.clock.now }).run();
    const reports = new Reports(t.ctx, {} as never, {} as never, { notify: async () => ({ sent: 0, failed: [] }), lang: () => 'en' } as never);
    const made: string[] = [];
    reports.run = async () => {
      made.push(new Date(t.clock.now).toISOString());
      return {} as never;
    };
    // 2026-10-25: 02:00-03:00 CEST (00:00-01:00 UTC), then 02:00-03:00 CET again (01:00-02:00 UTC).
    for (const utc of ['2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:00:00Z', '2026-10-25T01:30:00Z']) {
      t.clock.now = Date.parse(utc);
      await reports.tick();
    }
    expect(made).toEqual(['2026-10-25T00:00:00.000Z', '2026-10-25T00:30:00.000Z']);
  });
});

describe('a tick that comes late (OPS-W-07)', () => {
  it("a report whose minute no tick landed in is made by the next tick, once; not again the next day's ticks", async () => {
    t.ctx.db.insert(reportSchedules).values({ name: 'morning', enabled: true, kind: 'daily', day: 1, time: '08:00', cron: null, timeZone: 'UTC', createdAt: t.clock.now }).run();
    const reports = new Reports(t.ctx, {} as never, {} as never, { notify: async () => ({ sent: 0, failed: [] }), lang: () => 'en' } as never);
    const made: string[] = [];
    reports.run = async () => {
      made.push(new Date(t.clock.now).toISOString());
      return {} as never;
    };
    // The host slept (or the clock stepped) over 08:00.
    for (const utc of ['2026-10-20T07:59:30Z', '2026-10-20T08:01:30Z', '2026-10-20T08:02:30Z', '2026-10-20T12:00:00Z']) {
      t.clock.now = Date.parse(utc);
      await reports.tick();
    }
    expect(made).toEqual(['2026-10-20T08:01:30.000Z']);
  });
});
