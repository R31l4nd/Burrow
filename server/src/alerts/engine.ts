import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Client } from 'ssh2';
import { alertTitle, fileLineTime, isHostSubject, muteCovers, subjectLabel, detectLevel, maskText, plural, splitTimestamp, type Alert, type AlertEvent, type AlertRule } from '@burrow/shared';
import { exitLine, fileTailCommand, logsCommand, logsScript, OUTPUT_MARK, scriptLines, zoneLine } from '../docker/logs.js';
import { logFilesOf } from '../docker/logfiles.js';
import type { Ctx } from '../context.js';
import { alertCounts, alertMutes, alertRules, alerts, hosts } from '../db/schema.js';
import type { SftpPool } from '../files/pool.js';
import type { DockerMonitor } from '../docker/monitor.js';
import { EVENTS_COMMAND, EventJudge, parseEvent } from './events.js';
import { linearMatcher } from '../linear.js';
import { Jobs } from '../jobs.js';
import type { Notifier } from '../notify/channels.js';
import { endsWithChannel, exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { throwaway } from './throwaway.js';

// Log alerts. Per Docker host one `docker events` stream (when an event rule
// covers it), and `docker logs -f` only for containers that a pattern or
// rate rule covers. What fires is bundled per rule and container for ten
// minutes (one push, a count that goes up), can be muted per container,
// and is pushed through ntfy with a link to the logs of that moment.

const RECONCILE_MS = 60_000;
const RETRY_MS = 10_000;
/** Longest wait between connects to a host that keeps failing them. */
const RETRY_MAX_MS = 30 * 60_000;
/** Refused for who Burrow is or what the host's key is: not better in seconds, and each try is a failed login to fail2ban. */
const REFUSED_RETRY_MS = 5 * 60_000;
const REFUSED = new Set(['auth_failed', 'unknown_host_key', 'host_key_mismatch']);
const BUNDLE_MS = 10 * 60_000;
/** Longest line looked at (bytes of text). */
export const MAX_LINE = 64 * 1024;
// One channel per host however many: the limit is what one shell runs well.
const MAX_FOLLOWED_PER_HOST = 60;
const MAX_FILES_PER_HOST = 20;

/** Burrow's words, not the container's, when its last lines could not be read. */
export function lastLinesUnread(out: string): string {
  const why = /no such container/i.test(out) ? 'the container is gone' : out.trim().split('\n').pop() || 'docker logs failed';
  return `(Burrow could not read its last lines: ${why}.)`;
}

export function toRule(r: typeof alertRules.$inferSelect): AlertRule {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    hostId: r.hostId,
    container: r.container,
    project: r.project,
    events: JSON.parse(r.events) as AlertEvent[],
    pattern: r.pattern,
    threshold: r.threshold,
    windowMinutes: r.windowMinutes,
    enabled: r.enabled,
    builtin: r.builtin,
  };
}

/**
 * How long to wait before connecting again after `failures` failed connects in a row: from ten
 * seconds (five minutes when the host refused Burrow itself), doubled each time up to half an hour,
 * a little spread. Every ten seconds, a wrong password got Burrow banned by fail2ban within minutes,
 * terminals and files with it, and a host that was off filled the log.
 */
export function retryAfter(failures: number, code: string | undefined, random: () => number = Math.random): number {
  const first = code && REFUSED.has(code) ? REFUSED_RETRY_MS : RETRY_MS;
  return Math.min(RETRY_MAX_MS, Math.round(first * 2 ** Math.max(0, failures - 1) * (1 + random() * 0.1)));
}

/** Does a rule cover this container? */
export function covers(r: AlertRule, hostId: number, container: string, project: string | null): boolean {
  return (r.hostId === null || r.hostId === hostId) && (!r.container || r.container === container) && (!r.project || r.project === project);
}

interface Stream {
  stop: () => void;
}

/** A container's output (file null) or one of its log files (or the host's: container ''). */
interface Followed {
  container: string;
  project: string | null;
  file: string | null;
}

export interface EngineOptions {
  reconcileMs?: number;
  /** The spread of the waits between connects (tests: none). */
  random?: () => number;
}

/** A host whose connects fail: how many in a row, and the wait before the next one (shared by its streams). */
interface Down {
  failures: number;
  wait: Promise<void>;
  waiting: boolean;
}

export class AlertEngine {
  readonly #events = new Map<number, Stream>();
  /** Each host's followed logs (containers and log files) in one stream; `key` says which. */
  readonly #followers = new Map<number, { key: string; stream: Stream; ended: boolean }>();
  readonly #judges = new Map<number, EventJudge>();
  /** Error lines per rule and container, for rate rules. */
  readonly #errors = new Map<string, number[]>();
  /** Hosts with more containers to follow than followed: which, and which are (OPS-W-09). */
  readonly #capped = new Map<number, { hostName: string; all: { name: string; project: string | null }[]; followed: Set<string> }>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  /** Called after an alert is stored (tests wait on it). */
  onAlert: ((a: Alert) => void) | null = null;
  /** Where a host's failed connects are said, once per change (the app's, or one of its own). */
  jobs: Jobs | null = null;
  readonly #down = new Map<number, Down>();

  /** A stack Burrow is working on (OpRunner.quiet): its containers raise no alerts meanwhile. */
  quiet: ((hostId: number, project: string) => boolean) | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
    private readonly monitor: DockerMonitor,
    private readonly notifier: Notifier,
    private readonly opts: EngineOptions = {},
  ) {}

  start(): void {
    // A round that throws (a rule row that does not parse, the database busy) is said; the next one comes all the same.
    const round = () => void this.reconcile().catch((err: Error) => this.ctx.log.warn(`alerts: matching the streams to the rules failed: ${err.message}`));
    round();
    this.#timer = setInterval(round, this.opts.reconcileMs ?? RECONCILE_MS);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const s of [...this.#events.values(), ...[...this.#followers.values()].map((f) => f.stream)]) s.stop();
    this.#events.clear();
    this.#followers.clear();
  }

  /** The hosts whose Docker events are being watched now. */
  watching(): number[] {
    return [...this.#events.keys()];
  }

  rules(): AlertRule[] {
    return this.ctx.db.select().from(alertRules).all().map(toRule);
  }

  /** The rules, each log rule with the hosts where it sees only some of its containers (OPS-W-09). */
  rulesShown(): AlertRule[] {
    return this.rules().map((r) => {
      if (r.kind === 'event') return r;
      const partial = [...this.#capped].flatMap(([hostId, c]) => {
        const mine = c.all.filter((x) => covers(r, hostId, x.name, x.project));
        const following = mine.filter((x) => c.followed.has(x.name)).length;
        return following < mine.length ? [{ hostId, hostName: c.hostName, following, total: mine.length }] : [];
      });
      return partial.length ? { ...r, partial } : r;
    });
  }

  #allHosts(): { id: number; name: string }[] {
    return this.ctx.db
      .select()
      .from(hosts)
      .all()
      .map((h) => ({ id: h.id, name: h.name }));
  }

  #dockerHosts(): { id: number; name: string }[] {
    return this.ctx.db
      .select()
      .from(hosts)
      .all()
      .filter((h) => h.facts && (JSON.parse(h.facts) as { hasDocker?: boolean }).hasDocker)
      .map((h) => ({ id: h.id, name: h.name }));
  }

  /** The round under way, and whether another was asked for meanwhile. */
  #reconciling: Promise<void> | null = null;
  #again = false;

  /**
   * Starts and stops streams to match the rules and hosts. One round at a
   * time: a slow one (a host that times out) ended after one asked for
   * since (a rule saved) and undid it with what held before; a rule
   * switched off kept its follower. Asked for during one, another follows
   * it, with what holds then.
   */
  reconcile(): Promise<void> {
    if (this.#reconciling) {
      this.#again = true;
      return this.#reconciling;
    }
    const run = (async () => {
      try {
        do {
          this.#again = false;
          await this.#reconcile();
        } while (this.#again && !this.#stopped);
      } finally {
        this.#reconciling = null;
      }
    })();
    this.#reconciling = run;
    return run;
  }

  async #reconcile(): Promise<void> {
    if (this.#stopped) return;
    const rules = this.rules().filter((r) => r.enabled);
    const dockerHosts = this.#dockerHosts();
    // Event streams.
    const wantEvents = new Set(dockerHosts.filter((h) => rules.some((r) => r.kind === 'event' && (r.hostId === null || r.hostId === h.id))).map((h) => h.id));
    for (const [id, s] of this.#events) {
      if (wantEvents.has(id)) continue;
      s.stop();
      this.#events.delete(id);
    }
    for (const id of wantEvents) if (!this.#events.has(id)) this.#events.set(id, this.#stream(id, 'events', EVENTS_COMMAND, (line) => this.onEvent(id, line)));
    // Log followers: per host one stream for all it follows, the
    // containers' own output and their log files (and the host's for a rule
    // on the whole host), so a host with many containers does not run out
    // of SSH channels (sshd allows ten per connection, and the monitor and
    // the pages need some too).
    const logRules = rules.filter((r) => r.kind !== 'event');
    const want = new Map<number, Followed[]>();
    // Every host a rule covers: its containers when it has Docker (and the
    // daemon answers), and the host's own log files and units' journals in
    // any case (a host without Docker, or with a failing daemon, still has
    // them; AUDIT2 J-02).
    const docker = new Set(dockerHosts.map((h) => h.id));
    // Hosts whose containers could not be read this round: their followers stay as they are. Stopped
    // and started again without the containers, then with them once more, at tail 0: what the
    // containers logged in between was never looked at (audit 2026-11-05).
    const unread = new Set<number>();
    const all = this.#allHosts();
    // A host deleted while it waited: forgotten.
    for (const id of this.#down.keys()) if (!all.some((h) => h.id === id)) this.#down.delete(id);
    for (const h of all) {
      if (!logRules.some((r) => r.hostId === null || r.hostId === h.id)) continue;
      const list: Followed[] = [];
      if (docker.has(h.id)) {
        // A host waiting out failed connects is not asked every minute here either.
        const snap = this.#down.get(h.id)?.waiting ? null : await this.monitor.poll(h.id).catch(() => null);
        if (!snap || snap.error) unread.add(h.id);
        if (snap && !snap.error) {
          const running = snap.containers.filter((c) => c.state === 'running' && !c.ignored && !throwaway(c.name, c.project) && logRules.some((r) => covers(r, h.id, c.name, c.project)));
          const was = this.#capped.get(h.id);
          if (running.length > MAX_FOLLOWED_PER_HOST) {
            // Said on the rules, and in the log once per change, not every minute (OPS-W-09).
            if (was?.all.length !== running.length) this.ctx.log.warn({ hostId: h.id }, `alerts: ${running.length} containers to follow on ${h.name}; following the first ${MAX_FOLLOWED_PER_HOST}`);
            this.#capped.set(h.id, { hostName: h.name, all: running.map((c) => ({ name: c.name, project: c.project ?? null })), followed: new Set(running.slice(0, MAX_FOLLOWED_PER_HOST).map((c) => c.name)) });
          } else this.#capped.delete(h.id);
          list.push(...running.slice(0, MAX_FOLLOWED_PER_HOST).map((c) => ({ container: c.name, project: c.project ?? null, file: null })));
        }
      }
      const files = logFilesOf(this.ctx, h.id).filter((f) => (f.container ? list.some((c) => c.container === f.container) : logRules.some((r) => covers(r, h.id, '', null))));
      for (const f of files.slice(0, MAX_FILES_PER_HOST)) list.push({ container: f.container, project: list.find((c) => c.container === f.container)?.project ?? null, file: f.path });
      if (list.length) want.set(h.id, list);
    }
    for (const [hostId, f] of this.#followers) {
      // A source that ended (a container made anew under its name, a journal that failed) is followed
      // again: the stream stayed open for the others and that one was never read again (AUDIT2 MON-13).
      if (JSON.stringify(want.get(hostId) ?? null) === f.key && !f.ended) continue;
      if (unread.has(hostId) && !f.ended) continue;
      f.stream.stop();
      this.#followers.delete(hostId);
    }
    for (const [hostId, list] of want) {
      if (this.#followers.has(hostId)) continue;
      const opts = { tail: 0, follow: true, since: null, until: null };
      // Per log file: the zone of where it is, from its first line (AUDIT2 AI-12).
      const zones = new Map<number, string>();
      const follower = { key: JSON.stringify(list), ended: false } as { key: string; ended: boolean; stream: Stream };
      // Per run of the stream: the parts of a long line joined (a part left from a run before is dropped with it).
      let read = scriptLines();
      const stream = this.#stream(
        hostId,
        'logs',
        async (client) => ((read = scriptLines()), logsScript(await Promise.all(list.map(async (x, i) => ({ i, command: x.file ? await fileTailCommand(client, { container: x.container, file: x.file }, opts) : logsCommand(x.container, opts) }))))),
        (raw) => {
          const l = read(raw);
          const x = l && list[l.i];
          if (!l || !x) return;
          if ('end' in l) return void (follower.ended = true);
          // Burrow's own end mark, and what docker logs, tail or journalctl said themselves on
          // stderr ("Error response from daemon", "tail: cannot open"): not the log's lines; a rule
          // on "error" fired on them. A container's own lines carry docker's timestamp.
          if (exitLine(l.text) !== null) return;
          if (!x.file) return void (splitTimestamp(l.text) || l.s === 'o' ? this.#onLine(hostId, x.container, x.project, l.text) : undefined);
          if (l.s === 'e') return;
          // A file that is the container's own output: its lines come through the container's log.
          if (l.text.trim() === OUTPUT_MARK) return;
          const zone = l.s === 'o' ? zoneLine(l.text) : null;
          if (zone !== null) return void zones.set(l.i, zone);
          // The alert's subject: the container and the file, as a log target without its host.
          this.#check(hostId, `${x.container}:${encodeURIComponent(x.file)}`, x.container, x.project, fileLineTime(l.text, undefined, zones.get(l.i) ?? null) ?? new Date(this.ctx.now()).toISOString(), l.text);
        },
      );
      follower.stream = stream;
      this.#followers.set(hostId, follower);
    }
  }

  /**
   * A long-running command on a host, line by line; started again when it ends, and after a
   * failed connect only once the host's wait is over (retryAfter). Failures are said once per
   * change (Jobs), not at every try.
   */
  #stream(hostId: number, label: string, command: string | ((client: Client) => Promise<string>), onLine: (line: string) => void): Stream {
    let stopped = false;
    let close: (() => void) | null = null;
    const done = () => stopped || this.#stopped;
    const run = async () => {
      while (!done()) {
        await this.#down.get(hostId)?.wait;
        if (done()) break;
        let connected = false;
        try {
          await this.pool.with(hostId, async ({ client }) => {
            connected = true;
            this.#up(hostId);
            return this.#lines(client, typeof command === 'string' ? command : await command(client), onLine, (c) => ((close = c), this.#told().fine('alerts', `${this.#hostName(hostId)} ${label}`, { hostId })), done);
          });
        } catch (err) {
          if (!connected) {
            this.#failedConnect(hostId, err as Error & { code?: unknown });
            continue;
          }
          this.#told().failed('alerts', `${this.#hostName(hostId)} ${label}`, `stream failed: ${(err as Error).message}`, { hostId });
        }
        if (done()) break;
        await new Promise((r) => setTimeout(r, RETRY_MS).unref());
      }
    };
    void run();
    return {
      stop: () => {
        stopped = true;
        close?.();
      },
    };
  }

  #told(): Jobs {
    return (this.jobs ??= new Jobs(this.ctx));
  }

  #hostName(hostId: number): string {
    return this.ctx.db.select({ name: hosts.name }).from(hosts).where(eq(hosts.id, hostId)).get()?.name ?? String(hostId);
  }

  /** Connected: the host's wait is over, and its failure, if one was said, is said to be over. */
  #up(hostId: number): void {
    if (!this.#down.delete(hostId)) return;
    this.#told().fine('alerts', this.#hostName(hostId), { hostId });
  }

  /** A connect failed: the host waits longer before the next one. Its other stream failing on the same try (the pool's shared connect) adds no wait. */
  #failedConnect(hostId: number, err: Error & { code?: unknown }): void {
    const was = this.#down.get(hostId);
    if (was?.waiting) return;
    const code = typeof err.code === 'string' ? err.code : undefined;
    const down: Down = { failures: (was?.failures ?? 0) + 1, wait: Promise.resolve(), waiting: true };
    const ms = retryAfter(down.failures, code, this.opts.random);
    down.wait = this.#waitOut(hostId, down, ms).finally(() => (down.waiting = false));
    this.#down.set(hostId, down);
    this.#told().failed('alerts', this.#hostName(hostId), `cannot connect (${err.message}); trying again less often while it lasts, at most every ${RETRY_MAX_MS / 60_000} min`, { hostId });
  }

  /** The wait, ended early when what a connect is made with changed (another password, key or trust: worth a try now) or the engine stopped. */
  async #waitOut(hostId: number, down: Down, ms: number): Promise<void> {
    const identity = this.#identity(hostId);
    for (let left = ms; left > 0; left -= RETRY_MS) {
      await new Promise((r) => setTimeout(r, Math.min(left, RETRY_MS)).unref());
      if (this.#stopped || this.#down.get(hostId) !== down) return;
      if (this.#identity(hostId) !== identity) {
        this.#down.delete(hostId);
        return;
      }
    }
  }

  #identity(hostId: number): string | null {
    try {
      return this.pool.identity(hostId);
    } catch {
      // The host gone meanwhile: its streams are stopped by the next round.
      return null;
    }
  }

  #lines(client: Client, command: string, onLine: (line: string) => void, setClose: (c: () => void) => void, cancelled: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      // Stopped while the connection or the channel was still opening: the
      // late channel is closed, not left following on its own (AUDIT2 MON-16).
      if (cancelled()) return resolve();
      client.exec(endsWithChannel(command), (err, ch) => {
        if (err) return reject(err);
        if (cancelled()) {
          ch.close();
          return resolve();
        }
        setClose(() => ch.close());
        const lines = lineSplitter(onLine);
        const onData = (b: Buffer) => lines(b);
        ch.on('data', onData);
        ch.stderr.on('data', onData);
        ch.on('close', () => resolve());
      });
    });
  }

  /** One line of a host's `docker events` stream (public for the tests). */
  onEvent(hostId: number, line: string): void {
    const e = parseEvent(line, this.ctx.config.ignoreLabel);
    if (!e) return;
    // A container Docker named itself, outside compose: a throwaway, no alert (decision 18).
    if (throwaway(e.container, e.project)) return;
    if (e.project && this.quiet?.(hostId, e.project)) return;
    let judge = this.#judges.get(hostId);
    if (!judge) this.#judges.set(hostId, (judge = new EventJudge()));
    for (const h of judge.judge(e)) {
      const rules = this.rules().filter((r) => r.enabled && r.kind === 'event' && r.events.includes(h.event) && covers(r, hostId, e.container, e.project));
      if (!rules.length) continue;
      // The container's last lines say more than "exited with code 1".
      void this.#lastLines(hostId, e.container).then((detail) => {
        for (const r of rules) this.#fireLater(r, hostId, e.container, h.title, detail, e.at);
      });
    }
  }

  async #lastLines(hostId: number, container: string): Promise<string | null> {
    try {
      const r = await this.pool.with(hostId, ({ client }) => exec(client, `docker logs --tail 5 -- ${shellQuote(container)} 2>&1`, 10_000, 64 << 10));
      // Failed is not its output: docker's "No such container" (a --rm container, gone already) went out as the container's last lines (W-FUNC-08).
      if (r.code !== 0) return lastLinesUnread(r.stdout);
      return r.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Trouble on the host itself (host statistics): a full disk, SMART, heat. */
  hostTrouble(hostId: number, t: { subject: string; event: AlertEvent; title: string }, at: string): void {
    for (const r of this.rules()) {
      if (!r.enabled || r.kind !== 'event' || !r.events.includes(t.event)) continue;
      if ((r.hostId !== null && r.hostId !== hostId) || r.container || r.project) continue;
      this.#fireLater(r, hostId, t.subject, t.title, null, at);
    }
  }

  #onLine(hostId: number, container: string, project: string | null, raw: string): void {
    const split = splitTimestamp(raw);
    this.#check(hostId, container, container, project, split?.ts ?? new Date(this.ctx.now()).toISOString(), split?.text ?? raw);
  }

  // A rule's pattern, compiled once (RE2: linear in the line, whatever the pattern).
  readonly #matchers = new Map<string, ((text: string) => boolean) | null>();
  #matcher(pattern: string): ((text: string) => boolean) | null {
    let m = this.#matchers.get(pattern);
    if (m === undefined) {
      const c = linearMatcher(pattern);
      m = c instanceof Error ? null : c;
      if (this.#matchers.size > 500) this.#matchers.clear();
      this.#matchers.set(pattern, m);
    }
    return m;
  }

  /** A line against the rules: `subject` is what an alert is about (a container, or a container's log file). */
  #check(hostId: number, subject: string, container: string, project: string | null, at: string, text: string): void {
    if (project && this.quiet?.(hostId, project)) return;
    for (const r of this.rules()) {
      if (!r.enabled || !covers(r, hostId, container, project)) continue;
      if (r.kind === 'pattern' && r.pattern) {
        const match = this.#matcher(r.pattern);
        if (match && match(text)) this.#fireLater(r, hostId, subject, `log matches "${r.pattern}"`, text, at);
      } else if (r.kind === 'rate' && r.threshold && r.windowMinutes) {
        const level = detectLevel(text);
        if (level !== 'error' && level !== 'fatal') continue;
        const key = `${r.id}:${hostId}:${subject}`;
        const now = this.ctx.now();
        const times = [...(this.#errors.get(key) ?? []).filter((t) => now - t < r.windowMinutes! * 60_000), now];
        if (times.length > r.threshold) {
          this.#errors.set(key, []);
          this.#fireLater(r, hostId, subject, `${plural(times.length, 'error', 'errors')} in ${r.windowMinutes} min`, text, at);
        } else this.#errors.set(key, times);
      }
    }
  }

  /** Muted: the subject itself, or (a log file of a container) its container. */
  #muted(hostId: number, container: string): boolean {
    const now = this.ctx.now();
    return this.ctx.db
      .select()
      .from(alertMutes)
      .where(eq(alertMutes.hostId, hostId))
      .all()
      .some((m) => (m.until === null || m.until > now) && muteCovers(m.container, container));
  }

  /** Started in the background (an event, a log line): a failure is logged, never an unhandled rejection (AUDIT2 MON-14). */
  #fireLater(rule: AlertRule, hostId: number, container: string, title: string, detail: string | null, at: string): void {
    this.fire(rule, hostId, container, title, detail, at).catch((err: Error) => this.ctx.log.warn({ hostId }, `alert: ${container} ${title}: ${err.message}`));
  }

  readonly #retriedAt = new Map<number, number>();

  /** Stores an alert (or adds to the one of the last ten minutes of the same kind) and pushes it. */
  async fire(rule: AlertRule, hostId: number, container: string, title: string, detail: string | null, at: string): Promise<void> {
    const now = this.ctx.now();
    // The host or the rule went while the event was being looked at: nothing to store (AUDIT2 MON-14).
    if (!this.ctx.db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, hostId)).get()) return;
    if (!this.ctx.db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, rule.id)).get()) return;
    const safeDetail = detail ? maskText(detail, { ips: false }).slice(0, 1000) : null;
    // Bundled with one of the same kind only: a crash and an unhealthy check
    // of one container are two alerts, each with its own count (AUDIT2 MON-11).
    const kind = alertKind(title);
    const recent = this.ctx.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.ruleId, rule.id), eq(alerts.hostId, hostId), eq(alerts.container, container), gt(alerts.updatedAt, now - BUNDLE_MS)))
      .orderBy(desc(alerts.id))
      .all()
      .find((a) => alertKind(a.title) === kind);
    const muted = this.#muted(hostId, container);
    if (recent) {
      this.ctx.db
        .update(alerts)
        .set({ count: recent.count + 1, title, detail: safeDetail ?? recent.detail, updatedAt: now, read: false })
        .where(eq(alerts.id, recent.id))
        .run();
      this.#count(recent.id, now);
      this.ctx.log.info({ hostId }, `alert: ${container} ${title} (bundled, ${recent.count + 1}x)`);
      // Still happening after its mute ended, or its push failed: told now
      // (a failed one at most every few minutes), not kept quiet for as long
      // as it recurs (AUDIT2 MON-12).
      const retry = recent.pushed === 'failed' && now - (this.#retriedAt.get(recent.id) ?? recent.createdAt) >= BUNDLE_MS / 2;
      if ((recent.pushed === 'muted' && !muted) || retry) {
        this.#retriedAt.set(recent.id, now);
        const row = { ...recent, count: recent.count + 1, title, detail: safeDetail ?? recent.detail, updatedAt: now, read: false };
        await this.#deliver(rule, row);
      }
      return;
    }
    const row = this.ctx.db
      .insert(alerts)
      .values({ ruleId: rule.id, ruleName: rule.name, hostId, container, title, detail: safeDetail, at, count: 1, read: false, pushed: muted ? 'muted' : 'no', createdAt: now, updatedAt: now })
      .returning()
      .get();
    this.#count(row.id, now);
    this.ctx.log.warn({ hostId }, `alert: ${container} ${title}${muted ? ' (muted)' : ''}`);
    if (!muted) await this.#deliver(rule, row);
    else this.onAlert?.(toAlert(row, this.ctx));
  }

  /** One more of this alert in the minute it happened (reports count by period). */
  #count(alertId: number, now: number): void {
    const minute = Math.floor(now / 60_000);
    this.ctx.db.insert(alertCounts).values({ alertId, minute, n: 1 }).onConflictDoUpdate({ target: [alertCounts.alertId, alertCounts.minute], set: { n: sql`${alertCounts.n} + 1` } }).run();
  }

  async #deliver(rule: AlertRule, row: typeof alerts.$inferSelect): Promise<void> {
    const { hostId, container, title, at } = row;
    const safeDetail = row.detail;
    {
      const hostName = this.ctx.db.select({ name: hosts.name }).from(hosts).where(eq(hosts.id, hostId)).get()?.name ?? String(hostId);
      const host = isHostSubject(container);
      const page = host ? `/hosts/${hostId}/stats` : `/logs?t=${hostId}:${encodeURIComponent(container)}&at=${encodeURIComponent(at)}`;
      const what = subjectLabel(container);
      const r = await this.notifier.notify({
        topic: 'alerts',
        title: `${what} on ${hostName}: ${title}`,
        body: safeDetail ?? `${rule.name}: ${what} ${title}.`,
        page,
        priority: rule.kind === 'event' ? 4 : 3,
        ...(host
          ? {}
          : {
              actions: [
                { label: 'Logs', page },
                { label: 'Analyse', page: `${page}&analyze=1` },
              ],
            }),
        nl: {
          title: `${what} op ${hostName}: ${alertTitle(title, 'nl')}`,
          body: safeDetail ?? `${rule.name}: ${what} ${alertTitle(title, 'nl')}.`,
          ...(host
            ? {}
            : {
                actions: [
                  { label: 'Logs', page },
                  { label: 'Analyseer', page: `${page}&analyze=1` },
                ],
              }),
        },
        data: { hostId, hostName, container, rule: rule.name, title, at },
      });
      const pushed: 'yes' | 'no' | 'failed' = r.sent ? 'yes' : r.failed.length ? 'failed' : 'no';
      this.ctx.db.update(alerts).set({ pushed }).where(eq(alerts.id, row.id)).run();
      row.pushed = pushed;
    }
    this.onAlert?.(toAlert(row, this.ctx));
  }
}

/**
 * Bytes of a stream into lines. A line without end (a binary log, a
 * minified bundle) is checked by its start and the rest dropped up to its
 * newline: held whole it grew without bound (AUDIT2 MON-15).
 */
export function lineSplitter(onLine: (line: string) => void): (b: Buffer) => void {
  const dec = new TextDecoder();
  let pending = '';
  let skipping = false;
  return (b) => {
    pending += dec.decode(b, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      if (line && !skipping) onLine(line);
      skipping = false;
    }
    if (pending.length > MAX_LINE) {
      if (!skipping) onLine(pending.slice(0, MAX_LINE));
      skipping = true;
      pending = '';
    }
  };
}

/** What kind of thing an alert says, its numbers aside: "exited with code 1" and "... 137" are one kind, "unhealthy" another. */
export function alertKind(title: string): string {
  return title.replace(/\d+(\.\d+)?/g, '#');
}

export function toAlert(r: typeof alerts.$inferSelect, ctx: Ctx): Alert {
  const hostName = ctx.db.select({ name: hosts.name }).from(hosts).where(eq(hosts.id, r.hostId)).get()?.name ?? String(r.hostId);
  return {
    id: r.id,
    ruleId: r.ruleId,
    ruleName: r.ruleName,
    hostId: r.hostId,
    hostName,
    container: r.container,
    title: r.title,
    detail: r.detail,
    at: r.at,
    count: r.count,
    read: r.read,
    pushed: r.pushed,
  };
}
