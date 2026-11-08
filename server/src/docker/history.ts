import type { ContainerSample, HostContainers, StatsHistory } from '@burrow/shared';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { containerSamples, hosts } from '../db/schema.js';
import { eachLimited, type Jobs } from '../jobs.js';

// Every container's CPU and memory every five minutes, kept a month, on
// every host with Docker (report 428102: the sparklines started over at each
// visit and knew only the minutes the page had been open). Kept by name: a
// container made again by an update keeps its history. A host that could
// not be read adds nothing, not zeros. As Beszel keeps its container charts.

const SAMPLE_MS = 5 * 60_000;
const KEEP_MS = 31 * 86_400_000;
// Every five minutes for two days, then one average an hour (OPS-W-06): a
// month of 5-minute samples was 8928 rows a container, 4.4 million at 500
// containers. An hour's average is stored at the hour's first millisecond,
// which tells it from the samples.
const FINE_MS = 2 * 86_400_000;
const HOUR = 3_600_000;
/** Hosts read at once: one that hangs holds up only its own turn. */
const AT_ONCE = 4;
/** Longest a host holds the round (a read is one docker command, timed out well before). */
export const HISTORY_HOST_MS = 2 * 60_000;

export class ContainerHistory {
  #timer: NodeJS.Timeout | null = null;
  #first: NodeJS.Timeout | null = null;
  #busy = false;
  /** Hosts whose sample is under way, maybe still from a round that went on without them. */
  readonly #sampling = new Set<number>();
  #stopped = false;

  constructor(
    private readonly ctx: Ctx,
    /** A host's containers with their stats now (the monitor's, when someone watches it). */
    private readonly read: (hostId: number) => Promise<HostContainers>,
    private readonly jobs: Jobs | null = null,
  ) {}

  /** One sample of a host's containers into the history. A host that could not be read throws (and adds nothing). */
  async sample(hostId: number): Promise<void> {
    const h = await this.read(hostId);
    if (h.error) throw new Error(h.error);
    const at = this.ctx.now();
    const rows = h.containers.flatMap((c) => {
      const st = h.stats[c.id];
      return st && st.memKnown !== false ? [{ hostId, name: c.name, at, cpu: Math.round(st.cpu * 100) / 100, memBytes: Math.round(st.memBytes) }] : [];
    });
    if (rows.length) this.ctx.db.insert(containerSamples).values(rows).run();
  }

  /** One container's samples of the last [sinceMs], oldest first. */
  history(hostId: number, name: string, sinceMs: number): ContainerSample[] {
    return this.ctx.db
      .select()
      .from(containerSamples)
      .where(and(eq(containerSamples.hostId, hostId), eq(containerSamples.name, name), gte(containerSamples.at, this.ctx.now() - sinceMs)))
      .orderBy(containerSamples.at)
      .all()
      .map((s) => ({ at: new Date(s.at).toISOString(), cpu: s.cpu, memBytes: s.memBytes }));
  }

  /** Every container's samples of the last [sinceMs] on a host, by name: what the list starts with. */
  recent(hostId: number, sinceMs: number): Map<string, StatsHistory> {
    const out = new Map<string, StatsHistory>();
    const rows = this.ctx.db
      .select()
      .from(containerSamples)
      .where(and(eq(containerSamples.hostId, hostId), gte(containerSamples.at, this.ctx.now() - sinceMs)))
      .orderBy(containerSamples.at)
      .all();
    for (const r of rows) {
      let h = out.get(r.name);
      if (!h) out.set(r.name, (h = { at: [], cpu: [], mem: [] }));
      h.at.push(r.at);
      h.cpu.push(r.cpu);
      h.mem.push(r.memBytes);
    }
    return out;
  }

  start(): void {
    this.#stopped = false;
    this.#timer = setInterval(() => void this.tick(), SAMPLE_MS);
    this.#timer.unref();
    this.#first = setTimeout(() => void this.tick(), 90_000);
    this.#first.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
  }

  /** Samples older than two days as one average an hour, a whole hour at a time (OPS-W-06). */
  downsample(): number {
    const cutoff = Math.floor((this.ctx.now() - FINE_MS) / HOUR) * HOUR;
    // The hour as a literal: a bound number is a REAL to SQLite, and its division no whole hour.
    const hour = sql.raw(String(HOUR));
    return this.ctx.db.transaction((tx) => {
      tx.run(sql`INSERT INTO container_samples (host_id, name, at, cpu, mem_bytes)
        SELECT host_id, name, (at / ${hour}) * ${hour}, ROUND(AVG(cpu), 2), CAST(AVG(mem_bytes) AS INTEGER) FROM container_samples
        WHERE at < ${cutoff} AND at % ${hour} != 0 GROUP BY host_id, name, at / ${hour}`);
      return tx.run(sql`DELETE FROM container_samples WHERE at < ${cutoff} AND at % ${hour} != 0`).changes;
    });
  }

  /** Every host with Docker, a few at a time; then older samples thinned, and what is older than a month goes. */
  async tick(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    this.#busy = true;
    const started = performance.now();
    let failure: string | null = null;
    try {
      const withDocker = this.ctx.db
        .select()
        .from(hosts)
        .all()
        .filter((h) => {
          try {
            return !!h.facts && (JSON.parse(h.facts) as { hasDocker?: boolean }).hasDocker === true;
          } catch {
            return false;
          }
        });
      await eachLimited(
        withDocker,
        AT_ONCE,
        async (h) => {
          // Still at it from a round before (a host that hangs): not asked again on top.
          if (this.#sampling.has(h.id)) return;
          this.#sampling.add(h.id);
          await this.sample(h.id).then(
            () => this.jobs?.fine('container history', h.name, { hostId: h.id }),
            (err: Error) => {
              // Said once per host and message, at warn: at debug nobody saw it (OPS-W-14).
              failure ??= `${h.name}: ${err.message}`;
              this.jobs?.failed('container history', h.name, err.message, { hostId: h.id });
            },
          );
          this.#sampling.delete(h.id);
        },
        () => this.#stopped,
        // A host that does not answer in time no longer holds the round: the others are sampled again next time.
        {
          itemMs: HISTORY_HOST_MS,
          late: (h) => {
            const msg = `no answer in ${HISTORY_HOST_MS / 60_000} min`;
            failure ??= `${h.name}: ${msg}`;
            this.jobs?.failed('container history', h.name, msg, { hostId: h.id });
          },
        },
      );
      if (this.#stopped) return;
      this.downsample();
      this.ctx.db.delete(containerSamples).where(lt(containerSamples.at, this.ctx.now() - KEEP_MS)).run();
    } finally {
      this.#busy = false;
      if (!this.#stopped) this.jobs?.ran('container-history', performance.now() - started, failure);
    }
  }
}
