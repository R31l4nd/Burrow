import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Who reads and writes, sampled on demand (report d4a9c0): through sudo when
// it is allowed, else as the SSH user; a refusal is remembered, so a host
// whose sudo says no is not asked again every few seconds (each one a failed
// sudo in its log, and a lockout with pam_faillock).

const SAMPLE = (uid: number) => `@@sudo
@@begin ${uid}
@@procs 3 ${uid === 0 ? 3 : 1}
@@io1
100.00 50.00
   8       0 sda 10 0 80 0 10 0 80 0 0 10 10 0 0 0 0
@@io2
102.00 51.00
   8       0 sda 10 0 80 0 30 0 4176 0 0 210 10 0 0 0 0
   8       1 sda1 10 0 80 0 30 0 4176 0 0 210 10 0 0 0 0
@@a
@@b
42/io:write_bytes: 2097152
@@blk
/sys/block/sda/queue/rotational:1
/sys/block/sda/size:1000
@@parts /sys/block/sda/sda1/partition
@@slaves /sys/block/*/slaves/*
@@selfns mnt:[1]
@@selfmounts
29 1 8:1 / / rw - ext4 /dev/sda1 rw
@@pid 42
@@comm writer
@@cg
@@ns mnt:[1]
@@fd
l-wx------ 1 a a 64 Oct 16 00:17 3 -> /var/log/busy.log
@@end
`;

const calls: { command: string; input?: string }[] = [];
let answer: (command: string) => { code: number; stdout: string; stderr: string } = () => ({ code: 0, stdout: SAMPLE(0), stderr: '' });
vi.mock('../../src/ssh/connect.js', async (orig) => ({
  ...(await orig<typeof import('../../src/ssh/connect.js')>()),
  exec: async (_c: unknown, command: string, _t: number, _m: number, input?: string) => {
    calls.push({ command, input });
    await new Promise((r) => setTimeout(r, 5));
    return answer(command);
  },
}));
const { HostStatsService } = await import('../../src/hosts/stats.js');

let t: TestApp;
let h: Host;
const pool = { with: async (_id: number, fn: (c: { client: unknown }) => unknown) => fn({ client: {} }) };
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan', username: 'me', authMethod: 'password', password: 'secret-pw' });
  calls.length = 0;
});
afterEach(async () => t.close());

describe('who reads and writes, on demand', () => {
  it('as root through sudo with the stored password; two viewers at once share one sample', async () => {
    const s = new HostStatsService(t.ctx, pool as never);
    const [a, b] = await Promise.all([s.activity(h.id), s.activity(h.id)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain("sudo -S -p ''");
    expect(calls[0]!.input).toBe('secret-pw\n');
    expect(a).toBe(b);
    expect(a).toMatchObject({ asRoot: true, rootRefused: null, seconds: 2 });
    expect(a.top).toEqual([{ pid: 42, name: 'writer', container: null, readBps: 0, writeBps: 1048576, files: [{ path: '/var/log/busy.log', write: true, disks: ['sda'] }], disks: ['sda'], moreFiles: 0, filesUnread: false }]);
    // The disk over the same seconds: 4096 sectors in 20 writes, busy 200 of 2000 ms.
    expect(a.disks[0]).toMatchObject({ name: 'sda', writeBps: 1048576, writeIops: 10, util: 10, power: 'active', powerFrom: 'io' });
  });

  it("sudo refused: the user's own processes, the reason said, and sudo not tried again for a while", async () => {
    answer = (command) => (command.startsWith('sh -c') ? { code: 0, stdout: SAMPLE(1000), stderr: '' } : { code: 1, stdout: '', stderr: 'sudo: 1 incorrect password attempt' });
    const s = new HostStatsService(t.ctx, pool as never);
    const first = await s.activity(h.id);
    expect(first).toMatchObject({ asRoot: false, rootRefused: 'sudo: 1 incorrect password attempt', processes: { total: 3, readable: 1 } });
    expect(calls.map((c) => c.command.slice(0, 5))).toEqual(['if [ ', 'sh -c']);
    // As the user: no password sent to anything.
    expect(calls[1]!.input).toBeUndefined();
    t.clock.now += 60_000;
    await s.activity(h.id);
    expect(calls.map((c) => c.command.slice(0, 5))).toEqual(['if [ ', 'sh -c', 'sh -c']);
    t.clock.now += 15 * 60_000;
    await s.activity(h.id);
    expect(calls).toHaveLength(5);
  });

  it('a sample that could not be read is an error, not "nobody writes"', async () => {
    answer = () => ({ code: 3, stdout: '@@sudo\n@@begin 0\n', stderr: 'sh: cd: can\'t cd to /proc' });
    const s = new HostStatsService(t.ctx, pool as never);
    await expect(s.activity(h.id)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("can't cd to /proc") });
    answer = () => ({ code: 0, stdout: SAMPLE(0), stderr: '' });
  });
});
