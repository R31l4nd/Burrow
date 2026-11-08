import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Channel, ConnectResult, Host, Report, ReportSchedule } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { appSettings, reportSchedules } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Phase 10 against real services: the test stack on this machine's Docker
// (burrowtest-web logs errors, burrowtest-worker exited with 3), ntfy on
// :5002, Mailpit on :1025/:8025, and a local server standing in for Discord,
// a webhook receiver and the language model.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DOCKER_SSHD_PORT ?? 2297);
const NTFY = process.env.NTFY_URL ?? 'http://127.0.0.1:5002';
const MAIL_API = 'http://127.0.0.1:8025';
const TOPIC = `burrow-reports-${Date.now().toString(36)}`;
const DISCORD = 'https://discord.com/api/webhooks/123/abc';

let t: TestApp;
let h: Host;
let stand: Server;
let standUrl = '';
const got: { path: string; headers: IncomingMessage['headers']; body: string }[] = [];

async function pushes(): Promise<{ title: string; message: string; click?: string }[]> {
  const res = await fetch(`${NTFY}/${TOPIC}/json?poll=1&since=all`);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((m) => m.event === 'message');
}

async function mails(): Promise<{ Subject: string; To: { Address: string }[] }[]> {
  return ((await (await fetch(`${MAIL_API}/api/v1/messages`)).json()) as { messages: { Subject: string; To: { Address: string }[] }[] }).messages;
}

beforeAll(async () => {
  await fetch(`${MAIL_API}/api/v1/messages`, { method: 'DELETE' });
  stand = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ path: req.url ?? '', headers: req.headers, body });
      if (req.url === '/v1/chat/completions') {
        const content = JSON.stringify({ summary: 'The upstream keeps timing out.', fixes: [
            { step: 'Check the upstream service.', command: 'docker logs --tail 50 upstream', risk: 'low', risk_reason: '' },
            // The model says low; Burrow's rules say otherwise.
            { step: 'Restart it.', command: 'sudo docker restart upstream', risk: 'low', risk_reason: '' },
            { step: 'Look at the config.', command: '', risk: 'low', risk_reason: '' },
          ],
        });
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      }
      res.statusCode = req.url?.startsWith('/discord') ? 204 : 200;
      res.end();
    });
  });
  await new Promise<void>((r) => stand.listen(0, '127.0.0.1', r));
  standUrl = `http://127.0.0.1:${(stand.address() as AddressInfo).port}`;

  // Discord's address is checked to be Discord's: the test sends it here instead.
  const fetchVia = (url: string, init?: RequestInit) => fetch(url.startsWith('https://discord.com/') ? `${standUrl}/discord` : url, init);
  t = await makeApp({ send: { fetch: fetchVia } });
  // Real time: the logs are read for a period up to now.
  t.clock.now = Date.now();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'docker-real', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: process.env.DOCKER_SSHD_PASSWORD ?? 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
  await t.json('PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: `${standUrl}/v1`, model: 'fake' } });
}, 60_000);

afterAll(async () => {
  await t?.close();
  stand?.close();
});

describe('channels', () => {
  const ids: Record<string, number> = {};

  it('ntfy, e-mail, Discord and a signed webhook each take a test message', async () => {
    const make = async (body: unknown) => t.json<Channel>('POST', '/api/channels', body);
    ids.ntfy = (await make({ kind: 'ntfy', name: 'Phone', enabled: true, topics: ['alerts', 'reports'], lang: 'en', ntfy: { url: NTFY, topic: TOPIC, openIn: 'browser' } })).id;
    ids.email = (
      await make({ kind: 'email', name: 'Mail', enabled: true, topics: ['reports'], lang: 'nl', email: { host: '127.0.0.1', port: 1025, secure: false, user: '', from: 'burrow@example.com', to: 'me@example.com' } })
    ).id;
    const discord = await make({ kind: 'discord', name: 'Discord', enabled: true, topics: ['reports', 'updates'], lang: 'en', discord: { url: DISCORD } });
    ids.discord = discord.id;
    // The address is a secret: never sent back.
    expect(discord.discord).toEqual({ hasUrl: true });
    expect(JSON.stringify(await t.json('GET', '/api/channels'))).not.toContain('webhooks/123');
    ids.webhook = (await make({ kind: 'webhook', name: 'Hook', enabled: true, topics: ['reports'], lang: 'en', webhook: { url: `${standUrl}/hook`, secret: 's3cret' } })).id;
    expect((await t.request('POST', '/api/channels', { kind: 'discord', name: 'x', enabled: true, topics: [], lang: 'en', discord: { url: 'not a url' } })).statusCode).toBe(400);

    for (const id of Object.values(ids)) await t.json('POST', `/api/channels/${id}/test`);
    expect((await pushes()).map((m) => m.title)).toContain('Burrow test');
    const m = await mails();
    expect(m[0]).toMatchObject({ Subject: 'Burrow-test', To: [{ Address: 'me@example.com' }] });
    const d = got.find((g) => g.path === '/discord')!;
    expect(JSON.parse(d.body).embeds[0]).toMatchObject({ title: 'Burrow test' });
    const hook = got.find((g) => g.path === '/hook')!;
    expect(hook.headers['x-burrow-signature']).toBe(`sha256=${createHmac('sha256', 's3cret').update(hook.body).digest('hex')}`);
    expect(JSON.parse(hook.body)).toMatchObject({ topic: 'test', title: 'Burrow test' });
  });

  it('a failing channel says why', async () => {
    const bad = await t.json<Channel>('POST', '/api/channels', { kind: 'webhook', name: 'Down', enabled: true, topics: [], lang: 'en', webhook: { url: 'http://127.0.0.1:9/x' } });
    const r = await t.request('POST', `/api/channels/${bad.id}/test`);
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('send_failed');
    await t.request('DELETE', `/api/channels/${bad.id}`);
  });
});

describe('reports', () => {
  let schedule: ReportSchedule;

  it('the weekly report is there, and off', async () => {
    const [s] = await t.json<ReportSchedule[]>('GET', '/api/reports/schedules');
    expect(s).toMatchObject({ name: 'Weekly report', enabled: false, kind: 'weekly', day: 1, time: '08:00', nextRunAt: null });
    schedule = s!;
  });

  it('a report: status per container, explanations, sent to every channel for reports', async () => {
    await t.json('PUT', `/api/reports/schedules/${schedule.id}`, {
      ...schedule,
      enabled: true,
      hostIds: [h.id],
      containers: ['burrowtest-web', 'burrowtest-worker'],
      timeZone: 'Europe/Amsterdam',
    });
    // burrowtest-web logs an error every 1.5 s: wait for enough of them.
    await expect
      .poll(
        async () => {
          const [x] = await t.json<{ stdout: string }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command: 'docker logs burrowtest-web 2>&1 | grep -c ERROR' });
          return Number(x!.stdout.trim());
        },
        { timeout: 30_000, interval: 1000 },
      )
      .toBeGreaterThanOrEqual(12);
    t.clock.now = Date.now();
    got.length = 0;
    const { id } = await t.json<{ id: number }>('POST', `/api/reports/schedules/${schedule.id}/run`);
    const r = await t.json<Report>('GET', `/api/reports/${id}`);
    const web = r.containers.find((c) => c.container === 'burrowtest-web')!;
    const worker = r.containers.find((c) => c.container === 'burrowtest-worker')!;
    expect(r.containers).toHaveLength(2);
    expect(worker).toMatchObject({ status: 'problem', reasons: [{ code: 'exited', n: 3 }] });
    expect(web.status).toBe('attention');
    expect(web.errors).toBeGreaterThanOrEqual(10);
    expect(web.problems[0]).toMatchObject({ trend: 'new' });
    expect(web.problems[0]!.title).toMatch(/ERROR upstream timeout/);
    expect(web.summary).toBe('The upstream keeps timing out.');
    expect(web.fixes).toEqual([
      { step: 'Check the upstream service.', command: 'docker logs --tail 50 upstream', risk: 'low', riskReasons: [] },
      { step: 'Restart it.', command: 'sudo docker restart upstream', risk: 'medium', riskReasons: ['stops or restarts containers', 'runs as root'] },
      { step: 'Look at the config.', command: null, risk: 'low', riskReasons: [] },
    ]);
    expect(r).toMatchObject({ status: 'problem', counts: { ok: 0, attention: 1, problem: 1 }, model: 'openai:fake' });
    // The model was asked about the two that need it, and never about "ok" ones.
    expect(got.filter((g) => g.path === '/v1/chat/completions')).toHaveLength(2);

    await expect.poll(async () => (await pushes()).map((m) => m.title)).toContain('Weekly report: 1 problem, 1 attention, 0 ok');
    await expect.poll(async () => (await mails()).map((m) => m.Subject)).toContain('Weekrapport: 1 probleem, 1 let op, 0 ok');
    expect(JSON.parse(got.find((g) => g.path === '/discord')!.body).embeds[0].url).toBe(`http://localhost:8080/#/reports/${id}`);
    expect(JSON.parse(got.find((g) => g.path === '/hook')!.body).data).toMatchObject({ id, status: 'problem' });
  }, 120_000);

  it('the next report compares: recurring errors, and a trend per container', async () => {
    // A few more errors since the first report.
    await new Promise((r2) => setTimeout(r2, 4000));
    t.clock.now = Date.now();
    const { id } = await t.json<{ id: number }>('POST', `/api/reports/schedules/${schedule.id}/run`);
    const r = await t.json<Report & { trend: Record<string, string[]> }>('GET', `/api/reports/${id}`);
    const web = r.containers.find((c) => c.container === 'burrowtest-web')!;
    expect(web.problems[0]!.trend).toBe('recurring');
    // Fewer errors in a few seconds than in a week: this time not "attention".
    expect(r.trend[`${h.id}:burrowtest-web`]).toEqual(['attention', web.status]);
    expect((await t.json<unknown[]>('GET', '/api/reports')).length).toBe(2);
  }, 120_000);

  it('a schedule of its own: one channel, no explanations, its own threshold, quiet when all is well', async () => {
    const hook = (await t.json<{ id: number; kind: string }[]>('GET', '/api/channels')).find((c) => c.kind === 'webhook')!;
    const base = { name: 'Web only', enabled: false, kind: 'daily', day: 1, time: '07:00', cron: null, timeZone: 'Europe/Amsterdam', hostIds: [h.id], containers: ['burrowtest-web'], channelIds: [hook.id], ai: false };
    // Errors counted only from 100 000 on: all well, and asked to stay quiet then.
    const quiet = await t.json<ReportSchedule>('POST', '/api/reports/schedules', { ...base, onlyAttention: true, errorsAttention: 100_000 });
    expect(quiet).toMatchObject({ channelIds: [hook.id], onlyAttention: true, ai: false, errorsAttention: 100_000 });
    got.length = 0;
    t.clock.now = Date.now();
    const first = await t.json<{ id: number }>('POST', `/api/reports/schedules/${quiet.id}/run`);
    expect((await t.json<Report>('GET', `/api/reports/${first.id}`)).status).toBe('ok');
    await new Promise((r2) => setTimeout(r2, 1500));
    expect(got.map((g) => g.path)).toEqual([]);
    // From one error on, and sent: to the webhook only, and no model asked.
    await t.json('PUT', `/api/reports/schedules/${quiet.id}`, { ...base, onlyAttention: false, errorsAttention: 1, warningsAttention: 100 });
    await new Promise((r2) => setTimeout(r2, 3000));
    t.clock.now = Date.now();
    const second = await t.json<{ id: number }>('POST', `/api/reports/schedules/${quiet.id}/run`);
    const r = await t.json<Report>('GET', `/api/reports/${second.id}`);
    expect(r.status).toBe('attention');
    expect(r.model).toBeNull();
    await expect.poll(() => got.map((g) => g.path)).toEqual(['/hook']);
    await t.request('DELETE', `/api/reports/schedules/${quiet.id}`);
  }, 120_000);

  it('reads the logs its selection asks for: only one container, its last lines, only errors', async () => {
    const s = await t.json<ReportSchedule>('POST', '/api/reports/schedules', {
      name: 'Selected',
      enabled: false,
      kind: 'daily',
      day: 1,
      time: '07:00',
      cron: null,
      timeZone: 'Europe/Amsterdam',
      ai: false,
      selection: {
        rules: [
          { target: null, window: { kind: 'since_last', n: 1 }, levels: ['fatal', 'error', 'warn'], skip: true },
          { target: { hostId: h.id, project: null, container: 'burrowtest-web' }, window: { kind: 'lines', n: 40 }, levels: ['error'], skip: false },
        ],
      },
    });
    t.clock.now = Date.now();
    const { id } = await t.json<{ id: number }>('POST', `/api/reports/schedules/${s.id}/run`);
    const r = await t.json<Report>('GET', `/api/reports/${id}`);
    expect(r.containers.map((c) => c.container)).toEqual(['burrowtest-web']);
    const web = r.containers[0]!;
    // The last 40 lines, of which only the errors are kept (every third line is one).
    expect(web.linesRead).toBeGreaterThan(0);
    expect(web.linesRead).toBeLessThanOrEqual(40);
    expect(web.errors).toBe(web.linesRead);
    expect(web.warnings).toBe(0);
    await t.request('DELETE', `/api/reports/schedules/${s.id}`);
  }, 60_000);

  it("reads a container's log files with it, and the host's own log files as parts of their own", async () => {
    const sh = (command: string) => t.json<{ exitCode: number; stderr: string }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
    const now = new Date().toISOString();
    await sh(`docker exec burrowtest-worker true 2>/dev/null; docker exec burrowtest-web sh -c "printf '%s ERROR cache write failed\\n%s INFO fine\\n' ${now} ${now} > /tmp/app.log; ln -sf /dev/stderr /tmp/error.log"; printf '%s ERROR disk sdb failing\\n%s WARN disk sdb slow\\n' ${now} ${now} > /tmp/burrowtest-host.log`);
    const fa = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: 'burrowtest-web', path: '/tmp/app.log' });
    // nginx's way: error.log a link to the container's own output. Not "could not be read" (report 71d6c5).
    const fc = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: 'burrowtest-web', path: '/tmp/error.log' });
    const fb = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: '', path: '/tmp/burrowtest-host.log' });
    const s = await t.json<ReportSchedule>('POST', '/api/reports/schedules', {
      name: 'With files',
      enabled: false,
      kind: 'daily',
      day: 1,
      time: '07:00',
      cron: null,
      timeZone: 'Europe/Amsterdam',
      ai: false,
      selection: {
        rules: [
          { target: null, window: { kind: 'hours', n: 1 }, levels: ['fatal', 'error', 'warn'], skip: false },
          { target: { hostId: h.id, project: null, container: 'burrowtest-worker' }, window: { kind: 'hours', n: 1 }, levels: ['error'], skip: true },
        ],
      },
    });
    t.clock.now = Date.now() + 1000;
    const before = (await t.json<Report>('GET', `/api/reports/${(await t.json<{ id: number }>('POST', `/api/reports/schedules/${s.id}/run`)).id}`));
    const web = before.containers.find((c) => c.container === 'burrowtest-web')!;
    const file = before.containers.find((c) => c.container === `:${encodeURIComponent('/tmp/burrowtest-host.log')}`)!;
    // The container's errors include its file's; the host's file is a part of its own.
    expect(web.problems.map((p) => p.title).join('\n')).toContain('cache write failed');
    expect(web.reasons.filter((r) => r.code === 'logs_unread')).toEqual([]);
    // Which files it read, for the report's link to its logs (AUDIT2 PAGE-21).
    expect(web.files?.sort()).toEqual(['/tmp/app.log', '/tmp/error.log']);
    expect(file).toMatchObject({ hostId: h.id, errors: 1, warnings: 1, linesRead: 2 });
    expect(file.problems.map((p) => p.title).join('\n')).toContain('disk sdb failing');
    await t.request('DELETE', `/api/reports/schedules/${s.id}`);
    await t.request('DELETE', `/api/docker/${h.id}/logfiles/${fa.id}`);
    await t.request('DELETE', `/api/docker/${h.id}/logfiles/${fb.id}`);
    await t.request('DELETE', `/api/docker/${h.id}/logfiles/${fc.id}`);
    await sh('docker exec burrowtest-web rm -f /tmp/app.log /tmp/error.log; rm -f /tmp/burrowtest-host.log');
  }, 90_000);

  it('runs on its schedule, once per minute it is due', async () => {
    // Monday 2026-09-28 08:00 in Amsterdam is 06:00 UTC.
    const due = Date.UTC(2026, 8, 28, 6, 0, 20);
    const before = (await t.json<unknown[]>('GET', '/api/reports')).length;
    await t.reports.tick(Date.UTC(2026, 8, 28, 5, 59));
    await t.reports.tick(due);
    await t.reports.tick(due + 10_000);
    expect((await t.json<unknown[]>('GET', '/api/reports')).length).toBe(before + 1);
    const [s] = await t.json<ReportSchedule[]>('GET', '/api/reports/schedules');
    expect(s!.nextRunAt).not.toBeNull();
  }, 120_000);

  it('a schedule due while another report is being made waits its turn', async () => {
    // The Monday after: 2026-10-05 08:00 in Amsterdam is 06:00 UTC.
    const due = Date.UTC(2026, 9, 5, 6, 0, 20);
    const [s] = await t.json<ReportSchedule[]>('GET', '/api/reports/schedules');
    const before = (await t.json<unknown[]>('GET', '/api/reports')).length;
    // Made by hand, still going when the schedule falls due.
    const byHand = t.reports.run(s!.id);
    await t.reports.tick(due);
    await byHand;
    // The next minute's tick makes the one that waited.
    await t.reports.tick(due + 60_000);
    expect((await t.json<unknown[]>('GET', '/api/reports')).length).toBe(before + 2);
  }, 120_000);

  it('a run claimed but not made when Burrow stopped is made after the restart (audit BE-14)', async () => {
    const [s] = await t.json<ReportSchedule[]>('GET', '/api/reports/schedules');
    // Its minute came, then Burrow stopped before the report was made.
    const claimed = t.ctx.now();
    t.ctx.db.update(reportSchedules).set({ claimedAt: claimed, lastRunAt: claimed - 60_000 }).where(eq(reportSchedules.id, s!.id)).run();
    const before = (await t.json<unknown[]>('GET', '/api/reports')).length;
    // A Burrow just started: its first tick, at a minute when nothing is due.
    const { Reports } = await import('../../src/reports/generate.js');
    const fresh = new Reports(t.ctx, t.files, t.docker, t.notifier);
    await fresh.tick(claimed + 120_000);
    expect((await t.json<unknown[]>('GET', '/api/reports')).length).toBe(before + 1);
    // Made: not again on the next start.
    await new Reports(t.ctx, t.files, t.docker, t.notifier).tick(claimed + 180_000);
    expect((await t.json<unknown[]>('GET', '/api/reports')).length).toBe(before + 1);
  }, 120_000);

  it('a report can be deleted, and is gone (report aafaba)', async () => {
    const [r] = await t.json<{ id: number }[]>('GET', '/api/reports');
    expect(r).toBeTruthy();
    expect((await t.request('DELETE', `/api/reports/${r!.id}`)).statusCode).toBe(204);
    expect((await t.request('GET', `/api/reports/${r!.id}`)).statusCode).toBe(404);
    expect((await t.json<{ id: number }[]>('GET', '/api/reports')).map((x) => x.id)).not.toContain(r!.id);
  });
});

describe('from phase 9', () => {
  it('the ntfy setting becomes a channel for alerts', async () => {
    const t2 = await makeApp();
    t2.ctx.db.insert(appSettings).values({ key: 'ntfy', value: JSON.stringify({ enabled: true, url: 'https://ntfy.sh', topic: 'burrow-old', tokenEnc: null }), updatedAt: 0 }).run();
    const { migrateNtfySetting, listChannels } = await import('../../src/notify/channels.js');
    migrateNtfySetting(t2.ctx);
    expect(listChannels(t2.ctx)).toEqual([expect.objectContaining({ kind: 'ntfy', enabled: true, topics: ['alerts'], ntfy: expect.objectContaining({ topic: 'burrow-old', hasToken: false }) })]);
    migrateNtfySetting(t2.ctx);
    expect(listChannels(t2.ctx)).toHaveLength(1);
    await t2.close();
  });
});
