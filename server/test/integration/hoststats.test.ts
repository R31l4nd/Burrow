import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, ConnectResult, DiskActivity, DiskHistory, Host, HostLimitsView, HostSample, HostStats, SmartReport } from '@burrow/shared';
import { makeApp, setupAdmin, totpNow, type TestApp } from '../helpers.js';

// Phase 11: a host's own numbers from the test sshd (a Debian container):
// CPU, memory, disks; the history; SMART (no smartctl there: "none"); and a
// host alert when a disk is fuller than the threshold.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;
let secret: string;

beforeAll(async () => {
  t = await makeApp();
  ({ secret } = await setupAdmin(t));
  h = await t.json<Host>('POST', '/api/hosts', { name: 'test-sshd', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
});
afterAll(async () => {
  await t.close();
});

describe('host statistics', () => {
  it('reads the numbers now', async () => {
    const s = await t.json<HostStats>('GET', `/api/hosts/${h.id}/stats`);
    expect(s.cores).toBeGreaterThan(0);
    expect(s.memTotal).toBeGreaterThan(s.memUsed);
    expect(s.cpu).toBeGreaterThanOrEqual(0);
    expect(s.disks.map((d) => d.mount)).toContain('/');
    expect(s.uptimeSeconds).toBeGreaterThan(0);
  });

  it('keeps samples for the graphs, and raises a host alert for a full disk', async () => {
    const got: Alert[] = [];
    t.alerts.onAlert = (a) => got.push(a);
    // Any disk counts as full for this test.
    (t.hostStats.thresholds as { diskPercent: number }).diskPercent = 0.01;
    await t.hostStats.sample(h.id);
    t.advance(5 * 60_000);
    await t.hostStats.sample(h.id);
    const hist = await t.json<HostSample[]>('GET', `/api/hosts/${h.id}/stats/history?range=day`);
    expect(hist).toHaveLength(2);
    expect(hist[0]!.memPercent).toBeGreaterThan(0);
    await expect.poll(() => got.map((a) => [a.container, a.ruleName])).toContainEqual(['@disk /', 'Host health']);
    // Muting works for host subjects too.
    await t.json('POST', '/api/alerts/mutes', { hostId: h.id, container: '@disk /', minutes: 60 });
    (t.hostStats.thresholds as { diskPercent: number }).diskPercent = 90;
  });

  it('reads each whole disk and what it did over the second (report d4a9c0)', async () => {
    const s = await t.json<HostStats>('GET', `/api/hosts/${h.id}/stats`);
    expect(s.ioError).toBeNull();
    expect(s.io!.length).toBeGreaterThan(0);
    for (const d of s.io!) {
      // Whole disks: no partitions (sda1, nvme0n1p2), nothing virtual.
      expect(d.name).not.toMatch(/^(loop|dm-|md|zram|sr)|^nvme\d+n\d+p\d+$|^[shv]d[a-z]+\d+$/);
      expect(['hdd', 'ssd', 'nvme']).toContain(d.kind);
      expect(d.sizeBytes).toBeGreaterThan(0);
      expect(d.util).toBeGreaterThanOrEqual(0);
      // Without root (the stats page reads as the SSH user): a hard disk's state only from the kernel or its I/O, else unknown.
      if (d.kind === 'hdd') expect(['active', 'standby', 'unknown']).toContain(d.power);
      else expect(d.power).toBeNull();
    }
  });

  it("keeps each disk's counters with the samples: the history is its rates per interval", async () => {
    await t.hostStats.sample(h.id);
    t.advance(5 * 60_000);
    await t.hostStats.sample(h.id);
    const hist = await t.json<DiskHistory[]>('GET', `/api/hosts/${h.id}/stats/disks?range=day`);
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[0]!.samples.length).toBeGreaterThanOrEqual(1);
    expect(hist[0]!.samples.at(-1)).toMatchObject({ readBps: expect.any(Number), writeBps: expect.any(Number), util: expect.any(Number) });
  });

  it('who reads and writes: a process writing is seen as root (through sudo with the stored password), with its file', async () => {
    // A writer that keeps at it (each 512 bytes synced), in the background, as root: root in
    // the test container lacks CAP_SYS_PTRACE, so it reads only root's own processes' counters.
    t.advance(30_000);
    await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
    const [r] = await t.json<{ exitCode: number; stderr: string }[]>('POST', '/api/snippets/run', {
      hostIds: [h.id],
      command: "echo burrow-test-password | sudo -S -p '' sh -c 'nohup sh -c \"exec dd if=/dev/zero of=/tmp/burrow-writer bs=512 count=200000 oflag=dsync\" >/dev/null 2>&1 & echo $! > /tmp/burrow-writer.pid'",
    });
    expect(r!.exitCode, r!.stderr).toBe(0);
    try {
      let a: DiskActivity | null = null;
      await expect
        .poll(
          async () => {
            a = await t.json<DiskActivity>('POST', `/api/hosts/${h.id}/disks/activity`);
            return a.top.some((p) => p.name === 'dd');
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      const got = a! as DiskActivity;
      expect(got).toMatchObject({ asRoot: true, rootRefused: null });
      expect(got.seconds).toBeGreaterThan(1);
      expect(got.processes.readable).toBeGreaterThan(0);
      const dd = got.top.find((p) => p.name === 'dd')!;
      expect(dd.writeBps).toBeGreaterThan(0);
      expect(dd.files).toContainEqual(expect.objectContaining({ path: '/tmp/burrow-writer', write: true }));
      expect(got.disks.length).toBeGreaterThan(0);
    } finally {
      t.advance(30_000);
      await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
      await t.json('POST', '/api/snippets/run', { hostIds: [h.id], command: "echo burrow-test-password | sudo -S -p '' sh -c 'kill $(cat /tmp/burrow-writer.pid); rm -f /tmp/burrow-writer /tmp/burrow-writer.pid'" });
    }
  });

  it("who reads and writes, sudo refused: the SSH user's own processes only, and why", async () => {
    // Logging in with a key, no password stored: sudo -n, which the test user may not.
    const other = await t.json<Host>('POST', '/api/hosts', { name: 'no-sudo', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
    const c = await t.json<ConnectResult>('POST', `/api/hosts/${other.id}/test`);
    if (c.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${other.id}/trust`, { fingerprint: c.fingerprint });
    const key = await t.json<{ id: number }>('POST', '/api/keys/generate', { name: 'disk-io' });
    expect((await t.json<ConnectResult>('POST', `/api/hosts/${other.id}/install-key`, { keyId: key.id, password: 'burrow-test-password' })).status).toBe('ok');
    await t.json('PUT', `/api/hosts/${other.id}`, { name: 'no-sudo', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'key', keyId: key.id, password: '' });
    try {
      const a = await t.json<DiskActivity>('POST', `/api/hosts/${other.id}/disks/activity`);
      expect(a.asRoot).toBe(false);
      expect(a.rootRefused).toMatch(/password is required/);
      // sshd runs as root: its counters are not the test user's to read.
      expect(a.processes.readable).toBeLessThan(a.processes.total);
      expect(a.disks.length).toBeGreaterThan(0);
    } finally {
      t.advance(30_000);
      await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
      await t.json('POST', '/api/snippets/run', { hostIds: [other.id], command: "sed -i '/burrow-disk-io/d' ~/.ssh/authorized_keys" });
      await t.json('DELETE', `/api/hosts/${other.id}`);
    }
  });

  it("a host's own limit wins over the default, and goes with the host", async () => {
    // The default says any disk is full; this host's own limit says 100 %.
    (t.hostStats.thresholds as { diskPercent: number }).diskPercent = 0.01;
    const v = await t.json<HostLimitsView>('PUT', `/api/hosts/${h.id}/limits`, { cpuCelsius: 95, diskCelsius: null, diskPercent: 100 });
    expect(v).toMatchObject({ own: { cpuCelsius: 95, diskCelsius: null, diskPercent: 100 }, limits: { cpuCelsius: 95, diskPercent: 100 }, defaults: { diskPercent: 0.01 } });
    expect(v.limits.diskCelsius).toBe(v.defaults.diskCelsius);
    const other = await t.json<Host>('POST', '/api/hosts', { name: 'other', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'x' });
    expect((await t.json<HostLimitsView>('GET', `/api/hosts/${other.id}/limits`)).own).toEqual({ cpuCelsius: null, diskCelsius: null, diskPercent: null });
    expect(t.hostStats.thresholdsFor(other.id).diskPercent).toBe(0.01);
    expect(t.hostStats.thresholdsFor(h.id).diskPercent).toBe(100);
    // Out of range is refused.
    expect((await t.request('PUT', `/api/hosts/${h.id}/limits`, { cpuCelsius: 20, diskCelsius: null, diskPercent: null })).statusCode).toBe(400);
    // A deleted host's limits do not pass to a later host with its id.
    await t.json('PUT', `/api/hosts/${other.id}/limits`, { cpuCelsius: 60, diskCelsius: null, diskPercent: null });
    await t.json('DELETE', `/api/hosts/${other.id}`);
    expect(t.hostStats.own(other.id)).toEqual({ cpuCelsius: null, diskCelsius: null, diskPercent: null });
    // Back to the defaults.
    await t.json('PUT', `/api/hosts/${h.id}/limits`, { cpuCelsius: null, diskCelsius: null, diskPercent: null });
    expect(t.hostStats.thresholdsFor(h.id).diskPercent).toBe(0.01);
    (t.hostStats.thresholds as { diskPercent: number }).diskPercent = 90;
  });

  it('SMART: without smartctl the page says so', async () => {
    const r = await t.json<SmartReport>('POST', `/api/hosts/${h.id}/smart`);
    expect(r).toMatchObject({ state: 'none', disks: [] });
    expect(await t.json('GET', `/api/hosts/${h.id}/smart`)).toMatchObject({ state: 'none' });
  });

  it("SMART judged by Backblaze's counts against the oldest check kept: above zero is watch, growing is failing (N4)", async () => {
    // Running a command on the host needs a fresh step-up (the clock moves on in this test).
    const sh = async (command: string) => {
      t.advance(30_000);
      await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
      const [r] = await t.json<{ exitCode: number; stderr: string }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
      expect(r!.exitCode, r!.stderr).toBe(0);
    };
    const answer = (reallocated: number) => JSON.stringify({ model_name: 'Test disk', serial_number: 'T1', smart_status: { passed: true }, ata_smart_attributes: { table: [{ id: 5, raw: { value: reallocated } }, { id: 197, raw: { value: 0 } }] } });
    // A stand-in smartctl (through sudo, as Burrow runs it) that answers from a file the test writes.
    const fake = Buffer.from('#!/bin/sh\ncase "$1" in --scan) echo "/dev/sda -d sat # test" ;; *) cat /tmp/smart.json ;; esac\n').toString('base64');
    await sh(`echo ${fake} | base64 -d > /tmp/smartctl && chmod 755 /tmp/smartctl && echo burrow-test-password | sudo -S -p '' cp /tmp/smartctl /usr/local/bin/smartctl`);
    try {
      await sh(`printf '%s' '${answer(8)}' > /tmp/smart.json`);
      const first = await t.json<SmartReport>('POST', `/api/hosts/${h.id}/smart`);
      expect(first.disks[0]).toMatchObject({ verdict: 'watch', reasons: [{ code: 'attr', attr: 'reallocated', value: 8 }] });
      t.advance(6 * 3600_000);
      await sh(`printf '%s' '${answer(12)}' > /tmp/smart.json`);
      const second = await t.json<SmartReport>('POST', `/api/hosts/${h.id}/smart`);
      expect(second.disks[0]).toMatchObject({ verdict: 'failing', reasons: [{ code: 'attr', attr: 'reallocated', value: 12, was: 8, since: first.checkedAt }] });
      // One kept per day: the second check of the day is not kept again.
      expect((await t.json<SmartReport[]>('GET', `/api/hosts/${h.id}/smart/history`)).map((r) => r.checkedAt)).toEqual([first.checkedAt]);
    } finally {
      await sh("echo burrow-test-password | sudo -S -p '' rm -f /usr/local/bin/smartctl; rm -f /tmp/smartctl /tmp/smart.json");
    }
  });
});
