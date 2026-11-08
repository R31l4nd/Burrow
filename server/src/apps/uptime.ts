import { and, eq, gte, lt } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { appChecks, apps } from '../db/schema.js';
import type { Notifier } from '../notify/channels.js';
import { certExpiry } from './cert.js';
import { probeApp, type Fetcher } from './probe.js';

// The app tabs, watched: every minute each one is asked for its page. Any
// answer below 500 is up (a login page is up); no answer or a server error
// is down. Two misses in a row make it down (one lost packet does not), and
// the channels hear it once when it goes down and once when it is back.
// Every app failing in the same round is Burrow's own network (DNS, the
// proxy), not that many outages: that round counts for none of them, and
// one message says Burrow cannot reach the apps.

const EVERY_MS = 60_000;
const TIMEOUT_MS = 10_000;
const KEEP_MS = 7 * 86_400_000;
const MISSES = 2;
// Certificates: read every six hours; told at 14 days, again at 3, and when run out.
const CERT_EVERY_MS = 6 * 3600_000;
// Days left under which a message comes (once each per certificate): 0 is run out.
const CERT_WARN_DAYS = [0, 3, 14];
// At least this many apps before "all failed" says more about Burrow than about them.
const BLIND_MIN = 3;
// Icons: fetched again once a day (and soon after a start), so an app that
// changed its logo shows the new one; it was fetched only when the app was
// added (report 5866c2: Burrow's own old logo).
const ICON_EVERY_MS = 86_400_000;
const ICON_FIRST_MS = 120_000;

type Probe = { ok: boolean; ms: number | null; error: string | null };

export class UptimeMonitor {
  #timer: NodeJS.Timeout | null = null;
  #iconTimers: NodeJS.Timeout[] = [];
  #misses = new Map<number, number>();
  #running = false;
  // Rounds in which every app failed: Burrow's own reach (told once).
  #blind: string | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly fetcher: Fetcher,
    public notifier: Notifier | null,
    /** When an https URL's certificate runs out (cert.ts); a stand-in in tests. */
    private readonly certOf: (url: string) => Promise<number | null> = certExpiry,
  ) {}

  start(): void {
    this.#timer = setInterval(() => void this.checkAll().catch((err: Error) => this.ctx.log.warn(`uptime: ${err.message}`)), EVERY_MS);
    this.#timer.unref();
    const icons = () => void this.refreshIcons().catch((err: Error) => this.ctx.log.warn(`app icons: ${err.message}`));
    this.#iconTimers = [setTimeout(icons, ICON_FIRST_MS), setInterval(icons, ICON_EVERY_MS)];
    for (const t of this.#iconTimers) t.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    for (const t of this.#iconTimers) clearTimeout(t);
  }

  /** Every app's icon fetched again; a new one replaces the stored one, none found keeps it. Returns how many changed. */
  async refreshIcons(): Promise<number> {
    let changed = 0;
    for (const a of this.ctx.db.select({ id: apps.id, url: apps.url, icon: apps.icon }).from(apps).all()) {
      const { icon } = await probeApp(a.url, this.ctx.config.origin, this.fetcher);
      if (!icon || (a.icon && Buffer.from(a.icon).equals(icon.data))) continue;
      if (this.ctx.db.select({ url: apps.url }).from(apps).where(eq(apps.id, a.id)).get()?.url !== a.url) continue;
      this.ctx.db.update(apps).set({ icon: icon.data, iconType: icon.type }).where(eq(apps.id, a.id)).run();
      changed++;
    }
    return changed;
  }

  async checkAll(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const list = this.ctx.db.select().from(apps).where(eq(apps.monitor, true)).all();
      const probes = await Promise.all(list.map(async (a) => ({ a, p: await this.#probe(a.url) })));
      const failed = probes.filter((x) => !x.p.ok);
      // Burrow blind: no app answered at all. Apps that answered with an
      // error (all 500) are down, each of them (AUDIT2 MON-17).
      if (list.length >= BLIND_MIN && failed.length === list.length && failed.every((x) => !x.p.error?.startsWith('HTTP '))) {
        // Nothing recorded, no app down: Burrow cannot see out.
        if (this.#blind === null) {
          this.#blind = failed[0]!.p.error ?? 'no answer';
          this.ctx.log.warn(`uptime: none of the ${list.length} apps answered (${this.#blind}); not counted`);
          void this.notifier?.notify({
            topic: 'alerts',
            title: `Burrow cannot reach the apps`,
            body: `None of the ${list.length} apps answered (${this.#blind}). Burrow's own network, DNS or proxy, most likely; their uptime does not count this time.`,
            page: '/apps',
            priority: 4,
            nl: { title: 'Burrow kan de apps niet bereiken', body: `Geen van de ${list.length} apps antwoordde (${this.#blind}). Waarschijnlijk Burrows eigen netwerk, DNS of proxy; hun uptime telt deze keer niet mee.` },
          });
        }
      } else {
        if (this.#blind !== null) {
          this.#blind = null;
          void this.notifier?.notify({ topic: 'alerts', title: 'Burrow reaches the apps again', body: '', page: '/apps', priority: 2, nl: { title: 'Burrow bereikt de apps weer', body: '' } });
        }
        for (const { a, p } of probes) this.#record(a.id, p, a.url);
      }
      const due = list.filter((a) => a.url.startsWith('https:') && (!a.certCheckedAt || this.ctx.now() - a.certCheckedAt >= CERT_EVERY_MS));
      await Promise.all(due.map((a) => this.checkCert(a.id)));
      this.ctx.db.delete(appChecks).where(lt(appChecks.at, this.ctx.now() - KEEP_MS)).run();
    } finally {
      this.#running = false;
    }
  }

  /** One check of one app: its state, a record, a message when it changed. */
  async check(id: number): Promise<void> {
    const a = this.ctx.db.select().from(apps).where(eq(apps.id, id)).get();
    if (!a) return;
    this.#record(id, await this.#probe(a.url), a.url);
  }

  /** The app's page asked for once: up below 500, and how long it took. */
  async #probe(url: string): Promise<Probe> {
    const t0 = performance.now();
    try {
      const res = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      await res.body?.cancel();
      return res.status < 500 ? { ok: true, ms: Math.round(performance.now() - t0), error: null } : { ok: false, ms: null, error: `HTTP ${res.status}` };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      return { ok: false, ms: null, error: e.cause?.code ?? e.name ?? 'no answer' };
    }
  }

  #record(id: number, { ok, ms }: Probe, url: string): void {
    // Removed while it was asked: nothing to record (its checks went with
    // it). Its address changed or watching it stopped meanwhile: the answer
    // is of something else, not written over the new state (AUDIT2 MON-18).
    const a = this.ctx.db.select().from(apps).where(eq(apps.id, id)).get();
    if (!a || a.url !== url || !a.monitor) return;
    const now = this.ctx.now();
    this.ctx.db.insert(appChecks).values({ appId: id, at: now, ok, ms }).run();
    const misses = ok ? 0 : (this.#misses.get(id) ?? 0) + 1;
    this.#misses.set(id, misses);
    // Down only after MISSES in a row; up at once.
    const up = ok ? true : misses >= MISSES ? false : (a.up ?? null);
    const wentDown = a.up !== false && up === false;
    const cameBack = a.up === false && up === true;
    this.ctx.db
      .update(apps)
      .set({ up, checkedAt: now, latencyMs: ms, downSince: up === false ? (a.downSince ?? now) : null })
      .where(eq(apps.id, id))
      .run();
    if (wentDown) this.#tell(a.name, a.url, 'down', null, id);
    if (cameBack) this.#tell(a.name, a.url, 'up', a.downSince ? Math.round((now - a.downSince) / 60_000) : null, id);
  }

  /**
   * When the app's certificate runs out, and a message when that is within
   * 14 days (and again within 3, or once run out): each once per certificate.
   */
  async checkCert(id: number): Promise<void> {
    const a = this.ctx.db.select().from(apps).where(eq(apps.id, id)).get();
    if (!a) return;
    const end = await this.certOf(a.url).catch(() => null);
    const still = this.ctx.db.select({ url: apps.url }).from(apps).where(eq(apps.id, id)).get();
    if (still?.url !== a.url) return;
    const now = this.ctx.now();
    const days = end === null ? null : Math.floor((end - now) / 86_400_000);
    const level = days === null ? null : (CERT_WARN_DAYS.find((d) => days < d) ?? null);
    const warned = level !== null ? `${end}:${level}` : a.certWarned;
    this.ctx.db.update(apps).set({ certExpiresAt: end, certCheckedAt: now, certWarned: warned }).where(eq(apps.id, id)).run();
    if (level === null || a.certWarned === warned) return;
    const when = days! < 0 ? 'has run out' : `runs out in ${days} ${days === 1 ? 'day' : 'days'}`;
    const wanneer = days! < 0 ? 'is verlopen' : `verloopt over ${days} ${days === 1 ? 'dag' : 'dagen'}`;
    void this.notifier?.notify({
      topic: 'alerts',
      title: `${a.name}: its certificate ${when}`,
      body: a.url,
      page: '/apps',
      priority: days! < 3 ? 4 : 3,
      nl: { title: `${a.name}: het certificaat ${wanneer}`, body: a.url },
      data: { appId: id, certExpiresAt: new Date(end!).toISOString() },
    });
  }

  /** Share of the checks since `since` that found the app up; null without checks. */
  uptime(id: number, since = this.ctx.now() - 86_400_000): number | null {
    const rows = this.ctx.db.select({ ok: appChecks.ok }).from(appChecks).where(and(eq(appChecks.appId, id), gte(appChecks.at, since))).all();
    return rows.length ? rows.filter((r) => r.ok).length / rows.length : null;
  }

  #tell(name: string, url: string, what: 'down' | 'up', minutes: number | null, id: number): void {
    const back = minutes !== null ? ` (${minutes} min)` : '';
    void this.notifier?.notify({
      topic: 'alerts',
      title: what === 'down' ? `${name} is down` : `${name} is back${back}`,
      body: url,
      page: '/apps',
      priority: what === 'down' ? 4 : 2,
      nl: { title: what === 'down' ? `${name} is onbereikbaar` : `${name} is weer bereikbaar${back}`, body: url },
      data: { appId: id, state: what },
    });
  }
}
