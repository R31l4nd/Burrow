import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContainerInfo, ContainerReport, Report } from '@burrow/shared';
import { emailHtml } from '../../src/notify/channels.js';
import { compare, judge, logsCommand, overall, readFileLines, readLogs, reportNotice } from '../../src/reports/generate.js';
import { cronMatches, dueAt, nextRun, parseCron, runKey, zonedParts } from '../../src/reports/schedule.js';

describe('schedules', () => {
  it('reads cron expressions', () => {
    const c = parseCron('*/15 8-18 * * 1-5');
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toHaveLength(11);
    expect([...parseCron('0 8 * * 7').dow]).toEqual([0]);
    expect(() => parseCron('0 8 * *')).toThrow(/five fields/);
    expect(() => parseCron('61 * * * *')).toThrow();
    // Monday 2026-09-28 08:00 UTC.
    const mon = zonedParts(Date.UTC(2026, 8, 28, 8, 0), 'UTC');
    expect(mon).toMatchObject({ weekday: 1, hour: 8, minute: 0, day: 28, month: 9 });
    expect(cronMatches(parseCron('0 8 * * 1'), mon)).toBe(true);
    expect(cronMatches(parseCron('0 8 1 * *'), mon)).toBe(false);
    // Both day fields restricted: either matches.
    expect(cronMatches(parseCron('0 8 1 * 1'), mon)).toBe(true);
  });

  it('a day field that starts with * does not restrict, as in classic cron (AUDIT2 MON-20)', () => {
    // Monday 2026-09-28 (day 28: even), Tuesday 2026-09-29 (odd), Monday 2026-10-05 (odd).
    const at = (d: number, m = 8) => zonedParts(Date.UTC(2026, m, d, 8, 0), 'UTC');
    const c = parseCron('0 8 */2 * 1');
    // Every other day that is a Monday: not every other day, nor every Monday.
    expect(cronMatches(c, at(28))).toBe(false);
    expect(cronMatches(c, at(29))).toBe(false);
    expect(cronMatches(c, at(5, 9))).toBe(true);
    // Both restricted by a list: either.
    expect(cronMatches(parseCron('0 8 1,15 * 1'), at(28))).toBe(true);
  });

  it('knows when a weekly, daily or cron report is due, in its time zone', () => {
    const weekly = { kind: 'weekly' as const, day: 1, time: '08:00', cron: null, timeZone: 'Europe/Amsterdam' };
    expect(dueAt(weekly, Date.UTC(2026, 8, 28, 6, 0))).toBe(true);
    expect(dueAt(weekly, Date.UTC(2026, 8, 28, 8, 0))).toBe(false);
    expect(new Date(nextRun(weekly, Date.UTC(2026, 8, 28, 6, 0))!).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    const daily = { ...weekly, kind: 'daily' as const, timeZone: 'UTC' };
    expect(new Date(nextRun(daily, Date.UTC(2026, 8, 28, 9, 0))!).toISOString()).toBe('2026-09-29T08:00:00.000Z');
    const cron = { ...weekly, kind: 'cron' as const, cron: '30 7 1 * *', timeZone: 'UTC' };
    expect(new Date(nextRun(cron, Date.UTC(2026, 8, 28))!).toISOString()).toBe('2026-10-01T07:30:00.000Z');
    expect(nextRun({ ...cron, cron: 'nonsense' }, 0)).toBeNull();
  });

  it('over a change of the clocks: once in the hour that comes twice, and still on the day an hour is skipped', () => {
    const daily = { kind: 'daily' as const, day: 0, time: '02:30', cron: null, timeZone: 'Europe/Amsterdam' };
    // 25 October 2026: 02:30 comes twice (00:30 and 01:30 UTC). Both minutes
    // match, but they are one run: the same key.
    expect(dueAt(daily, Date.UTC(2026, 9, 25, 0, 30))).toBe(true);
    expect(dueAt(daily, Date.UTC(2026, 9, 25, 1, 30))).toBe(true);
    expect(runKey(Date.UTC(2026, 9, 25, 0, 30), daily.timeZone)).toBe(runKey(Date.UTC(2026, 9, 25, 1, 30), daily.timeZone));
    expect(runKey(Date.UTC(2026, 9, 25, 0, 30), daily.timeZone)).not.toBe(runKey(Date.UTC(2026, 9, 26, 1, 30), daily.timeZone));
    // 29 March 2026: 02:00 to 03:00 is skipped. A 02:30 report runs at 03:00, once.
    expect(new Date(nextRun(daily, Date.UTC(2026, 2, 28, 12, 0))!).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(dueAt(daily, Date.UTC(2026, 2, 29, 1, 1))).toBe(false);
    // Any other day 03:00 is not 02:30.
    expect(dueAt(daily, Date.UTC(2026, 2, 30, 1, 0))).toBe(false);
    // A weekly one on that Sunday too; on another weekday, not.
    expect(dueAt({ ...daily, kind: 'weekly' as const, day: 0 }, Date.UTC(2026, 2, 29, 1, 0))).toBe(true);
    expect(dueAt({ ...daily, kind: 'weekly' as const, day: 1 }, Date.UTC(2026, 2, 29, 1, 0))).toBe(false);
    // Cron the same way: "15 2 * * *" runs at 03:00 that day, once.
    const cron = { ...daily, kind: 'cron' as const, cron: '15 2 * * *' };
    expect(new Date(nextRun(cron, Date.UTC(2026, 2, 28, 12, 0))!).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(new Date(nextRun(cron, Date.UTC(2026, 2, 29, 1, 0))!).toISOString()).toBe('2026-03-30T00:15:00.000Z');
  });
});

describe('cron day of the week', () => {
  it('7 is Sunday in a range and a list, and a step is left as written (audit BE-24)', () => {
    expect([...parseCron('0 8 * * 1-7').dow].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...parseCron('0 8 * * 5-7').dow].sort()).toEqual([0, 5, 6]);
    expect([...parseCron('0 8 * * 7').dow]).toEqual([0]);
    expect([...parseCron('0 8 * * 1,7').dow].sort()).toEqual([0, 1]);
    expect([...parseCron('0 8 * * */7').dow].sort()).toEqual([0]);
    expect(() => parseCron('0 8 * * 8')).toThrow();
  });
});

describe('the next run, found fast (audit BE-28)', () => {
  // The old way, every minute for five weeks: the reference where it finds one.
  const slow = (s: Parameters<typeof nextRun>[0], from: number) => {
    let t = Math.ceil((from + 1) / 60_000) * 60_000;
    for (let i = 0; i < 36 * 1440; i++, t += 60_000) if (dueAt(s, t)) return t;
    return null;
  };

  it('a yearly cron: its date next year, in a few milliseconds instead of a second and null', () => {
    const yearly = { kind: 'cron' as const, day: 0, time: '00:00', cron: '0 0 1 1 *', timeZone: 'Europe/Amsterdam' };
    const at = performance.now();
    const next = nextRun(yearly, Date.UTC(2026, 9, 6));
    expect(performance.now() - at).toBeLessThan(250);
    expect(new Date(next!).toISOString()).toBe('2026-12-31T23:00:00.000Z');
    // 29 February: the next one is in 2028, past a year; none within it.
    expect(nextRun({ ...yearly, cron: '0 0 29 2 *' }, Date.UTC(2026, 9, 6))).toBeNull();
  });

  it('the same minute as walking every minute, over the changes of the clocks too', () => {
    const base = { day: 0, time: '02:30', cron: null, timeZone: 'Europe/Amsterdam' };
    const schedules = [
      { ...base, kind: 'daily' as const },
      { ...base, kind: 'weekly' as const, day: 0 },
      { ...base, kind: 'weekly' as const, day: 3, time: '23:59' },
      { ...base, kind: 'daily' as const, time: '00:00', timeZone: 'America/New_York' },
      { ...base, kind: 'cron' as const, cron: '15 2 * * *' },
      { ...base, kind: 'cron' as const, cron: '*/20 9-17 * * 1-5' },
      { ...base, kind: 'cron' as const, cron: '0 0 1 * *' },
      { ...base, kind: 'cron' as const, cron: '30 4 13 * 5' },
      { ...base, kind: 'cron' as const, cron: '45 23 * * 0', timeZone: 'Asia/Kolkata' },
      { ...base, kind: 'cron' as const, cron: '0 1-3 * 3,10 0', timeZone: 'Europe/London' },
    ];
    // Around both changes of the clocks in Europe and America, and an ordinary week.
    const froms = [Date.UTC(2026, 2, 27, 23, 59), Date.UTC(2026, 2, 29, 0, 59), Date.UTC(2026, 9, 24, 22, 0), Date.UTC(2026, 9, 25, 0, 31), Date.UTC(2026, 10, 1, 4, 0)];
    for (const s of schedules)
      for (const from of froms) {
        const want = slow(s, from);
        // Past five weeks the old way gave up; the new one goes on.
        if (want === null) expect(nextRun(s, from)! - from).toBeGreaterThan(35 * 86_400_000);
        else expect([s, from, nextRun(s, from)]).toEqual([s, from, want]);
      }
    // The old way is the slow part: several seconds under coverage.
  }, 60_000);
});

const c = (over: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: 'x',
  name: 'web',
  image: 'nginx',
  imageId: 'sha256:1',
  state: 'running',
  health: null,
  restarts: 0,
  startedAt: null,
  finishedAt: null,
  exitCode: 0,
  oomKilled: false,
  createdAt: '',
  project: null,
  service: null,
  configFiles: null,
  workingDir: null,
  ...over,
});
const facts = { crashes: 0, oom: 0, unhealthyEvents: 0, errors: 0, warnings: 0, restartsBefore: null };

describe('status', () => {
  it('ok, attention or problem, and why', () => {
    expect(judge({ ...facts, c: c() })).toEqual({ status: 'ok', reasons: [] });
    expect(judge({ ...facts, c: c(), errors: 3 })).toEqual({ status: 'ok', reasons: [{ code: 'errors', n: 3 }] });
    expect(judge({ ...facts, c: c(), errors: 40 }).status).toBe('attention');
    expect(judge({ ...facts, c: c({ restarts: 5 }), restartsBefore: 2 })).toEqual({ status: 'attention', reasons: [{ code: 'restarts', n: 3 }] });
    expect(judge({ ...facts, c: c(), crashes: 2 }).status).toBe('problem');
    expect(judge({ ...facts, c: c({ health: 'unhealthy' }) }).reasons).toEqual([{ code: 'unhealthy' }]);
    expect(judge({ ...facts, c: c({ state: 'exited', exitCode: 3 }) }).status).toBe('problem');
    // A one-off that finished well is fine.
    expect(judge({ ...facts, c: c({ state: 'exited', exitCode: 0 }) }).status).toBe('ok');
  });

  it('new, recurring and resolved errors', () => {
    const now = [
      { key: 'a', title: 'A', count: 3 },
      { key: 'b', title: 'B', count: 1 },
    ];
    const before = ['a', 'c'].map((key) => ({ key, title: key, count: 1, trend: 'new' as const }));
    expect(compare(now, before)).toEqual({
      problems: [
        { key: 'a', title: 'A', count: 3, trend: 'recurring' },
        { key: 'b', title: 'B', count: 1, trend: 'new' },
      ],
      resolved: ['c'],
    });
    expect(compare(now, null).problems.every((p) => p.trend === 'new')).toBe(true);
  });

  it('a summary of the whole, in either language', () => {
    const r = (container: string, status: ContainerReport['status'], extra: Partial<ContainerReport> = {}) => ({ container, status, problems: [], resolved: [], ...extra }) as unknown as ContainerReport;
    const cs = [r('web', 'problem', { problems: [{ key: 'k', title: 't', count: 1, trend: 'new' }] }), r('db', 'attention', { resolved: ['x'] }), r('cache', 'ok')];
    expect(overall(cs, { ok: 1, attention: 1, problem: 1 }, 'en')).toBe('Problems: web. Needs attention: db. New errors in web. Resolved in db.');
    expect(overall([r('a', 'ok')], { ok: 1, attention: 0, problem: 0 }, 'nl')).toBe('Alle 1 containers zijn in orde.');
  });
});

describe('logs of a period', () => {
  it("a log file's lines of the window: their own times, a following line with the one before, nothing before the window or after it", () => {
    const out = ['2026-09-27T09:00:00Z INFO before the window', '2026-09-27T10:00:00Z ERROR boom', '    at main (app.js:1)', '2026-09-27T12:00:00Z WARN after the window', ''].join('\n');
    const r = readFileLines(out, Date.parse('2026-09-27T09:30:00Z'), Date.parse('2026-09-27T11:00:00Z'));
    expect(r.total).toBe(4);
    expect(r.lines).toEqual([
      { ts: '2026-09-27T10:00:00.000Z', text: '2026-09-27T10:00:00Z ERROR boom' },
      { ts: '2026-09-27T10:00:00.000Z', text: '    at main (app.js:1)' },
    ]);
    // No time at all in the file: every line counts.
    expect(readFileLines('a\nb\n', Date.parse('2026-09-27T09:30:00Z'), Date.parse('2026-09-27T11:00:00Z')).lines).toEqual([
      { ts: null, text: 'a' },
      { ts: null, text: 'b' },
    ]);
  });

  it("a log file's times without a zone are in the zone of where it is, said first; that line is no line of the file (AUDIT2 AI-12)", () => {
    const out = ['@@burrow-zone -0500', '2026-09-27 05:00:00 ERROR boom', ''].join('\n');
    const r = readFileLines(out, Date.parse('2026-09-27T09:30:00Z'), Date.parse('2026-09-27T11:00:00Z'));
    expect(r).toEqual({ lines: [{ ts: '2026-09-27T10:00:00.000Z', text: '2026-09-27 05:00:00 ERROR boom' }], total: 1 });
  });

  it('reads the last lines and how many there were; a docker logs that failed is not an empty log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-logs-'));
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nif [ "$MODE" = gone ]; then echo "Error: No such container: web" >&2; exit 1; fi\nseq 1 7000 | sed "s/^/2026-09-27T10:00:00.000000000Z line /"\n');
    chmodSync(join(dir, 'docker'), 0o755);
    const run = (mode: string) => readLogs(execFileSync('sh', ['-c', logsCommand('web', 0, 60_000)], { env: { PATH: `${dir}:/usr/bin:/bin`, MODE: mode }, encoding: 'utf8' }));
    const ok = run('ok');
    expect(ok).toMatchObject({ total: 7000, error: null });
    expect(ok.lines).toHaveLength(5000);
    expect(ok.lines.at(-1)).toEqual({ ts: '2026-09-27T10:00:00.000000000Z', text: 'line 7000' });
    expect(run('gone')).toEqual({ lines: [], total: 1, error: 'Error: No such container: web' });
    // Cut off before docker said it ended: not read either.
    expect(readLogs('2026-09-27T10:00:00.000000000Z ERROR boom\nplain\n@@burrow-lines 9000\n')).toEqual({
      lines: [
        { ts: '2026-09-27T10:00:00.000000000Z', text: 'ERROR boom' },
        { ts: null, text: 'plain' },
      ],
      total: 9000,
      error: 'no answer',
    });
  });

  it('logs that could not be read: attention, and nothing called resolved', () => {
    expect(judge({ ...facts, c: c(), unread: 'docker logs' })).toEqual({ status: 'attention', reasons: [{ code: 'logs_unread', what: 'docker logs' }] });
    const before = [{ key: 'a', title: 'A', count: 3, trend: 'new' as const }];
    expect(compare([], before)).toEqual({ problems: [], resolved: ['a'] });
    expect(compare([], before, true)).toEqual({ problems: before, resolved: [] });
  });
});

describe('e-mail', () => {
  it('escapes the text and links to Burrow', () => {
    const html = emailHtml({ topic: 'reports', title: 'Week <1>', body: 'a & b\n\n<script>x</script>', page: '/reports/1', priority: 3 }, 'https://b/#/reports/1', 'nl');
    expect(html).toContain('<h2 style="font-size:18px;margin:0 0 12px">Week &lt;1&gt;</h2>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('href="https://b/#/reports/1"');
    expect(html).toContain('Openen in Burrow');
  });
});

describe('a host that cannot be read', () => {
  it('is in the report, as a problem: never "all fine" over containers nobody saw', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { hosts } = await import('../../src/db/schema.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
    const { eq } = await import('drizzle-orm');
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).where(eq(hosts.id, h.id)).run();
    (t.docker as unknown as { poll: () => Promise<unknown> }).poll = async () => ({ error: 'connection refused', containers: [] });
    const s = await t.json<{ id: number }>('POST', '/api/reports/schedules', { name: 'Daily', enabled: true, kind: 'daily', timeZone: 'UTC', ai: false });
    const { id } = await t.json<{ id: number }>('POST', `/api/reports/schedules/${s.id}/run`);
    const r = await t.json<Report>('GET', `/api/reports/${id}`);
    expect(r.status).toBe('problem');
    expect(r.unreachable).toEqual([{ hostId: h.id, hostName: 'nas', error: 'connection refused' }]);
    expect(r.summary).toContain('nas');
    expect(r.summary).not.toContain('are fine');
    await t.close();
  });

  it("its summary is said in the reader's language, whatever the schedule's (decision 22)", async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { hosts } = await import('../../src/db/schema.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
    const { eq } = await import('drizzle-orm');
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).where(eq(hosts.id, h.id)).run();
    (t.docker as unknown as { poll: () => Promise<unknown> }).poll = async () => ({ error: 'connection refused', containers: [] });
    const s = await t.json<{ id: number }>('POST', '/api/reports/schedules', { name: 'Daily', enabled: true, kind: 'daily', timeZone: 'UTC', ai: false });
    const { id } = await t.json<{ id: number }>('POST', `/api/reports/schedules/${s.id}/run`);
    expect((await t.json<Report>('GET', `/api/reports/${id}?lang=nl`)).summary).toBe('Niet te lezen: nas; hun containers ontbreken.');
    expect((await t.json<Report>('GET', `/api/reports/${id}?lang=en`)).summary).toBe('Could not be read: nas; their containers are missing.');
    await t.close();
  });
});

describe('a report sent to channels', () => {
  it("each language's body has the summary in that language, whichever was stored (AUDIT2 MON-23)", () => {
    const containers = [{ container: 'web', hostName: 'debian', status: 'problem', reasons: [], problems: [], resolved: [] } as unknown as ContainerReport];
    const report = { id: 1, scheduleId: 1, name: 'Weekly report', createdAt: '', from: '', to: '', status: 'problem', counts: { ok: 0, attention: 0, problem: 1 }, summary: overall(containers, { ok: 0, attention: 0, problem: 1 }, 'en'), lang: 'en', containers, model: null, tokens: null } as Report;
    const n = reportNotice(report);
    expect(n.body.startsWith(overall(containers, report.counts, 'en'))).toBe(true);
    expect(n.nl.body.startsWith(overall(containers, report.counts, 'nl'))).toBe(true);
    expect(n.nl.body).not.toContain(report.summary);
  });
});
