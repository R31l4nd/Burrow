import { and, eq, gte, lt } from 'drizzle-orm';
import { judgeDisk, plural, sameDisk, sensorLabel, type DiskActivity, type DiskAttr, type DiskHistory, type DiskUsage, type HostSample, type HostStats, type SmartDisk, type SmartReport, type Temperature } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { hostDiskSamples, hostSamples, hostSmart, hostSmartHistory, hosts } from '../db/schema.js';
import type { SftpPool } from '../files/pool.js';
import { HttpError } from '../http.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { activityCommand, counterRows, diskSamples, IO_BEFORE, IO_AFTER, parseActivity, statsIo, SUDO_OK } from './diskio.js';
import { ownLimits, setOwnLimits, type OwnLimits } from './limits.js';
import { hostPassword } from './service.js';
import { eachLimited, type Jobs } from '../jobs.js';
import type { PackageChecks } from './packages.js';

// A host's own numbers, read over SSH with what every Linux has (/proc,
// /sys, df) in one command; SMART with smartctl through sudo (the stored
// password, or sudo -n), less often. A sample every few minutes goes into
// the history (a month) for the graphs, and trouble - a full disk, a
// failing or worn disk, heat - raises a host alert.

export const STATS_COMMAND = [
  // The disks' counters around the same second as the CPU's (diskio.ts).
  `echo @@cpu; head -n1 /proc/stat; ${IO_BEFORE}; sleep 1; head -n1 /proc/stat`,
  "echo @@mem; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  'echo @@load; cat /proc/loadavg; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
  'echo @@up; cat /proc/uptime',
  // GNU df knows -T and -x; busybox does not: then without the type.
  'echo @@df; df -P -T -B1 -x tmpfs -x devtmpfs -x squashfs -x efivarfs 2>/dev/null || { echo @@df-plain; df -P -k; }',
  'echo @@temp',
  'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && echo "zone:$(cat $z/type 2>/dev/null) $(cat $z/temp)"; done 2>/dev/null',
  'for h in /sys/class/hwmon/hwmon*; do n=$(cat $h/name 2>/dev/null); for t in $h/temp*_input; do [ -r "$t" ] && echo "$n:$(basename $t _input) $(cat $t)"; done; done 2>/dev/null',
  IO_AFTER,
  'true',
].join('\n');

/**
 * What the stats command left out that every Linux has: then the numbers
 * are not read (no zeros that look like an idle host). Null when complete.
 */
export function statsGap(out: string): string | null {
  const after = (mark: string) => out.split(`@@${mark}\n`)[1]?.split(/\n@@/)[0]?.split('\n').filter((l) => l.trim()) ?? [];
  if (after('cpu').filter((l) => /^cpu\s+\d/.test(l)).length < 2) return '/proc/stat';
  if (!after('mem').some((l) => /^MemTotal:\s+[1-9]/.test(l))) return '/proc/meminfo';
  if (!/^\d/.test(after('up')[0] ?? '')) return '/proc/uptime';
  // Each number read, or none: a missing one became 0 (no load, no disk use) or a full memory (AUDIT2 MON-08).
  if (!after('mem').some((l) => /^MemAvailable:\s+\d/.test(l))) return '/proc/meminfo';
  if (!/^\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s/.test(after('load')[0] ?? '')) return '/proc/loadavg';
  if (![...after('df'), ...after('df-plain')].some((l) => /^Filesystem\s/.test(l))) return 'df';
  return null;
}

// Kernel and runtime mounts, and the files Docker mounts into a container.
const IGNORE_MOUNTS = /^\/(proc|sys|dev|run)(\/|$)|^\/snap\/|\/docker\/|\/containers\/storage\/|^\/etc\/(hosts|hostname|resolv\.conf)$/;

/** The stats command's answer by section ("@@name"), and what a marker line carried after its name. */
export function statsSections(out: string): { sec: Map<string, string[]>; markers: Map<string, string> } {
  const sec = new Map<string, string[]>();
  const markers = new Map<string, string>();
  let cur = '';
  for (const line of out.split('\n')) {
    const m = /^@@([\w-]+)(?: (.*))?$/.exec(line.trim());
    if (m) {
      cur = m[1]!;
      sec.set(cur, []);
      markers.set(cur, m[2] ?? '');
    } else if (cur && line.trim()) sec.get(cur)!.push(line);
  }
  return { sec, markers };
}

export function parseStats(hostId: number, out: string, at: number): HostStats {
  const { sec, markers } = statsSections(out);
  // CPU: two samples of the first line of /proc/stat.
  const cpuLines = (sec.get('cpu') ?? []).map((l) => l.trim().split(/\s+/).slice(1).map(Number));
  let cpu = 0;
  if (cpuLines.length >= 2) {
    const [a, b] = cpuLines as [number[], number[]];
    const idle = (x: number[]) => (x[3] ?? 0) + (x[4] ?? 0);
    const total = cpuTotal;
    const dt = total(b) - total(a);
    cpu = dt > 0 ? Math.round(((dt - (idle(b) - idle(a))) / dt) * 1000) / 10 : 0;
  }
  const mem = Object.fromEntries((sec.get('mem') ?? []).map((l) => [l.split(':')[0], Number(l.split(':')[1]!.trim().split(/\s+/)[0]) * 1024]));
  const [loadLine = '', coresLine = '1'] = sec.get('load') ?? [];
  const lp = loadLine.split(/\s+/).map(Number);
  const disks: DiskUsage[] = [];
  const typed = sec.has('df') && !sec.has('df-plain');
  for (const line of (typed ? sec.get('df') : sec.get('df-plain')) ?? []) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'Filesystem') continue;
    if (typed && p.length >= 7) {
      const mount = p.slice(6).join(' ');
      // An overlay only as the root (a host that is itself a container).
      if (IGNORE_MOUNTS.test(mount) || (p[1] === 'overlay' && mount !== '/')) continue;
      disks.push({ device: p[0]!, fs: p[1]!, sizeBytes: Number(p[2]), usedBytes: Number(p[3]), mount });
    } else if (!typed && p.length >= 6) {
      const mount = p.slice(5).join(' ');
      if (IGNORE_MOUNTS.test(mount) || /^(tmpfs|devtmpfs|shm|none)$/.test(p[0]!) || (p[0] === 'overlay' && mount !== '/')) continue;
      disks.push({ device: p[0]!, fs: '', sizeBytes: Number(p[1]) * 1024, usedBytes: Number(p[2]) * 1024, mount });
    }
  }
  // The same filesystem mounted twice (bind mounts) counts once.
  const seen = new Set<string>();
  const uniq = disks.filter((d) => d.sizeBytes > 0 && !seen.has(`${d.device}|${d.sizeBytes}`) && seen.add(`${d.device}|${d.sizeBytes}`));
  const temps: Temperature[] = [];
  for (const line of sec.get('temp') ?? []) {
    const m = /^(.+?) (-?\d+)$/.exec(line.trim());
    if (!m) continue;
    const c = Number(m[2]) / 1000;
    if (c <= 0 || c > 150) continue;
    temps.push({ label: m[1]!.replace(/^zone:/, ''), celsius: Math.round(c * 10) / 10 });
  }
  return {
    hostId,
    at: new Date(at).toISOString(),
    cpu,
    cores: Number(coresLine) || 1,
    load: [lp[0] || 0, lp[1] || 0, lp[2] || 0],
    memTotal: mem.MemTotal ?? 0,
    memUsed: (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0),
    swapTotal: mem.SwapTotal ?? 0,
    swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0),
    uptimeSeconds: Math.round(Number((sec.get('up') ?? ['0'])[0]!.split(/\s+/)[0]) || 0),
    disks: uniq,
    temps,
    ...statsIo(sec, markers),
  };
}

// ---- SMART

/** smartctl for every disk it finds, as JSON, each after a marker line. */
export const SMART_SCRIPT = [
  'command -v smartctl >/dev/null 2>&1 || PATH="$PATH:/usr/sbin:/sbin"; command -v smartctl >/dev/null 2>&1 || { echo @@nosmart; exit 0; }',
  // A scan that failed is said, not taken for "no disks" (AUDIT2 MON-09).
  'list=$($SC --scan) || { echo @@scanfailed; exit 3; }',
  // -n standby: a disk that sleeps is not woken for this; it says so and is skipped this time (decision 5).
  'printf "%s\\n" "$list" | while read -r dev _ type _; do [ -n "$dev" ] || continue; echo "@@dev $dev"; $SC -j -n standby -H -A -i -d "$type" "$dev"; done',
].join('\n');

/**
 * With the host's password: the whole script through one sudo. Without:
 * each smartctl through `sudo -n smartctl`, so the sudoers line the help
 * shows (NOPASSWD: /usr/sbin/smartctl) is enough (AUDIT2 SMART-08; it ran
 * `sudo sh`, which that line does not allow).
 */
export function smartCommand(password: string | null): string {
  if (password !== null) return `sudo -S -p '' env SC=smartctl sh -c ${shellQuote(SMART_SCRIPT)}`;
  return `SC='sudo -n smartctl' sh -c ${shellQuote(SMART_SCRIPT)}`;
}

interface SmartJson {
  smartctl?: { messages?: { string?: string; severity?: string }[]; exit_status?: number };
  model_name?: string;
  model_family?: string;
  serial_number?: string;
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  ata_smart_attributes?: { table?: { id: number; raw?: { value?: number } }[] };
  nvme_smart_health_information_log?: { percentage_used?: number; media_errors?: number; temperature?: number; critical_warning?: number };
}

/**
 * What a SMART run says: ok only with disks that answered; a run that
 * failed, or disks that gave no readable answer, is an error (not "fine").
 */
export function smartOutcome(code: number | null, stdout: string, stderr: string): Pick<SmartReport, 'state' | 'message' | 'disks'> {
  const last = (s: string) => s.trim().split('\n').pop() || null;
  if (stdout.includes('@@nosmart')) return { state: 'none', message: 'smartctl is not installed (smartmontools).', disks: [] };
  const denied = /password is required|incorrect password|not in the sudoers|may not run sudo|sudo: .*not found|no tty present/i;
  if (stdout.includes('@@scanfailed')) return denied.test(stderr) ? { state: 'denied', message: last(stderr) ?? 'sudo refused', disks: [] } : { state: 'error', message: last(stderr) ?? 'smartctl --scan failed', disks: [] };
  const devices = [...stdout.matchAll(/^@@dev (.+)$/gm)].map((m) => m[1]!.trim());
  if (!devices.length) {
    if (denied.test(stderr)) return { state: 'denied', message: last(stderr) ?? 'sudo refused', disks: [] };
    if (code !== 0) return { state: 'error', message: last(stderr) ?? `exit ${code}`, disks: [] };
    return { state: 'none', message: 'smartctl found no disks.', disks: [] };
  }
  const disks = parseSmart(stdout);
  // Disks that gave no answer, and those whose answer says smartctl could not read them.
  const silent = [...devices.filter((d) => !disks.some((x) => x.device === d)), ...disks.filter((d) => d.unread).map((d) => (d.note ? `${d.device} (${d.note.replace(/\.$/, '')})` : d.device))];
  const asleep = disks.filter((d) => d.asleep).map((d) => d.device);
  if (!disks.some((d) => !d.unread)) return { state: 'error', message: `No readable answer from ${silent.join(', ')}.`, disks: [] };
  const said = [silent.length ? `No readable answer from ${silent.join(', ')}.` : '', asleep.length ? `Asleep, not woken: ${asleep.join(', ')}.` : ''].filter(Boolean).join(' ');
  return { state: 'ok', message: said || null, disks };
}

export function parseSmart(out: string): SmartDisk[] {
  const disks: SmartDisk[] = [];
  const parts = out.split(/^@@dev /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const device = part.slice(0, nl).trim();
    let j: SmartJson;
    try {
      j = JSON.parse(part.slice(nl + 1)) as SmartJson;
    } catch {
      continue;
    }
    const attr = (id: number) => j.ata_smart_attributes?.table?.find((a) => a.id === id)?.raw?.value ?? null;
    const nvme = j.nvme_smart_health_information_log;
    // 0 C is smartctl's "no temperature" (a USB enclosure, for one), not a reading.
    const celsius = j.temperature?.current || nvme?.temperature || null;
    // Why a disk said nothing: smartctl's own words, without the device it repeats.
    const said = (j.smartctl?.messages ?? []).map((m) => (m.string ?? '').replace(/^\/dev\/\S+:\s*/, '').trim()).filter(Boolean);
    const asleep = j.smart_status?.passed === undefined && said.some((x) => /\b(STANDBY|SLEEP)\b mode/i.test(x));
    disks.push({
      device,
      model: j.model_name ?? j.model_family ?? null,
      serial: j.serial_number ?? null,
      passed: j.smart_status?.passed ?? null,
      celsius,
      powerOnHours: j.power_on_time?.hours ?? null,
      reallocated: attr(5),
      pending: attr(197),
      percentUsed: nvme?.percentage_used ?? null,
      mediaErrors: nvme?.media_errors ?? null,
      uncorrectable: attr(187),
      timeouts: attr(188),
      offlineUncorrectable: attr(198),
      criticalWarning: nvme?.critical_warning ?? null,
      ...(said.length && !asleep ? { note: said.map((x) => (/[.!?]$/.test(x) ? x : `${x}.`)).join(' ').slice(0, 300) } : {}),
      // Asleep, and left so (-n standby): nothing read, nothing wrong.
      ...(asleep ? { asleep: true } : {}),
      // smartctl could not run as asked, open the disk, or send its SMART
      // command (exit bits 0-2) and said nothing of its health: valid JSON,
      // not a reading.
      ...(!asleep && ((j.smartctl?.exit_status ?? 0) & 7) !== 0 && j.smart_status?.passed === undefined ? { unread: true } : {}),
    });
  }
  return disks;
}

// ---- trouble

export interface Thresholds {
  diskPercent: number;
  cpuCelsius: number;
  diskCelsius: number;
  nvmeWearPercent: number;
  /** Busy: the CPU's average over a whole sample interval, and memory over two samples in a row. */
  cpuPercent: number;
  memPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { diskPercent: 90, cpuCelsius: 85, diskCelsius: 60, nvmeWearPercent: 90, cpuPercent: 90, memPercent: 95 };

export interface Trouble {
  /** What it is about: "@disk /data", "@smart /dev/sda", "@temperature". */
  subject: string;
  event: 'disk_full' | 'smart' | 'hot' | 'busy' | 'updates' | 'scheduled';
  title: string;
}

/** The CPU's counters (all and idle jiffies) at the end of a stats sample. */
export function cpuCounters(out: string): { total: number; idle: number } | null {
  const lines = (out.split('@@cpu\n')[1] ?? '').split('\n').filter((l) => /^cpu\s+\d/.test(l));
  const x = lines.at(-1)?.trim().split(/\s+/).slice(1).map(Number);
  if (!x || x.length < 4) return null;
  return { total: cpuTotal(x), idle: (x[3] ?? 0) + (x[4] ?? 0) };
}

/** All of /proc/stat's CPU time but guest and guest_nice: those are already in user and nice (AUDIT2 MON-24). */
function cpuTotal(x: number[]): number {
  return x.slice(0, 8).reduce((s, v) => s + (v || 0), 0);
}

/**
 * A short peak is not trouble (Beszel's "for 5 minutes"): the CPU counts
 * when its average over the whole interval since the last sample is high;
 * memory and heat when two samples in a row are. `streak` is carried from
 * sample to sample.
 */
export function sustainedTrouble(
  s: HostStats,
  cpu: { percent: number; minutes: number } | null,
  streak: { hot: number; mem: number },
  t: Thresholds,
): { troubles: Trouble[]; streak: { hot: number; mem: number } } {
  const now = statsTrouble(s, t);
  const hot = now.some((x) => x.event === 'hot') ? streak.hot + 1 : 0;
  const memPct = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
  const mem = memPct >= t.memPercent ? streak.mem + 1 : 0;
  const troubles = now.filter((x) => x.event !== 'hot' || hot >= 2);
  if (cpu && cpu.percent >= t.cpuPercent) troubles.push({ subject: '@cpu', event: 'busy', title: `CPU at ${Math.round(cpu.percent)}% for ${cpu.minutes} minutes` });
  if (mem >= 2) troubles.push({ subject: '@memory', event: 'busy', title: `memory ${memPct}% full for ${mem * Math.round(SAMPLE_MS / 60_000)} minutes` });
  return { troubles, streak: { hot, mem } };
}

export function statsTrouble(s: HostStats, t: Thresholds): Trouble[] {
  const out: Trouble[] = [];
  for (const d of s.disks) {
    const pct = (d.usedBytes / d.sizeBytes) * 100;
    if (pct >= t.diskPercent) out.push({ subject: `@disk ${d.mount}`, event: 'disk_full', title: `disk ${Math.floor(pct)}% full` });
  }
  const hot = s.temps.filter((x) => x.celsius >= t.cpuCelsius).sort((a, b) => b.celsius - a.celsius)[0];
  if (hot) out.push({ subject: '@temperature', event: 'hot', title: `${sensorLabel(hot.label)} at ${hot.celsius} C` });
  return out;
}

const ATTR_WORDS: Record<DiskAttr, [string, string]> = {
  reallocated: ['reallocated sector', 'reallocated sectors'],
  pending: ['pending sector', 'pending sectors'],
  uncorrectable: ['uncorrectable error', 'uncorrectable errors'],
  offlineUncorrectable: ['unreadable sector', 'unreadable sectors'],
  timeouts: ['command timeout', 'command timeouts'],
  mediaErrors: ['media error', 'media errors'],
};

export function smartTrouble(disks: SmartDisk[], before: SmartDisk[], t: Thresholds): Trouble[] {
  const out: Trouble[] = [];
  for (const d of disks) {
    const prev = before.find((b) => b.device === d.device && b.serial === d.serial);
    const subject = `@smart ${d.device}`;
    if (d.passed === false) out.push({ subject, event: 'smart', title: 'SMART says the disk is failing' });
    else if (prev && (d.reallocated ?? 0) > (prev.reallocated ?? 0)) out.push({ subject, event: 'smart', title: `${plural(d.reallocated!, 'reallocated sector', 'reallocated sectors')} (was ${prev.reallocated ?? 0})` });
    else if (prev && (d.pending ?? 0) > (prev.pending ?? 0)) out.push({ subject, event: 'smart', title: `${plural(d.pending!, 'pending sector', 'pending sectors')} (was ${prev.pending ?? 0})` });
    else if (prev && (d.mediaErrors ?? 0) > (prev.mediaErrors ?? 0)) out.push({ subject, event: 'smart', title: `${plural(d.mediaErrors!, 'media error', 'media errors')} (was ${prev.mediaErrors ?? 0})` });
    else if (prev && (d.uncorrectable ?? 0) > (prev.uncorrectable ?? 0)) out.push({ subject, event: 'smart', title: `${plural(d.uncorrectable!, 'uncorrectable error', 'uncorrectable errors')} (was ${prev.uncorrectable ?? 0})` });
    else if (prev && (d.offlineUncorrectable ?? 0) > (prev.offlineUncorrectable ?? 0)) out.push({ subject, event: 'smart', title: `${plural(d.offlineUncorrectable!, 'unreadable sector', 'unreadable sectors')} (was ${prev.offlineUncorrectable ?? 0})` });
    else if ((d.criticalWarning ?? 0) > 0 && !((prev?.criticalWarning ?? 0) > 0)) out.push({ subject, event: 'smart', title: 'the disk reports a critical warning' });
    else if ((d.percentUsed ?? 0) >= 100 && (prev?.percentUsed ?? 0) < 100) out.push({ subject, event: 'smart', title: `worn out: ${d.percentUsed}% used` });
    else if ((d.percentUsed ?? 0) >= t.nvmeWearPercent && (prev?.percentUsed ?? 0) < t.nvmeWearPercent) out.push({ subject, event: 'smart', title: `worn: ${d.percentUsed}% used` });
    // Judged failing now, and not before: said too, also when no count grew
    // since the last check (it grew since the oldest kept one; AUDIT2 SMART-01).
    else if (d.verdict === 'failing' && prev && prev.verdict !== 'failing') {
      const r = d.reasons?.find((x) => x.code === 'attr' && x.was !== undefined);
      out.push({ subject, event: 'smart', title: r && r.code === 'attr' ? `getting worse: ${plural(r.value, ATTR_WORDS[r.attr][0], ATTR_WORDS[r.attr][1])} (was ${r.was})` : 'the disk is judged failing' });
    }
    if (d.celsius !== null && d.celsius >= t.diskCelsius) out.push({ subject, event: 'hot', title: `disk at ${d.celsius} C` });
  }
  return out;
}

// ---- the service

const SAMPLE_MS = 5 * 60_000;
const SMART_MS = 6 * 3600_000;
/** Longest a host holds the round: within a round's five minutes, the SMART check (two minutes) and package check included. */
export const STATS_HOST_MS = 4 * 60_000;
const KEEP_MS = 31 * 86_400_000;
const SMART_KEEP_MS = 90 * 86_400_000;

export type TroubleSink = (hostId: number, t: Trouble, at: string) => void;

export class HostStatsService {
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  onTrouble: TroubleSink | null = null;
  /** Where its runs and failures are told (OPS-W-14). */
  jobs: Jobs | null = null;
  /** The package updates, checked in the same round when due. */
  packages: PackageChecks | null = null;
  readonly #cpu = new Map<number, { total: number; idle: number; at: number }>();
  readonly #cpuAvg = new Map<number, { percent: number; minutes: number } | null>();
  readonly #streak = new Map<number, { hot: number; mem: number }>();

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
    readonly thresholds: Thresholds = { ...DEFAULT_THRESHOLDS },
  ) {}

  own(hostId: number): OwnLimits {
    return ownLimits(this.ctx, hostId);
  }

  setOwn(hostId: number, own: OwnLimits): void {
    setOwnLimits(this.ctx, hostId, own);
  }

  /** What counts for a host: its own limits over the defaults. */
  thresholdsFor(hostId: number): Thresholds {
    const o = this.own(hostId);
    const d = this.thresholds;
    return { ...d, cpuCelsius: o.cpuCelsius ?? d.cpuCelsius, diskCelsius: o.diskCelsius ?? d.diskCelsius, diskPercent: o.diskPercent ?? d.diskPercent };
  }

  /** The numbers now. `sampling`: the five-minute sampler's read, the only one that moves the CPU's baseline. */
  async read(hostId: number, sampling = false): Promise<HostStats> {
    return (await this.#read(hostId, sampling)).stats;
  }

  async #read(hostId: number, sampling: boolean): Promise<{ stats: HostStats; out: string; at: number }> {
    const r = await this.pool.with(hostId, ({ client }) => exec(client, STATS_COMMAND, 20_000, 1 << 20));
    const gap = statsGap(r.stdout);
    if (gap) throw new HttpError(502, 'stats_unreadable', `The host's numbers could not be read (${gap}).`);
    const now = this.ctx.now();
    // The CPU's average since the last sample, from the counters (a whole
    // interval, not one second). The stats page reading every ten seconds
    // must not move that baseline: then no interval was ever whole and a
    // busy CPU was never told (AUDIT2 MON-07).
    if (sampling) {
      const c = cpuCounters(r.stdout);
      const prev = this.#cpu.get(hostId);
      if (c) this.#cpu.set(hostId, { ...c, at: now });
      const minutes = prev ? Math.round((now - prev.at) / 60_000) : 0;
      this.#cpuAvg.set(hostId, c && prev && c.total > prev.total && minutes >= 4 && minutes <= 15 ? { percent: 100 * (1 - (c.idle - prev.idle) / (c.total - prev.total)), minutes } : null);
    }
    return { stats: parseStats(hostId, r.stdout, now), out: r.stdout, at: now };
  }

  /** SMART now, through sudo; kept for the page and compared with last time. One check at a time per host (AUDIT2 SMART-03). */
  smart(hostId: number): Promise<SmartReport> {
    const before = this.#smartRuns.get(hostId) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => this.#smartNow(hostId));
    this.#smartRuns.set(hostId, run);
    void run.finally(() => this.#smartRuns.get(hostId) === run && this.#smartRuns.delete(hostId)).catch(() => {});
    return run;
  }

  readonly #smartRuns = new Map<number, Promise<SmartReport>>();

  async #smartNow(hostId: number): Promise<SmartReport> {
    const password = hostPassword(this.ctx, hostId);
    let report: SmartReport;
    try {
      const r = await this.pool.with(hostId, ({ client }) => exec(client, smartCommand(password), 120_000, 4 << 20, password !== null ? `${password}\n` : undefined));
      report = { hostId, checkedAt: new Date(this.ctx.now()).toISOString(), ...smartOutcome(r.code, r.stdout, r.stderr) };
    } catch (err) {
      report = { hostId, checkedAt: new Date(this.ctx.now()).toISOString(), state: 'error', message: (err as Error).message, disks: [] };
    }
    const now = Date.parse(report.checkedAt);
    // Kept 90 days, whatever this check found (AUDIT2 SMART-05).
    this.ctx.db.delete(hostSmartHistory).where(and(eq(hostSmartHistory.hostId, hostId), lt(hostSmartHistory.checkedAt, now - SMART_KEEP_MS))).run();
    // Compared with the last check that read the disks, not one that failed in between (AUDIT2 SMART-01).
    const history = this.smartHistory(hostId);
    const last = this.lastSmart(hostId);
    const prevOk = last?.state === 'ok' ? last : (history[history.length - 1] ?? null);
    if (report.state === 'ok') {
      // A disk asleep at this check: its last reading stands, said when it was taken (decision 5).
      report.disks = report.disks.map((d) => {
        const was = d.asleep && prevOk ? sameDisk(d, prevOk.disks) : null;
        return was ? { ...was, device: d.device, asleep: true, readAt: was.readAt ?? prevOk!.checkedAt } : d;
      });
      report.disks = this.#judge(hostId, report.disks, history);
      // One kept per day.
      const newest = history[history.length - 1];
      if (!newest || now - Date.parse(newest.checkedAt) >= 20 * 3_600_000) this.ctx.db.insert(hostSmartHistory).values({ hostId, checkedAt: now, report: JSON.stringify(report) }).run();
    }
    this.ctx.db
      .insert(hostSmart)
      .values({ hostId, checkedAt: now, report: JSON.stringify(report) })
      .onConflictDoUpdate({ target: hostSmart.hostId, set: { checkedAt: now, report: JSON.stringify(report) } })
      .run();
    if (report.state === 'ok') for (const t of smartTrouble(report.disks, prevOk ? this.#judge(hostId, prevOk.disks, history) : [], this.thresholdsFor(hostId))) this.onTrouble?.(hostId, t, report.checkedAt);
    return report;
  }

  /** Each disk judged against the same disk in the kept daily checks. */
  #judge(hostId: number, disks: SmartDisk[], history: SmartReport[]): SmartDisk[] {
    const wear = this.thresholdsFor(hostId).nvmeWearPercent;
    return disks.map((d) => ({
      ...d,
      ...judgeDisk(
        d,
        history.map((h) => ({ at: h.checkedAt, disk: sameDisk(d, h.disks) })).filter((h): h is { at: string; disk: SmartDisk } => h.disk !== null),
        wear,
      ),
    }));
  }

  /** The kept daily SMART reports of a host, oldest first (only the ones that read disks). */
  smartHistory(hostId: number): SmartReport[] {
    return this.ctx.db
      .select()
      .from(hostSmartHistory)
      .where(and(eq(hostSmartHistory.hostId, hostId), gte(hostSmartHistory.checkedAt, this.ctx.now() - SMART_KEEP_MS)))
      .orderBy(hostSmartHistory.checkedAt)
      .all()
      .map((r) => JSON.parse(r.report) as SmartReport);
  }

  lastSmart(hostId: number): SmartReport | null {
    const r = this.ctx.db.select().from(hostSmart).where(eq(hostSmart.hostId, hostId)).get();
    if (!r) return null;
    const report = JSON.parse(r.report) as SmartReport;
    // Kept before disks were judged: judged now, by today's rules (AUDIT2 SMART-04).
    if (report.state === 'ok' && report.disks.some((d) => !d.verdict)) report.disks = this.#judge(hostId, report.disks, this.smartHistory(hostId));
    return report;
  }

  history(hostId: number, sinceMs: number): HostSample[] {
    return this.ctx.db
      .select()
      .from(hostSamples)
      .where(and(eq(hostSamples.hostId, hostId), gte(hostSamples.at, this.ctx.now() - sinceMs)))
      .orderBy(hostSamples.at)
      .all()
      .map((s) => ({ at: new Date(s.at).toISOString(), cpu: s.cpu, memPercent: s.memPercent, load1: s.load1, diskPercent: s.diskPercent, maxCelsius: s.maxCelsius }));
  }

  /** A host's container ids to their names (the Docker monitor's list), for the processes in them. */
  containerNames: ((hostId: number) => Promise<Map<string, string>>) | null = null;
  readonly #activityRuns = new Map<number, Promise<DiskActivity>>();
  /** Hosts where sudo said no lately: not asked again every few seconds (each refusal is a failed sudo in the host's log). */
  readonly #noRoot = new Map<number, { until: number; why: string }>();

  /**
   * Who reads and writes now, on demand (the page asks while its view is
   * open): one sample at a time per host, shared by whoever asks meanwhile.
   * As root through sudo when it is allowed, else the SSH user's own processes.
   */
  activity(hostId: number): Promise<DiskActivity> {
    const running = this.#activityRuns.get(hostId);
    if (running) return running;
    const run = this.#activityNow(hostId).finally(() => this.#activityRuns.delete(hostId));
    this.#activityRuns.set(hostId, run);
    return run;
  }

  async #activityNow(hostId: number): Promise<DiskActivity> {
    const password = hostPassword(this.ctx, hostId);
    const run = (asUser: boolean) => this.pool.with(hostId, ({ client }) => exec(client, activityCommand(password, asUser), 30_000, 4 << 20, !asUser && password !== null ? `${password}\n` : undefined));
    let rootRefused: string | null = null;
    const no = this.#noRoot.get(hostId);
    let r = no && no.until > this.ctx.now() ? null : await run(false);
    if (r && !r.stdout.includes(SUDO_OK)) {
      // sudo itself said no (no password stored and none allowed without, a wrong password, no sudo).
      const why = r.stderr.trim().split('\n').pop() || `sudo exited with ${r.code}`;
      this.#noRoot.set(hostId, { until: this.ctx.now() + 15 * 60_000, why });
      r = null;
    }
    if (!r) {
      rootRefused = this.#noRoot.get(hostId)?.why ?? null;
      r = await run(true);
    }
    if (r.truncated) throw new HttpError(502, 'activity_unreadable', 'The answer was larger than Burrow reads (4 MB).');
    let parsed: ReturnType<typeof parseActivity>;
    try {
      const ids = new Set([...r.stdout.matchAll(/^@@cg .*?([0-9a-f]{64})/gm)].map((m) => m[1]!));
      const names = ids.size && this.containerNames ? await this.containerNames(hostId).catch(() => new Map<string, string>()) : new Map<string, string>();
      parsed = parseActivity(r.stdout, names);
    } catch (err) {
      const said = r.stderr.trim().split('\n').pop();
      throw new HttpError(502, 'activity_unreadable', said ? `${(err as Error).message} (${said})` : (err as Error).message);
    }
    return { hostId, at: new Date(this.ctx.now()).toISOString(), rootRefused: parsed.asRoot ? null : rootRefused, ...parsed };
  }

  /** Each whole disk's rates over each sample interval, oldest first. */
  diskHistory(hostId: number, sinceMs: number): DiskHistory[] {
    const rows = this.ctx.db
      .select()
      .from(hostDiskSamples)
      // One interval more: the first point needs the counters before it.
      .where(and(eq(hostDiskSamples.hostId, hostId), gte(hostDiskSamples.at, this.ctx.now() - sinceMs - SAMPLE_MS - 60_000)))
      .orderBy(hostDiskSamples.at)
      .all();
    const by = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = by.get(r.disk);
      if (list) list.push(r);
      else by.set(r.disk, [r]);
    }
    const from = this.ctx.now() - sinceMs;
    return [...by]
      .map(([disk, rs]) => ({ disk, samples: diskSamples(rs).filter((x) => Date.parse(x.at) >= from) }))
      .sort((a, b) => a.disk.localeCompare(b.disk, 'en', { numeric: true }));
  }

  /** One sample of a host into the history, and its trouble. */
  async sample(hostId: number): Promise<HostStats> {
    const { stats: s, out, at } = await this.#read(hostId, true);
    // Each whole disk's counters: its rates over the five minutes come from these (diskio.ts).
    const { sec, markers } = statsSections(out);
    const rows = counterRows(sec, markers, at).map((r) => ({ hostId, ...r }));
    if (rows.length) this.ctx.db.insert(hostDiskSamples).values(rows).run();
    const diskPercent = Math.max(0, ...s.disks.map((d) => (d.usedBytes / d.sizeBytes) * 100));
    this.ctx.db
      .insert(hostSamples)
      .values({
        hostId,
        at: this.ctx.now(),
        cpu: s.cpu,
        memPercent: s.memTotal ? Math.round((s.memUsed / s.memTotal) * 1000) / 10 : 0,
        load1: s.load[0],
        diskPercent: Math.round(diskPercent * 10) / 10,
        maxCelsius: s.temps.length ? Math.max(...s.temps.map((t) => t.celsius)) : null,
      })
      .run();
    const sus = sustainedTrouble(s, this.#cpuAvg.get(hostId) ?? null, this.#streak.get(hostId) ?? { hot: 0, mem: 0 }, this.thresholdsFor(hostId));
    this.#streak.set(hostId, sus.streak);
    for (const t of sus.troubles) this.onTrouble?.(hostId, t, s.at);
    return s;
  }

  start(): void {
    this.#stopped = false;
    this.#timer = setInterval(() => void this.tick(), SAMPLE_MS);
    this.#timer.unref();
    this.#first = setTimeout(() => void this.tick(), 60_000);
    this.#first.unref();
  }

  /** No sampling after this, also not the first one still to come (AUDIT2 MON-27). */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
  }

  #first: NodeJS.Timeout | null = null;
  #stopped = false;

  /** Every host that answered its last connection test, a few at a time (one that hangs holds up only itself, OPS-W-06). */
  async tick(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    this.#busy = true;
    const started = performance.now();
    let failure: string | null = null;
    try {
      const all = this.ctx.db.select().from(hosts).all().filter((h) => h.facts);
      await eachLimited(
        all,
        4,
        async (h) => {
          // Still at it from a round before (a host that hangs): not asked again on top.
          if (this.#sampling.has(h.id)) return;
          this.#sampling.add(h.id);
          try {
            await this.#hostRound(h, (msg) => (failure ??= `${h.name}: ${msg}`));
          } finally {
            this.#sampling.delete(h.id);
          }
        },
        () => this.#stopped,
        // A host that does not answer in time no longer holds the round: the others are sampled again next time.
        {
          itemMs: STATS_HOST_MS,
          late: (h) => {
            const msg = `no answer in ${STATS_HOST_MS / 60_000} min`;
            failure ??= `${h.name}: ${msg}`;
            this.jobs?.failed('host statistics', h.name, msg, { hostId: h.id });
          },
        },
      );
      if (this.#stopped) return;
      this.ctx.db.delete(hostSamples).where(lt(hostSamples.at, this.ctx.now() - KEEP_MS)).run();
      this.ctx.db.delete(hostDiskSamples).where(lt(hostDiskSamples.at, this.ctx.now() - KEEP_MS)).run();
    } finally {
      this.#busy = false;
      if (!this.#stopped) this.jobs?.ran('host-stats', performance.now() - started, failure);
    }
  }

  /** Hosts whose sampling is under way, maybe still from a round that went on without them. */
  readonly #sampling = new Set<number>();

  /** One host's part of a round: its sample, then SMART and its packages when due. */
  async #hostRound(h: { id: number; name: string }, failed: (message: string) => void): Promise<void> {
    try {
      await this.sample(h.id);
      this.jobs?.fine('host statistics', h.name, { hostId: h.id });
    } catch (err) {
      // At warn, once per host and message: at debug nobody saw it (OPS-W-14).
      failed((err as Error).message);
      this.jobs?.failed('host statistics', h.name, (err as Error).message, { hostId: h.id });
    }
    if (this.#stopped) return;
    const last = this.ctx.db.select().from(hostSmart).where(eq(hostSmart.hostId, h.id)).get();
    if (!last || this.ctx.now() - last.checkedAt > SMART_MS) await this.smart(h.id).catch(() => {});
    if (this.#stopped) return;
    await this.packages?.checkIfDue(h.id).catch(() => {});
  }
}
