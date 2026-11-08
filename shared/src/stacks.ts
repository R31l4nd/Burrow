import type { ReleaseFlags } from './breaking.js';
import { z } from 'zod';

// Phase 8: managing containers and compose stacks over SSH, image update
// checks against the registries, and opt-in automatic updates with rollback.

export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove';
export const CONTAINER_ACTIONS: ContainerAction[] = ['start', 'stop', 'restart', 'remove'];

/** Operations on a whole stack; each runs `docker compose` on the host. */
export type StackOp = 'up' | 'pull' | 'update' | 'restart' | 'down';
export const STACK_OPS: StackOp[] = ['up', 'pull', 'update', 'restart', 'down'];

export const stackOpInput = z.object({
  op: z.enum(STACK_OPS as [StackOp, ...StackOp[]]),
  /**
   * Only these services (update: the ones with a newer image). Left out:
   * the default. Given, it is at least one: an empty list meant all of them
   * (AUDIT2 DO-22).
   */
  services: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)).min(1).max(100).optional(),
});

/** A compose operation running (or finished) on a host. */
export interface OpInfo {
  id: string;
  hostId: number;
  project: string;
  op: StackOp | 'rollback';
  startedAt: string;
  /** null while running. */
  exitCode: number | null;
}

/**
 * How an operation ended beyond its exit code: rolled back (the previous
 * version runs again, W-FUNC-10), or done but not running well with nothing
 * to put back.
 */
export interface OpOutcome {
  kind: 'rolled_back' | 'not_well';
  why: string;
}

export type OpServerMessage = { t: 'output'; d: string } | { t: 'exit'; code: number; outcome?: OpOutcome } | { t: 'error'; message: string };

export interface StackService {
  service: string;
  container: string;
  image: string;
  state: string;
}

export interface StackInfo {
  hostId: number;
  project: string;
  /** Compose files the stack was started from (absolute paths on the host). */
  configFiles: string[];
  workingDir: string | null;
  services: StackService[];
  autoUpdate: boolean;
  /** Burrow runs in this stack: it cannot update itself automatically. */
  self: boolean;
  /** The compose file as Burrow last deployed it, for the diff. */
  deployed: { file: string; content: string; at: string } | null;
  running: OpInfo | null;
  /** Brought down from Burrow (no containers now): since when; null while it has containers. */
  downAt: string | null;
}

/** A stack brought down from Burrow, listed with the containers so it can be brought up again. */
export interface DownStack {
  hostId: number;
  hostName: string;
  project: string;
  downAt: string;
}

export const stackSettingsInput = z.object({ autoUpdate: z.boolean() });

/** Result of `docker compose config` on the stack's files as they are now. */
export interface ComposeCheck {
  ok: boolean;
  output: string;
  /**
   * The whole effective configuration as checked (every compose file, .env,
   * interpolation): a deploy from the review sends it back and runs only if
   * nothing changed since. Null when the check failed.
   */
  digest: string | null;
  /**
   * Services a deploy would recreate or create although the file may not
   * have changed: their configuration (`docker compose config --hash`)
   * differs from what their container runs, or they have none (W-FUNC-04).
   * Absent when it cannot be told.
   */
  recreate?: { service: string; why: 'differs' | 'missing' }[];
}

// ---- image updates

/**
 * current: the registry has the same image.
 * update: the registry has a newer one under the same tag.
 * pinned: the image is fixed to a digest; never outdated.
 * local: built here or never pulled from a registry (no digest to compare).
 * unknown: the registry could not be asked (private, offline, rate limited).
 */
export type ImageStatus = 'current' | 'update' | 'pinned' | 'local' | 'unknown';

export interface ImageCheck {
  hostId: number;
  image: string;
  status: ImageStatus;
  localDigest: string | null;
  remoteDigest: string | null;
  error: string | null;
  /** org.opencontainers.image.source / .version of the image here. */
  source: string | null;
  version: string | null;
  /** A newer version under another tag (shared/src/tags.ts), or null. */
  newerTag: string | null;
  checkedAt: string;
  /** When an update to this very remote digest was rolled back (or failed) here: not tried again by itself (W-FUNC-03). */
  rolledBackAt?: string | null;
}

export interface Release {
  tag: string;
  name: string;
  publishedAt: string | null;
  /** Markdown, shown as text. */
  body: string;
  url: string;
  /** What in it asks for attention before updating (shared/src/breaking.ts). */
  flags: ReleaseFlags;
  /** A release candidate, beta and the like: left out unless the version here is one too (report 0d33eb). */
  prerelease?: boolean;
}

export interface Changelog {
  /** The repository's releases page. */
  url: string;
  /** Newest first: the releases after the version here, or the latest few when that version is not found. */
  releases: Release[];
  /** The version here was found among the releases: all of these are new. */
  matched: boolean;
  /** The version Burrow read for the image here (label, *_VERSION variable or tag), or null when it says none. */
  version?: string | null;
  /** Releases among these with a breaking change or a new major version. */
  breaking: number;
}

export interface UpdateSettings {
  /** The scheduled check runs (and with it the automatic updates). */
  enabled: boolean;
  /** The stacks that opted in are updated in the window (off: check and tell only). */
  autoUpdate: boolean;
  /** When the window opens: every day, one day a week, or by a cron expression. */
  kind: 'daily' | 'weekly' | 'cron';
  /** For weekly: 0 = Sunday. */
  day: number;
  /** For cron: "minute hour day month weekday"; it replaces windowStart. */
  cron: string | null;
  /** The window's start, local time in `timeZone`, "HH:MM". */
  windowStart: string;
  windowHours: number;
  timeZone: string;
  /** How far an automatic update may go: every version, minor and patch, or patch only; a bigger step waits for a person. */
  autoLevel: 'major' | 'minor' | 'patch';
}

export const updateSettingsInput = z.object({
  enabled: z.boolean(),
  autoUpdate: z.boolean().default(true),
  kind: z.enum(['daily', 'weekly', 'cron']).default('daily'),
  day: z.number().int().min(0).max(6).default(1),
  cron: z.string().trim().max(100).nullable().default(null),
  windowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  windowHours: z.number().int().min(1).max(12),
  timeZone: z.string().min(1).max(64),
  autoLevel: z.enum(['major', 'minor', 'patch']).default('major'),
});

/** What runs now: stack operations, and an image update check with its progress. */
export interface Activity {
  ops: OpInfo[];
  check: { done: number; total: number } | null;
}

export interface UpdatesOverview {
  settings: UpdateSettings;
  checks: ImageCheck[];
  lastCheckAt: string | null;
  nextWindowAt: string | null;
  checking: boolean;
  /** While checking: tags asked at their registry, of all (0 of 0 while the hosts are read). */
  progress: { done: number; total: number } | null;
  /** The maintenance window's work runs now (by its schedule or "Run now"). */
  windowRunning: boolean;
}

export type UpdateResult = 'updated' | 'rolled_back' | 'failed' | 'unchanged';

export interface StackUpdate {
  id: number;
  hostId: number;
  project: string;
  auto: boolean;
  result: UpdateResult;
  /** Per image: digest before and after. */
  images: { image: string; from: string | null; to: string | null }[];
  detail: string | null;
  startedAt: string;
  finishedAt: string;
}

/** What an admin should know about how Burrow runs (GET /api/system/hints). */
export interface SystemHints {
  /** Requests come through a proxy TRUST_PROXY does not name (empty, or stale): its address, and what to set (decision 12, OPS-W-12). */
  trustProxy: { proxies: string[]; current: string | null; suggest: string } | null;
  /** Burrow's data disk is (nearly) full (OPS-W-02). */
  diskFull: boolean;
  /** Problem reports not closed yet (W-FUNC-11). */
  openReports: number;
}

/** A background job of the server, as it last ran (GET /api/system/jobs, OPS-W-14). */
/** One kind of Burrow's own warnings or errors, kept across deploys (OPS-W-13). */
export interface LogEvent {
  /** The message with its numbers left out. */
  kind: string;
  level: 'warn' | 'error';
  count: number;
  firstAt: string;
  lastAt: string;
  /** The newest message of this kind, masked. */
  example: string;
}

export interface BackgroundJob {
  name: 'container-history' | 'host-stats' | 'reports' | 'housekeeping' | 'update-check' | 'scheduled-commands';
  lastRunAt: string;
  /** How long its last run took. */
  ms: number;
  runs: number;
  /** Its last run went without a failure. */
  ok: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}
