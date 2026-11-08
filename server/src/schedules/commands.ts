import { desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { commandScheduleInput, scheduledScript, TIMED_OUT_CODE, type CommandRun, type CommandRunBrief, type CommandSchedule } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { commandRuns, commandSchedules, hosts } from '../db/schema.js';
import { validTimeZone } from '../docker/updates.js';
import type { SftpPool } from '../files/pool.js';
import type { TroubleSink } from '../hosts/stats.js';
import { actor, HttpError, idParam, noContent, parse, requireAuth } from '../http.js';
import { eachLimited, type Jobs } from '../jobs.js';
import { dueAt, nextRun, parseCron, runKey, tryCron } from '../reports/schedule.js';
import { CommandTimeout, exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';

// Commands on a schedule (2.11.0): on chosen hosts, as each host's own user,
// checked once a minute like the reports. Admins make and change them with a
// fresh step-up; sudo only without a password (sudo -n: nobody is there to
// type one); ended after their time limit. Each run per host is kept 30
// days with the end of its output; one that fails or times out raises a
// Host health alert.

const KEEP_MS = 30 * 86_400_000;
const OUTPUT_KEEP = 64 * 1024;
const CATCH_UP_MS = 3600_000;

type Row = typeof commandSchedules.$inferSelect;
type RunRow = typeof commandRuns.$inferSelect;

export class CommandScheduler {
  onTrouble: TroubleSink | null = null;
  jobs: Jobs | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastTick: number | null = null;
  /** Schedules running now: one round at a time each. */
  readonly #running = new Set<number>();

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
  ) {}

  // Every 20 seconds, each minute's run once (runKey): a timer a minute apart drifts and can step over a minute.
  start(): void {
    // A tick that throws (the database busy for a moment) is said; the next one comes all the same.
    this.#timer = setInterval(() => void this.tick().catch((err: Error) => this.ctx.log.warn(`scheduled commands: the schedule check failed: ${err.message}`)), 20_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** The schedules due this minute start (each once per minute, also after a restart); old runs go. */
  async tick(): Promise<void> {
    const now = this.ctx.now();
    const minute = Math.floor(now / 60_000) * 60_000;
    const started = performance.now();
    // Every minute since the last tick, as the reports do (OPS-W-07): a tick that came late (the
    // host slept, the event loop stalled, Burrow restarted at 03:00) skipped that night's run for
    // good. At most an hour back: a backup of the night does not start in the middle of the day.
    const since = Math.max(this.#lastTick ?? now - CATCH_UP_MS, now - CATCH_UP_MS);
    this.#lastTick = Math.max(now, this.#lastTick ?? now);
    const due: Row[] = [];
    for (const s of this.ctx.db.select().from(commandSchedules).where(eq(commandSchedules.enabled, true)).all()) {
      const cron = s.kind === 'cron' ? tryCron(s.cron) : null;
      // Not before it was made or changed: a schedule for 03:00 saved at 03:05 waits for tomorrow.
      const at = dueAt(s, minute, cron) ? minute : nextRun(s, Math.max(since, s.updatedAt) - 60_000);
      if (at === null || at > now) continue;
      const key = runKey(at, s.timeZone);
      // The local minutes claimed lately, not only the last one, as the reports keep them: when the
      // clock goes back an hour, 02:00 comes round again after 02:30 was the last, and ran twice
      // (audit 2026-11-05).
      const claimed = (s.lastRunKey ?? '').split('|').filter(Boolean);
      if (claimed.includes(key)) continue;
      this.ctx.db.update(commandSchedules).set({ lastRunKey: [key, ...claimed].slice(0, 64).join('|') }).where(eq(commandSchedules.id, s.id)).run();
      due.push(s);
    }
    this.ctx.db.delete(commandRuns).where(lt(commandRuns.startedAt, now - KEEP_MS)).run();
    await Promise.all(due.map((s) => this.run(s.id).catch((err: Error) => this.ctx.log.warn({ scheduleId: s.id }, `scheduled command ${s.name}: ${err.message}`))));
    if (due.length) this.jobs?.ran('scheduled-commands', performance.now() - started, null);
  }

  /** One round now: on each of its hosts, a few at a time. Refused while its last round still runs. */
  async run(id: number): Promise<number[]> {
    const s = this.ctx.db.select().from(commandSchedules).where(eq(commandSchedules.id, id)).get();
    if (!s) throw new HttpError(404, 'not_found');
    if (this.#running.has(id)) throw new HttpError(409, 'still_running', 'Its last run has not ended yet.');
    this.#running.add(id);
    try {
      const ids = JSON.parse(s.hostIds) as number[];
      const targets = ids.length ? this.ctx.db.select({ id: hosts.id }).from(hosts).where(inArray(hosts.id, ids)).all() : [];
      this.ctx.db.update(commandSchedules).set({ lastRunAt: this.ctx.now() }).where(eq(commandSchedules.id, id)).run();
      const runIds: number[] = [];
      await eachLimited(targets, 4, async (h) => {
        runIds.push(await this.#onHost(s, h.id));
      });
      return runIds;
    } finally {
      this.#running.delete(id);
    }
  }

  async #onHost(s: Row, hostId: number): Promise<number> {
    const startedAt = this.ctx.now();
    const row = this.ctx.db.insert(commandRuns).values({ scheduleId: s.id, hostId, startedAt }).returning({ id: commandRuns.id }).get();
    let code: number | null = null;
    let timedOut = false;
    let output = '';
    let cut = false;
    let error: string | null = null;
    try {
      // Past the host's own time limit (timeout(1)) by half a minute: a host without timeout is ended from here.
      const r = await this.pool.with(hostId, ({ client }) => exec(client, scheduledScript(s.command, s.timeoutMinutes, shellQuote), s.timeoutMinutes * 60_000 + 30_000, 1 << 20));
      code = r.code;
      timedOut = r.code === TIMED_OUT_CODE;
      output = r.stdout + (r.stderr ? (r.stdout && !r.stdout.endsWith('\n') ? '\n' : '') + r.stderr : '');
      cut = !!r.truncated;
    } catch (err) {
      if (err instanceof CommandTimeout) timedOut = true;
      else error = (err as Error).message;
    }
    if (output.length > OUTPUT_KEEP) {
      output = output.slice(-OUTPUT_KEEP);
      cut = true;
    }
    this.ctx.db.update(commandRuns).set({ endedAt: this.ctx.now(), code: timedOut ? null : code, timedOut, output, cut, error }).where(eq(commandRuns.id, row.id)).run();
    const at = new Date(this.ctx.now()).toISOString();
    const title = timedOut ? `"${s.name}" timed out after ${s.timeoutMinutes} min` : error ? `"${s.name}" could not run: ${error.slice(0, 200)}` : code !== 0 ? `"${s.name}" failed with exit code ${code}` : null;
    if (title) this.onTrouble?.(hostId, { subject: '@scheduled', event: 'scheduled', title }, at);
    return row.id;
  }

  list(): CommandSchedule[] {
    const names = new Map(this.ctx.db.select({ id: hosts.id, name: hosts.name }).from(hosts).all().map((h) => [h.id, h.name]));
    return this.ctx.db
      .select()
      .from(commandSchedules)
      .all()
      .map((s) => {
        // The last run on each of its hosts.
        const last = new Map<number, CommandRunBrief>();
        for (const r of this.ctx.db.select().from(commandRuns).where(eq(commandRuns.scheduleId, s.id)).orderBy(desc(commandRuns.startedAt)).limit(200).all()) if (!last.has(r.hostId)) last.set(r.hostId, brief(r, names));
        const next = s.enabled ? nextRun(s, this.ctx.now()) : null;
        return {
          id: s.id,
          name: s.name,
          command: s.command,
          hostIds: (JSON.parse(s.hostIds) as number[]).filter((id) => names.has(id)),
          enabled: s.enabled,
          kind: s.kind,
          day: s.day,
          time: s.time,
          cron: s.cron,
          timeZone: s.timeZone,
          timeoutMinutes: s.timeoutMinutes,
          lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
          nextRunAt: next ? new Date(next).toISOString() : null,
          last: [...last.values()],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  runs(scheduleId: number): CommandRunBrief[] {
    const names = new Map(this.ctx.db.select({ id: hosts.id, name: hosts.name }).from(hosts).all().map((h) => [h.id, h.name]));
    return this.ctx.db.select().from(commandRuns).where(eq(commandRuns.scheduleId, scheduleId)).orderBy(desc(commandRuns.startedAt), desc(commandRuns.id)).limit(200).all().map((r) => brief(r, names));
  }

  runById(id: number): CommandRun | null {
    const r = this.ctx.db.select().from(commandRuns).where(eq(commandRuns.id, id)).get();
    if (!r) return null;
    const names = new Map(this.ctx.db.select({ id: hosts.id, name: hosts.name }).from(hosts).where(eq(hosts.id, r.hostId)).all().map((h) => [h.id, h.name]));
    return { ...brief(r, names), scheduleId: r.scheduleId, output: r.output, error: r.error, cut: r.cut };
  }
}

function brief(r: RunRow, names: Map<number, string>): CommandRunBrief {
  const ended = r.endedAt !== null;
  return {
    id: r.id,
    hostId: r.hostId,
    hostName: names.get(r.hostId) ?? `#${r.hostId}`,
    startedAt: new Date(r.startedAt).toISOString(),
    endedAt: ended ? new Date(r.endedAt!).toISOString() : null,
    code: r.code,
    ok: ended ? r.code === 0 && !r.timedOut && !r.error : null,
    timedOut: r.timedOut,
  };
}

export function registerCommandScheduleRoutes(app: FastifyInstance, ctx: Ctx, scheduler: CommandScheduler): void {
  const values = (body: unknown) => {
    const b = parse(commandScheduleInput, body);
    if (!validTimeZone(b.timeZone)) throw new HttpError(400, 'invalid_time_zone');
    if (b.kind === 'cron') {
      try {
        parseCron(b.cron ?? '');
      } catch (err) {
        throw new HttpError(400, 'invalid_cron', (err as Error).message);
      }
    }
    const known = new Set(ctx.db.select({ id: hosts.id }).from(hosts).where(inArray(hosts.id, b.hostIds)).all().map((h) => h.id));
    if (b.hostIds.some((id) => !known.has(id))) throw new HttpError(400, 'unknown_host');
    return { name: b.name, command: b.command, hostIds: JSON.stringify(b.hostIds), enabled: b.enabled, kind: b.kind, day: b.day, time: b.time, cron: b.kind === 'cron' ? b.cron : null, timeZone: b.timeZone, timeoutMinutes: b.timeoutMinutes };
  };
  const one = (id: number) => scheduler.list().find((s) => s.id === id);

  // Admins only (the default); a command that will run on hosts by itself is made and changed with a fresh step-up.
  app.get('/api/schedules/commands', async (): Promise<CommandSchedule[]> => scheduler.list());

  app.post('/api/schedules/commands', { config: { stepUp: true } }, async (req) => {
    const v = values(req.body);
    const now = ctx.now();
    const row = ctx.db
      .insert(commandSchedules)
      .values({ ...v, createdBy: requireAuth(req).user.id, createdAt: now, updatedAt: now })
      .returning({ id: commandSchedules.id })
      .get();
    audit(ctx, actor(req), 'command_schedule.create', v.name, { hosts: JSON.parse(v.hostIds) as number[], command: v.command.slice(0, 500) });
    return one(row.id);
  });

  app.put('/api/schedules/commands/:id', { config: { stepUp: true } }, async (req) => {
    const id = idParam(req);
    const v = values(req.body);
    if (!ctx.db.select({ id: commandSchedules.id }).from(commandSchedules).where(eq(commandSchedules.id, id)).get()) throw new HttpError(404, 'not_found');
    ctx.db.update(commandSchedules).set({ ...v, updatedAt: ctx.now() }).where(eq(commandSchedules.id, id)).run();
    audit(ctx, actor(req), 'command_schedule.update', v.name, { enabled: v.enabled, hosts: JSON.parse(v.hostIds) as number[], command: v.command.slice(0, 500) });
    return one(id);
  });

  app.delete('/api/schedules/commands/:id', { config: { stepUp: true } }, async (req, reply) => {
    const id = idParam(req);
    const s = ctx.db.select({ name: commandSchedules.name }).from(commandSchedules).where(eq(commandSchedules.id, id)).get();
    if (!s) throw new HttpError(404, 'not_found');
    ctx.db.delete(commandSchedules).where(eq(commandSchedules.id, id)).run();
    audit(ctx, actor(req), 'command_schedule.delete', s.name);
    return noContent(reply);
  });

  /** A round now, besides the schedule: started, and answered when it has ended on every host. */
  app.post('/api/schedules/commands/:id/run', { config: { stepUp: true } }, async (req) => {
    const id = idParam(req);
    const s = ctx.db.select({ name: commandSchedules.name }).from(commandSchedules).where(eq(commandSchedules.id, id)).get();
    if (!s) throw new HttpError(404, 'not_found');
    audit(ctx, actor(req), 'command_schedule.run', s.name);
    return { runs: await scheduler.run(id) };
  });

  app.get('/api/schedules/commands/:id/runs', async (req): Promise<CommandRunBrief[]> => scheduler.runs(idParam(req)));

  app.get('/api/schedules/commands/runs/:id', async (req): Promise<CommandRun> => {
    const r = scheduler.runById(idParam(req));
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  });
}

