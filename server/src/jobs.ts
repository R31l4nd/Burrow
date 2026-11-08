import type { BackgroundJob } from '@burrow/shared';
import type { Ctx } from './context.js';

// What the background jobs did (OPS-W-14): container history, host
// statistics, reports, alerts, housekeeping ... ran silently, and their
// failures went to debug, so whether they ran could not be told from the
// log or the API. Each says here when it last ran, how long it took, and
// its last failure; admins read it on Settings -> About. A failure is
// logged at warn once per change of its message, its recovery at info.

export class Jobs {
  readonly #jobs = new Map<string, BackgroundJob>();
  /** Per job and subject (a host), the failure last logged. */
  readonly #told = new Map<string, string>();

  constructor(private readonly ctx: Ctx) {}

  /** A run of a job ended: how long it took, and what failed in it (null: nothing). */
  ran(name: BackgroundJob['name'], ms: number, error: string | null = null): void {
    const was = this.#jobs.get(name);
    const at = new Date(this.ctx.now()).toISOString();
    this.#jobs.set(name, {
      name,
      lastRunAt: at,
      ms: Math.round(ms),
      runs: (was?.runs ?? 0) + 1,
      lastError: error ?? (was?.lastError ?? null),
      lastErrorAt: error ? at : (was?.lastErrorAt ?? null),
      ok: error === null,
    });
  }

  /** One subject of a job failed (a host that could not be read): logged at warn when it is news. */
  failed(name: string, subject: string, message: string, fields: Record<string, unknown> = {}): void {
    const key = `${name} ${subject}`;
    if (this.#told.get(key) === message) return;
    this.#told.set(key, message);
    this.ctx.log.warn(fields, `${name}: ${subject}: ${message}`);
  }

  /** That subject is well again: said once. */
  fine(name: string, subject: string, fields: Record<string, unknown> = {}): void {
    const key = `${name} ${subject}`;
    if (!this.#told.has(key)) return;
    this.#told.delete(key);
    this.ctx.log.info(fields, `${name}: ${subject}: fine again`);
  }

  list(): BackgroundJob[] {
    return [...this.#jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Runs fn over items, at most `limit` at a time; one slow or hung item does not hold up the others. */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
