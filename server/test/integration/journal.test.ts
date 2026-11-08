import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, ConnectResult, Host, Report, ReportSchedule } from '@burrow/shared';
import { hosts } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A unit's journal as a log source of the host (server/test/sshd has
// stand-ins for systemctl and journalctl), watched and reported on like a
// log file, also on a host without Docker. Real time: the stand-in's lines
// carry the host's clock.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;

beforeAll(async () => {
  t = await makeApp();
  t.clock.now = Date.now();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'test-sshd', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
});
afterAll(async () => {
  await t.close();
});

describe('journal', () => {
  it("a unit's journal on a host without Docker: watched by an alert rule and read for a report (AUDIT2 J-02)", async () => {
    // The host as one without Docker (its facts say so); the stand-in journal has an error and new lines each second.
    const row = t.ctx.db.select().from(hosts).where(eq(hosts.id, h.id)).get()!;
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ ...(JSON.parse(row.facts ?? '{}') as object), hasDocker: false }) }).where(eq(hosts.id, h.id)).run();
    const kept = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: '', path: 'journal:cron.service' });
    const subject = `:${encodeURIComponent('journal:cron.service')}`;
    const rule = await t.json<{ id: number }>('POST', '/api/alerts/rules', { name: 'Ticks', kind: 'pattern', hostId: h.id, container: null, project: null, pattern: 'tick' });
    const got = new Promise<Alert>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no alert from the journal')), 20_000);
      t.alerts.onAlert = (a) => {
        if (a.ruleName !== 'Ticks') return;
        clearTimeout(timer);
        t.alerts.onAlert = null;
        resolve(a);
      };
    });
    await t.alerts.reconcile();
    const alert = await got;
    expect(alert.container).toBe(subject);
    expect(alert.detail).toMatch(/cron\.service\[100\]: tick \d+/);
    await t.json('DELETE', `/api/alerts/rules/${rule.id}`);
    await t.alerts.reconcile();

    // A report over the last hour: the journal is a part of its own, with its error.
    const s = await t.json<ReportSchedule>('POST', '/api/reports/schedules', {
      name: 'Journal',
      enabled: false,
      kind: 'daily',
      day: 1,
      time: '07:00',
      cron: null,
      timeZone: 'Europe/Amsterdam',
      ai: false,
      selection: { rules: [{ target: null, window: { kind: 'hours', n: 1 }, levels: ['fatal', 'error', 'warn'], skip: false }] },
    });
    const report = await t.json<Report>('GET', `/api/reports/${(await t.json<{ id: number }>('POST', `/api/reports/schedules/${s.id}/run`)).id}`);
    const part = report.containers.find((c) => c.container === subject);
    expect(part).toMatchObject({ hostId: h.id, errors: 1 });
    expect(part!.problems.map((p) => p.title).join('\n')).toContain('could not reach the database');
    await t.request('DELETE', `/api/reports/schedules/${s.id}`);
    await t.request('DELETE', `/api/docker/${h.id}/logfiles/${kept.id}`);
  }, 60_000);

  it('lists the services of the host to read the journal of, sorted, and which are kept', async () => {
    const kept = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: '', path: 'journal:ssh.service' });
    const r = await t.json<{ units: { unit: string; active: string; sub: string; description: string }[]; kept: { id: number; unit: string }[] }>('GET', `/api/hosts/${h.id}/journal/units`);
    expect(r.units.map((u) => u.unit)).toEqual(['burrowtest-app.service', 'cron.service', 'ssh.service', 'wg-quick@wg0.service']);
    expect(r.units.find((u) => u.unit === 'wg-quick@wg0.service')).toMatchObject({ active: 'failed', sub: 'failed', description: 'WireGuard via wg-quick(8) for wg0' });
    expect(r.kept).toContainEqual({ id: kept.id, unit: 'ssh.service' });
    expect((await t.request('GET', '/api/hosts/999999/journal/units')).statusCode).toBe(404);
  });
});
