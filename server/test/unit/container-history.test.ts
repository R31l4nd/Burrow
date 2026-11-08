import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerSample, Host, HostContainers } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { hosts } from '../../src/db/schema.js';
import { ContainerHistory, HISTORY_HOST_MS } from '../../src/docker/history.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Report 428102: a container's CPU and memory were only the last minutes the
// page had been open; now kept on the server, to look back on.

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => t.close());

const snap = (hostId: number, rows: [string, string, number, number][], at: number): HostContainers =>
  ({
    hostId,
    hostName: 'h',
    at: new Date(at).toISOString(),
    error: null,
    history: {},
    containers: rows.map(([id, name]) => ({ id, name, state: 'running' })),
    stats: Object.fromEntries(rows.map(([id, , cpu, mem]) => [id, { cpu, memBytes: mem, memKnown: true }])),
  }) as unknown as HostContainers;

describe('container history', () => {
  it('keeps each container by name across its id, and gives it back for a period (report 428102)', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'dock', address: 'dock.lan', username: 'me' });
    const answers = [snap(h.id, [['a1', 'web', 1.5, 100], ['b1', 'db', 0.2, 900]], t.clock.now)];
    const hist = new ContainerHistory(t.ctx, async () => answers.shift()!);
    await hist.sample(h.id);
    t.clock.now += 5 * 60_000;
    // Made again (an update): another id, the same name and history.
    answers.push(snap(h.id, [['a2', 'web', 3, 200]], t.clock.now));
    await hist.sample(h.id);
    const web = hist.history(h.id, 'web', 86_400_000);
    expect(web.map((s) => [s.cpu, s.memBytes])).toEqual([[1.5, 100], [3, 200]]);
    expect(hist.history(h.id, 'db', 86_400_000)).toHaveLength(1);
    // Over the route too, for a day.
    const r = await t.json<ContainerSample[]>('GET', `/api/docker/${h.id}/containers/web/history?range=day`);
    expect(r).toHaveLength(2);
  });

  it('a host that could not be read adds nothing, not zeros (failed is not empty)', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'gone', address: 'gone.lan', username: 'me' });
    const hist = new ContainerHistory(t.ctx, async () => ({ ...snap(h.id, [], t.clock.now), error: 'ssh: timeout' }));
    await expect(hist.sample(h.id)).rejects.toThrow('ssh: timeout');
    expect(hist.recent(h.id, 3_600_000).size).toBe(0);
  });

  it('older than two days, one average an hour; a host that hangs holds up only itself; failures said once, at warn (OPS-W-06, OPS-W-14)', async () => {
    const { Jobs } = await import('../../src/jobs.js');
    const { containerSamples } = await import('../../src/db/schema.js');
    const hs: Host[] = [];
    for (const n of ['hung', 'one', 'two', 'down']) {
      const h = await t.json<Host>('POST', '/api/hosts', { name: n, address: `${n}.lan`, username: 'me' });
      t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).where(eq(hosts.id, h.id)).run();
      hs.push(h);
    }
    const [hung, one, two, down] = hs as [Host, Host, Host, Host];
    // Three days of 5-minute samples of one container: 864 rows.
    const start = t.clock.now - 3 * 86_400_000;
    const rows = Array.from({ length: 864 }, (_, k) => ({ hostId: one.id, name: 'app', at: start + k * 300_000 + 7, cpu: k % 2, memBytes: 100 }));
    for (let k = 0; k < rows.length; k += 200) t.ctx.db.insert(containerSamples).values(rows.slice(k, k + 200)).run();
    const jobs = new Jobs(t.ctx);
    const warn = vi.spyOn(t.ctx.log, 'warn');
    const read = async (id: number) => {
      if (id === hung.id) return new Promise<HostContainers>((r) => setTimeout(() => r(snap(id, [], t.clock.now)), 300));
      if (id === down.id) return { ...snap(id, [], t.clock.now), error: 'connection refused' } as HostContainers;
      return snap(id, [['x', 'app', 1, 1]], t.clock.now);
    };
    const hist = new ContainerHistory(t.ctx, read, jobs);
    const t0 = performance.now();
    await hist.tick();
    // Not one after another behind the hung one.
    expect(performance.now() - t0).toBeLessThan(1000);
    await hist.tick();
    const kept = hist.history(one.id, 'app', 4 * 86_400_000);
    // The last two days at 5 minutes (and the new samples), the day before as 24 or 25 hourly averages.
    const hourly = kept.filter((k) => Date.parse(k.at) % 3_600_000 === 0);
    expect(hourly.length).toBeGreaterThanOrEqual(24);
    expect(hourly.length).toBeLessThanOrEqual(25);
    expect(hourly.every((k) => k.cpu === 0.5 && k.memBytes === 100)).toBe(true);
    expect(kept.length).toBeLessThan(864 - 250);
    expect(hist.history(two.id, 'app', 86_400_000)).toHaveLength(2);
    expect(warn.mock.calls.filter((c) => String(c.at(-1)).includes('connection refused'))).toHaveLength(1);
    expect(jobs.list()).toEqual([expect.objectContaining({ name: 'container-history', runs: 2, ok: false, lastError: 'down: connection refused' })]);
  });

  it('a host that never answers no longer holds the round: the others are sampled again, the hung one is not asked again on top', async () => {
    const { Jobs } = await import('../../src/jobs.js');
    const hung = await t.json<Host>('POST', '/api/hosts', { name: 'hung', address: 'hung.lan', username: 'me' });
    const fine = await t.json<Host>('POST', '/api/hosts', { name: 'fine', address: 'fine.lan', username: 'me' });
    for (const h of [hung, fine]) t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).where(eq(hosts.id, h.id)).run();
    const jobs = new Jobs(t.ctx);
    const warn = vi.spyOn(t.ctx.log, 'warn');
    const asked: number[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The hung host's read never ends (a stale NFS home under its SSH, say).
      const hist = new ContainerHistory(t.ctx, (id) => (asked.push(id), id === hung.id ? new Promise<HostContainers>(() => {}) : Promise.resolve(snap(id, [['x', 'app', 1, 1]], t.clock.now))), jobs);
      let ended = false;
      void hist.tick().then(() => (ended = true));
      await vi.advanceTimersByTimeAsync(HISTORY_HOST_MS + 1000);
      expect(ended).toBe(true);
      t.clock.now += 5 * 60_000;
      await hist.tick();
      expect(asked).toEqual([hung.id, fine.id, fine.id]);
      expect(hist.history(fine.id, 'app', 86_400_000)).toHaveLength(2);
      expect(warn.mock.calls.filter((c) => String(c.at(-1)).includes('hung: no answer in 2 min'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets what is older than a month, and samples only hosts with Docker', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'old', address: 'old.lan', username: 'me' });
    const other = await t.json<Host>('POST', '/api/hosts', { name: 'plain', address: 'plain.lan', username: 'me' });
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).where(eq(hosts.id, h.id)).run();
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: false }) }).where(eq(hosts.id, other.id)).run();
    const asked: number[] = [];
    const hist = new ContainerHistory(t.ctx, async (id) => (asked.push(id), snap(id, [['x', 'app', 1, 1]], t.clock.now)));
    await hist.tick();
    expect(asked).toEqual([h.id]);
    t.clock.now += 32 * 86_400_000;
    await hist.tick();
    expect(hist.history(h.id, 'app', 40 * 86_400_000)).toHaveLength(1);
  });

  it('samples every five minutes once started (the first after a minute and a half); stopped, it reads no host, not even halfway a round', async () => {
    const a = await t.json<Host>('POST', '/api/hosts', { name: 'a', address: 'a.lan', username: 'me' });
    const b = await t.json<Host>('POST', '/api/hosts', { name: 'b', address: 'b.lan', username: 'me' });
    for (const h of [a, b]) t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).where(eq(hosts.id, h.id)).run();
    // A host whose facts cannot be read is no Docker host.
    const broken = await t.json<Host>('POST', '/api/hosts', { name: 'c', address: 'c.lan', username: 'me' });
    t.ctx.db.update(hosts).set({ facts: '{not json' }).where(eq(hosts.id, broken.id)).run();
    const asked: number[] = [];
    let hist: ContainerHistory;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      hist = new ContainerHistory(t.ctx, async (id) => {
        asked.push(id);
        // Stopped while the first host is read: the second is not.
        if (asked.length === 3) hist.stop();
        return snap(id, [['x', 'app', 1, 1]], t.clock.now);
      });
      hist.start();
      await vi.advanceTimersByTimeAsync(89_000);
      expect(asked).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(asked).toEqual([a.id, b.id]);
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 90_000);
      expect(asked).toEqual([a.id, b.id, a.id]);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(asked).toEqual([a.id, b.id, a.id]);
      await hist.tick();
      expect(asked).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the last hour per name, for the list to start with (not empty at every visit)', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'list', address: 'list.lan', username: 'me' });
    const hist = new ContainerHistory(t.ctx, async () => snap(h.id, [['c', 'cache', 2, 50]], t.clock.now));
    await hist.sample(h.id);
    t.clock.now += 5 * 60_000;
    await hist.sample(h.id);
    const r = hist.recent(h.id, 3_600_000).get('cache')!;
    expect(r.cpu).toEqual([2, 2]);
    expect(r.at).toHaveLength(2);
  });
});

describe('the list sparklines', () => {
  it('start with the kept hour when a watch begins, then add the live samples (report 428102)', async () => {
    const { DockerMonitor } = await import('../../src/docker/monitor.js');
    class Fake extends DockerMonitor {
      override async poll(hostId: number): Promise<HostContainers> {
        return snap(hostId, [['a', 'web', 1, 2]], t.clock.now);
      }
    }
    const m = new Fake(t.ctx, {} as never, 60_000);
    m.seed = () => new Map([['web', { at: [t.clock.now - 600_000], cpu: [5], mem: [10] }]]);
    const first = await new Promise<HostContainers>((resolve) => {
      const stop = m.watch(1, (h) => (stop(), resolve(h)));
    });
    m.stop();
    expect(first.history.a?.cpu).toEqual([5, 1]);
    expect(first.history.a?.mem).toEqual([10, 2]);
  });

  it('one poll that failed (an SSH hiccup) forgets no chart: the next good one goes on with the hour (review 2026-10-24)', async () => {
    const { DockerMonitor } = await import('../../src/docker/monitor.js');
    let n = 0;
    class Fake extends DockerMonitor {
      override async poll(hostId: number): Promise<HostContainers> {
        n++;
        if (n === 2) return { ...snap(hostId, [], t.clock.now), error: 'connect ETIMEDOUT' };
        return snap(hostId, [['a', 'web', 1, 2]], t.clock.now);
      }
    }
    const m = new Fake(t.ctx, {} as never, 1);
    const seen = await new Promise<HostContainers[]>((resolve) => {
      const got: HostContainers[] = [];
      const stop = m.watch(1, (h) => {
        got.push(h);
        if (got.length < 3) return;
        stop();
        resolve(got);
      });
    });
    m.stop();
    expect(seen[1]!.error).toBe('connect ETIMEDOUT');
    expect(seen[2]!.history.a?.cpu).toEqual([1]);
  });
});

describe('the background jobs, for admins (OPS-W-14)', () => {
  it('when each last ran, how long, and its last failure', async () => {
    expect(await t.json('GET', '/api/system/jobs')).toEqual([]);
    await t.updates.check([]);
    expect(await t.json('GET', '/api/system/jobs')).toEqual([expect.objectContaining({ name: 'update-check', runs: 1, ok: true, lastError: null, lastRunAt: new Date(t.clock.now).toISOString() })]);
  });
});
