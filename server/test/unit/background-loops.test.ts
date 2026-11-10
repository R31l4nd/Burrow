import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '@burrow/shared';
import { AlertEngine } from '../../src/alerts/engine.js';
import { Updater } from '../../src/docker/autoupdate.js';
import { DockerMonitor } from '../../src/docker/monitor.js';
import { Reports } from '../../src/reports/generate.js';
import { CommandScheduler } from '../../src/schedules/commands.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Background rounds started with `void`: one that threw was a rejection
// nobody handled (Node ends the process for it), and a throw in the
// container poll ended that host's polling for good (audit 2026-11-05).

let t: TestApp;
const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => void unhandled.push(r);
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
  await t.close();
});

describe('a background round that throws', () => {
  it('is said in the log, and the next round comes: reports, scheduled commands, the maintenance window, the alert streams', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(t.ctx.log, 'warn');
    const boom = async () => {
      throw new Error('database is locked');
    };
    const reports = new Reports(t.ctx, {} as never, {} as never, {} as never);
    const scheduled = new CommandScheduler(t.ctx, {} as never);
    const updater = new Updater(t.ctx, {} as never, { adoptRunning: async () => [] } as never, {} as never);
    const engine = new AlertEngine(t.ctx, {} as never, {} as never, {} as never, { reconcileMs: 60_000 });
    let rounds = 0;
    const counted = async () => {
      rounds++;
      return boom();
    };
    reports.tick = counted;
    scheduled.tick = counted;
    updater.tick = counted;
    engine.reconcile = counted;
    reports.start();
    scheduled.start();
    updater.start();
    engine.start();
    await vi.advanceTimersByTimeAsync(120_000);
    reports.stop();
    scheduled.stop();
    updater.stop();
    engine.stop();
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
    // Each one more than once: the loop went on after the throw.
    expect(rounds).toBeGreaterThanOrEqual(2 + 6 + 2 + 3);
    expect(warn.mock.calls.filter((c) => String(c.at(-1)).includes('database is locked')).length).toBe(rounds);
  });

  it("a viewer whose listener throws stops neither the host's container poll nor the other viewers", async () => {
    const host = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: 'h.lan', username: 'me' });
    // Every poll fails (no SSH here): a snapshot with its error, still sent each round.
    const pool = { with: async () => Promise.reject(new Error('connect ECONNREFUSED')) };
    const monitor = new DockerMonitor(t.ctx, pool as never, 10);
    let bad = 0;
    let good = 0;
    const stopBad = monitor.watch(host.id, () => {
      bad++;
      throw new Error('socket gone');
    });
    const stopGood = monitor.watch(host.id, () => void good++);
    await vi.waitFor(() => expect(good).toBeGreaterThanOrEqual(3));
    expect(bad).toBeGreaterThanOrEqual(3);
    stopBad();
    stopGood();
    monitor.stop();
    expect(unhandled).toEqual([]);
  });
});

describe("the container monitor and a host's failing connects (audit 2026-11-09)", () => {
  it('the history sampler waits them out too; a watch just opened tries at once, its later rounds wait', async () => {
    const host = await t.json<Host>('POST', '/api/hosts', { name: 'h2', address: 'h2.lan', username: 'me' });
    const asked: (boolean | undefined)[] = [];
    const pool = { with: async (_id: number, _fn: unknown, o?: { background?: boolean }) => (asked.push(o?.background), Promise.reject(new Error('connect ECONNREFUSED'))) };
    const monitor = new DockerMonitor(t.ctx, pool as never, 10);
    // The sampler every five minutes (a wrong password was a failed login each time: fail2ban).
    await monitor.recent(host.id, 60_000, true, true);
    expect(asked).toEqual([true]);
    asked.length = 0;
    // Someone opens Containers: the first round is theirs, not held back by an old failure.
    const stop = monitor.watch(host.id, () => {});
    await vi.waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(3));
    stop();
    monitor.stop();
    expect(asked[0]).toBe(false);
    expect(asked.slice(1).every((b) => b === true)).toBe(true);
  });
});
