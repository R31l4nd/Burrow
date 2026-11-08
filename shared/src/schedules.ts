import { z } from 'zod';
import type { ScheduleKind } from './reports.js';

// A command that runs by itself on a schedule (2.11.0), on chosen hosts, as
// each host's own user: a backup, a clean-up, a check. Admins make and change
// them, with a fresh step-up; sudo works only where it needs no password
// (sudo -n), as nobody is there to type one. Each run's output is kept 30
// days; a run that fails or times out raises a Host health alert.

export interface CommandSchedule {
  id: number;
  name: string;
  command: string;
  hostIds: number[];
  enabled: boolean;
  kind: ScheduleKind;
  /** weekly: 0 (Sunday) ... 6. */
  day: number;
  /** weekly/daily: "HH:MM". */
  time: string;
  cron: string | null;
  timeZone: string;
  timeoutMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** How the last run went on each host, newest first. */
  last: CommandRunBrief[];
}

export interface CommandRunBrief {
  id: number;
  hostId: number;
  hostName: string;
  startedAt: string;
  /** null while it runs. */
  endedAt: string | null;
  /** The command's exit code; null when it did not end by itself (timed out, the host not reached). */
  code: number | null;
  ok: boolean | null;
  timedOut: boolean;
}

export interface CommandRun extends CommandRunBrief {
  scheduleId: number;
  output: string;
  /** Why it could not run at all (the host not reached), or null. */
  error: string | null;
  /** The output was longer than kept (64 KB): its end is kept. */
  cut: boolean;
}

export const TIMEOUT_MAX_MINUTES = 24 * 60;

export const commandScheduleInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    command: z.string().trim().min(1, 'Enter a command.').max(10_000),
    hostIds: z.array(z.number().int().positive()).min(1, 'Choose at least one host.').max(100),
    enabled: z.boolean(),
    kind: z.enum(['weekly', 'daily', 'cron']),
    day: z.number().int().min(0).max(6).default(1),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('03:00'),
    cron: z.string().trim().max(100).nullable().default(null),
    timeZone: z.string().min(1).max(64),
    timeoutMinutes: z.number().int().min(1).max(TIMEOUT_MAX_MINUTES).default(10),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'cron' && !s.cron) ctx.addIssue({ code: 'custom', message: 'Enter a cron expression.', path: ['cron'] });
  });
export type CommandScheduleInput = z.infer<typeof commandScheduleInput>;

/** The script a host runs: sudo without a password only, the person's command in bash (else sh), ended after the time limit. */
export function scheduledScript(command: string, timeoutMinutes: number, quote: (s: string) => string): string {
  const body = `sudo() { command sudo -n "$@"; }\n${command}`;
  const secs = Math.max(1, Math.round(timeoutMinutes * 60));
  return [
    `s=$(command -v bash || command -v sh)`,
    `if command -v timeout >/dev/null 2>&1; then exec timeout -k 10 ${secs} "$s" -c ${quote(body)}; else exec "$s" -c ${quote(body)}; fi`,
  ].join('\n');
}

/** timeout(1) exits with 124 when it ended the command. */
export const TIMED_OUT_CODE = 124;
