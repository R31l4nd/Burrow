import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alertCounts, alerts, auditLog, recordings, reports, stackUpdates, terminalSessions, users } from '../../src/db/schema.js';
import { KEEP_REPORTS, KEEP_STACK_UPDATES, pruneOld } from '../../src/retention.js';
import { RECORDINGS_DIR } from '../../src/terminal/recorder.js';
import { DEFAULT_KEEP_DAYS, pruneRecordings } from '../../src/terminal/recordings.js';
import { makeApp, setupAdmin } from '../helpers.js';

describe('retention', () => {
  it('keeps the audit log a year, alerts 90 days, the newest reports', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const now = t.clock.now;
    const day = 86_400_000;
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'a', address: 'a.lan' });
    t.ctx.db.insert(auditLog).values([{ at: now - 400 * day, action: 'old' }, { at: now - 10 * day, action: 'recent' }]).run();
    const alert = { ruleName: 'r', hostId: h.id, container: 'web', title: 't', at: new Date(now).toISOString(), count: 1, read: false, pushed: 'no' as const, createdAt: now };
    t.ctx.db.insert(alerts).values([{ ...alert, updatedAt: now - 100 * day }, { ...alert, updatedAt: now - day }]).run();
    for (let i = 0; i < KEEP_REPORTS + 5; i++) {
      t.ctx.db.insert(reports).values({ name: `r${i}`, createdAt: now, periodFrom: now, periodTo: now, status: 'ok', counts: '{}', summary: '', containers: '[]' }).run();
    }
    const r = pruneOld(t.ctx);
    expect(r).toEqual({ audit: 1, alerts: 1, reports: 5 });
    expect(t.ctx.db.select().from(auditLog).all().map((x) => x.action)).not.toContain('old');
    expect(t.ctx.db.select().from(reports).all().map((x) => x.name)).not.toContain('r0');
    expect(t.ctx.db.select().from(reports).all()).toHaveLength(KEEP_REPORTS);
    await t.close();
  });

  it("an alert that keeps recurring keeps its counts of the last 90 days only; each stack its newest updates (audit 2026-11-05)", async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const now = t.clock.now;
    const day = 86_400_000;
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'a', address: 'a.lan' });
    // Recurring: it happened today, so the alert itself stays; a count a day for 200 days.
    const id = t.ctx.db.insert(alerts).values({ ruleName: 'r', hostId: h.id, container: 'web', title: 't', at: new Date(now).toISOString(), count: 200, read: false, pushed: 'no', createdAt: now - 200 * day, updatedAt: now }).returning().get().id;
    t.ctx.db.insert(alertCounts).values(Array.from({ length: 200 }, (_, i) => ({ alertId: id, minute: Math.floor((now - i * day) / 60_000), n: 1 }))).run();
    const row = (project: string, i: number) => ({ hostId: h.id, project, auto: true, result: 'updated' as const, images: '[]', startedAt: now - (1000 - i) * 60_000, finishedAt: now - (1000 - i) * 60_000 });
    t.ctx.db.insert(stackUpdates).values([...Array.from({ length: KEEP_STACK_UPDATES + 20 }, (_, i) => row('busy', i)), ...Array.from({ length: 3 }, (_, i) => row('calm', i))]).run();
    pruneOld(t.ctx);
    const kept = t.ctx.db.select().from(alertCounts).all();
    expect(kept.length).toBeGreaterThanOrEqual(89);
    expect(kept.length).toBeLessThanOrEqual(91);
    expect(t.ctx.db.select().from(alerts).all()).toHaveLength(1);
    const left = t.ctx.db.select().from(stackUpdates).all();
    expect(left.filter((r) => r.project === 'busy')).toHaveLength(KEEP_STACK_UPDATES);
    // The newest kept: the oldest 20 went.
    expect(Math.min(...left.filter((r) => r.project === 'busy').map((r) => r.startedAt))).toBe(row('busy', 20).startedAt);
    expect(left.filter((r) => r.project === 'calm')).toHaveLength(3);
    await t.close();
  });

  it('keeps a recording that is still being written, however old; one left unfinished by a stop goes (A3-SRV-21)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-ret-'));
    const t = await makeApp({ env: { BURROW_DATA_DIR: dir } });
    await setupAdmin(t);
    const userId = t.ctx.db.select().from(users).get()!.id;
    const now = t.clock.now;
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'rec', address: 'rec.lan' });
    mkdirSync(join(dir, RECORDINGS_DIR), { recursive: true });
    t.ctx.db.insert(terminalSessions).values({ id: 'live', hostId: h.id, userId, mode: 'tmux', createdAt: now, lastActivityAt: now, recording: true }).run();
    const old = now - (DEFAULT_KEEP_DAYS + 1) * 86_400_000;
    for (const [file, sessionId, endedAt] of [['running.cast', 'live', null], ['ended.cast', 'live', old + 1000], ['stale.cast', 'gone', null]] as const) {
      writeFileSync(join(dir, RECORDINGS_DIR, file), '{}\n');
      t.ctx.db.insert(recordings).values({ sessionId, hostName: 'rec', file, startedAt: old, endedAt }).run();
    }
    expect(pruneRecordings(t.ctx)).toBe(2);
    expect(t.ctx.db.select().from(recordings).all().map((r) => r.file)).toEqual(['running.cast']);
    expect(existsSync(join(dir, RECORDINGS_DIR, 'running.cast'))).toBe(true);
    expect(existsSync(join(dir, RECORDINGS_DIR, 'stale.cast'))).toBe(false);
    await t.close();
  });

  it('kept as long as an admin chose, 30 days by default; shorter, what is older goes at once (decision 16)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-ret-'));
    const t = await makeApp({ env: { BURROW_DATA_DIR: dir } });
    await setupAdmin(t);
    mkdirSync(join(dir, RECORDINGS_DIR), { recursive: true });
    const day = 86_400_000;
    for (const [file, age] of [['ten.cast', 10], ['three.cast', 3]] as const) {
      writeFileSync(join(dir, RECORDINGS_DIR, file), '{}\n');
      t.ctx.db.insert(recordings).values({ sessionId: 'x', hostName: 'rec', file, startedAt: t.clock.now - age * day, endedAt: t.clock.now - age * day + 1000 }).run();
    }
    expect(await t.json('GET', '/api/recordings/settings')).toEqual({ keepDays: 30 });
    expect(pruneRecordings(t.ctx)).toBe(0);
    expect(await t.json('PUT', '/api/recordings/settings', { keepDays: 7 })).toEqual({ keepDays: 7, removed: 1 });
    expect(t.ctx.db.select().from(recordings).all().map((r) => r.file)).toEqual(['three.cast']);
    expect(existsSync(join(dir, RECORDINGS_DIR, 'ten.cast'))).toBe(false);
    expect((await t.request('PUT', '/api/recordings/settings', { keepDays: 0 })).statusCode).toBe(400);
    expect(await t.json('GET', '/api/recordings/settings')).toEqual({ keepDays: 7 });
    await t.close();
  });
});
