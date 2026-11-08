import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, CommandRun, CommandSchedule, ConnectResult, Host } from '@burrow/shared';
import { makeApp, setupAdmin, totpNow, type TestApp } from '../helpers.js';

// Commands on a schedule (2.11.0) on the test sshd: run as the host's user,
// sudo only without a password, output kept, a failure a Host health alert,
// due once per minute of the schedule.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;
let secret: string;

const base = (over: Record<string, unknown> = {}) => ({ name: 'say hello', command: 'echo "hello from $(whoami)"; echo warned >&2', hostIds: [h.id], enabled: true, kind: 'daily', time: '03:00', timeZone: 'UTC', timeoutMinutes: 5, ...over });
/** A fresh step-up, as the person would give with their authenticator. */
const stepUp = async () => {
  t.advance(31_000);
  await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
};

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

describe('scheduled commands', () => {
  let s: CommandSchedule;

  it('made by an admin; Run now runs it as the host user, its output (stderr too) kept; in the audit log', async () => {
    s = await t.json<CommandSchedule>('POST', '/api/schedules/commands', base());
    expect(s).toMatchObject({ name: 'say hello', hostIds: [h.id], enabled: true, nextRunAt: expect.stringMatching(/T03:00:00/) });
    const { runs } = await t.json<{ runs: number[] }>('POST', `/api/schedules/commands/${s.id}/run`);
    expect(runs).toHaveLength(1);
    const run = await t.json<CommandRun>('GET', `/api/schedules/commands/runs/${runs[0]}`);
    expect(run).toMatchObject({ hostId: h.id, hostName: 'test-sshd', code: 0, ok: true, timedOut: false, error: null, cut: false });
    expect(run.output).toContain('hello from tester');
    expect(run.output).toContain('warned');
    const list = await t.json<CommandSchedule[]>('GET', '/api/schedules/commands');
    expect(list.find((x) => x.id === s.id)!.last).toEqual([expect.objectContaining({ id: runs[0], ok: true })]);
    const audit = await t.json<{ action: string; target: string | null }[]>('GET', '/api/audit');
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['command_schedule.create', 'command_schedule.run']));
  });

  it('sudo only without a password: it ends at once with sudo\'s words, never waits for one', async () => {
    await stepUp();
    const x = await t.json<CommandSchedule>('POST', '/api/schedules/commands', base({ name: 'needs root', command: 'sudo true' }));
    const { runs } = await t.json<{ runs: number[] }>('POST', `/api/schedules/commands/${x.id}/run`);
    const run = await t.json<CommandRun>('GET', `/api/schedules/commands/runs/${runs[0]}`);
    expect(run.ok).toBe(false);
    expect(run.output).toMatch(/password is required/);
  });

  it('a failure and a time-out are Host health alerts, with the schedule name', async () => {
    const got: Alert[] = [];
    t.alerts.onAlert = (a) => got.push(a);
    await stepUp();
    const bad = await t.json<CommandSchedule>('POST', '/api/schedules/commands', base({ name: 'nightly backup', command: 'exit 3' }));
    await t.json('POST', `/api/schedules/commands/${bad.id}/run`);
    await expect.poll(() => got.map((a) => [a.container, a.ruleName, a.title])).toContainEqual(['@scheduled', 'Host health', '"nightly backup" failed with exit code 3']);
    // timeout(1) on the host ends it with 124: said as timed out, not as an exit code.
    await stepUp();
    const slow = await t.json<CommandSchedule>('POST', '/api/schedules/commands', base({ name: 'slow', command: 'exit 124', timeoutMinutes: 2 }));
    const { runs } = await t.json<{ runs: number[] }>('POST', `/api/schedules/commands/${slow.id}/run`);
    expect(await t.json<CommandRun>('GET', `/api/schedules/commands/runs/${runs[0]}`)).toMatchObject({ ok: false, timedOut: true, code: null });
    await expect.poll(() => got.map((a) => a.title)).toContain('"slow" timed out after 2 min');
  });

  it('due once in its minute (every minute by cron here), not again in the same minute; disabled: not at all', async () => {
    await stepUp();
    const every = await t.json<CommandSchedule>('POST', '/api/schedules/commands', base({ name: 'every minute', kind: 'cron', cron: '* * * * *' }));
    const count = async () => (await t.json<unknown[]>('GET', `/api/schedules/commands/${every.id}/runs`)).length;
    await t.scheduled.tick();
    expect(await count()).toBe(1);
    await t.scheduled.tick();
    expect(await count()).toBe(1);
    t.advance(60_000);
    await t.scheduled.tick();
    expect(await count()).toBe(2);
    await stepUp();
    await t.json('PUT', `/api/schedules/commands/${every.id}`, base({ name: 'every minute', kind: 'cron', cron: '* * * * *', enabled: false }));
    t.advance(60_000);
    await t.scheduled.tick();
    expect(await count()).toBe(2);
  });

  it('a minute missed (Burrow stalled or restarted then) runs at the next tick, once; not one from before it was made, nor more than an hour back', async () => {
    await stepUp();
    // The test clock is 12:xx UTC; a daily run two minutes from now.
    const at = new Date(t.ctx.now() + 2 * 60_000);
    const hhmm = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
    const late = await t.json<CommandSchedule>('POST', '/api/schedules/commands', base({ name: 'nightly', time: hhmm }));
    const count = async () => (await t.json<unknown[]>('GET', `/api/schedules/commands/${late.id}/runs`)).length;
    await t.scheduled.tick();
    expect(await count()).toBe(0);
    // No tick in its minute: three minutes later it runs, once.
    t.advance(5 * 60_000);
    await t.scheduled.tick();
    expect(await count()).toBe(1);
    await t.scheduled.tick();
    expect(await count()).toBe(1);
    // A schedule saved after its minute today waits for tomorrow.
    await stepUp();
    const past = new Date(t.ctx.now() - 3 * 60_000);
    const before = `${String(past.getUTCHours()).padStart(2, '0')}:${String(past.getUTCMinutes()).padStart(2, '0')}`;
    const fresh = await t.json<CommandSchedule>('POST', '/api/schedules/commands', base({ name: 'saved later', time: before }));
    await t.scheduled.tick();
    expect(await t.json<unknown[]>('GET', `/api/schedules/commands/${fresh.id}/runs`)).toEqual([]);
    // Missed by more than an hour (Burrow was down): not run in the middle of the day.
    t.advance(23 * 3600_000);
    await t.scheduled.tick();
    const n = await count();
    t.advance(2 * 3600_000);
    await t.scheduled.tick();
    expect(await count()).toBe(n);
  });

  it('refused: an unknown host, a bad cron, no host; without a fresh step-up', async () => {
    await stepUp();
    expect((await t.request('POST', '/api/schedules/commands', base({ hostIds: [9999] }))).json()).toMatchObject({ error: 'unknown_host' });
    expect((await t.request('POST', '/api/schedules/commands', base({ kind: 'cron', cron: 'every day' }))).json()).toMatchObject({ error: 'invalid_cron' });
    expect((await t.request('POST', '/api/schedules/commands', base({ hostIds: [] }))).statusCode).toBe(400);
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/schedules/commands', base())).json()).toMatchObject({ error: 'step_up_required' });
    expect((await t.request('POST', `/api/schedules/commands/${s.id}/run`)).json()).toMatchObject({ error: 'step_up_required' });
    expect((await t.request('DELETE', `/api/schedules/commands/${s.id}`)).json()).toMatchObject({ error: 'step_up_required' });
  });

  it('runs older than 30 days go; a deleted schedule takes its runs along', async () => {
    const { commandRuns } = await import('../../src/db/schema.js');
    const before = (await t.json<{ id: number }[]>('GET', `/api/schedules/commands/${s.id}/runs`)).map((r) => r.id);
    expect(before.length).toBeGreaterThan(0);
    const old = t.ctx.db.insert(commandRuns).values({ scheduleId: s.id, hostId: h.id, startedAt: t.ctx.now() - 31 * 86_400_000, endedAt: t.ctx.now() - 31 * 86_400_000, code: 0 }).returning().get();
    await t.scheduled.tick();
    const after = (await t.json<{ id: number }[]>('GET', `/api/schedules/commands/${s.id}/runs`)).map((r) => r.id);
    expect(after).not.toContain(old.id);
    expect(after).toEqual(before);
    await stepUp();
    await t.json('DELETE', `/api/schedules/commands/${s.id}`);
    expect((await t.json<CommandSchedule[]>('GET', '/api/schedules/commands')).find((x) => x.id === s.id)).toBeUndefined();
    expect((await t.request('GET', `/api/schedules/commands/runs/${before[0]}`)).statusCode).toBe(404);
  });
});
