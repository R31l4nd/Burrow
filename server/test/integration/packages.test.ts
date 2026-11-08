import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, ConnectResult, Host, PackageReport, PackageSummary } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Package updates on the test sshd (Debian): its image has a local apt
// repository that offers newer builds of bash and tar (a -security suite)
// and gzip (-updates), so apt list --upgradable has something to say,
// read without root and without a refresh.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'test-sshd', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
});
afterAll(async () => {
  await t.close();
});

describe('package updates', () => {
  it('none checked yet: said as none, not as "nothing to update"', async () => {
    expect(await t.json('GET', `/api/hosts/${h.id}/packages`)).toBeNull();
    expect(await t.json<PackageSummary[]>('GET', '/api/hosts/packages')).toEqual([]);
  });

  it('a host that cannot be reached is an error kept as the check, never "up to date"', async () => {
    const dead = await t.json<Host>('POST', '/api/hosts', { name: 'gone', address: '127.0.0.1', port: 1, username: 'tester', authMethod: 'password', password: 'x' });
    const r = await t.json<PackageReport>('POST', `/api/hosts/${dead.id}/packages`);
    expect(r).toMatchObject({ state: 'error', updates: [], security: 0 });
    expect(r.message).toBeTruthy();
    await t.json('DELETE', `/api/hosts/${dead.id}`);
  });

  it('Check now reads apt as it is: the security updates first, the lists age, kept for the page and the list; one Host health alert', async () => {
    const got: Alert[] = [];
    t.alerts.onAlert = (a) => got.push(a);
    const r = await t.json<PackageReport>('POST', `/api/hosts/${h.id}/packages`);
    expect(r).toMatchObject({ state: 'ok', manager: 'apt', security: 2, reboot: false, message: null });
    expect(r.updates.map((u) => [u.name, u.security])).toEqual([
      ['bash', true],
      ['tar', true],
      ['gzip', false],
    ]);
    expect(r.updates[0]!.to).toMatch(/\+burrowtest1$/);
    expect(r.updates[0]!.from).toBeTruthy();
    expect(Date.parse(r.listAt!)).toBeGreaterThan(Date.parse('2026-01-01'));
    expect(await t.json('GET', `/api/hosts/${h.id}/packages`)).toEqual(r);
    expect(await t.json<PackageSummary[]>('GET', '/api/hosts/packages')).toEqual([{ hostId: h.id, checkedAt: r.checkedAt, state: 'ok', total: 3, security: 2, reboot: false, listAt: r.listAt }]);
    await expect.poll(() => got.map((a) => [a.container, a.ruleName, a.title])).toContainEqual(['@packages', 'Host health', '2 security updates waiting: bash, tar']);
    const audit = await t.json<{ action: string; target: string | null }[]>('GET', '/api/audit');
    expect(audit.find((e) => e.action === 'host.packages')?.target).toBe('test-sshd');
  });

  it('lists refreshed at a press: apt-get update through sudo with the stored password, then read again, the lists fresh (report 1f6c0c)', async () => {
    // Reported: the lists a month old (the host's own daily refresh off), Burrow only saying so.
    const before = Date.now();
    const r = await t.json<PackageReport>('POST', `/api/hosts/${h.id}/packages/refresh`);
    expect(r).toMatchObject({ state: 'ok', manager: 'apt', security: 2 });
    expect(Date.parse(r.listAt!)).toBeGreaterThanOrEqual(before - 60_000);
    expect(await t.json('GET', `/api/hosts/${h.id}/packages`)).toEqual(r);
    const audit = await t.json<{ action: string; target: string | null }[]>('GET', '/api/audit');
    expect(audit.find((e) => e.action === 'host.packages.refresh')?.target).toBe('test-sshd');
  });

  it('the same updates at the next check raise no alert again', async () => {
    const got: Alert[] = [];
    t.alerts.onAlert = (a) => got.push(a);
    t.advance(7 * 3600_000);
    await t.packages.checkIfDue(h.id);
    expect((await t.json<PackageReport>('GET', `/api/hosts/${h.id}/packages`)).checkedAt).not.toBe(new Date(0).toISOString());
    await new Promise((r) => setTimeout(r, 500));
    expect(got.filter((a) => a.container === '@packages')).toEqual([]);
  });

  it('not due within six hours: not checked again', async () => {
    const before = await t.json<PackageReport>('GET', `/api/hosts/${h.id}/packages`);
    t.advance(3600_000);
    await t.packages.checkIfDue(h.id);
    expect((await t.json<PackageReport>('GET', `/api/hosts/${h.id}/packages`)).checkedAt).toBe(before.checkedAt);
  });
});
