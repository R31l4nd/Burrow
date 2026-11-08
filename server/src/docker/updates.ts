import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { imageVersion, newerTag, tagShape, type ContainerInfo, type ImageCheck, type ImageStatus, type UpdateSettings } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { appSettings, imageChecks } from '../db/schema.js';
import type { SftpPool } from '../files/pool.js';
import { linearMatcher } from '../linear.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { dueAt, nextRun, tryCron } from '../reports/schedule.js';
import { listTags, localDigest, localDigests, parseImageRef, RegistryError, refKey, remoteDigest, type FetchFn } from './registry.js';

// Is there a newer image? Per host: which images the containers use, and
// with which digest they were pulled (docker image inspect over SSH). Per
// registry: which digest the tag has now (HEAD, from Burrow). Each tag is
// asked once per check, however many hosts use it, a moment apart.

const PAUSE_MS = 250;
const MARK = '@@img ';
const FAILED = '@@failed';

/** Per image: the tag's image id here, the digests it was pulled with, its labels and its variables (for its version). */
export function inspectCommand(images: string[]): string {
  // One that cannot be inspected says so: it read as an image built here (AUDIT2 DO-09).
  return `for i in ${images.map(shellQuote).join(' ')}; do printf '${MARK}%s\\t' "$i"; docker image inspect --format '{{.Id}}\t{{json .RepoDigests}}\t{{json .Config.Labels}}\t{{json .Config.Env}}' "$i" 2>/dev/null || printf '\\t${FAILED}\\n'; done`;
}

export interface Inspected {
  id: string;
  repoDigests: string[];
  labels: Record<string, string>;
  /** Only its *_VERSION variables (the official images say their version there); nothing else is kept. */
  env?: string[];
  /** docker image inspect failed for it. */
  failed?: boolean;
}

export function parseInspect(out: string): Map<string, Inspected> {
  const m = new Map<string, Inspected>();
  for (const line of out.split('\n')) {
    if (!line.startsWith(MARK)) continue;
    const [image = '', id = '', digests = '', labels = 'null', env = 'null'] = line.slice(MARK.length).split('\t');
    if (!id && digests === FAILED) {
      m.set(image, { id: '', repoDigests: [], labels: {}, failed: true });
      continue;
    }
    if (!id) continue;
    try {
      m.set(image, {
        id,
        repoDigests: (JSON.parse(digests) as string[] | null) ?? [],
        labels: (JSON.parse(labels) as Record<string, string> | null) ?? {},
        ...(env !== 'null' ? { env: ((JSON.parse(env) as string[] | null) ?? []).filter((e) => /^[A-Z][A-Z0-9_]*_VERSION=/.test(e)) } : {}),
      });
    } catch {
      // Not ours.
    }
  }
  return m;
}

export interface LocalImage {
  image: string;
  localDigest: string | null;
  /** All digests the image has for its repository (localDigest is the first). */
  localDigests: string[];
  /** A container still runs an older image than the tag here (pulled, not recreated). */
  stale: boolean;
  pinned: boolean;
  source: string | null;
  version: string | null;
  /** The containers' labels on which tags count as newer (the first that says). */
  tagInclude: string | null;
  tagExclude: string | null;
  /** Its inspection failed: nothing is known of it here. */
  unread?: boolean;
}

/** What each image of a host is locally. */
export function localImages(containers: ContainerInfo[], inspected: Map<string, Inspected>): LocalImage[] {
  const out: LocalImage[] = [];
  for (const image of [...new Set(containers.map((c) => c.image).filter(Boolean))].sort()) {
    const ref = parseImageRef(image);
    // Not in the answer at all (cut off at the size limit, the connection gone halfway): as
    // unread as one docker could not inspect, not an image built here (audit 2026-11-05).
    const read = inspected.get(image) ?? { id: '', repoDigests: [], labels: {}, failed: true };
    const ins = read.failed ? undefined : read;
    const users = containers.filter((c) => c.image === image);
    out.push({
      image,
      localDigest: ref && ins ? localDigest(ref, ins.repoDigests) : null,
      localDigests: ref && ins ? localDigests(ref, ins.repoDigests) : [],
      stale: !!ins && users.some((c) => c.imageId && c.imageId !== ins.id),
      pinned: !!ref?.digest,
      source: ins?.labels['org.opencontainers.image.source'] || ins?.labels['org.opencontainers.image.url'] || null,
      // The version that runs: a container on an older image than the tag
      // (pulled, not recreated) has that older one's label; the tag's label
      // made notes from the running version on miss what came between
      // (AUDIT2 DO-06).
      // A label that is no version ("latest", "main") does not count; an image without one says it in its
      // *_VERSION variable or its tag (report 9190c5).
      // A container on an older image: only its own label tells (the tag's variables are the newer one's).
      version: users.some((c) => ins && c.imageId && c.imageId !== ins.id)
        ? imageVersion(image, users.find((c) => ins && c.imageId && c.imageId !== ins.id && c.version)?.version ?? null, [])
        : imageVersion(image, ins?.labels['org.opencontainers.image.version'] || users.find((c) => c.version)?.version || null, ins?.env),
      tagInclude: users.find((c) => c.tagInclude)?.tagInclude ?? null,
      tagExclude: users.find((c) => c.tagExclude)?.tagExclude ?? null,
      ...(read.failed ? { unread: true } : {}),
    });
  }
  return out;
}

/** A label's pattern as a test on tags (RE2: a compose file's pattern cannot hold up the check); none, or one RE2 refuses, counts as no label. */
function tagTest(pattern: string | null): ((tag: string) => boolean) | null {
  if (!pattern || pattern.length > 200) return null;
  const m = linearMatcher(pattern);
  return m instanceof Error ? null : m;
}

export function decide(l: LocalImage, remote: string | null, error: string | null): { status: ImageStatus; error: string | null } {
  if (l.pinned) return { status: 'pinned', error: null };
  if (l.unread) return { status: 'unknown', error: 'docker image inspect failed for it on this host' };
  if (l.stale) return { status: 'update', error: null };
  if (!l.localDigest) return { status: 'local', error: null };
  if (!remote) return { status: 'unknown', error };
  return { status: remote === l.localDigest || l.localDigests.includes(remote) ? 'current' : 'update', error: null };
}

export class UpdateChecker {
  checking = false;
  /** While checking: registry questions done of all (total 0 while the hosts are read). */
  progress: { done: number; total: number } | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
    private readonly readHost: (hostId: number) => Promise<{ containers: ContainerInfo[]; error: string | null }>,
    private readonly fetchFn?: FetchFn,
    /** Which images a full check covers (tests leave out the machine's other containers). */
    private readonly scope: (image: string) => boolean = () => true,
  ) {}

  /**
   * Checks the images of these hosts, or only the given images (one stack);
   * one host that cannot be read does not stop the others.
   */
  async check(hostIds: number[], only?: string[]): Promise<void> {
    // One at a time; asked for meanwhile, it runs after (report 25f8d5: the
    // check after an update was skipped while another ran, its "update" stayed).
    while (this.#running) await this.#running.catch(() => {});
    const run = this.#check(hostIds, only);
    this.#running = run;
    const started = performance.now();
    let failure: string | null = null;
    try {
      await run.catch((err: Error) => {
        failure = err.message;
        throw err;
      });
    } finally {
      if (this.#running === run) this.#running = null;
      this.jobs?.ran('update-check', performance.now() - started, failure);
    }
  }

  /** Where its runs are told (OPS-W-14). */
  jobs: import('../jobs.js').Jobs | null = null;

  #running: Promise<void> | null = null;

  async #check(hostIds: number[], only?: string[]): Promise<void> {
    this.checking = true;
    this.progress = { done: 0, total: 0 };
    try {
      const perHost: { hostId: number; images: LocalImage[] }[] = [];
      for (const hostId of hostIds) {
        try {
          const h = await this.readHost(hostId);
          if (h.error) throw new Error(h.error);
          const containers = h.containers.filter((c) => !c.ignored && (only ? only.includes(c.image) : this.scope(c.image)));
          const all = [...new Set(containers.map((c) => c.image).filter(Boolean))];
          const r = all.length ? await this.pool.with(hostId, ({ client }) => exec(client, inspectCommand(all), 60_000)) : { stdout: '', code: 0 };
          // Its images not in what came are unknown (localImages); said here why.
          if (r.code !== 0 || ('truncated' in r && r.truncated)) this.ctx.log.warn({ hostId }, `updates: the image inspection ${r.code !== 0 ? `ended with ${r.code}` : 'was cut off at its size limit'}`);
          perHost.push({ hostId, images: localImages(containers, parseInspect(r.stdout)) });
        } catch (err) {
          this.ctx.log.warn({ hostId }, `updates: cannot read images: ${(err as Error).message}`);
        }
      }
      // One registry question per tag.
      const remote = new Map<string, { digest: string | null; error: string | null }>();
      const limited = new Set<string>();
      const tags = new Set<string>();
      for (const l of perHost.flatMap((h) => h.images)) {
        const ref = parseImageRef(l.image);
        if (ref && !l.pinned && l.localDigest) tags.add(`${refKey(ref)}:${ref.tag}`);
      }
      // Newer versions under another tag: one tag list per repository, for
      // images on a version tag (1.25, v2.3.1-alpine) from a registry.
      const repos = new Set<string>();
      for (const l of perHost.flatMap((h) => h.images)) {
        const ref = parseImageRef(l.image);
        if (ref && !l.pinned && l.localDigest && ref.tag && tagShape(ref.tag)) repos.add(refKey(ref));
      }
      const total = tags.size + repos.size;
      this.progress = { done: 0, total };
      for (const l of perHost.flatMap((h) => h.images)) {
        const ref = parseImageRef(l.image);
        if (!ref || l.pinned || !l.localDigest) continue;
        const k = `${refKey(ref)}:${ref.tag}`;
        if (remote.has(k)) continue;
        if (limited.has(ref.registry)) {
          remote.set(k, { digest: null, error: 'rate limited by the registry' });
          continue;
        }
        try {
          remote.set(k, { digest: await remoteDigest(ref, { endpoints: this.ctx.config.registryEndpoints, fetch: this.fetchFn }), error: null });
        } catch (err) {
          if (err instanceof RegistryError && err.rateLimited) limited.add(ref.registry);
          remote.set(k, { digest: null, error: (err as Error).message });
        }
        this.progress = { done: remote.size, total };
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
      const tagLists = new Map<string, string[]>();
      for (const key of repos) {
        const ref = parseImageRef(key)!;
        if (!limited.has(ref.registry)) {
          try {
            tagLists.set(key, await listTags(ref, { endpoints: this.ctx.config.registryEndpoints, fetch: this.fetchFn }));
          } catch (err) {
            if (err instanceof RegistryError && err.rateLimited) limited.add(ref.registry);
            this.ctx.log.warn(`updates: no tags for ${key}: ${(err as Error).message}`);
          }
        }
        this.progress = { done: remote.size + tagLists.size, total };
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
      const now = this.ctx.now();
      for (const h of perHost) {
        for (const l of h.images) {
          const ref = parseImageRef(l.image);
          const rem = ref ? remote.get(`${refKey(ref)}:${ref.tag}`) : undefined;
          const d = decide(l, rem?.digest ?? null, rem?.error ?? (ref ? null : 'not an image name Burrow understands'));
          // Current by another of its digests: show that one, the registry's.
          const list = ref?.tag ? tagLists.get(refKey(ref)) : undefined;
          const newer = list && ref?.tag ? newerTag(ref.tag, list, { include: tagTest(l.tagInclude), exclude: tagTest(l.tagExclude) }) : null;
          const row = { status: d.status, localDigest: d.status === 'current' && rem?.digest ? rem.digest : l.localDigest, remoteDigest: rem?.digest ?? null, error: d.error, source: l.source, version: l.version, newerTag: newer, checkedAt: now };
          this.ctx.db
            .insert(imageChecks)
            .values({ hostId: h.hostId, image: l.image, ...row })
            .onConflictDoUpdate({ target: [imageChecks.hostId, imageChecks.image], set: row })
            .run();
        }
        // Images no container uses any more: of all on the host, or of the ones asked about (the
        // check after a restart). Left in place, one still counted as an update after its container
        // was removed, until the next full check (report 5f9ff3).
        const keep = h.images.map((l) => l.image);
        const gone = (only ?? []).filter((image) => !keep.includes(image));
        if (only) {
          if (gone.length) this.ctx.db.delete(imageChecks).where(and(eq(imageChecks.hostId, h.hostId), inArray(imageChecks.image, gone))).run();
          continue;
        }
        this.ctx.db
          .delete(imageChecks)
          .where(keep.length ? and(eq(imageChecks.hostId, h.hostId), notInArray(imageChecks.image, keep)) : eq(imageChecks.hostId, h.hostId))
          .run();
      }
      setUpdateState(this.ctx, { lastCheckAt: now });
      const n = this.list().filter((c) => c.status === 'update').length;
      this.ctx.log.info(`updates: checked ${perHost.length} host(s), ${remote.size} tag(s); ${n} image(s) with an update`);
    } finally {
      this.checking = false;
      this.progress = null;
    }
  }

  /**
   * Checks again only the images marked "update": one may have been updated
   * outside Burrow, or judged by an older Burrow (at start-up).
   */
  async recheckFlagged(): Promise<void> {
    const byHost = new Map<number, string[]>();
    for (const c of this.list().filter((x) => x.status === 'update')) byHost.set(c.hostId, [...(byHost.get(c.hostId) ?? []), c.image]);
    for (const [hostId, images] of byHost) await this.check([hostId], images).catch(() => {});
  }

  list(hostId?: number): ImageCheck[] {
    const rows = hostId ? this.ctx.db.select().from(imageChecks).where(eq(imageChecks.hostId, hostId)).all() : this.ctx.db.select().from(imageChecks).all();
    return rows.map((r) => ({
      hostId: r.hostId,
      image: r.image,
      status: r.status,
      localDigest: r.localDigest,
      remoteDigest: r.remoteDigest,
      error: r.error,
      source: r.source,
      version: r.version,
      newerTag: r.newerTag,
      checkedAt: new Date(r.checkedAt).toISOString(),
      rolledBackAt: rolledBackAt(this.ctx, r.hostId, r.image, r.remoteDigest),
    }));
  }
}

// ---- settings and state (app_settings rows)

const SETTINGS_KEY = 'updates';
const STATE_KEY = 'updates.state';

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { enabled: true, autoUpdate: true, kind: 'daily', day: 1, cron: null, windowStart: '04:00', windowHours: 1, timeZone: 'UTC', autoLevel: 'major' };

function readJson<T>(ctx: Ctx, key: string): Partial<T> {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return row ? (JSON.parse(row.value) as Partial<T>) : {};
}

function writeJson(ctx: Ctx, key: string, value: unknown): void {
  const v = JSON.stringify(value);
  ctx.db
    .insert(appSettings)
    .values({ key, value: v, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: v, updatedAt: ctx.now() } })
    .run();
}

export function getUpdateSettings(ctx: Ctx): UpdateSettings {
  return { ...DEFAULT_UPDATE_SETTINGS, ...readJson<UpdateSettings>(ctx, SETTINGS_KEY) };
}

export function setUpdateSettings(ctx: Ctx, s: UpdateSettings): void {
  writeJson(ctx, SETTINGS_KEY, s);
}

export interface UpdateState {
  lastCheckAt: number | null;
  /** Updates already told about ("hostId image remoteDigest"), so each is told once. */
  notified?: string[];
  /** Newer tags already told about ("hostId image tag"), the same way. */
  notifiedTags?: string[];
  /** Stack updates held for a breaking change, already told about ("hostId project releases"). */
  held?: string[];
  /** Holds a person lifted after reading ("hostId project releases"): these releases may go by themselves. */
  released?: string[];
  /** The day (in the window's time zone) the window last ran: once a day. */
  lastWindowDay: string | null;
  /** Stack updates under way (autoupdate.ts PendingUpdate), finished after a restart. */
  pending?: import('./autoupdate.js').PendingUpdate[];
  /** Deploys under way (autoupdate.ts PendingDeploy), finished after a restart (OPS-W-05). */
  deploys?: import('./autoupdate.js').PendingDeploy[];
  /** Stacks ("hostId project") whose update went on without readable release notes once: not asked again for that (decision 9). */
  notesWaived?: string[];
  /** Updates to these remote digests were rolled back (or failed): the window does not try them again (W-FUNC-03). */
  rolledBack?: { hostId: number; image: string; digest: string; at: number }[];
}

/** When an update of this image to this digest was rolled back on this host, or null. */
export function rolledBackAt(ctx: Ctx, hostId: number, image: string, digest: string | null): string | null {
  if (!digest) return null;
  const r = (getUpdateState(ctx).rolledBack ?? []).find((x) => x.hostId === hostId && x.image === image && x.digest === digest);
  return r ? new Date(r.at).toISOString() : null;
}

export function getUpdateState(ctx: Ctx): UpdateState {
  return { lastCheckAt: null, lastWindowDay: null, ...readJson<UpdateState>(ctx, STATE_KEY) };
}

export function setUpdateState(ctx: Ctx, patch: Partial<UpdateState>): void {
  writeJson(ctx, STATE_KEY, { ...getUpdateState(ctx), ...patch });
}

// ---- the window

/** Year-month-day and minutes after midnight of `at` in a time zone. */
const formats = new Map<string, Intl.DateTimeFormat>();

export function localTime(at: number, timeZone: string): { day: string; minutes: number } {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formats.set(timeZone, f);
  }
  const parts = Object.fromEntries(
    f
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// The window opens when its schedule is due (the reports' rules: daily or
// weekly at windowStart, or a cron expression) and stays open windowHours.
const when = (s: UpdateSettings) => ({ kind: s.kind, day: s.day, time: s.windowStart, cron: s.cron, timeZone: s.timeZone });

/**
 * Inside a window, and which one: its start's day (a window may cross
 * midnight), with the time for cron, where one day can have several.
 */
export function inWindow(at: number, s: UpdateSettings): { inside: boolean; day: string } {
  const w = when(s);
  const cron = s.kind === 'cron' ? tryCron(s.cron) : null;
  const now = Math.floor(at / 60_000) * 60_000;
  for (let i = 0; i < s.windowHours * 60; i++) {
    const t = now - i * 60_000;
    if (!dueAt(w, t, cron)) continue;
    const l = localTime(t, s.timeZone);
    return { inside: true, day: s.kind === 'cron' ? `${l.day} ${String(Math.floor(l.minutes / 60)).padStart(2, '0')}:${String(l.minutes % 60).padStart(2, '0')}` : l.day };
  }
  return { inside: false, day: localTime(at, s.timeZone).day };
}

/** When the next window opens (to the minute), for the settings page; null when not within five weeks. */
export const nextWindow = (from: number, s: UpdateSettings): number | null => nextRun(when(s), from);

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
