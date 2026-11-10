import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandRuns, commandSchedules } from '../../src/db/schema.js';
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

describe('a run the last start of Burrow left unfinished (a crash, a restart while it ran)', () => {
  it('is ended at start, as failed and said why, not shown as running for the 30 days it is kept; a full disk does not stop the start', async () => {
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan', username: 'me' });
    const s = t.ctx.db.insert(commandSchedules).values({ name: 'backup', command: 'true', hostIds: JSON.stringify([h.id]), enabled: true, kind: 'daily', day: 1, time: '03:00', cron: '', timeZone: 'UTC', timeoutMinutes: 5, createdAt: 0, updatedAt: 0 }).returning().get();
    const open = t.ctx.db.insert(commandRuns).values({ scheduleId: s.id, hostId: h.id, startedAt: t.clock.now - 60_000 }).returning().get();
    const done = t.ctx.db.insert(commandRuns).values({ scheduleId: s.id, hostId: h.id, startedAt: t.clock.now - 60_000, endedAt: t.clock.now - 30_000, code: 0 }).returning().get();
    const scheduled = new CommandScheduler(t.ctx, {} as never);
    t.ctx.db.$client.pragma('query_only = ON');
    try {
      expect(() => scheduled.start()).not.toThrow();
    } finally {
      scheduled.stop();
      t.ctx.db.$client.pragma('query_only = OFF');
    }
    scheduled.start();
    scheduled.stop();
    expect(scheduled.runById(open.id)).toMatchObject({ endedAt: new Date(t.clock.now).toISOString(), ok: false, error: 'Burrow stopped while this ran: how it ended is not known.' });
    expect(scheduled.runById(done.id)).toMatchObject({ endedAt: new Date(t.clock.now - 30_000).toISOString(), ok: true, error: null });
  });
});

describe('a deleted host (audit 2026-11-09)', () => {
  it('leaves the schedules, the reports and the wake relays: a new host given its id is no target of theirs', async () => {
    const { commandSchedules: cs, reportSchedules: rs, hosts } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    type H = { id: number };
    const a = await t.json<H>('POST', '/api/hosts', { name: 'keep', address: 'keep.lan' });
    const b = await t.json<H>('POST', '/api/hosts', { name: 'old-nas', address: 'nas.lan', wakeVia: a.id });
    await t.json('PUT', `/api/hosts/${a.id}`, { name: 'keep', address: 'keep.lan', wakeVia: b.id });
    const now = t.clock.now;
    t.ctx.db.insert(cs).values({ name: 'nightly', command: 'docker system prune -af', hostIds: JSON.stringify([a.id, b.id]), enabled: true, kind: 'daily', day: 1, time: '03:00', cron: null, timeZone: 'UTC', timeoutMinutes: 5, createdAt: now, updatedAt: now }).run();
    const report = t.ctx.db.select().from(rs).all()[0];
    if (report) t.ctx.db.update(rs).set({ hostIds: JSON.stringify([b.id]) }).where(eq(rs.id, report.id)).run();
    await t.json('DELETE', `/api/hosts/${b.id}`);
    const c = await t.json<H>('POST', '/api/hosts', { name: 'someone-else', address: 'other.lan' });
    expect(c.id).toBe(b.id);
    expect(JSON.parse(t.ctx.db.select().from(cs).all()[0]!.hostIds) as number[]).toEqual([a.id]);
    if (report) expect(JSON.parse(t.ctx.db.select().from(rs).where(eq(rs.id, report.id)).get()!.hostIds ?? '[]') as number[]).not.toContain(c.id);
    expect(t.ctx.db.select().from(hosts).where(eq(hosts.id, a.id)).get()!.wakeVia).toBeNull();
  });
});
