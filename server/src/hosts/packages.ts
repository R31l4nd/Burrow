import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { packageSummary, parsePackageCheck, plural, PKG_AGE, PKG_EXIT, PKG_MARK, PKG_REBOOT, PKG_SECURITY, type PackageReport, type PackageSummary } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { hostPackages, hosts } from '../db/schema.js';
import type { SftpPool } from '../files/pool.js';
import { actor, HttpError, idParam } from '../http.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { getHost, hostPassword } from './service.js';
import type { TroubleSink } from './stats.js';

// A host's package updates, read as its package manager has them: no
// refresh and no root (Debian and Ubuntu fetch their lists by themselves
// every day; the age of the lists is said, and old lists can be fetched
// again at a press, through sudo: refresh). Every six hours with the host
// statistics, and on Check now. New security updates raise a Host health
// alert once; the same ones next time do not.

export const PACKAGES_MS = 6 * 3600_000;

/** The check, in sh: the first package manager found, its list with its exit code, the lists' age, a restart asked for. */
export const PACKAGES_COMMAND = [
  'export LC_ALL=C',
  'if command -v apt >/dev/null 2>&1 && [ -d /var/lib/apt/lists ]; then',
  `  echo '${PKG_MARK}apt'`,
  // The newest list, or apt's own mark of the last refresh that worked (an unchanged list is not written again).
  `  echo "${PKG_AGE}$(ls -t /var/lib/apt/lists/*Release /var/lib/apt/periodic/update-success-stamp 2>/dev/null | head -n 1 | xargs -r stat -c %Y 2>/dev/null)"`,
  `  apt list --upgradable; echo "${PKG_EXIT}$?"`,
  'elif command -v dnf >/dev/null 2>&1; then',
  `  echo '${PKG_MARK}dnf'`,
  `  echo "${PKG_AGE}$(ls -td /var/cache/dnf/* /var/cache/libdnf5/* 2>/dev/null | head -n 1 | xargs -r stat -c %Y 2>/dev/null)"`,
  `  dnf -q -C check-update; echo "${PKG_EXIT}$?"`,
  `  echo '${PKG_SECURITY}'`,
  `  dnf -q -C updateinfo list --security 2>/dev/null; echo "${PKG_EXIT}$?"`,
  'elif command -v apk >/dev/null 2>&1; then',
  `  echo '${PKG_MARK}apk'`,
  `  echo "${PKG_AGE}$(ls -t /var/cache/apk/APKINDEX* 2>/dev/null | head -n 1 | xargs -r stat -c %Y 2>/dev/null)"`,
  `  apk list -u 2>/dev/null; echo "${PKG_EXIT}$?"`,
  'elif command -v pacman >/dev/null 2>&1; then',
  `  echo '${PKG_MARK}pacman'`,
  `  echo "${PKG_AGE}$(ls -t /var/lib/pacman/sync/*.db 2>/dev/null | head -n 1 | xargs -r stat -c %Y 2>/dev/null)"`,
  `  pacman -Qu; echo "${PKG_EXIT}$?"`,
  'else',
  `  echo '${PKG_MARK}none'`,
  'fi',
  `if [ -f /var/run/reboot-required ] || { command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; }; then echo '${PKG_REBOOT}yes'; else echo '${PKG_REBOOT}no'; fi`,
].join('\n');

/** Exit code: no package manager whose lists Burrow refreshes (pacman: a sync without the upgrade is a partial upgrade). */
export const NO_REFRESH = 3;

/**
 * The package lists fetched again (report 1f6c0c: a host's own daily refresh
 * was off and its lists a month old). As root, or through sudo with the
 * host's stored password, else sudo -n; apt marks it as its daily refresh does.
 */
export function refreshCommand(password: string | null): string {
  const sudo = password !== null ? "sudo -S -p ''" : 'sudo -n';
  const script = [
    'export LC_ALL=C DEBIAN_FRONTEND=noninteractive',
    'if command -v apt-get >/dev/null 2>&1 && [ -d /var/lib/apt/lists ]; then apt-get -q update && mkdir -p /var/lib/apt/periodic && touch /var/lib/apt/periodic/update-success-stamp',
    'elif command -v dnf >/dev/null 2>&1; then dnf -q makecache',
    'elif command -v apk >/dev/null 2>&1; then apk update -q',
    `else echo 'no package manager whose lists Burrow refreshes' >&2; exit ${NO_REFRESH}`,
    'fi',
  ].join('\n');
  return `if [ "$(id -u)" = 0 ]; then sh -c ${shellQuote(script)}; else ${sudo} sh -c ${shellQuote(script)}; fi`;
}

export class PackageChecks {
  onTrouble: TroubleSink | null = null;
  readonly #runs = new Map<number, Promise<PackageReport>>();

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
  ) {}

  /** A check now; one at a time per host, shared by whoever asks meanwhile. */
  check(hostId: number): Promise<PackageReport> {
    const running = this.#runs.get(hostId);
    if (running) return running;
    const run = this.#checkNow(hostId).finally(() => this.#runs.delete(hostId));
    this.#runs.set(hostId, run);
    return run;
  }

  async #checkNow(hostId: number): Promise<PackageReport> {
    const at = new Date(this.ctx.now()).toISOString();
    let report: PackageReport;
    try {
      const r = await this.pool.with(hostId, ({ client }) => exec(client, PACKAGES_COMMAND, 120_000, 4 << 20));
      report = r.truncated ? { ...parsePackageCheck(hostId, at, ''), message: 'The answer was larger than Burrow reads (4 MB).' } : parsePackageCheck(hostId, at, r.stdout, r.stderr);
    } catch (err) {
      report = { hostId, checkedAt: at, state: 'error', manager: null, listAt: null, updates: [], security: 0, reboot: false, message: (err as Error).message };
    }
    const before = this.last(hostId);
    const now = Date.parse(at);
    this.ctx.db
      .insert(hostPackages)
      .values({ hostId, checkedAt: now, report: JSON.stringify(report) })
      .onConflictDoUpdate({ target: hostPackages.hostId, set: { checkedAt: now, report: JSON.stringify(report) } })
      .run();
    // Security updates not there at the last check that read the list: told once.
    if (report.state === 'ok') {
      const known = new Set(before?.state === 'ok' ? before.updates.filter((u) => u.security).map((u) => `${u.name} ${u.to}`) : []);
      const fresh = report.updates.filter((u) => u.security && !known.has(`${u.name} ${u.to}`));
      if (fresh.length) {
        const names = fresh.slice(0, 5).map((u) => u.name).join(', ') + (fresh.length > 5 ? ', ...' : '');
        this.onTrouble?.(hostId, { subject: '@packages', event: 'updates', title: `${plural(report.security, 'security update', 'security updates')} waiting: ${names}` }, at);
      }
    }
    return report;
  }

  /** The lists fetched again on the host, then checked; refused with the host's words when that failed. */
  async refresh(hostId: number): Promise<PackageReport> {
    const password = hostPassword(this.ctx, hostId);
    const r = await this.pool.with(hostId, ({ client }) => exec(client, refreshCommand(password), 300_000, 1 << 20, password !== null ? `${password}\n` : undefined));
    const why = r.stderr.trim().split('\n').pop() || `exit ${r.code}`;
    if (r.code === NO_REFRESH) throw new HttpError(400, 'refresh_unsupported', why);
    if (r.code !== 0) throw new HttpError(400, 'refresh_failed', why);
    return this.check(hostId);
  }

  last(hostId: number): PackageReport | null {
    const r = this.ctx.db.select().from(hostPackages).where(eq(hostPackages.hostId, hostId)).get();
    return r ? (JSON.parse(r.report) as PackageReport) : null;
  }

  /** Every host's last check, for the host list, the widget and the reports. */
  all(): PackageSummary[] {
    return this.ctx.db
      .select()
      .from(hostPackages)
      .all()
      .map((r) => packageSummary(JSON.parse(r.report) as PackageReport));
  }

  /** Checked when the last check is older than six hours (or there is none); a failure is kept as the check's state. */
  async checkIfDue(hostId: number): Promise<void> {
    const last = this.ctx.db.select({ checkedAt: hostPackages.checkedAt }).from(hostPackages).where(eq(hostPackages.hostId, hostId)).get();
    if (last && this.ctx.now() - last.checkedAt < PACKAGES_MS) return;
    // Only hosts Burrow could read (facts): one never reached is not checked over and over.
    const h = this.ctx.db.select({ facts: hosts.facts }).from(hosts).where(eq(hosts.id, hostId)).get();
    if (!h?.facts) return;
    await this.check(hostId);
  }
}

// Reading the last check is for operators too; checking now (a command on the host) is for admins, as SMART.
export function registerPackageRoutes(app: FastifyInstance, ctx: Ctx, checks: PackageChecks): void {
  app.get('/api/hosts/packages', { config: { auth: 'user' } }, async (): Promise<PackageSummary[]> => checks.all());

  app.get('/api/hosts/:id/packages', { config: { auth: 'user' } }, async (req): Promise<PackageReport | null> => {
    const id = idParam(req);
    getHost(ctx, id);
    return checks.last(id);
  });

  app.post('/api/hosts/:id/packages', async (req): Promise<PackageReport> => {
    const id = idParam(req);
    const host = getHost(ctx, id);
    const r = await checks.check(id);
    audit(ctx, actor(req), 'host.packages', host.name, { state: r.state, updates: r.updates.length, security: r.security });
    return r;
  });

  // Fetching the lists again changes the host (through sudo): an admin's, confirmed afresh.
  app.post('/api/hosts/:id/packages/refresh', { config: { stepUp: true } }, async (req): Promise<PackageReport> => {
    const id = idParam(req);
    const host = getHost(ctx, id);
    const r = await checks.refresh(id);
    audit(ctx, actor(req), 'host.packages.refresh', host.name, { state: r.state, updates: r.updates.length, security: r.security });
    return r;
  });
}
