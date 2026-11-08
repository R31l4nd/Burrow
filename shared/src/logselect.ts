import { z } from 'zod';
import { LOG_LEVELS, type LogLevel } from './docker.js';
import { MAX_SOURCE_SUBJECT } from './logfiles.js';

// Which log lines, of which containers, are read: one small system for the
// reports, the analysis and the log view. A default rule for everything, and
// rules for a host, a stack or a container that differ from it (the most
// specific one wins: container, then stack, then host). Each rule says how
// far back (the last N lines, since the container started, the last hours,
// since the last report) and which levels; or that the target is skipped.

export const LOG_WINDOWS = ['since_last', 'lines', 'hours', 'since_start'] as const;

export const logWindow = z.object({
  kind: z.enum(LOG_WINDOWS),
  /** lines: how many; hours: how many. */
  n: z.number().int().min(1).max(100_000).default(500),
});
export type LogWindow = z.infer<typeof logWindow>;

export const LEVEL_PICKS = [...LOG_LEVELS, 'none'] as const;
export type LevelPick = LogLevel | 'none';

export const logSelTarget = z.object({
  hostId: z.number().int().positive().nullable().default(null),
  /** A compose stack (project), or null. */
  project: z.string().max(128).nullable().default(null),
  /** A container, or a log file (":<encoded path>" of the host, "web:<encoded path>" of a container). */
  container: z.string().max(MAX_SOURCE_SUBJECT).nullable().default(null),
});
export type LogSelTarget = z.infer<typeof logSelTarget>;

export const logRule = z.object({
  /** null: the default rule, for everything no other rule matches. */
  target: logSelTarget.nullable(),
  window: logWindow,
  levels: z.array(z.enum(LEVEL_PICKS)).min(1).max(LEVEL_PICKS.length),
  /** This target is left out altogether. */
  skip: z.boolean().default(false),
});
export type LogRule = z.infer<typeof logRule>;

export const logSelection = z.object({ rules: z.array(logRule).min(1).max(100) });
export type LogSelection = z.infer<typeof logSelection>;

/** Errors and warnings since the last report, of everything: the simple start. */
export const DEFAULT_SELECTION: LogSelection = {
  rules: [{ target: null, window: { kind: 'since_last', n: 500 }, levels: ['fatal', 'error', 'warn'], skip: false }],
};

// A stack or container named on one host is more specific than the same name on any host.
const specificity = (t: LogSelTarget | null) => (t === null ? 0 : (t.container ? 3 : t.project ? 2 : t.hostId ? 1 : 0) + (t.hostId && (t.container || t.project) ? 0.5 : 0));

/** The rule for one container: the most specific that matches, else the default. */
export function ruleFor(sel: LogSelection, hostId: number, project: string | null, container: string): LogRule {
  const matches = sel.rules.filter((r) => {
    const t = r.target;
    if (t === null) return true;
    if (t.hostId && t.hostId !== hostId) return false;
    if (t.project && t.project !== project) return false;
    if (t.container && t.container !== container) return false;
    return true;
  });
  return matches.sort((a, b) => specificity(b.target) - specificity(a.target))[0] ?? DEFAULT_SELECTION.rules[0]!;
}

/**
 * The part of `docker logs` a window asks for: --since (seconds since the
 * epoch) and/or --tail. `lastRun` is the previous report's end, `started`
 * the container's start, both in ms; `now` in ms.
 */
export function windowArgs(w: LogWindow, times: { now: number; lastRun: number | null; started: number | null; fallbackMs: number }): { since: number | null; tail: number | null } {
  switch (w.kind) {
    case 'lines':
      return { since: null, tail: w.n };
    case 'hours':
      return { since: times.now - w.n * 3_600_000, tail: null };
    case 'since_start':
      return { since: times.started, tail: null };
    default:
      return { since: times.lastRun ?? times.now - times.fallbackMs, tail: null };
  }
}

/** Whether a line of this level is kept (a line without a level: 'none'). */
export const keepLevel = (levels: LevelPick[], level: LogLevel | null): boolean => levels.includes(level ?? 'none');
