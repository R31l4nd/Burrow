import { addSample, dockerDelta, type ContainerStats, type DockerDelta, type HostContainers, type StatsHistory } from '@burrow/shared';
import type { Ctx } from '../context.js';
import type { SftpPool } from '../files/pool.js';
import { getHost } from '../hosts/service.js';
import { exec } from '../ssh/connect.js';
import { EXIT_NO_STATS, MONITOR_COMMAND, parseMonitor, STATE_COMMAND } from './parse.js';
import { markSelf } from './stacks.js';

// Polls the containers of the hosts someone is looking at, and only those:
// one SSH command per host every few seconds (docker stats itself takes
// about two to sample). Keeps a few minutes of CPU and memory per container
// for the sparklines, so a new viewer sees them filled at once.

const INTERVAL_MS = 5000;
/** A stats sample every this many polls (every 15 s). */
const STATS_EVERY = 3;
// The list's sparklines: the last hour, the kept samples first (report 428102), then the live ones (shared addSample).
// A host nobody watches any more stops being polled after this.
const LINGER_MS = 30_000;

/** A snapshot, and what changed since the one before (null: the first one this listener gets, sent whole). */
type Listener = (h: HostContainers, delta: DockerDelta | null) => void;

interface HostState {
  listeners: Set<Listener>;
  last: HostContainers | null;
  history: Record<string, StatsHistory>;
  timer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
  running: boolean;
  polls: number;
}

export class DockerMonitor {
  readonly #hosts = new Map<number, HostState>();
  /** A host's kept samples by container name, to start a new watch's sparklines with. */
  seed: ((hostId: number) => Map<string, StatsHistory>) | null = null;
  readonly #hostListeners = new Set<() => void>();

  /** Told when hosts or groups change, from any device (W-FUNC-09); returns the way to stop. */
  onHostsChanged(fn: () => void): () => void {
    this.#hostListeners.add(fn);
    return () => this.#hostListeners.delete(fn);
  }

  hostsChanged(): void {
    for (const fn of this.#hostListeners) fn();
  }

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
    private readonly intervalMs = INTERVAL_MS,
  ) {}

  /** Start receiving a host's containers; returns the way to stop. */
  watch(hostId: number, fn: Listener): () => void {
    let st = this.#hosts.get(hostId);
    if (!st) {
      st = { listeners: new Set(), last: null, history: {}, timer: null, stopTimer: null, running: false, polls: 0 };
      this.#hosts.set(hostId, st);
    }
    const s = st;
    if (s.stopTimer) clearTimeout(s.stopTimer);
    s.stopTimer = null;
    s.listeners.add(fn);
    if (s.last) fn(s.last, null);
    if (!s.running) {
      s.running = true;
      this.ctx.log.info({ hostId }, 'docker: watching host containers');
      void this.#loop(hostId, s);
    }
    return () => {
      s.listeners.delete(fn);
      if (s.listeners.size === 0 && !s.stopTimer) {
        s.stopTimer = setTimeout(() => {
          this.ctx.log.info({ hostId }, 'docker: stopped watching (nobody looking)');
          s.running = false;
          if (s.timer) clearTimeout(s.timer);
          this.#hosts.delete(hostId);
        }, LINGER_MS);
        s.stopTimer.unref();
      }
    };
  }

  /** What a host's containers were at most [maxAgeMs] ago (someone watches it), else a poll now. `background`: a job of Burrow's own, which waits out failing connects (audit 2026-11-09). */
  async recent(hostId: number, maxAgeMs = 30_000, withStats = true, background = false): Promise<HostContainers> {
    const last = this.#hosts.get(hostId)?.last;
    if (last && !last.error && this.ctx.now() - Date.parse(last.at) <= maxAgeMs) return last;
    return this.poll(hostId, withStats, background);
  }

  /** One poll now, without watching (tests, and hosts shown once). */
  /** `background`: the watch's own round, which waits out a host whose connects fail (the pool's backoff). */
  async poll(hostId: number, withStats = true, background = false): Promise<HostContainers> {
    const hostName = (() => {
      try {
        return getHost(this.ctx, hostId).name;
      } catch {
        return String(hostId);
      }
    })();
    const at = new Date(this.ctx.now()).toISOString();
    try {
      const r = await this.pool.with(hostId, ({ client }) => exec(client, withStats ? MONITOR_COMMAND : STATE_COMMAND, 30_000, 4 << 20), { background });
      // Cut off: not all containers (a half list read as "these are all"; AUDIT2 DO-13).
      if (r.truncated) return { hostId, hostName, containers: [], stats: {}, history: {}, error: "docker's answer was larger than Burrow reads (4 MB)", at };
      // Failed is not empty: a host whose docker cannot be read has no "no containers".
      if (r.code !== 0 && r.code !== EXIT_NO_STATS) {
        const msg = (r.stderr || r.stdout).trim().split('\n').pop() || `docker exited with ${r.code}`;
        this.ctx.log.warn({ hostId }, `docker: cannot read containers on ${hostName}: ${msg}`);
        return { hostId, hostName, containers: [], stats: {}, history: {}, error: msg, at };
      }
      const { containers: all, stats } = parseMonitor(r.stdout, this.ctx.config.ignoreLabel);
      const containers = markSelf(all);
      return { hostId, hostName, containers, stats: Object.fromEntries(stats) as Record<string, ContainerStats>, history: {}, error: null, at };
    } catch (err) {
      return { hostId, hostName, containers: [], stats: {}, history: {}, error: (err as Error).message, at };
    }
  }

  async #loop(hostId: number, s: HostState): Promise<void> {
    if (!s.running) return;
    // Whatever throws in one round (a listener, the kept samples) is said and the next round comes:
    // a throw here ended this host's polling for good while it still read as watched.
    try {
      await this.#round(hostId, s);
    } catch (err) {
      this.ctx.log.warn({ hostId }, `docker: a poll round failed: ${(err as Error).message}`);
    }
    if (!s.running) return;
    s.timer = setTimeout(() => void this.#loop(hostId, s), this.intervalMs);
    s.timer.unref();
  }

  async #round(hostId: number, s: HostState): Promise<void> {
    // State every poll, CPU and memory every STATS_EVERY polls (the rest
    // carry the last sample on).
    const withStats = (s.polls++ % STATS_EVERY) === 0;
    // The first round of a watch is for whoever opened the page: it tries at once, an old failure
    // held it back for up to half an hour after the host was up again (audit 2026-11-09).
    const h = await this.poll(hostId, withStats, s.polls > 1);
    if (!withStats && s.last) h.stats = s.last.stats;
    const now = this.ctx.now();
    // A watch just started: the kept hour first, so the list is not empty at every visit.
    const kept = withStats && s.polls === 1 ? (this.seed?.(hostId) ?? null) : null;
    const names = new Map(h.containers.map((c) => [c.id, c.name]));
    if (withStats) {
      // A container new to the watch starts with its kept samples, if any.
      for (const id of Object.keys(h.stats)) {
        const k = s.history[id] ? undefined : kept?.get(names.get(id) ?? '');
        if (k) s.history[id] = { at: [...k.at], cpu: [...k.cpu], mem: [...k.mem] };
      }
      addSample(s.history, h.stats, now);
    }
    // Forget containers that are gone; a poll that failed says nothing about that (one SSH hiccup kept every chart).
    if (h.error === null) {
      const ids = new Set(h.containers.map((c) => c.id));
      for (const id of Object.keys(s.history)) if (!ids.has(id)) delete s.history[id];
    }
    // A copy: the next poll grows s.history, while this snapshot may still be on its way.
    h.history = Object.fromEntries(Object.entries(s.history).map(([id, x]) => [id, { at: [...x.at], cpu: [...x.cpu], mem: [...x.mem] }]));
    // Every poll goes out, a small delta when nothing changed: a viewer can tell a host that stopped answering (OPS-W-04).
    const delta = s.last ? dockerDelta(s.last, h, withStats ? now : null) : null;
    s.last = h;
    // One listener that throws (a socket gone) keeps it from none of the others.
    for (const fn of s.listeners) {
      try {
        fn(h, delta);
      } catch (err) {
        this.ctx.log.warn({ hostId }, `docker: a viewer of the containers failed: ${(err as Error).message}`);
      }
    }
  }

  stop(): void {
    for (const s of this.#hosts.values()) {
      s.running = false;
      if (s.timer) clearTimeout(s.timer);
      if (s.stopTimer) clearTimeout(s.stopTimer);
    }
    this.#hosts.clear();
  }
}
