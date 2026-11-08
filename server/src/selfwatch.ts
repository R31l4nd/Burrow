import { compareVersions, type BackgroundJob, type LogEvent, type Notice, type UpdateCheck } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { appSettings } from './db/schema.js';

// Burrow tells about itself (2026-11-07): it watches hosts and containers,
// but its own troubles were only on Settings -> About, where nobody looks
// when all seems well. Every hour it looks at itself and sends what is new
// over the notification channels, once per problem, and once more when the
// problem is gone:
//
//   - a background job that keeps failing (an hour or more);
//   - the data disk getting full (an early warning, before DiskWatch's
//     "full", when nothing can be saved any more);
//   - a notification channel that fails (told through the others);
//   - errors in Burrow's own log of a kind not told in the last week;
//   - a new Burrow version (checked once a day), and a self-update that
//     failed or was rolled back;
//   - once a week a short "Burrow runs" on every channel: when it stops
//     coming, Burrow or the channel is broken.
//
// What was told is kept in the database, so a restart does not tell it again.

const TOLD_KEY = 'selfwatch.told';
/** A job failing this long is told. */
export const JOB_FAILING_MS = 3600_000;
/** Below this much free space, or this share of the disk, the data disk is told. */
export const DISK_LOW_BYTES = 1024 ** 3;
export const DISK_LOW_SHARE = 0.05;
/** An error of one kind is told again after a week. */
const ERROR_AGAIN_MS = 7 * 86_400_000;
const VERSION_EVERY_MS = 86_400_000;
const WEEKLY_MS = 7 * 86_400_000;

export interface Problem {
  key: string;
  en: { title: string; body: string };
  nl: { title: string; body: string };
  page: string;
}

/** What the problem is now; null when there is none. Pure, for the tests. */
export function jobProblems(jobs: BackgroundJob[], failingSince: Map<string, number>, now: number): Problem[] {
  const out: Problem[] = [];
  for (const j of jobs) {
    if (j.ok) {
      failingSince.delete(j.name);
      continue;
    }
    if (!failingSince.has(j.name)) failingSince.set(j.name, now);
    if (now - failingSince.get(j.name)! < JOB_FAILING_MS) continue;
    const error = (j.lastError ?? '').slice(0, 300);
    out.push({
      key: `job:${j.name}`,
      en: { title: `Burrow: "${j.name}" keeps failing`, body: `Since ${new Date(failingSince.get(j.name)!).toISOString()}: ${error}\nSettings -> About shows the jobs.` },
      nl: { title: `Burrow: "${j.name}" blijft mislukken`, body: `Sinds ${new Date(failingSince.get(j.name)!).toISOString()}: ${error}\nInstellingen -> Over toont de taken.` },
      page: '/settings?s=about',
    });
  }
  return out;
}

export function diskProblem(free: number | null, total: number | null): Problem | null {
  if (free === null || total === null || total <= 0) return null;
  if (free >= DISK_LOW_BYTES && free / total >= DISK_LOW_SHARE) return null;
  const gb = (free / 1024 ** 3).toFixed(1);
  const pct = Math.round((free / total) * 100);
  return {
    key: 'disk',
    en: { title: `Burrow's data disk is nearly full: ${gb} GB free (${pct}%)`, body: 'When it is full Burrow cannot save anything and sign-in fails. Free space on the host where Burrow keeps its data (its Docker volume).' },
    nl: { title: `Burrow's dataschijf is bijna vol: ${gb} GB vrij (${pct}%)`, body: 'Is hij vol, dan kan Burrow niets meer opslaan en lukt inloggen niet. Maak ruimte vrij op de host waar Burrow zijn data bewaart (zijn Docker-volume).' },
    page: '/settings?s=about',
  };
}

export function channelProblems(failing: Map<string, { error: string; since: number }>): Problem[] {
  return [...failing].map(([name, f]) => ({
    key: `channel:${name}`,
    en: { title: `Burrow: the notification channel "${name}" fails`, body: `Since ${new Date(f.since).toISOString()}: ${f.error.slice(0, 300)}\nSettings -> Notifications: edit it and press Test.` },
    nl: { title: `Burrow: meldingskanaal "${name}" werkt niet`, body: `Sinds ${new Date(f.since).toISOString()}: ${f.error.slice(0, 300)}\nInstellingen -> Meldingen: pas het aan en druk op Test.` },
    page: '/settings?s=channels',
  }));
}

/** Error kinds seen since `since` and not told within a week. */
export function newErrors(events: LogEvent[], told: Record<string, number>, since: number, now: number): LogEvent[] {
  return events.filter((e) => e.level === 'error' && Date.parse(e.lastAt) >= since && !(now - (told[`error:${e.kind}`] ?? -Infinity) < ERROR_AGAIN_MS));
}

/** A newer version, and a self-update that went wrong, as one-off notices. */
export function updateNotices(c: UpdateCheck): Problem[] {
  const out: Problem[] = [];
  if (c.available && compareVersions(c.available, c.running) > 0) {
    const breaking = c.breaking.length ? `\nBreaking changes to read first:\n${c.breaking.slice(0, 5).join('\n')}` : '';
    out.push({
      key: `version:${c.available}`,
      en: { title: `Burrow ${c.available} is available`, body: `This one runs ${c.running}. Settings -> About: What is new, and Update.${breaking}` },
      nl: { title: `Burrow ${c.available} is beschikbaar`, body: `Deze draait ${c.running}. Instellingen -> Over: Wat is nieuw, en Bijwerken.${breaking}` },
      page: '/settings?s=about',
    });
  }
  if (c.last && (c.last.state === 'failed' || c.last.state === 'rolledback')) {
    const rolled = c.last.state === 'rolledback';
    out.push({
      key: `selfupdate:${c.last.at}`,
      en: { title: rolled ? 'Burrow: the update was rolled back' : 'Burrow: the update failed', body: `${c.last.message}\nThe version before runs. Settings -> About says more.` },
      nl: { title: rolled ? 'Burrow: de update is teruggedraaid' : 'Burrow: de update is mislukt', body: `${c.last.message}\nDe vorige versie draait. Instellingen -> Over zegt meer.` },
      page: '/settings?s=about',
    });
  }
  return out;
}

interface Told {
  /** Problems told and not yet gone: key -> when told. */
  open: Record<string, Problem & { at: number }>;
  /** One-off notices told (versions, updates, error kinds): key -> when. */
  once: Record<string, number>;
  versionAt: number;
  weeklyAt: number;
  errorsSince: number;
}

type Send = (n: Notice) => Promise<{ sent: number }>;

export interface SelfWatchDeps {
  send: Send;
  jobs: () => BackgroundJob[];
  logEvents: () => LogEvent[];
  disk: () => { free: number | null; total: number | null };
  failingChannels: () => Map<string, { error: string; since: number }>;
  /** Burrow's own update check (over SSH); null when its container is not found. */
  checkUpdate: () => Promise<UpdateCheck | null>;
  /** One line about how Burrow runs, for the weekly notice. */
  summary: () => { en: string; nl: string };
}

export class SelfWatch {
  readonly #failingSince = new Map<string, number>();

  constructor(
    private readonly ctx: Ctx,
    private readonly deps: SelfWatchDeps,
  ) {}

  #load(): Told {
    const row = this.ctx.db.select().from(appSettings).where(eq(appSettings.key, TOLD_KEY)).get();
    const fresh: Told = { open: {}, once: {}, versionAt: 0, weeklyAt: this.ctx.now(), errorsSince: this.ctx.now() };
    if (!row) return fresh;
    try {
      return { ...fresh, ...(JSON.parse(row.value) as Partial<Told>) };
    } catch {
      return fresh;
    }
  }

  #save(t: Told): void {
    const value = JSON.stringify(t);
    this.ctx.db
      .insert(appSettings)
      .values({ key: TOLD_KEY, value, updatedAt: this.ctx.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: this.ctx.now() } })
      .run();
  }

  async #tell(p: Problem, priority: number, topic: Notice['topic'] = 'alerts'): Promise<boolean> {
    const r = await this.deps.send({ topic, title: p.en.title, body: p.en.body, page: p.page, priority, nl: p.nl, data: { selfwatch: p.key } });
    return r.sent > 0;
  }

  /** One look (every hour). Returns the keys told, for the tests. */
  async tick(): Promise<string[]> {
    const now = this.ctx.now();
    const t = this.#load();
    const told: string[] = [];

    // Problems that last: told once, and once more when gone.
    const jobs = this.deps.jobs();
    const current: Problem[] = [...jobProblems(jobs, this.#failingSince, now), ...channelProblems(this.deps.failingChannels())];
    const d = this.deps.disk();
    const disk = diskProblem(d.free, d.total);
    if (disk) current.push(disk);
    for (const p of current) {
      if (t.open[p.key]) continue;
      if (await this.#tell(p, 4)) {
        t.open[p.key] = { ...p, at: now };
        told.push(p.key);
      }
    }
    // A job still failing is not "fine again", also when this watcher has not seen it fail an hour (a restart).
    const keys = new Set([...current.map((p) => p.key), ...jobs.filter((j) => !j.ok).map((j) => `job:${j.name}`)]);
    for (const [key, p] of Object.entries(t.open)) {
      if (keys.has(key)) continue;
      const fine: Problem = { key, page: p.page, en: { title: `Fine again: ${p.en.title}`, body: 'Burrow no longer sees this problem.' }, nl: { title: `Weer in orde: ${p.nl.title}`, body: 'Burrow ziet dit probleem niet meer.' } };
      // Told or not (no channel left), it is no longer open.
      if (await this.#tell(fine, 2)) told.push(`fine:${key}`);
      delete t.open[key];
    }

    // Errors in Burrow's own log, of a kind not told this week: one message for all of them.
    const errors = newErrors(this.deps.logEvents(), t.once, t.errorsSince, now);
    if (errors.length) {
      const lines = errors.slice(0, 5).map((e) => `- ${e.example.slice(0, 200)} (${e.count}x)`).join('\n');
      const more = errors.length > 5 ? `\n... and ${errors.length - 5} more` : '';
      const p: Problem = {
        key: 'errors',
        en: { title: `Burrow logged ${errors.length} new ${errors.length === 1 ? 'error' : 'errors'}`, body: `${lines}${more}\nSettings -> About lists them.` },
        nl: { title: `Burrow logde ${errors.length} ${errors.length === 1 ? 'nieuwe fout' : 'nieuwe fouten'}`, body: `${lines}${more}\nInstellingen -> Over toont ze.` },
        page: '/settings?s=about',
      };
      if (await this.#tell(p, 3)) {
        for (const e of errors) t.once[`error:${e.kind}`] = now;
        told.push('errors');
      }
    }
    t.errorsSince = now;

    // A new version and a failed self-update: once a day, told once each.
    if (now - t.versionAt >= VERSION_EVERY_MS) {
      let check: UpdateCheck | null = null;
      try {
        check = await this.deps.checkUpdate();
        t.versionAt = now;
      } catch (err) {
        this.ctx.log.warn(`selfwatch: the update check failed: ${(err as Error).message}`);
      }
      for (const p of check ? updateNotices(check) : []) {
        if (t.once[p.key]) continue;
        if (await this.#tell(p, 3, 'updates')) {
          t.once[p.key] = now;
          told.push(p.key);
        }
      }
    }

    // Once a week on every channel: its silence says something is broken.
    if (now - t.weeklyAt >= WEEKLY_MS) {
      const s = this.deps.summary();
      const open = Object.keys(t.open).length;
      const p: Problem = {
        key: 'weekly',
        en: { title: 'Burrow runs', body: `${s.en}\n${open ? `${open} problem(s) still open.` : 'No open problems.'}\nThis message comes once a week; when it stops coming, Burrow or this channel is broken.` },
        nl: { title: 'Burrow draait', body: `${s.nl}\n${open ? `${open} probleem/problemen nog open.` : 'Geen open problemen.'}\nDit bericht komt eens per week; komt het niet meer, dan is Burrow of dit kanaal kapot.` },
        page: '/settings?s=about',
      };
      // The test topic: every channel gets it, whatever topics it has.
      if (await this.#tell(p, 1, 'test')) told.push('weekly');
      t.weeklyAt = now;
    }

    // Old one-off keys go after a month, so the record stays small.
    for (const [k, at] of Object.entries(t.once)) if (now - at > 30 * 86_400_000) delete t.once[k];
    this.#save(t);
    return told;
  }
}
