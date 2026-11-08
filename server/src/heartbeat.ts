import type { Ctx } from './context.js';

// A dead-man switch (2026-11-07): Burrow tells about trouble it can see,
// but not about being down itself. With HEARTBEAT_URL (or Settings ->
// System) it calls that address every five minutes while it runs well; a
// service there (Healthchecks, an Uptime Kuma push monitor) tells you when
// the calls stop: Burrow down, stuck, its disk full, or its host gone.
// Healthchecks and Uptime Kuma both take a plain GET.

export const BEAT_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

export type Beat = 'off' | 'unwell' | 'sent' | 'failed';

export class Heartbeat {
  #timer: NodeJS.Timeout | null = null;
  /** The last failure logged, so one is not logged every five minutes. */
  #told: string | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly deps: { fetch: (url: string, init?: RequestInit) => Promise<Response>; healthy: () => boolean },
  ) {}

  async beat(): Promise<Beat> {
    const url = this.ctx.config.heartbeatUrl;
    if (!url) return 'off';
    // Unwell is silence: the service there then says so.
    if (!this.deps.healthy()) return 'unwell';
    try {
      const res = await this.deps.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      if (this.#told) this.ctx.log.info('heartbeat: calls go through again');
      this.#told = null;
      return 'sent';
    } catch (err) {
      const message = (err as Error).message;
      if (this.#told !== message) this.ctx.log.warn(`heartbeat: calling the heartbeat address failed: ${message}`);
      this.#told = message;
      return 'failed';
    }
  }

  start(): void {
    void this.beat();
    this.#timer = setInterval(() => void this.beat(), BEAT_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
