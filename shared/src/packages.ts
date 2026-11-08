// A host's package updates: what its package manager says can be updated,
// read as it is (no refresh, no root), with the security updates apart and
// whether the host asks for a restart. Pure parsing here; the command is in
// server/src/hosts/packages.ts. Debian and Ubuntu refresh their lists by
// themselves (apt-daily), so the age of the lists is said with them.

export type PackageManager = 'apt' | 'dnf' | 'apk' | 'pacman';

export interface PackageUpdate {
  name: string;
  /** The version installed, when the manager says it. */
  from: string | null;
  to: string;
  security: boolean;
}

export interface PackageReport {
  hostId: number;
  checkedAt: string;
  /** ok: read; none: no package manager Burrow knows; error: it could not be read (never "nothing to update"). */
  state: 'ok' | 'none' | 'error';
  manager: PackageManager | null;
  /** When the package lists were last fetched on the host, when that can be told. */
  listAt: string | null;
  updates: PackageUpdate[];
  security: number;
  /** The host asks for a restart (/var/run/reboot-required, needs-restarting -r). */
  reboot: boolean;
  message: string | null;
}

/** What the host list, the widget and a report show of a host's last check. */
export interface PackageSummary {
  hostId: number;
  checkedAt: string;
  state: PackageReport['state'];
  total: number;
  security: number;
  reboot: boolean;
  listAt: string | null;
}

export const packageSummary = (r: PackageReport): PackageSummary => ({ hostId: r.hostId, checkedAt: r.checkedAt, state: r.state, total: r.updates.length, security: r.security, reboot: r.reboot, listAt: r.listAt });

export const PKG_MARK = '@@pkg ';
export const PKG_AGE = '@@age ';
export const PKG_EXIT = '@@burrow-exit ';
export const PKG_SECURITY = '@@security';
export const PKG_REBOOT = '@@reboot ';

/** `apt list --upgradable`: name/suite[,suite] version arch [upgradable from: old]. A suite ending in -security is a security update. */
export function parseAptList(out: string): PackageUpdate[] {
  const list: PackageUpdate[] = [];
  for (const line of out.split('\n')) {
    const m = /^([^\s/]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/.exec(line.trim());
    if (!m) continue;
    list.push({ name: m[1]!, from: m[4]?.trim() ?? null, to: m[3]!, security: m[2]!.split(',').some((s) => /-security$/.test(s)) });
  }
  return list;
}

/** `dnf check-update`: name.arch version repo; obsoletes after their header are left out. */
export function parseDnfList(out: string): PackageUpdate[] {
  const list: PackageUpdate[] = [];
  for (const line of out.split('\n')) {
    if (/^Obsoleting packages/i.test(line.trim())) break;
    const m = /^(\S+)\.([A-Za-z0-9_]+)\s+(\S+)\s+\S+\s*$/.exec(line.trim());
    if (!m || /^(Last metadata|Security:)/i.test(line)) continue;
    list.push({ name: m[1]!, from: null, to: m[3]!, security: false });
  }
  return list;
}

/** `dnf updateinfo list --security`: the package names of its advisories (the NEVRA column, name-[epoch:]version-release.arch). */
export function parseDnfSecurity(out: string): Set<string> {
  const names = new Set<string>();
  for (const line of out.split('\n')) {
    for (const f of line.trim().split(/\s+/)) {
      const m = /^(.+)-[^-]+-[^-]+\.(x86_64|aarch64|armv7hl|i686|noarch|ppc64le|s390x)$/.exec(f);
      if (m) names.add(m[1]!);
    }
  }
  return names;
}

/** `apk list -u`: name-version-rN arch {origin} (license) [upgradable from: name-old]. */
export function parseApkList(out: string): PackageUpdate[] {
  const list: PackageUpdate[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)-(\d[^-\s]*-r\d+)\s.*\[upgradable from:\s*(\S+?)\]/.exec(line.trim());
    if (!m) continue;
    const old = new RegExp(`^${m[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(.+)$`).exec(m[3]!);
    list.push({ name: m[1]!, from: old ? old[1]! : m[3]!, to: m[2]!, security: false });
  }
  return list;
}

/** `pacman -Qu`: name old -> new, maybe [ignored] (those left out). */
export function parsePacmanList(out: string): PackageUpdate[] {
  const list: PackageUpdate[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line.trim());
    if (m) list.push({ name: m[1]!, from: m[2]!, to: m[3]!, security: false });
  }
  return list;
}

const MANAGERS: PackageManager[] = ['apt', 'dnf', 'apk', 'pacman'];

/** The check's whole output: which manager, its list (and dnf's security list), each with its exit code, the age, the restart. */
export function parsePackageCheck(hostId: number, checkedAt: string, out: string, stderr = ''): PackageReport {
  const base = { hostId, checkedAt, listAt: null, updates: [], security: 0, message: null };
  const lines = out.split('\n');
  const reboot = lines.some((l) => l.trim() === `${PKG_REBOOT}yes`);
  const said = lines.find((l) => l.startsWith(PKG_MARK))?.slice(PKG_MARK.length).trim() ?? '';
  if (said === 'none') return { ...base, state: 'none', manager: null, reboot };
  const manager = MANAGERS.find((m) => m === said) ?? null;
  const why = (fallback: string) => stderr.trim().split('\n').filter((l) => l && !/^WARNING: apt does not have a stable CLI/.test(l)).pop() ?? fallback;
  if (!manager) return { ...base, state: 'error', manager: null, reboot, message: why('The check said nothing about a package manager.') };
  const age = Number(lines.find((l) => l.startsWith(PKG_AGE))?.slice(PKG_AGE.length).trim());
  const listAt = Number.isFinite(age) && age > 0 ? new Date(age * 1000).toISOString() : null;
  // The parts between the markers: the list, then (dnf) its security advisories.
  const parts: { body: string[]; code: number | null }[] = [{ body: [], code: null }];
  for (const l of lines) {
    if (l.startsWith(PKG_MARK) || l.startsWith(PKG_AGE) || l.startsWith(PKG_REBOOT)) continue;
    const cur = parts[parts.length - 1]!;
    if (l.startsWith(PKG_EXIT)) cur.code = Number(l.slice(PKG_EXIT.length));
    else if (l.trim() === PKG_SECURITY) parts.push({ body: [], code: null });
    else cur.body.push(l);
  }
  const list = parts[0]!;
  // dnf check-update: 100 means updates are there, 0 none; pacman -Qu: 1 with nothing said means none. Anything else failed.
  const ok = (code: number | null) => code === 0 || (manager === 'dnf' && code === 100) || (manager === 'pacman' && code === 1 && !stderr.trim());
  if (list.code === null) return { ...base, state: 'error', manager, listAt, reboot, message: 'The check was cut short.' };
  if (!ok(list.code)) return { ...base, state: 'error', manager, listAt, reboot, message: why(`${manager} exited with ${list.code}`) };
  const body = list.body.join('\n');
  let updates = manager === 'apt' ? parseAptList(body) : manager === 'dnf' ? parseDnfList(body) : manager === 'apk' ? parseApkList(body) : parsePacmanList(body);
  const sec = parts[1];
  if (manager === 'dnf' && sec && sec.code === 0) {
    const names = parseDnfSecurity(sec.body.join('\n'));
    updates = updates.map((u) => ({ ...u, security: names.has(u.name) }));
  }
  updates.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
  return { ...base, state: 'ok', manager, listAt, reboot, updates, security: updates.filter((u) => u.security).length };
}
