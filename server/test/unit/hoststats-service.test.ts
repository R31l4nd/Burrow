import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { hosts } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// The CPU counters each read of the stats command returns (user, idle).
const counters: [number, number][] = [];
// What smartctl answers, check by check.
const smart: string[] = [];
vi.mock('../../src/ssh/connect.js', async (orig) => ({
  ...(await orig<typeof import('../../src/ssh/connect.js')>()),
  exec: async (_client: unknown, command: string) => {
    if (command.includes('smartctl')) return { code: 0, stdout: smart.shift()!, stderr: '' };
    const [u, i] = counters.shift()!;
    const line = `cpu  ${u} 0 0 ${i} 0 0 0 0 0 0`;
    const stdout = `@@cpu\n${line}\n${line}\n@@mem\nMemTotal: 1000 kB\nMemAvailable: 900 kB\n@@load\n0.1 0.1 0.1 1/1 1\n2\n@@up\n100.0 100.0\n@@df\nFilesystem Type 1B-blocks Used Available Capacity Mounted on\n/dev/sda ext4 100 10 90 10% /\n@@temp\n`;
    return { code: 0, stdout, stderr: '' };
  },
}));
const { HostStatsService } = await import('../../src/hosts/stats.js');

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => t.close());

describe('the five-minute CPU check', () => {
  it('the stats page reading in between does not hide a busy CPU (AUDIT2 MON-07)', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'busy', address: 'busy.lan', username: 'me' });
    const pool = { with: async (_id: number, fn: (c: { client: unknown }) => unknown) => fn({ client: {} }) };
    const s = new HostStatsService(t.ctx, pool as never);
    const told: string[] = [];
    s.onTrouble = (_id, tr) => told.push(tr.title);
    counters.push([1000, 1000], [1100, 1010], [1950, 1050]);
    await s.sample(h.id);
    t.clock.now += 4 * 60_000;
    await s.read(h.id);
    t.clock.now += 60_000;
    await s.sample(h.id);
    expect(told).toEqual(['CPU at 95% for 5 minutes']);
  });

  it('stopped before its first sample, it takes none (AUDIT2 MON-27)', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'idle', address: 'idle.lan', username: 'me' });
    // Answered once: a host the sampler would read.
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ checkedAt: new Date(t.clock.now).toISOString() }) }).where(eq(hosts.id, h.id)).run();
    vi.useFakeTimers();
    try {
      const pool = { with: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) };
      const s = new HostStatsService(t.ctx, pool as never);
      s.start();
      s.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await s.tick();
      expect(pool.with).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a disk asleep at a SMART check (decision 5)', () => {
  it('is not woken: smartctl -n standby; its last reading stands, said from when, and no trouble from it', async () => {
    const { smartCommand } = await import('../../src/hosts/stats.js');
    expect(smartCommand(null)).toContain('-n standby');
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan', username: 'me' });
    const pool = { with: async (_id: number, fn: (c: { client: unknown }) => unknown) => fn({ client: {} }) };
    const s = new HostStatsService(t.ctx, pool as never);
    const told: string[] = [];
    s.onTrouble = (_id, tr) => told.push(tr.title);
    const awake = JSON.stringify({ model_name: 'WDC', serial_number: 'W1', smart_status: { passed: true }, power_on_time: { hours: 1000 }, ata_smart_attributes: { table: [{ id: 5, raw: { value: 0 } }] } });
    const asleep = JSON.stringify({ smartctl: { exit_status: 2, messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] } });
    smart.push(`@@dev /dev/sda\n${awake}\n`, `@@dev /dev/sda\n${asleep}\n`, `@@dev /dev/sda\n${asleep}\n`);
    const first = await s.smart(h.id);
    t.clock.now += 86_400_000;
    const second = await s.smart(h.id);
    expect(second).toMatchObject({ state: 'ok', message: 'Asleep, not woken: /dev/sda.' });
    expect(second.disks).toEqual([expect.objectContaining({ device: '/dev/sda', asleep: true, readAt: first.checkedAt, passed: true, powerOnHours: 1000, verdict: 'good' })]);
    expect(second.disks[0]!.unread).toBeUndefined();
    // Asleep again: still from the first reading, not from the check that only saw it asleep.
    t.clock.now += 86_400_000;
    expect((await s.smart(h.id)).disks[0]).toMatchObject({ asleep: true, readAt: first.checkedAt });
    expect(told).toEqual([]);
  });
});
