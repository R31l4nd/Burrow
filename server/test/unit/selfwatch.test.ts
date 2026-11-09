import type { BackgroundJob, LogEvent, Notice, UpdateCheck } from '@burrow/shared';
import { describe, expect, it } from 'vitest';
import { DISK_LOW_BYTES, diskProblem, SelfWatch, updateNotices, type SelfWatchDeps } from '../../src/selfwatch.js';
import { makeApp, type TestApp } from '../helpers.js';

const HOUR = 3600_000;

function watch(t: TestApp, over: Partial<SelfWatchDeps> = {}) {
  const sent: Notice[] = [];
  const state = {
    channels: 1,
    jobs: [] as BackgroundJob[],
    events: [] as LogEvent[],
    disk: { free: 50 * DISK_LOW_BYTES, total: 100 * DISK_LOW_BYTES } as { free: number | null; total: number | null },
    failing: new Map<string, { error: string; since: number }>(),
    check: null as UpdateCheck | null,
  };
  const w = new SelfWatch(t.ctx, {
    send: async (n) => (sent.push(n), { sent: state.channels }),
    jobs: () => state.jobs,
    logEvents: () => state.events,
    disk: () => state.disk,
    failingChannels: () => state.failing,
    checkUpdate: async () => state.check,
    summary: () => ({ en: 'Version 9.9.9.', nl: 'Versie 9.9.9.' }),
    ...over,
  });
  return { w, sent, state, titles: () => sent.map((n) => n.title) };
}

const job = (name: BackgroundJob['name'], error: string | null, at: string): BackgroundJob => ({ name, lastRunAt: at, ms: 5, runs: 3, lastError: error, lastErrorAt: error ? at : null, ok: error === null });

const check = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({ target: null, running: '2.20.3', mode: 'git', available: '2.20.3', behind: 0, subject: null, last: null, problem: null, breaking: [], image: null, pinned: null, ...over });

describe('Burrow tells about itself (2026-11-07)', () => {
  it('a job failing for an hour is told once, and once more when it works again', async () => {
    const t = await makeApp();
    const { w, state, titles } = watch(t);
    const at = () => new Date(t.clock.now).toISOString();
    state.jobs = [job('reports', 'ssh: connect timeout', at())];
    expect(await w.tick()).toEqual([]);
    t.advance(HOUR);
    state.jobs = [job('reports', 'ssh: connect timeout', at())];
    expect(await w.tick()).toEqual(['job:reports']);
    // Still failing: not told again, also not after a restart (a new watcher, the same database).
    t.advance(HOUR);
    expect(await w.tick()).toEqual([]);
    expect(await watch(t, { jobs: () => state.jobs }).w.tick()).toEqual([]);
    state.jobs = [job('reports', null, at())];
    expect(await w.tick()).toEqual(['fine:job:reports']);
    expect(titles()).toEqual(['Burrow: "reports" keeps failing', 'Fine again: Burrow: "reports" keeps failing']);
    await t.close();
  });

  it('with no channel to take it, a problem is tried again the next hour', async () => {
    const t = await makeApp();
    const { w, state } = watch(t);
    state.disk = { free: DISK_LOW_BYTES / 2, total: 100 * DISK_LOW_BYTES };
    state.channels = 0;
    expect(await w.tick()).toEqual([]);
    state.channels = 1;
    t.advance(HOUR);
    expect(await w.tick()).toEqual(['disk']);
    await t.close();
  });

  it('warns of the data disk well before it is full: under 1 GB or 5% free', () => {
    expect(diskProblem(50 * DISK_LOW_BYTES, 100 * DISK_LOW_BYTES)).toBeNull();
    expect(diskProblem(DISK_LOW_BYTES / 2, 100 * DISK_LOW_BYTES)?.key).toBe('disk');
    // A big disk: 4% free is still told, although that is many GB.
    expect(diskProblem(40 * DISK_LOW_BYTES, 1000 * DISK_LOW_BYTES)?.en.title).toMatch(/40\.0 GB free \(4%\)/);
    expect(diskProblem(null, null)).toBeNull();
  });

  it('a failing channel is told through the others', async () => {
    const t = await makeApp();
    const { w, state, sent } = watch(t);
    state.failing.set('Phone ntfy', { error: '401 unauthorized', since: t.clock.now });
    expect(await w.tick()).toEqual(['channel:Phone ntfy']);
    expect(sent[0]).toMatchObject({ topic: 'alerts', page: '/settings?s=channels' });
    expect(sent[0]!.body).toContain('401 unauthorized');
    state.failing.clear();
    expect(await w.tick()).toEqual(['fine:channel:Phone ntfy']);
    await t.close();
  });

  it("new errors in Burrow's own log: one message, each kind once a week", async () => {
    const t = await makeApp();
    const { w, state, sent } = watch(t);
    const ev = (kind: string, level: 'warn' | 'error'): LogEvent => ({ kind, level, count: 2, firstAt: new Date(t.clock.now).toISOString(), lastAt: new Date(t.clock.now).toISOString(), example: `${kind} happened` });
    t.advance(1000);
    state.events = [ev('db locked', 'error'), ev('slow host', 'warn')];
    expect(await w.tick()).toEqual(['errors']);
    expect(sent[0]!.title).toBe('Burrow logged 1 new error');
    expect(sent[0]!.body).toContain('db locked happened (2x)');
    // Seen again within the week: nothing new.
    t.advance(HOUR);
    state.events = [ev('db locked', 'error')];
    expect(await w.tick()).toEqual([]);
    await t.close();
  });

  it('a new version once a day, told once; a rolled-back self-update told once', async () => {
    const t = await makeApp();
    const { w, state, sent } = watch(t);
    state.check = check({ available: '2.21.0', breaking: ['2.21.0: the app has a new id'] });
    expect(await w.tick()).toEqual(['version:2.21.0']);
    expect(sent[0]).toMatchObject({ topic: 'updates', title: 'Burrow 2.21.0 is available' });
    expect(sent[0]!.body).toContain('the app has a new id');
    // Checked again only a day later, and the same version not told twice.
    t.advance(HOUR);
    state.check = check({ available: '2.22.0' });
    expect(await w.tick()).toEqual([]);
    t.advance(24 * HOUR);
    state.check = check({ available: '2.22.0', last: { state: 'rolledback', at: '2026-01-02T10:00:00Z', message: 'not healthy within two minutes' } });
    expect(await w.tick()).toEqual(['version:2.22.0', 'selfupdate:2026-01-02T10:00:00Z']);
    t.advance(24 * HOUR);
    expect(await w.tick()).toEqual([]);
    // Not newer than what runs: nothing.
    expect(sent.map((n) => n.title)).not.toContain('Burrow 2.20.3 is available');
    await t.close();
  });

  it('an install whose image tag does not reach the new version is told the tag that does', () => {
    const pinned = updateNotices(check({ mode: 'image', available: '2.22.0', image: 'ghcr.io/r31l4nd/burrow:2.21', pinned: { image: 'ghcr.io/r31l4nd/burrow:2.21', next: 'ghcr.io/r31l4nd/burrow:2.22' } }))[0]!;
    expect(pinned.en.body).toContain('set BURROW_IMAGE=ghcr.io/r31l4nd/burrow:2.22 in .env');
    expect(pinned.nl.body).toContain('zet BURROW_IMAGE=ghcr.io/r31l4nd/burrow:2.22 in .env');
    expect(updateNotices(check({ mode: 'image', available: '2.22.0', image: 'ghcr.io/r31l4nd/burrow:latest' }))[0]!.en.body).not.toContain('BURROW_IMAGE');
  });

  it('a check that fails is tried again the next hour, not a day later', async () => {
    const t = await makeApp();
    let fail = true;
    const { w, sent } = watch(t, { checkUpdate: async () => (fail ? Promise.reject(new Error('host away')) : check({ available: '3.0.0' })) });
    expect(await w.tick()).toEqual([]);
    fail = false;
    t.advance(HOUR);
    expect(await w.tick()).toEqual(['version:3.0.0']);
    expect(sent).toHaveLength(1);
    await t.close();
  });

  it('says once a week on every channel that it runs, so its silence means something', async () => {
    const t = await makeApp();
    const { w, sent } = watch(t);
    expect(await w.tick()).toEqual([]);
    t.advance(7 * 24 * HOUR);
    expect(await w.tick()).toContain('weekly');
    const weekly = sent.find((n) => n.title === 'Burrow runs')!;
    // The test topic: every channel gets it, whatever topics it has.
    expect(weekly.topic).toBe('test');
    expect(weekly.body).toContain('Version 9.9.9.');
    expect(weekly.nl!.body).toContain('eens per week');
    t.advance(HOUR);
    expect(await w.tick()).not.toContain('weekly');
    await t.close();
  });
});
