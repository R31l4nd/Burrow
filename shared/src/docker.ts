// Containers and their logs (phase 6): what the server reads from each
// host's Docker (over SSH, with the docker CLI) and what the pages show.

import { z } from 'zod';

export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  /** The image the container runs (sha256:...), which the tag may no longer point to. */
  imageId: string;
  state: ContainerState;
  /** healthy / unhealthy / starting, or null without a healthcheck. */
  health: string | null;
  restarts: number;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number;
  oomKilled: boolean;
  createdAt: string;
  /** Compose project (the stack) and service, from the compose labels. */
  project: string | null;
  service: string | null;
  /** The compose file(s) the stack was started from. */
  configFiles: string | null;
  /** The compose project's directory. */
  workingDir: string | null;
  /** Label burrow.ignore=true: no alerts, update checks or reports (still listed). */
  ignored?: boolean;
  /** Labels burrow.tag.include / burrow.tag.exclude: which tags count as a newer version. */
  tagInclude?: string | null;
  tagExclude?: string | null;
  /** Label burrow.update=manual: checked and told, never updated by itself. */
  updateManual?: boolean;
  /** The version the image says it is (its org.opencontainers.image.version label); null when it does not say. */
  version?: string | null;
  /** The container Burrow itself runs in: never stopped or removed from Burrow. */
  self?: boolean;
}

/** A container with this label set to "true" is left out of alerts, update checks and reports. */
export const IGNORE_LABEL = 'burrow.ignore';

export interface ContainerStats {
  /** Percent of one CPU (can exceed 100 on several cores), as docker stats shows it. */
  cpu: number;
  memBytes: number;
  memLimitBytes: number;
  /** false: the host does not measure memory (docker stats says 0B / 0B); shown as unknown, not 0. */
  memKnown?: false;
}

/** Recent samples for the sparklines, oldest first; one per poll. */
/** One kept sample of a container (every few minutes, a month back). */
export interface ContainerSample {
  at: string;
  cpu: number;
  memBytes: number;
}

export interface StatsHistory {
  at: number[];
  cpu: number[];
  mem: number[];
}

export interface HostContainers {
  hostId: number;
  hostName: string;
  containers: ContainerInfo[];
  stats: Record<string, ContainerStats>;
  history: Record<string, StatsHistory>;
  /** Why the host could not be read, if it could not. */
  error: string | null;
  at: string;
}

/**
 * host: a whole snapshot (the first of a watch); delta: what changed since the
 * one before on this socket (OPS-W-03); hosts-changed: hosts or groups were
 * changed (here or on another device), the list is to be read again (W-FUNC-09).
 */
export type DockerServerMessage = { t: 'host'; host: HostContainers } | { t: 'delta'; d: DockerDelta } | { t: 'hosts'; hostIds: number[] } | { t: 'hosts-changed' };

/** What a page sends on /api/docker/ws: the hosts it shows (the server watches at most 50). */
export const dockerClientMessage = z.object({ t: z.literal('watch'), hostIds: z.array(z.number().int().positive()).max(1000) });
export type DockerClientMessage = z.infer<typeof dockerClientMessage>;

// ---- the overview's changes (decision 19, OPS-W-03)
//
// A host's whole snapshot with an hour of sparkline history went to every
// viewer every 5 s: about 500 KB a message for 500 containers. After the
// first snapshot only what changed goes out; the history grows on both
// sides by the same rule from each stats sample.

/** The live sparkline points kept beyond the stored ones, and the span shown. */
export const HISTORY_POINTS = 60;
export const HISTORY_SPAN_MS = 3_600_000;

export interface DockerDelta {
  hostId: number;
  hostName: string;
  at: string;
  error: string | null;
  /** Containers new or changed since the message before. */
  changed?: ContainerInfo[];
  /** Ids of containers gone. */
  removed?: string[];
  /** Every container id in order, when the order or the set changed. */
  order?: string[];
  /** A new stats sample (every few polls), taken at sampleAt: the sparklines grow by it. */
  stats?: Record<string, ContainerStats>;
  sampleAt?: number;
}

/** Adds a stats sample to the sparklines (in place), keeping the last hour and at most a few minutes of live points beyond the kept ones. */
export function addSample(history: Record<string, StatsHistory>, stats: Record<string, ContainerStats>, at: number): void {
  for (const [id, st] of Object.entries(stats)) {
    const h = (history[id] ??= { at: [], cpu: [], mem: [] });
    h.at.push(at);
    h.cpu.push(Math.round(st.cpu * 100) / 100);
    h.mem.push(st.memBytes);
    while (h.at.length > 1 && (at - h.at[0]! > HISTORY_SPAN_MS || h.at.length > HISTORY_POINTS + 12)) {
      h.at.shift();
      h.cpu.shift();
      h.mem.shift();
    }
  }
}

const sameContainer = (a: ContainerInfo, b: ContainerInfo) => JSON.stringify(a) === JSON.stringify(b);

/** What changed from one snapshot to the next; sampleAt when next carries a new stats sample. */
export function dockerDelta(prev: HostContainers, next: HostContainers, sampleAt: number | null): DockerDelta {
  const d: DockerDelta = { hostId: next.hostId, hostName: next.hostName, at: next.at, error: next.error };
  const before = new Map(prev.containers.map((c) => [c.id, c]));
  const changed = next.containers.filter((c) => {
    const b = before.get(c.id);
    return !b || !sameContainer(b, c);
  });
  const ids = new Set(next.containers.map((c) => c.id));
  const removed = prev.containers.filter((c) => !ids.has(c.id)).map((c) => c.id);
  if (changed.length) d.changed = changed;
  if (removed.length) d.removed = removed;
  const order = next.containers.map((c) => c.id);
  if (order.length !== prev.containers.length || order.some((id, i) => prev.containers[i]!.id !== id)) d.order = order;
  if (sampleAt !== null) {
    d.stats = next.stats;
    d.sampleAt = sampleAt;
  }
  return d;
}

/** A snapshot with a delta applied: a new object, the one given left as it was. */
export function applyDockerDelta(base: HostContainers, d: DockerDelta): HostContainers {
  const byId = new Map(base.containers.map((c) => [c.id, c]));
  for (const id of d.removed ?? []) byId.delete(id);
  for (const c of d.changed ?? []) byId.set(c.id, c);
  const order = d.order ?? base.containers.map((c) => c.id);
  const containers = order.map((id) => byId.get(id)).filter((c): c is ContainerInfo => !!c);
  const history: Record<string, StatsHistory> = {};
  for (const [id, h] of Object.entries(base.history)) history[id] = { at: [...h.at], cpu: [...h.cpu], mem: [...h.mem] };
  let stats = base.stats;
  if (d.stats && d.sampleAt !== undefined) {
    stats = d.stats;
    addSample(history, d.stats, d.sampleAt);
  }
  // Containers that are gone are forgotten, as on the server.
  const live = new Set(containers.map((c) => c.id));
  for (const id of Object.keys(history)) if (!live.has(id)) delete history[id];
  return { hostId: d.hostId, hostName: d.hostName, containers, stats, history, error: d.error, at: d.at };
}

// ---- logs

export interface LogTarget {
  hostId: number;
  /** The container; empty for a file on the host itself. */
  container: string;
  /** A log file (absolute path) instead of the container's own output; see logfiles.ts. */
  file?: string | null;
}

/** One log line as the server sends it. i: index into the targets; s: stdout (o) or stderr (e). */
export interface LogLine {
  i: number;
  s: 'o' | 'e';
  /** Docker's RFC 3339 timestamp (nanoseconds), as sent: sorts as text. */
  ts: string;
  text: string;
  /** No time of its own (a plain log file's line, none before it): ts is when it was read. */
  undated?: true;
}

export type LogServerMessage =
  | { t: 'lines'; lines: LogLine[] }
  | { t: 'end'; i: number }
  /** A log file that is a link to its container's own output: nothing of its own to read (report 71d6c5). */
  | { t: 'output'; i: number }
  | { t: 'error'; i: number; message: string };

export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** A compose project (a stack) as Docker Compose names it: lowercase letters, digits, dashes and underscores. */
export const STACK_PROJECT = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

const WORDS: [RegExp, LogLevel][] = [
  [/^(fatal|panic|crit|critical|emerg|emergency|alert)$/i, 'fatal'],
  [/^(error|err|eror|severe)$/i, 'error'],
  [/^(warn|warning|wrn)$/i, 'warn'],
  [/^(info|inf|notice|information)$/i, 'info'],
  [/^(debug|dbg)$/i, 'debug'],
  [/^(trace|trc|verbose)$/i, 'trace'],
];

function levelWord(w: unknown): LogLevel | null {
  if (typeof w === 'number') {
    // pino / bunyan numbers.
    if (w >= 60) return 'fatal';
    if (w >= 50) return 'error';
    if (w >= 40) return 'warn';
    if (w >= 30) return 'info';
    if (w >= 20) return 'debug';
    return 'trace';
  }
  if (typeof w !== 'string') return null;
  for (const [re, l] of WORDS) if (re.test(w.trim())) return l;
  return null;
}

/** The line as JSON when it is a JSON object, else null. */
export function parseJsonLine(text: string): Record<string, unknown> | null {
  const s = text.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * The level of a log line, from JSON (level, lvl, severity, log.level;
 * pino numbers) or from a level word early in the text ("ERROR", "[warn]",
 * "level=info", "W0927"-style is not guessed). Null when there is no sign.
 */
export function detectLevel(text: string, json: Record<string, unknown> | null = parseJsonLine(text)): LogLevel | null {
  if (json) {
    for (const k of ['level', 'lvl', 'severity', 'loglevel', 'log.level', '@l']) {
      // ECS writes "log.level" as one key; others nest it as {log: {level}}.
      const v = k === 'log.level' ? (json[k] ?? (json.log as Record<string, unknown> | undefined)?.level) : json[k];
      const l = levelWord(v);
      if (l) return l;
    }
  }
  const head = text.replace(ANSI, '').slice(0, 120);
  const kv = /\b(?:level|lvl|severity)=["']?([a-zA-Z]+)/.exec(head);
  if (kv) return levelWord(kv[1]);
  for (const m of head.matchAll(/[A-Za-z]+/g)) {
    const w = m[0];
    // Only as a word of its own that looks like a tag: upper case, or in brackets/followed by ':'.
    const before = head[m.index - 1];
    const after = head[m.index + w.length];
    const tagged = w === w.toUpperCase() || before === '[' || before === '<' || after === ':' || after === ']';
    if (!tagged || w.length < 3) continue;
    const l = levelWord(w);
    if (l) return l;
  }
  return null;
}

/** Splits Docker's "2026-09-27T07:40:04.550926770Z message" (docker logs -t). */
export function splitTimestamp(line: string): { ts: string; text: string } | null {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) ?(.*)$/s.exec(line);
  return m ? { ts: m[1]!, text: m[2]! } : null;
}

/** Nanosecond timestamps as fixed-width text, so they sort (and merge) as strings. */
export function sortKey(ts: string): string {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(ts);
  if (!m || m[3] !== 'Z') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : `${d.toISOString().slice(0, 19)}.${String(d.getMilliseconds()).padStart(3, '0')}000000Z`;
  }
  return `${m[1]}.${(m[2] ?? '').padEnd(9, '0').slice(0, 9)}Z`;
}

/** Index to insert a key into a sorted array of keys (after equal ones: arrival order is kept). */
export function insertionIndex(keys: string[], key: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
