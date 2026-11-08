import { maskText, type LogEvent } from '@burrow/shared';
import { desc, lt, sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { logEvents } from './db/schema.js';

// Burrow's own warnings and errors, kept in the database grouped by kind
// (OPS-W-13): the container's log goes with every deploy. Collected from the
// logger (a pino hook, so every child logger too) and written every few
// seconds, not per line: a storm of one warning is one row and one write.
// Admins read them on Settings -> About.

/** Kept this long after a kind was last seen. */
export const KEEP_LOG_EVENTS_MS = 30 * 86_400_000;
/** At most this many kinds: the ones seen longest ago go first. */
export const MAX_LOG_EVENTS = 500;
const FLUSH_MS = 10_000;
/** Kinds waiting for the next write, at most (a full disk holds them back). */
const MAX_PENDING = 200;
const MAX_TEXT = 500;

/** A request's own line with a 4xx status ("POST /api/x 403 step_up_required"). */
const REFUSED = /^[A-Z]+ \/\S* 4\d\d\b/;

/** pino's numeric levels: warn and up are kept. */
const WARN = 40;

/** The kind of a message: its numbers and long hex left out, so "host 7: timeout after 3000 ms" and "host 12: ..." are one. */
export function kindOf(message: string): string {
  return message
    .replace(/\b[0-9a-f]{12,}\b/gi, '*')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** The text of a pino call: its message, and an error's message after it. */
export function messageOf(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first === 'string') return first;
  if (first instanceof Error) return typeof second === 'string' ? `${second}: ${first.message}` : first.message;
  const obj = (first ?? {}) as { msg?: unknown; err?: { message?: unknown } };
  const msg = typeof second === 'string' ? second : typeof obj.msg === 'string' ? obj.msg : '';
  const err = typeof obj.err?.message === 'string' ? obj.err.message : '';
  return err && !msg.includes(err) ? (msg ? `${msg}: ${err}` : err) : msg;
}

interface Pending {
  level: number;
  count: number;
  firstAt: number;
  lastAt: number;
  example: string;
}

export class LogEvents {
  #ctx: Ctx | null = null;
  readonly #pending = new Map<string, Pending>();
  #timer: NodeJS.Timeout | null = null;

  /** The database to write to: before it is known (the logger comes first), lines wait. */
  attach(ctx: Ctx): void {
    this.#ctx = ctx;
    this.#timer = setInterval(() => this.flush(), FLUSH_MS);
    this.#timer.unref();
  }

  /** The hook for the logger's options: sees every call at warn and up. */
  hooks(): { logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number): void } {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const events = this;
    return {
      logMethod(args, method, level) {
        if (level >= WARN) events.note(level, messageOf(args));
        method.apply(this, args);
      },
    };
  }

  note(level: number, message: string): void {
    // A request refused for what the person asked (403 step-up, 404, a bad field) is how Burrow
    // answers, not a problem of its own: it filled the list (live, 2026-10-22).
    if (!message || REFUSED.test(message)) return;
    const kind = kindOf(message);
    const at = this.#ctx?.now() ?? Date.now();
    const example = maskText(message, { ips: false }).slice(0, MAX_TEXT);
    const was = this.#pending.get(kind);
    if (was) {
      was.count += 1;
      was.lastAt = at;
      was.example = example;
      was.level = Math.max(was.level, level);
    } else if (this.#pending.size < MAX_PENDING) {
      this.#pending.set(kind, { level, count: 1, firstAt: at, lastAt: at, example });
    }
  }

  /** Writes what was collected. A failure (a full disk) keeps it for the next try and is not logged: that would add to it. */
  flush(): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#pending.size) return;
    const rows = [...this.#pending.entries()];
    try {
      ctx.db.transaction((tx) => {
        for (const [kind, p] of rows) {
          tx.insert(logEvents)
            .values({ kind, ...p })
            .onConflictDoUpdate({
              target: logEvents.kind,
              set: { count: sql`${logEvents.count} + ${p.count}`, lastAt: p.lastAt, example: p.example, level: sql`max(${logEvents.level}, ${p.level})` },
            })
            .run();
        }
        const cut = tx.select({ lastAt: logEvents.lastAt }).from(logEvents).orderBy(desc(logEvents.lastAt)).limit(1).offset(MAX_LOG_EVENTS).get();
        if (cut) tx.delete(logEvents).where(sql`${logEvents.lastAt} <= ${cut.lastAt}`).run();
      });
      for (const [kind] of rows) this.#pending.delete(kind);
    } catch {
      // Kept in memory (bounded) until the disk has room again.
    }
  }

  list(limit = 100): LogEvent[] {
    this.flush();
    if (!this.#ctx) return [];
    return this.#ctx.db
      .select()
      .from(logEvents)
      .orderBy(desc(logEvents.lastAt))
      .limit(limit)
      .all()
      .map((r) => ({ kind: r.kind, level: r.level >= 50 ? 'error' : 'warn', count: r.count, firstAt: new Date(r.firstAt).toISOString(), lastAt: new Date(r.lastAt).toISOString(), example: r.example }));
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.flush();
  }
}

/** Kinds not seen for 30 days go (with the other retention). */
export function pruneLogEvents(ctx: Ctx): number {
  return ctx.db.delete(logEvents).where(lt(logEvents.lastAt, ctx.now() - KEEP_LOG_EVENTS_MS)).run().changes;
}
