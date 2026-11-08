import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandSchedules } from '../../src/db/schema.js';
import { CommandScheduler } from '../../src/schedules/commands.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => t.close());

describe('a scheduled command and the clock going back an hour', () => {
  it('runs each local minute once, also when it comes round twice (audit 2026-11-05, as the reports: AUDIT2 MON-19)', async () => {
    const created = Date.parse('2026-10-24T00:00:00Z');
    t.ctx.db.insert(commandSchedules).values({ name: 'night', command: 'true', hostIds: '[]', enabled: true, kind: 'cron', day: 1, time: '00:00', cron: '0,30 2 * * *', timeZone: 'Europe/Amsterdam', timeoutMinutes: 5, createdAt: created, updatedAt: created }).run();
    const scheduled = new CommandScheduler(t.ctx, {} as never);
    const ran: string[] = [];
    scheduled.run = async () => {
      ran.push(new Date(t.clock.now).toISOString());
      return [];
    };
    // 2026-10-25: 02:00-03:00 CEST (00:00-01:00 UTC), then 02:00-03:00 CET again (01:00-02:00 UTC).
    for (const utc of ['2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:00:00Z', '2026-10-25T01:30:00Z']) {
      t.clock.now = Date.parse(utc);
      await scheduled.tick();
    }
    expect(ran).toEqual(['2026-10-25T00:00:00.000Z', '2026-10-25T00:30:00.000Z']);
  });
});
