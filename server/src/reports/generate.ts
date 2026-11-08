import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  assessCommand,
  DEFAULT_SELECTION,
  maxRisk,
  detectLevel,
  fileLineTime,
  groupLines,
  keepLevel,
  logSelection,
  plural,
  ruleFor,
  windowArgs,
  reasonText,
  maskText,
  renderGroups,
  splitTimestamp,
  subjectLabel,
  type ContainerInfo,
  type ContainerReport,
  type Report,
  type ReportListItem,
  type ReportFix,
  type ReportProblem,
  type ReportProgress,
  type ReportReason,
  type ReportSchedule,
  type ReportStatus,
} from '@burrow/shared';
import { providerExternal, providerFor } from '../ai/settings.js';
import type { Ctx } from '../context.js';
import { alertCounts, alerts, channels, hosts, reports, reportSchedules } from '../db/schema.js';
import type { DockerMonitor } from '../docker/monitor.js';
import { logFilesOf } from '../docker/logfiles.js';
import { fileTailCommand, OUTPUT_MARK, zoneLine } from '../docker/logs.js';
import type { SftpPool } from '../files/pool.js';
import type { PackageChecks } from '../hosts/packages.js';
import type { Notifier } from '../notify/channels.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { dueAt, nextRun, runKey } from './schedule.js';
import { recordUsage } from '../ai/usage.js';

// A report on the containers over a period: per container what Docker and
// the alerts say (crashes, health, restarts) and what the logs say (errors,
// warnings, the kinds of error), a status (ok, attention, problem), and the
// comparison with the previous report (new, recurring, resolved). The
// language model explains only the containers that need it; without one the
// report is still complete, just without explanations.

const MAX_LINES = 5000;
const LINES_MARK = '@@burrow-lines ';
const EXIT_MARK = '@@burrow-exit ';
const AI_CONTAINERS = 20;

/** A container's log lines of a window: from (or all), up to `to`, the last `tail` of them (at most MAX_LINES). */
export function logsCommand(container: string, from: number | null, to: number, tail: number | null = null): string {
  const since = from !== null ? ` --since ${new Date(from).toISOString()}` : '';
  const last = tail !== null ? ` --tail ${Math.min(tail, MAX_LINES)}` : '';
  // docker's own exit code as the last line through the pipe: a failure is not an empty log.
  return `{ docker logs${since} --until ${new Date(to).toISOString()}${last} -t ${shellQuote(container)} 2>&1; echo "${EXIT_MARK}$?"; } | awk '{print} END {print "${LINES_MARK}" NR-1}' | tail -n ${MAX_LINES + 2}`;
}

/** A log file's lines of a window: the last of them read (at most MAX_LINES), its times from the lines, kept from `from` to `to`. */
export function readFileLines(out: string, from: number | null, to: number, now = new Date()): { lines: { ts: string | null; text: string }[]; total: number } {
  const all = out.split('\n').filter((l, i, a) => l || i < a.length - 1);
  // First the zone of where the file is (fileCommand), for its times without one.
  const zone = all.length ? zoneLine(all[0]!) : null;
  if (zone !== null) all.shift();
  let last: string | null = null;
  const lines: { ts: string | null; text: string }[] = [];
  for (const text of all) {
    last = fileLineTime(text, now, zone) ?? last;
    const at = last ? Date.parse(last) : null;
    if (at !== null && ((from !== null && at < from) || at > to)) continue;
    lines.push({ ts: last, text });
  }
  return { lines, total: all.length };
}

/** Lines read, how many there were, and why not, when docker logs failed (or never said it ended). */
export function readLogs(out: string): { lines: { ts: string | null; text: string }[]; total: number; error: string | null } {
  const all = out.split('\n');
  let total = 0;
  let exit: number | null = null;
  const lines: { ts: string | null; text: string }[] = [];
  for (const raw of all) {
    if (raw.startsWith(LINES_MARK)) {
      total = Number(raw.slice(LINES_MARK.length)) || 0;
      continue;
    }
    if (raw.startsWith(EXIT_MARK)) {
      exit = Number(raw.slice(EXIT_MARK.length));
      continue;
    }
    if (!raw) continue;
    const s = splitTimestamp(raw);
    lines.push({ ts: s?.ts ?? null, text: s?.text ?? raw });
  }
  // A failed docker logs printed its complaint (2>&1) as the last line.
  const error = exit === null ? 'no answer' : exit !== 0 ? (lines.pop()?.text.slice(0, 200) ?? `exit ${exit}`) : null;
  return { lines, total: Math.max(total, lines.length), error };
}

export interface Facts {
  c: ContainerInfo;
  crashes: number;
  oom: number;
  unhealthyEvents: number;
  errors: number;
  warnings: number;
  restartsBefore: number | null;
  /** What could not be read (its logs, a log file), if anything. */
  unread?: string | null;
}

/** The status and why, from facts only; the thresholds are the schedule's (10 errors, 100 warnings by default). */
export function judge(f: Facts, limits: { errors: number; warnings: number } = { errors: 10, warnings: 100 }): { status: ReportStatus; reasons: ReportReason[] } {
  const reasons: ReportReason[] = [];
  let problem = false;
  let attention = false;
  const add = (r: ReportReason, level: 'problem' | 'attention' | null) => {
    reasons.push(r);
    if (level === 'problem') problem = true;
    if (level === 'attention') attention = true;
  };
  if (f.crashes) add({ code: 'crashes', n: f.crashes }, 'problem');
  if (f.oom) add({ code: 'oom', n: f.oom }, 'problem');
  if (f.c.health === 'unhealthy') add({ code: 'unhealthy' }, 'problem');
  if (f.c.state !== 'running' && f.c.exitCode !== 0) add({ code: 'exited', n: f.c.exitCode }, 'problem');
  if (f.unhealthyEvents && f.c.health !== 'unhealthy') add({ code: 'unhealthy_events', n: f.unhealthyEvents }, 'attention');
  const restarted = f.restartsBefore !== null && f.c.restarts > f.restartsBefore ? f.c.restarts - f.restartsBefore : 0;
  if (restarted) add({ code: 'restarts', n: restarted }, 'attention');
  if (f.errors) add({ code: 'errors', n: f.errors }, f.errors >= limits.errors ? 'attention' : null);
  if (f.warnings >= limits.warnings) add({ code: 'warnings', n: f.warnings }, 'attention');
  if (f.unread) add({ code: 'logs_unread', what: f.unread }, 'attention');
  return { status: problem ? 'problem' : attention ? 'attention' : 'ok', reasons };
}

/**
 * Kinds of error this period, compared with the previous report's. With
 * logs that could not be read (`unread`), nothing is resolved: the
 * previous problems not seen stay as they were.
 */
export function compare(now: { key: string; title: string; count: number }[], before: ReportProblem[] | null, unread = false): { problems: ReportProblem[]; resolved: string[] } {
  const prev = new Set((before ?? []).map((p) => p.key));
  const problems: ReportProblem[] = now.map((p) => ({ ...p, trend: prev.has(p.key) ? ('recurring' as const) : ('new' as const) }));
  const keys = new Set(now.map((p) => p.key));
  if (unread) return { problems: [...problems, ...(before ?? []).filter((p) => !keys.has(p.key))], resolved: [] };
  return { problems, resolved: [...prev].filter((k) => !keys.has(k)) };
}

const explainSchema = z.object({
  summary: z.string().describe('Two or three sentences: what is wrong and why, for this container.'),
  fixes: z
    .array(
      z.object({
        step: z.string().describe('One concrete step to check or change, in a sentence.'),
        command: z.string().describe('One shell command line on the host that carries out this step, ready to run (docker, docker compose, systemctl, ...); empty when a command does not fit.'),
        risk: z.enum(['low', 'medium', 'high']).describe('Of the command. low: reads only; medium: changes something recoverable; high: can destroy data or cut access'),
        risk_reason: z.string().describe('Empty for low risk; otherwise what could go wrong'),
      }),
    )
    .max(5),
});

/** The model's fixes, with Burrow's own risk rules over its commands. */
export function fixesFrom(out: z.infer<typeof explainSchema>['fixes']): ReportFix[] {
  return out.map((f) => {
    const command = f.command.trim() || null;
    if (!command) return { step: f.step, command: null, risk: 'low' as const, riskReasons: [] };
    const rules = assessCommand(command);
    return {
      step: f.step,
      command,
      risk: maxRisk(f.risk, rules.risk),
      riskReasons: [...(f.risk !== 'low' && f.risk_reason.trim() ? [f.risk_reason.trim()] : []), ...rules.reasons],
    };
  });
}

export class Reports {
  /** Where each report made is told (OPS-W-14). */
  jobs: import('../jobs.js').Jobs | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  // Schedules that fell due, waiting for the report being made.
  readonly #due: number[] = [];
  #recovered = false;
  /** When the scheduler last looked (OPS-W-07): the minutes since are looked at, not only the current one. */
  #lastTick: number | null = null;
  // The report being made, for its page and the busy pill: how far, and how
  // long it took last time. Kept a little after the end (the page learns
  // which report it became).
  #progress: ReportProgress | null = null;
  readonly #durations = new Map<number, number>();

  progress(): ReportProgress | null {
    return this.#progress;
  }

  /** A log file's lines over a container's window (see readFileLines); none, and why, when it cannot be read. */
  async #fileLines(hostId: number, container: string, file: string, w: { since: number | null; tail: number | null }, to: number): Promise<{ lines: { ts: string | null; text: string }[]; total: number; error: string | null }> {
    try {
      const tail = Math.min(w.tail ?? MAX_LINES, MAX_LINES);
      // Lines longer than the 4 MB read holds: the newest kept, and the first (the zone of the file's
      // times); the oldest went, silently the newest did (audit 2026-11-05).
      const r = await this.pool.with(hostId, async ({ client }) => exec(client, await fileTailCommand(client, { container, file }, { tail, follow: false, since: null, until: null }), 60_000, 4 << 20, undefined, { keepEnd: true }));
      if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `exit ${r.code}`);
      const out = r.head !== undefined ? `${r.head}\n${r.stdout}` : r.stdout;
      // The container's own output under a file's name: read already, with its log (report 71d6c5).
      if (out.trim() === OUTPUT_MARK) return { lines: [], total: 0, error: null };
      return { ...readFileLines(out, w.since, to), error: null };
    } catch (err) {
      this.ctx.log.warn({ hostId }, `report: log file ${file} of ${container || 'the host'}: ${(err as Error).message}`);
      return { lines: [], total: 0, error: file };
    }
  }

  #step(patch: Partial<ReportProgress>): void {
    if (this.#progress) this.#progress = { ...this.#progress, ...patch };
  }

  /** The hosts' package updates, named in each report. */
  packages: PackageChecks | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
    private readonly monitor: DockerMonitor,
    private readonly notifier: Notifier,
  ) {}

  start(): void {
    // A tick that throws (the database busy for a moment) is said, and the next minute's comes all the same.
    this.#timer = setInterval(() => void this.tick().catch((err: Error) => this.ctx.log.warn(`reports: the schedule check failed: ${err.message}`)), 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  schedules(): ReportSchedule[] {
    return this.ctx.db
      .select()
      .from(reportSchedules)
      .all()
      .map((r) => {
        const s = {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          kind: r.kind,
          day: r.day,
          time: r.time,
          cron: r.cron,
          timeZone: r.timeZone,
          hostIds: r.hostIds ? (JSON.parse(r.hostIds) as number[]) : null,
          containers: r.containers ? (JSON.parse(r.containers) as string[]) : null,
          channelIds: r.channelIds ? (JSON.parse(r.channelIds) as number[]) : null,
          selection: r.selection ? logSelection.parse(JSON.parse(r.selection)) : DEFAULT_SELECTION,
          onlyAttention: r.onlyAttention,
          ai: r.ai,
          errorsAttention: r.errorsAttention,
          warningsAttention: r.warningsAttention,
          lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
          nextRunAt: null as string | null,
        };
        const next = r.enabled ? nextRun(s, this.ctx.now()) : null;
        s.nextRunAt = next ? new Date(next).toISOString() : null;
        return s;
      });
  }

  /**
   * Once a minute: the schedules due now, each once. One report is made at
   * a time; one that falls due while another is being made (a long one with
   * explanations, or one run by hand) waits its turn instead of being lost.
   */
  async tick(now = this.ctx.now()): Promise<void> {
    // After a restart: runs claimed (their minute came) but never made,
    // waiting in the queue or being made when Burrow stopped. Made now,
    // within a day; the queue itself lived only in memory (audit BE-14).
    if (!this.#recovered) {
      this.#recovered = true;
      for (const r of this.ctx.db.select().from(reportSchedules).all()) {
        if (r.enabled && r.claimedAt !== null && (r.lastRunAt === null || r.lastRunAt < r.claimedAt) && now - r.claimedAt < 86_400_000 && !this.#due.includes(r.id)) this.#due.push(r.id);
      }
    }
    // Every minute since the last tick, not only this one: a tick that came
    // late (the clock stepped forward, the host slept, the event loop
    // stalled) skipped a report's minute for good (OPS-W-07). At most a day back.
    const since = Math.max(this.#lastTick ?? now - 60_000, now - 86_400_000);
    this.#lastTick = Math.max(now, this.#lastTick ?? now);
    for (const s of this.schedules()) {
      if (!s.enabled) continue;
      const at = dueAt(s, now) ? now : nextRun(s, since);
      if (at === null || at > now) continue;
      const key = runKey(at, s.timeZone);
      const row = this.ctx.db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id)).get();
      // The local minutes claimed lately, not only the last one: when the
      // clock goes back an hour, 02:00 and 02:30 come round again after
      // 02:30 was the last, and ran twice (AUDIT2 MON-19).
      const claimed = (row?.lastRunKey ?? '').split('|').filter(Boolean);
      if (claimed.includes(key)) continue;
      this.ctx.db.update(reportSchedules).set({ lastRunKey: [key, ...claimed].slice(0, 64).join('|'), claimedAt: now }).where(eq(reportSchedules.id, s.id)).run();
      if (!this.#due.includes(s.id)) this.#due.push(s.id);
    }
    // Busy: the tick making a report goes on with these, or a later one does.
    while (this.#due.length && !this.#running) {
      const id = this.#due.shift()!;
      // Switched off while it waited: not made (AUDIT2 MON-21). Made by hand stays possible.
      if (!this.schedules().find((x) => x.id === id)?.enabled) continue;
      await this.run(id).catch((err: Error) => this.ctx.log.warn(`report ${id} failed: ${err.message}`));
    }
  }

  /** Makes a report for a schedule now: since its last run (or a week), up to now. */
  async run(scheduleId: number): Promise<Report> {
    const s = this.schedules().find((x) => x.id === scheduleId);
    if (!s) throw new Error('no such report');
    if (this.#running) throw new Error('a report is being made already');
    this.#running = true;
    const started = Date.now();
    this.#progress = { scheduleId: s.id, name: s.name, phase: 'reading', done: 0, total: 0, startedAt: new Date(started).toISOString(), expectedMs: this.#durations.get(s.id) ?? null, reportId: null, error: null };
    const linger = () => {
      const p = this.#progress;
      setTimeout(() => this.#progress === p && (this.#progress = null), 30_000).unref();
    };
    try {
      const to = this.ctx.now();
      const last = this.ctx.db.select().from(reports).where(eq(reports.scheduleId, s.id)).orderBy(desc(reports.createdAt)).get();
      const from = last?.periodTo ?? to - (s.kind === 'daily' ? 1 : 7) * 86_400_000;
      const report = await this.#make(s, from, to, last ? (JSON.parse(last.containers) as ContainerReport[]) : null);
      this.ctx.db.update(reportSchedules).set({ lastRunAt: to }).where(eq(reportSchedules.id, s.id)).run();
      this.#step({ phase: 'sending' });
      await this.#notify(report, s);
      this.#durations.set(s.id, Date.now() - started);
      this.#step({ phase: 'done', reportId: report.id });
      this.jobs?.ran('reports', Date.now() - started);
      return report;
    } catch (err) {
      this.#step({ phase: 'failed', error: (err as Error).message });
      this.jobs?.ran('reports', Date.now() - started, `${s.name}: ${(err as Error).message}`);
      throw err;
    } finally {
      this.#running = false;
      linger();
    }
  }

  async #make(s: ReportSchedule, from: number, to: number, previous: ContainerReport[] | null): Promise<Report> {
    const lang = this.notifier.lang('reports');
    const prevBy = new Map((previous ?? []).map((c) => [`${c.hostId}:${c.container}`, c]));
    // Every host in the schedule: its containers when it has Docker, and its
    // own log files and units' journals in any case (a host without Docker,
    // or with a daemon that does not answer, still has them; AUDIT2 J-02).
    const inScope = this.ctx.db
      .select()
      .from(hosts)
      .all()
      .filter((h) => !s.hostIds || s.hostIds.includes(h.id))
      .map((h) => ({ ...h, hasDocker: !!(h.facts && (JSON.parse(h.facts) as { hasDocker?: boolean }).hasDocker) }))
      .filter((h) => h.hasDocker || logFilesOf(this.ctx, h.id, '').length > 0);
    const out: ContainerReport[] = [];
    const unreachable: NonNullable<Report['unreachable']> = [];
    const logsOf = new Map<ContainerReport, { ts: string | null; text: string }[]>();
    for (const h of inScope) {
      const snap = h.hasDocker ? await this.monitor.poll(h.id).catch(() => null) : null;
      if (h.hasDocker && (!snap || snap.error)) {
        this.ctx.log.warn({ hostId: h.id }, `report: cannot read ${h.name}: ${snap?.error ?? 'unreachable'}`);
        unreachable.push({ hostId: h.id, hostName: h.name, error: (snap?.error ?? 'unreachable').slice(0, 300) });
      }
      if (snap && !snap.error) {
        const inPeriod = this.ctx.db
          .select()
          .from(alerts)
          .where(and(eq(alerts.hostId, h.id), gte(alerts.updatedAt, from), lte(alerts.createdAt, to)))
          .all();
        // How often each happened within this period, not over the bundle's whole life (AUDIT2 MON-11).
        const inThis = new Map<number, number>();
        if (inPeriod.length) {
          for (const c of this.ctx.db
            .select()
            .from(alertCounts)
            .where(and(inArray(alertCounts.alertId, inPeriod.map((a) => a.id)), gte(alertCounts.minute, Math.floor(from / 60_000)), lte(alertCounts.minute, Math.floor(to / 60_000))))
            .all())
            inThis.set(c.alertId, (inThis.get(c.alertId) ?? 0) + c.n);
        }
        // Each container by its rule (the schedule's log selection): skipped,
        // or read over its window, only the levels it asks for.
        const chosen = snap.containers
          .filter((c) => !c.ignored && (!s.containers || s.containers.includes(c.name) || (c.project && s.containers.includes(c.project))))
          .map((c) => ({ c, rule: ruleFor(s.selection, h.id, c.project, c.name) }))
          .filter((x) => !x.rule.skip);
        this.#step({ total: (this.#progress?.total ?? 0) + chosen.length });
        for (const { c, rule } of chosen) {
          let logs: { lines: { ts: string | null; text: string }[]; total: number } = { lines: [], total: 0 };
          // What could not be read: no errors seen there is not no errors.
          const unread: string[] = [];
          const w = windowArgs(rule.window, { now: to, lastRun: from, started: c.startedAt ? Date.parse(c.startedAt) : null, fallbackMs: to - from });
          try {
            // The end kept when it is larger than read: the newest lines and the end marks, not the
            // oldest and "no answer" (audit 2026-11-05).
            const r = await this.pool.with(h.id, ({ client }) => exec(client, logsCommand(c.name, w.since, to, w.tail), 60_000, 4 << 20, undefined, { keepEnd: true }));
            const read = readLogs(r.stdout);
            logs = read;
            if (read.error) throw new Error(read.error);
          } catch (err) {
            this.ctx.log.warn({ hostId: h.id }, `report: logs of ${c.name}: ${(err as Error).message}`);
            unread.push('docker logs');
          }
          // Its log files over the same window, as part of the container.
          const files = logFilesOf(this.ctx, h.id, c.name);
          for (const f of files) {
            const more = await this.#fileLines(h.id, c.name, f.path, w, to);
            if (more.error) unread.push(more.error);
            logs = { lines: [...logs.lines, ...more.lines], total: logs.total + more.total };
          }
          this.#step({ done: (this.#progress?.done ?? 0) + 1 });
          const kept = logs.lines.filter((l) => keepLevel(rule.levels, detectLevel(l.text)));
          logs = { lines: kept, total: logs.total };
          let errors = 0;
          let warnings = 0;
          const errorLines: { source: string; ts: string | null; text: string }[] = [];
          for (const l of kept) {
            const lv = detectLevel(l.text);
            if (lv === 'error' || lv === 'fatal') {
              errors++;
              errorLines.push({ source: c.name, ...l });
            } else if (lv === 'warn') warnings++;
          }
          // Its own alerts and those about its log files ("web:%2Fapp%2Fa.log").
          const mine = inPeriod.filter((a) => a.container === c.name || a.container.startsWith(`${c.name}:`));
          const sum = (re: RegExp) => mine.filter((a) => re.test(a.title)).reduce((n, a) => n + (inThis.get(a.id) ?? 0), 0);
          const prev = prevBy.get(`${h.id}:${c.name}`);
          const { status, reasons } = judge({
            c,
            crashes: sum(/^(exited with code|stopped \d+ times)/),
            oom: sum(/out of memory/),
            unhealthyEvents: sum(/unhealthy/),
            errors,
            warnings,
            restartsBefore: prev ? prev.restarts : null,
            unread: unread.join(', ') || null,
          }, { errors: s.errorsAttention, warnings: s.warningsAttention });
          const kinds = groupLines(errorLines, { ips: false, budget: 4000 }).groups.slice(0, 5);
          const { problems, resolved } = compare(
            kinds.map((g) => ({ key: g.template.slice(0, 200), title: g.sample.slice(0, 200), count: g.count })),
            prev ? prev.problems : null,
            unread.length > 0,
          );
          const cr: ContainerReport = {
            hostId: h.id,
            hostName: h.name,
            container: c.name,
            project: c.project,
            image: c.image,
            status,
            reasons,
            linesRead: logs.lines.length,
            linesTotal: logs.total,
            errors,
            warnings,
            crashes: sum(/^(exited with code|stopped \d+ times)/),
            restarts: c.restarts,
            state: c.state,
            health: c.health,
            problems,
            resolved,
            summary: null,
            fixes: [],
            // Its logs on the report's page are these too: an error only in a file is found there (AUDIT2 PAGE-21).
            ...(files.length ? { files: files.map((f) => f.path) } : {}),
          };
          out.push(cr);
          if (status !== 'ok') logsOf.set(cr, logs.lines);
        }
      }
      // The host's own log files: each a part of the report of its own,
      // judged on its errors and warnings and its alerts.
      for (const f of logFilesOf(this.ctx, h.id, '')) {
        const subject = `:${encodeURIComponent(f.path)}`;
        const rule = ruleFor(s.selection, h.id, null, subject);
        if (rule.skip || (s.containers && !s.containers.includes(subject))) continue;
        const w = windowArgs(rule.window, { now: to, lastRun: from, started: null, fallbackMs: to - from });
        const read = await this.#fileLines(h.id, '', f.path, w, to);
        const kept = read.lines.filter((l) => keepLevel(rule.levels, detectLevel(l.text)));
        const errorLines = kept.filter((l) => ['error', 'fatal'].includes(detectLevel(l.text) ?? '')).map((l) => ({ source: subject, ...l }));
        const warnings = kept.filter((l) => detectLevel(l.text) === 'warn').length;
        const prev = prevBy.get(`${h.id}:${subject}`);
        // Judged like a running container without restarts or a healthcheck: on its errors and warnings.
        const asFile: ContainerInfo = { id: subject, name: subject, image: '', imageId: '', state: 'running', health: null, restarts: 0, startedAt: null, finishedAt: null, exitCode: 0, oomKilled: false, createdAt: new Date(to).toISOString(), project: null, service: null, configFiles: null, workingDir: null };
        const { status, reasons } = judge({ c: asFile, crashes: 0, oom: 0, unhealthyEvents: 0, errors: errorLines.length, warnings, restartsBefore: null, unread: read.error }, { errors: s.errorsAttention, warnings: s.warningsAttention });
        const kinds = groupLines(errorLines, { ips: false, budget: 4000 }).groups.slice(0, 5);
        const { problems, resolved } = compare(
          kinds.map((g) => ({ key: g.template.slice(0, 200), title: g.sample.slice(0, 200), count: g.count })),
          prev ? prev.problems : null,
          read.error !== null,
        );
        const cr: ContainerReport = {
          hostId: h.id,
          hostName: h.name,
          container: subject,
          project: null,
          image: '',
          status,
          reasons,
          linesRead: kept.length,
          linesTotal: read.total,
          errors: errorLines.length,
          warnings,
          crashes: 0,
          restarts: 0,
          state: 'running',
          health: null,
          problems,
          resolved,
          summary: null,
          fixes: [],
        };
        out.push(cr);
        if (status !== 'ok') logsOf.set(cr, kept);
      }
    }
    // The model explains the containers that need it, problems first.
    const provider = s.ai ? providerFor(this.ctx) : null;
    const worst = out.filter((c) => c.status !== 'ok').sort((a, b) => (a.status === b.status ? 0 : a.status === 'problem' ? -1 : 1));
    // What the model used over all its parts, kept with the report (report 18efc8).
    const used = { input: 0, output: 0, counted: false };
    if (provider && worst.length) {
      this.#step({ phase: 'explaining', done: 0, total: Math.min(worst.length, AI_CONTAINERS) });
      for (const c of worst.slice(0, AI_CONTAINERS)) {
        try {
          // Grouped and masked, and what is new since the last report first:
          // with a small budget the model reads the news, not the same
          // repeated errors again (fewer tokens, a sharper answer).
          const seen = new Set((prevBy.get(`${c.hostId}:${c.container}`)?.problems ?? []).map((p) => p.key));
          const { groups } = groupLines(
            (logsOf.get(c) ?? []).map((l) => ({ source: c.container, ...l })),
            { ips: providerExternal(this.ctx, provider.id), budget: provider.id === 'anthropic' || provider.id === 'gemini' ? 30_000 : 6000 },
          );
          groups.sort((a, b) => Number(seen.has(a.template.slice(0, 200))) - Number(seen.has(b.template.slice(0, 200))));
          const r = await provider.generate({
            onUsage: (u) => {
              recordUsage(this.ctx, 'report', `${provider.id}:${provider.model}`, u);
              used.input += u.input;
              used.output += u.output;
              used.counted = true;
            },
            name: 'container_report',
            schema: explainSchema,
            system: [
              'You write one part of a periodic report on Docker containers for the person who runs them.',
              `Answer in ${lang === 'nl' ? 'Dutch' : 'English'}. Be concrete and short; do not invent what the logs do not show.`,
              'Values like <secret> and <email> were masked on purpose.',
            ].join('\n'),
            // All of it masked, the names too (a host named by its address, a
            // secret in a path), not only the log lines (AUDIT2 AI-03).
            user: maskText(
              [
                c.container.includes(':') ? `Log file ${subjectLabel(c.container)} on ${c.hostName}.` : `Container ${c.container} on ${c.hostName} (image ${c.image}), now ${c.state}${c.health ? `, ${c.health}` : ''}.`,
                `This period: ${c.reasons.map((x) => reasonText(x, 'en')).join(', ') || 'nothing notable'}.`,
                `Log lines (grouped, errors first):`,
                renderGroups(groups) || '(none)',
              ].join('\n'),
              { ips: providerExternal(this.ctx, provider.id) },
            ),
          });
          c.summary = r.summary;
          c.fixes = fixesFrom(r.fixes);
        } catch (err) {
          this.ctx.log.warn(`report: no explanation for ${c.container}: ${(err as Error).message}`);
        }
        this.#step({ done: (this.#progress?.done ?? 0) + 1 });
      }
    }
    const counts = { ok: 0, attention: 0, problem: 0 };
    for (const c of out) counts[c.status]++;
    const status: ReportStatus = counts.problem || unreachable.length ? 'problem' : counts.attention ? 'attention' : 'ok';
    // Package updates waiting on the schedule's hosts, as their last check found them.
    const names = new Map(this.ctx.db.select({ id: hosts.id, name: hosts.name }).from(hosts).all().map((h) => [h.id, h.name]));
    const updates = (this.packages?.all() ?? [])
      .filter((p) => p.state === 'ok' && (p.total > 0 || p.reboot) && names.has(p.hostId) && (!s.hostIds || s.hostIds.includes(p.hostId)))
      .map((p) => ({ hostId: p.hostId, hostName: names.get(p.hostId)!, total: p.total, security: p.security, reboot: p.reboot }))
      .sort((a, b) => b.security - a.security || a.hostName.localeCompare(b.hostName));
    const summary = overall(out, counts, lang, unreachable.map((u) => u.hostName), updates);
    const row = this.ctx.db
      .insert(reports)
      .values({
        scheduleId: s.id,
        name: s.name,
        createdAt: to,
        periodFrom: from,
        periodTo: to,
        status,
        counts: JSON.stringify(counts),
        summary,
        containers: JSON.stringify(out),
        model: provider ? `${provider.id}:${provider.model}` : null,
        unreachable: unreachable.length ? JSON.stringify(unreachable) : null,
        updates: updates.length ? JSON.stringify(updates) : null,
        tokensIn: used.counted ? used.input : null,
        tokensOut: used.counted ? used.output : null,
      })
      .returning()
      .get();
    this.ctx.log.info(`report "${s.name}": ${counts.problem} problems, ${counts.attention} attention, ${counts.ok} ok`);
    return toReport(row, lang);
  }

  async #notify(r: Report, s: ReportSchedule): Promise<void> {
    // All well and asked to stay quiet then: kept, not sent.
    if (s.onlyAttention && r.status === 'ok') {
      this.ctx.log.info(`report "${r.name}": all ok, not sent (only when something needs a look)`);
      return;
    }
    const notice = reportNotice(r);
    // Chosen channels (switched on), or every channel that has reports on.
    if (s.channelIds) {
      const on = new Set(this.ctx.db.select({ id: channels.id, enabled: channels.enabled }).from(channels).all().filter((c) => c.enabled).map((c) => c.id));
      for (const id of s.channelIds.filter((x) => on.has(x))) await this.notifier.notify(notice, id);
    } else {
      await this.notifier.notify(notice);
    }
  }

  list(limit = 50): ReportListItem[] {
    return this.ctx.db
      .select()
      .from(reports)
      .orderBy(desc(reports.createdAt))
      .limit(limit)
      .all()
      .map((r) => {
        const { containers: _c, ...rest } = toReport(r, 'en');
        void _c;
        return rest;
      });
  }

  /** A report; with a language, its summary in that language (the reader's, decision 22), else as it was made. */
  get(id: number, lang?: 'en' | 'nl'): Report | null {
    const r = this.ctx.db.select().from(reports).where(eq(reports.id, id)).get();
    if (!r) return null;
    const out = toReport(r, lang ?? 'en');
    // The same parts said again in the reader's words: names and counts are stored, the sentence is not language.
    if (lang) out.summary = overall(out.containers, out.counts, lang, (out.unreachable ?? []).map((u) => u.hostName), out.updates);
    return out;
  }
}

/** A report as a notice: title and body in English and in Dutch, each channel takes its own. */
export function reportNotice(r: Report) {
  const text = (lang: 'en' | 'nl') => {
    const nl = lang === 'nl';
    const title = nl
      ? `${r.name === 'Weekly report' ? 'Weekrapport' : r.name}: ${plural(r.counts.problem, 'probleem', 'problemen')}, ${r.counts.attention} let op, ${r.counts.ok} ok`
      : `${r.name}: ${plural(r.counts.problem, 'problem', 'problems')}, ${r.counts.attention} attention, ${r.counts.ok} ok`;
    const lines = r.containers
      .filter((c) => c.status !== 'ok')
      .slice(0, 12)
      .map((c) => `${c.status === 'problem' ? 'x' : '!'} ${c.container} (${c.hostName}): ${c.reasons.map((x) => reasonText(x, lang)).join(', ')}`);
    // The summary in the channel's own language: the one stored is in the language of most
    // channels, and went to a Dutch channel in English beside Dutch lines (AUDIT2 MON-23).
    const summary = overall(r.containers, r.counts, lang, (r.unreachable ?? []).map((u) => u.hostName), r.updates);
    return { title, body: [summary, '', ...lines].join('\n').trim() };
  };
  const en = text('en');
  return {
    topic: 'reports' as const,
    ...en,
    page: `/reports/${r.id}`,
    priority: r.status === 'problem' ? 4 : 3,
    nl: text('nl'),
    data: { id: r.id, status: r.status, counts: r.counts, from: r.from, to: r.to },
  };
}

function toReport(r: typeof reports.$inferSelect, lang: 'en' | 'nl'): Report {
  const containers = JSON.parse(r.containers) as ContainerReport[];
  return {
    id: r.id,
    scheduleId: r.scheduleId,
    name: r.name,
    createdAt: new Date(r.createdAt).toISOString(),
    from: new Date(r.periodFrom).toISOString(),
    to: new Date(r.periodTo).toISOString(),
    status: r.status,
    counts: JSON.parse(r.counts) as Report['counts'],
    summary: r.summary,
    lang,
    containers,
    model: r.model,
    tokens: r.tokensIn !== null || r.tokensOut !== null ? { input: r.tokensIn ?? 0, output: r.tokensOut ?? 0 } : null,
    ...(r.unreachable ? { unreachable: JSON.parse(r.unreachable) as NonNullable<Report['unreachable']> } : {}),
    ...(r.updates ? { updates: JSON.parse(r.updates) as NonNullable<Report['updates']> } : {}),
  };
}

/** A few sentences on the whole report. */
export function overall(cs: ContainerReport[], counts: Report['counts'], lang: 'en' | 'nl', unreachable: string[] = [], updates: Report['updates'] = []): string {
  const nl = lang === 'nl';
  const list = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? ` ${nl ? 'en' : 'and'} ${xs.length - 5} ${nl ? 'meer' : 'more'}` : '');
  const names = (xs: ContainerReport[]) => list(xs.map((c) => c.container));
  const parts: string[] = [];
  const problems = cs.filter((c) => c.status === 'problem');
  const attention = cs.filter((c) => c.status === 'attention');
  // Hosts nobody could read come first: what is below says nothing about them.
  if (unreachable.length) parts.push(nl ? `Niet te lezen: ${list(unreachable)}; hun containers ontbreken.` : `Could not be read: ${list(unreachable)}; their containers are missing.`);
  if (!problems.length && !attention.length && !unreachable.length) parts.push(nl ? `Alle ${cs.length} containers zijn in orde.` : `All ${cs.length} containers are fine.`);
  if (problems.length) parts.push(nl ? `Problemen: ${names(problems)}.` : `Problems: ${names(problems)}.`);
  if (attention.length) parts.push(nl ? `Let op: ${names(attention)}.` : `Needs attention: ${names(attention)}.`);
  const fresh = cs.filter((c) => c.problems.some((p) => p.trend === 'new'));
  const fixed = cs.filter((c) => c.resolved.length);
  if (fresh.length) parts.push(nl ? `Nieuwe fouten bij ${names(fresh)}.` : `New errors in ${names(fresh)}.`);
  if (fixed.length) parts.push(nl ? `Opgelost bij ${names(fixed)}.` : `Resolved in ${names(fixed)}.`);
  // Package updates: the hosts with security updates named, the others counted.
  const secure = (updates ?? []).filter((u) => u.security > 0);
  const waiting = (updates ?? []).filter((u) => u.total > 0);
  if (secure.length) parts.push(nl ? `Beveiligingsupdates klaar op ${list(secure.map((u) => `${u.hostName} (${u.security})`))}.` : `Security updates waiting on ${list(secure.map((u) => `${u.hostName} (${u.security})`))}.`);
  else if (waiting.length) parts.push(nl ? `Pakketupdates klaar op ${plural(waiting.length, 'host', 'hosts')}.` : `Package updates waiting on ${plural(waiting.length, 'host', 'hosts')}.`);
  void counts;
  return parts.join(' ');
}
