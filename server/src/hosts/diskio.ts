import type { ContainerIo, DiskActivity, DiskIo, DiskKind, DiskPower, DiskPowerFrom, DiskSample, OpenFile, ProcessIo } from '@burrow/shared';
import { shellQuote } from '../ssh/quote.js';

// The disks themselves (report d4a9c0: "my hard disk spins all the time;
// which processes are writing?"): each whole disk's reads, writes and busy
// time from /proc/diskstats, what kind it is from /sys/block, and - on
// demand, while someone looks - which processes read and write, from
// /proc/<pid>/io sampled twice. Nothing here opens a disk or a file on one:
// /proc and /sys only, and as root the drive's own power state through
// `hdparm -C` or `smartctl -n standby`, which answer without spinning it up.

/** Sectors in /proc/diskstats are 512 bytes, whatever the disk's own sector size. */
const SECTOR = 512;

/** The stats command's part: the disks' counters before and after its one second (with the uptime, for the exact interval), and what each block device is. */
export const IO_BEFORE = 'io1=$(cat /proc/uptime /proc/diskstats 2>/dev/null)';
export const IO_AFTER = [
  'echo @@io1; printf "%s\\n" "$io1"',
  'echo @@io2; cat /proc/uptime /proc/diskstats 2>/dev/null',
  // One grep for all: rotational, size, model, runtime PM state, hidden, the device-mapper name.
  'echo @@blk; grep -sH "" /sys/block/*/queue/rotational /sys/block/*/size /sys/block/*/device/model /sys/block/*/device/power/runtime_status /sys/block/*/hidden /sys/block/*/dm/name',
  'echo "@@parts" /sys/block/*/*/partition',
  'echo "@@slaves" /sys/block/*/slaves/*',
].join('\n');

// Not a disk of its own: loop files, RAM disks, compressed swap, device
// mapper and software RAID (their disks are listed), optical drives, network
// block devices, ZFS volumes, an SD card's boot and RPMB areas, and the
// hidden per-path devices of multipath NVMe.
const NOT_A_DISK = /^(loop|ram|zram|dm-|md|sr|nbd|fd|zd|drbd)\d|^mmcblk\d+(boot\d+|rpmb)$|^nvme\d+c\d+n\d+$/;

interface BlockDev {
  rotational?: string;
  size?: string;
  model?: string;
  runtime?: string;
  hidden?: string;
  dmName?: string;
}

/** What /sys/block says: each block device, partitions to their disk, and the disks under a device-mapper or RAID device. */
export interface Inventory {
  devs: Map<string, BlockDev>;
  parts: Map<string, string>;
  slaves: Map<string, string[]>;
}

const KEYS: Record<string, keyof BlockDev> = { 'queue/rotational': 'rotational', size: 'size', 'device/model': 'model', 'device/power/runtime_status': 'runtime', hidden: 'hidden', 'dm/name': 'dmName' };

export function parseInventory(blk: string[], parts: string, slaves: string): Inventory {
  const devs = new Map<string, BlockDev>();
  for (const line of blk) {
    const m = /^\/sys\/block\/([^/]+)\/([^:]+):(.*)$/.exec(line.trim());
    const key = m && KEYS[m[2]!];
    if (!m || !key) continue;
    const d = devs.get(m[1]!) ?? {};
    d[key] = m[3]!.trim();
    devs.set(m[1]!, d);
  }
  const pm = new Map<string, string>();
  for (const m of parts.matchAll(/\/sys\/block\/([^/\s*]+)\/([^/\s*]+)\/partition/g)) pm.set(m[2]!, m[1]!);
  const sm = new Map<string, string[]>();
  for (const m of slaves.matchAll(/\/sys\/block\/([^/\s*]+)\/slaves\/([^/\s*]+)/g)) sm.set(m[1]!, [...(sm.get(m[1]!) ?? []), m[2]!]);
  return { devs, parts: pm, slaves: sm };
}

/** The whole disks: no partitions, nothing virtual, nothing empty (a card reader without a card). */
export function wholeDisks(inv: Inventory): string[] {
  return [...inv.devs.entries()]
    .filter(([name, d]) => !NOT_A_DISK.test(name) && d.hidden !== '1' && Number(d.size) > 0 && d.rotational !== undefined)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function diskKind(name: string, d: BlockDev | undefined): DiskKind {
  if (/^nvme/.test(name)) return 'nvme';
  return d?.rotational === '1' ? 'hdd' : 'ssd';
}

/** The I/O counters of one block device (/proc/diskstats). */
export interface Counters {
  dev: string;
  rdIos: number;
  rdSectors: number;
  wrIos: number;
  wrSectors: number;
  ioMs: number;
}

export interface IoSnapshot {
  /** The host's uptime when read (seconds), or null. */
  uptime: number | null;
  byName: Map<string, Counters>;
}

/** /proc/uptime's line and then /proc/diskstats. */
export function parseDiskstats(lines: string[]): IoSnapshot {
  let uptime: number | null = null;
  const byName = new Map<string, Counters>();
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    if (p.length === 2 && uptime === null && /^\d+(\.\d+)?$/.test(p[0]!)) {
      uptime = Number(p[0]);
      continue;
    }
    if (p.length < 14 || !/^\d+$/.test(p[0]!) || !/^\d+$/.test(p[1]!)) continue;
    const n = (i: number) => Number(p[i]) || 0;
    byName.set(p[2]!, { dev: `${p[0]}:${p[1]}`, rdIos: n(3), rdSectors: n(5), wrIos: n(7), wrSectors: n(9), ioMs: n(12) });
  }
  return { uptime, byName };
}

/** Rates between two readings of the same counters, `seconds` apart. A counter that went back (a reboot, a wrap) is no rate. */
export function rates(a: Counters, b: Counters, seconds: number): Pick<DiskIo, 'readBps' | 'writeBps' | 'readIops' | 'writeIops' | 'util'> | null {
  const d = (k: keyof Omit<Counters, 'dev'>) => b[k] - a[k];
  if (seconds <= 0 || (['rdIos', 'rdSectors', 'wrIos', 'wrSectors', 'ioMs'] as const).some((k) => d(k) < 0)) return null;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    readBps: Math.round((d('rdSectors') * SECTOR) / seconds),
    writeBps: Math.round((d('wrSectors') * SECTOR) / seconds),
    readIops: r1(d('rdIos') / seconds),
    writeIops: r1(d('wrIos') / seconds),
    util: r1(Math.min(100, (d('ioMs') / (seconds * 1000)) * 100)),
  };
}

/** What the drive said when asked (hdparm -C, smartctl -n standby -i), without waking it. */
export function parsePower(tool: string, out: string): DiskPower {
  if (tool === 'hdparm') {
    const s = /drive state is:\s*(\S+)/i.exec(out)?.[1]?.toLowerCase();
    if (s === 'standby' || s === 'sleeping') return 'standby';
    if (s && /^(active|idle)/.test(s)) return 'active';
    return 'unknown';
  }
  if (/Device is in (STANDBY|SLEEP)|Power mode (is|was):\s*(STANDBY|SLEEP)/i.test(out)) return 'standby';
  if (/Power mode (is|was):\s*(ACTIVE|IDLE)/i.test(out)) return 'active';
  return 'unknown';
}

/**
 * The whole disks and their rates between two snapshots. A hard disk's
 * power state: what the drive said when asked, else spun down by the kernel,
 * else active when it did I/O in the interval; otherwise unknown.
 */
export function diskIo(inv: Inventory, a: IoSnapshot, b: IoSnapshot, asked: Map<string, { state: DiskPower; from: DiskPowerFrom }> = new Map(), fallbackSeconds = 1): DiskIo[] {
  const seconds = a.uptime !== null && b.uptime !== null && b.uptime > a.uptime ? b.uptime - a.uptime : fallbackSeconds;
  const out: DiskIo[] = [];
  for (const name of wholeDisks(inv)) {
    const d = inv.devs.get(name)!;
    const x = a.byName.get(name);
    const y = b.byName.get(name);
    if (!x || !y) continue;
    const r = rates(x, y, seconds) ?? { readBps: 0, writeBps: 0, readIops: 0, writeIops: 0, util: 0 };
    const kind = diskKind(name, d);
    let power: DiskPower | null = null;
    let powerFrom: DiskPowerFrom | null = null;
    if (kind === 'hdd') {
      const said = asked.get(name);
      if (said && said.state !== 'unknown') [power, powerFrom] = [said.state, said.from];
      else if (d.runtime === 'suspended') [power, powerFrom] = ['standby', 'kernel'];
      else if (y.rdIos > x.rdIos || y.wrIos > x.wrIos) [power, powerFrom] = ['active', 'io'];
      else power = 'unknown';
    }
    out.push({ name, kind, model: d.model?.trim() || null, sizeBytes: Number(d.size) * SECTOR, ...r, power, powerFrom });
  }
  return out;
}

/** The disks' part of the stats command's answer (its sections), or why it could not be read. */
export function statsIo(sec: Map<string, string[]>, markers: Map<string, string>): { io: DiskIo[]; ioError: string | null } {
  const a = parseDiskstats(sec.get('io1') ?? []);
  const b = parseDiskstats(sec.get('io2') ?? []);
  if (!a.byName.size || !b.byName.size) return { io: [], ioError: '/proc/diskstats' };
  const inv = parseInventory(sec.get('blk') ?? [], markers.get('parts') ?? '', markers.get('slaves') ?? '');
  if (!inv.devs.size) return { io: [], ioError: '/sys/block' };
  return { io: diskIo(inv, a, b), ioError: null };
}

// ---- the history: the counters every five minutes, rates between them

export interface DiskCounterRow {
  at: number;
  disk: string;
  uptime: number;
  rdIos: number;
  rdSectors: number;
  wrIos: number;
  wrSectors: number;
  ioMs: number;
}

/** The counters of each whole disk to keep with a sample. */
export function counterRows(sec: Map<string, string[]>, markers: Map<string, string>, at: number): DiskCounterRow[] {
  const b = parseDiskstats(sec.get('io2') ?? []);
  const inv = parseInventory(sec.get('blk') ?? [], markers.get('parts') ?? '', markers.get('slaves') ?? '');
  if (b.uptime === null) return [];
  return wholeDisks(inv).flatMap((disk) => {
    const c = b.byName.get(disk);
    return c ? [{ at, disk, uptime: b.uptime!, rdIos: c.rdIos, rdSectors: c.rdSectors, wrIos: c.wrIos, wrSectors: c.wrSectors, ioMs: c.ioMs }] : [];
  });
}

/** Longer than this between two samples (Burrow was down): no average drawn over the gap. */
const GAP_MS = 20 * 60_000;

/**
 * One disk's kept counters (oldest first) as rates over each interval: the
 * average of the whole five minutes, so a disk woken every minute shows,
 * not only what one second happened to see. A reboot in between (the
 * uptime or a counter went back) and a long gap give no point.
 */
export function diskSamples(rows: DiskCounterRow[]): DiskSample[] {
  const out: DiskSample[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (b.at - a.at > GAP_MS || b.uptime <= a.uptime) continue;
    const r = rates({ ...a, dev: '' }, { ...b, dev: '' }, b.uptime - a.uptime);
    if (r) out.push({ at: new Date(b.at).toISOString(), ...r });
  }
  return out;
}

// ---- who reads and writes: on demand

/** How long the processes' counters are watched. */
export const ACTIVITY_SECONDS = 2;
/** The busiest processes looked at more closely (their files, their container). */
const TOP = 10;
/** Files listed per process. */
const FILES = 5;

/**
 * Every process's read_bytes and write_bytes (only those not 0: one that
 * never did I/O cannot have done any now), twice; the disks' counters over
 * the same seconds; then the busiest processes' names, cgroups, mount
 * tables and open files (`ls -l /proc/<pid>/fd`: its mode says read or
 * write). One grep reads all the counters: cheap on a host with thousands
 * of processes. As root, each hard disk's power state as the drive tells it.
 */
export const ACTIVITY_SCRIPT = [
  'echo @@begin "$(id -u)"',
  'cd /proc || exit 3',
  "s() { grep -sH -E '^(read|write)_bytes: *[1-9]' [0-9]*/io; }",
  // Each container's bytes per disk from its cgroup (v2; Docker with systemd or cgroupfs, Podman), over the same seconds (decision 6).
  "c() { grep -sH '' /sys/fs/cgroup/system.slice/docker-*.scope/io.stat /sys/fs/cgroup/docker/*/io.stat /sys/fs/cgroup/machine.slice/libpod-*.scope/io.stat; }",
  `a=$(s); c1=$(c); io1=$(cat uptime diskstats); sleep ${ACTIVITY_SECONDS}; b=$(s); c2=$(c); io2=$(cat uptime diskstats)`,
  // How many processes, and how many of their counters could be read (all, as root with CAP_SYS_PTRACE).
  "set -- [0-9]*/io; echo @@procs $# $(grep -sl '^rchar' \"$@\" | wc -l)",
  'echo @@io1; printf "%s\\n" "$io1"; echo @@io2; printf "%s\\n" "$io2"',
  'echo @@a; printf "%s\\n" "$a"; echo @@b; printf "%s\\n" "$b"',
  'echo @@c1; printf "%s\\n" "$c1"; echo @@c2; printf "%s\\n" "$c2"',
  IO_AFTER.split('\n').slice(2).join('\n'),
  `top=$(printf '%s\\n' "$a" @@ "$b" | awk -F'[/: ]+' '$0=="@@"{s=1;next} NF>=4{if(s)n[$1]+=$4; else o[$1]+=$4} END{for(k in n) if(n[k]>o[k]) print n[k]-o[k], k}' | sort -rn | head -n ${TOP} | cut -d' ' -f2)`,
  'seen=$(readlink self/ns/mnt); echo "@@selfns $seen"; echo @@selfmounts; cat self/mountinfo',
  'for p in $top; do echo "@@pid $p"; [ -d "$p" ] || { echo @@gone; continue; }',
  '  echo "@@comm $(cat $p/comm 2>/dev/null)"; echo "@@cg $(grep -s -m1 -E \'[0-9a-f]{64}|lxc\' $p/cgroup)"',
  '  ns=$(readlink $p/ns/mnt 2>/dev/null); echo "@@ns $ns"',
  '  [ -z "$ns" ] || case " $seen " in *" $ns "*) ;; *) seen="$seen $ns"; echo @@mounts; cat $p/mountinfo 2>/dev/null;; esac',
  "  l=$(ls -l $p/fd 2>/dev/null) || echo @@fdunread; echo @@fd; printf '%s\\n' \"$l\" | grep -F ' -> /' | head -n 300",
  'done',
  'if [ "$(id -u)" = 0 ]; then PATH="$PATH:/usr/sbin:/sbin"',
  '  for r in /sys/block/*/queue/rotational; do read -r v < "$r" 2>/dev/null || continue; [ "$v" = 1 ] || continue; n=${r#/sys/block/}; n=${n%%/*}',
  '    case $n in loop*|ram*|zram*|dm-*|md*|sr*|nbd*|fd*|zd*|drbd*) continue;; esac; [ -e "/sys/block/$n/device" ] || continue',
  '    if command -v hdparm >/dev/null 2>&1; then echo "@@power $n hdparm"; hdparm -C "/dev/$n" 2>&1 | grep -i state',
  "    elif command -v smartctl >/dev/null 2>&1; then echo \"@@power $n smartctl\"; smartctl -n standby -i \"/dev/$n\" 2>&1 | grep -iE 'power mode|standby|sleep'; fi",
  '  done',
  'fi',
  'echo @@end',
].join('\n');

/** Marks that sudo let the script run (before it, sudo's own refusal). */
export const SUDO_OK = '@@sudo';

/**
 * As root when the SSH user is root, else through sudo the way SMART goes:
 * with the host's stored password (`sudo -S`), or `sudo -n` when none is
 * stored. `asUser`: the user's own processes only (sudo refused).
 */
export function activityCommand(password: string | null, asUser = false): string {
  const script = shellQuote(`echo ${SUDO_OK}\n${ACTIVITY_SCRIPT}`);
  if (asUser) return `sh -c ${script}`;
  const sudo = password !== null ? "sudo -S -p ''" : 'sudo -n';
  return `if [ "$(id -u)" = 0 ]; then sh -c ${script}; else ${sudo} sh -c ${script}; fi`;
}

export interface Mount {
  dev: string;
  point: string;
  fs: string;
  source: string;
  opts: string;
}

const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/** /proc/<pid>/mountinfo: device number, mount point, type, source and the filesystem's options. */
export function parseMountinfo(lines: string[]): Mount[] {
  const out: Mount[] = [];
  for (const line of lines) {
    const [pre, post] = line.split(' - ');
    const a = pre?.trim().split(' ') ?? [];
    const b = post?.trim().split(' ') ?? [];
    if (a.length < 5 || b.length < 2 || !/^\d+:\d+$/.test(a[2]!)) continue;
    out.push({ dev: a[2]!, point: unescape(a[4]!), fs: b[0]!, source: unescape(b[1]!), opts: b[2] ?? '' });
  }
  return out;
}

/** The mount a path is on: the longest mount point that holds it, the later of two at the same point. */
export function mountOf(path: string, mounts: Mount[]): Mount | null {
  let best: Mount | null = null;
  for (const m of mounts) {
    const holds = m.point === '/' || path === m.point || path.startsWith(`${m.point}/`);
    if (holds && (!best || m.point.length >= best.point.length)) best = m;
  }
  return best;
}

/** What a mount's files are on, as whole disks. */
export class DiskMap {
  readonly #byDev = new Map<string, string>();
  readonly #dm = new Map<string, string>();
  readonly #whole: Set<string>;

  constructor(
    private readonly inv: Inventory,
    snap: IoSnapshot,
    private readonly self: Mount[],
  ) {
    for (const [name, c] of snap.byName) this.#byDev.set(c.dev, name);
    for (const [name, d] of inv.devs) if (d.dmName) this.#dm.set(d.dmName, name);
    this.#whole = new Set(wholeDisks(inv));
  }

  /** A block device's whole disks: itself, a partition's disk, or the disks under LVM, LUKS or RAID. */
  disksOf(name: string, depth = 0): string[] {
    if (this.#whole.has(name)) return [name];
    if (depth > 8) return [];
    const parent = this.inv.parts.get(name);
    if (parent) return this.disksOf(parent, depth + 1);
    return [...new Set((this.inv.slaves.get(name) ?? []).flatMap((s) => this.disksOf(s, depth + 1)))];
  }

  /**
   * A file's disks, by the mount table of the process that has it open:
   * the mount's device number, else (overlay, btrfs) its source; a
   * container's overlay by where its upper layer is in the host's mounts.
   */
  ofPath(path: string, mounts: Mount[], depth = 0): string[] {
    const m = mountOf(path, mounts);
    if (!m) return [];
    if (!m.dev.startsWith('0:')) {
      const name = this.#byDev.get(m.dev);
      return name ? this.disksOf(name) : [];
    }
    if (m.fs === 'overlay' && depth === 0) {
      const upper = /(?:^|,)upperdir=([^,]+)/.exec(m.opts)?.[1];
      return upper ? this.ofPath(unescape(upper), this.self, 1) : [];
    }
    if (m.source.startsWith('/dev/mapper/')) {
      const dm = this.#dm.get(m.source.slice('/dev/mapper/'.length));
      return dm ? this.disksOf(dm) : [];
    }
    return m.source.startsWith('/dev/') ? this.disksOf(m.source.slice(5)) : [];
  }
}

/** The container a process is in, from its cgroup: Docker, Podman and containerd by their 64-hex id, LXC by name. */
export function containerOf(cgroup: string, names: Map<string, string>): string | null {
  const id = /([0-9a-f]{64})/.exec(cgroup)?.[1];
  if (id) return names.get(id) ?? id.slice(0, 12);
  return /\/lxc(?:\.payload)?[./]([^/.\s]+)/.exec(cgroup)?.[1] ?? null;
}

/** `ls -l /proc/<pid>/fd` lines: the regular files, and whether each is open for writing (the link's mode is the open mode). */
export function parseFds(lines: string[]): { path: string; write: boolean }[] {
  const out = new Map<string, boolean>();
  for (const line of lines) {
    const i = line.indexOf(' -> /');
    if (i < 0) continue;
    const path = line.slice(i + 4).replace(/ \(deleted\)$/, '');
    if (/^\/(dev|proc|sys)\//.test(path) || path.startsWith('/memfd:')) continue;
    const write = line.trim()[2] === 'w';
    out.set(path, (out.get(path) ?? false) || write);
  }
  return [...out].map(([path, write]) => ({ path, write }));
}

interface Detail {
  name: string | null;
  cg: string;
  ns: string;
  fds: string[];
  fdUnread: boolean;
}

/** Thrown when the answer is not a whole sample: never an empty list read as "nobody writes". */
export class ActivityUnreadable extends Error {}

/**
 * Containers' bytes per whole disk between two readings of their cgroups'
 * io.stat ("<file>:<major>:<minor> rbytes=.. wbytes=.."), busiest first. A
 * device mapper or RAID device counts for the disks under it; a container
 * gone or made anew in between has no rate.
 */
export function containerIo(before: string[], after: string[], snap: IoSnapshot, map: DiskMap, names: Map<string, string>, seconds: number): ContainerIo[] {
  const nameOfDev = new Map([...snap.byName].map(([name, c]) => [c.dev, name]));
  const read = (lines: string[]) => {
    const m = new Map<string, Map<string, { r: number; w: number }>>();
    for (const l of lines) {
      const x = /([0-9a-f]{64})\.?[^:]*:(\d+:\d+) (.*)$/.exec(l.trim());
      if (!x) continue;
      const r = Number(/\brbytes=(\d+)/.exec(x[3]!)?.[1] ?? 0);
      const w = Number(/\bwbytes=(\d+)/.exec(x[3]!)?.[1] ?? 0);
      const per = m.get(x[1]!) ?? new Map<string, { r: number; w: number }>();
      per.set(x[2]!, { r, w });
      m.set(x[1]!, per);
    }
    return m;
  };
  const a = read(before);
  const b = read(after);
  const out: ContainerIo[] = [];
  for (const [id, devs] of b) {
    const was = a.get(id);
    if (!was) continue;
    const byDisk = new Map<string, { r: number; w: number }>();
    for (const [dev, c] of devs) {
      const p = was.get(dev);
      const name = nameOfDev.get(dev);
      if (!p || !name || c.r < p.r || c.w < p.w) continue;
      for (const disk of map.disksOf(name)) {
        const d = byDisk.get(disk) ?? { r: 0, w: 0 };
        d.r += c.r - p.r;
        d.w += c.w - p.w;
        byDisk.set(disk, d);
      }
    }
    const disks = [...byDisk].map(([disk, d]) => ({ disk, readBps: Math.round(d.r / seconds), writeBps: Math.round(d.w / seconds) })).filter((d) => d.readBps + d.writeBps > 0);
    if (!disks.length) continue;
    disks.sort((x, y) => y.readBps + y.writeBps - (x.readBps + x.writeBps));
    out.push({ container: names.get(id) ?? id.slice(0, 12), readBps: disks.reduce((s, d) => s + d.readBps, 0), writeBps: disks.reduce((s, d) => s + d.writeBps, 0), disks });
  }
  return out.sort((x, y) => y.readBps + y.writeBps - (x.readBps + x.writeBps)).slice(0, TOP);
}

/** The activity script's answer, read. `names`: container ids to the names Burrow knows. */
export function parseActivity(out: string, names: Map<string, string> = new Map()): Omit<DiskActivity, 'hostId' | 'at' | 'rootRefused'> {
  const sec = new Map<string, string[]>();
  const markers = new Map<string, string>();
  const details = new Map<number, Detail>();
  const nsMounts = new Map<string, string[]>();
  const power = new Map<string, { state: DiskPower; from: DiskPowerFrom }>();
  let cur: string[] | null = null;
  let pid: Detail | null = null;
  let powerOf: { name: string; tool: string; lines: string[] } | null = null;
  const endPower = () => {
    if (powerOf) power.set(powerOf.name, { state: parsePower(powerOf.tool, powerOf.lines.join('\n')), from: powerOf.tool as DiskPowerFrom });
    powerOf = null;
  };
  for (const line of out.split('\n')) {
    const m = /^@@([\w-]+)(?: (.*))?$/.exec(line);
    if (!m) {
      if (line.trim()) cur?.push(line);
      continue;
    }
    const [, key, rest = ''] = m as unknown as [string, string, string | undefined];
    endPower();
    cur = null;
    if (key === 'pid') {
      pid = { name: null, cg: '', ns: '', fds: [], fdUnread: false };
      details.set(Number(rest), pid);
    } else if (key === 'comm' && pid) pid.name = rest.trim() || null;
    else if (key === 'cg' && pid) pid.cg = rest;
    else if (key === 'ns' && pid) pid.ns = rest.trim();
    else if (key === 'mounts' && pid) nsMounts.set(pid.ns, (cur = []));
    else if (key === 'fd' && pid) cur = pid.fds;
    else if (key === 'fdunread' && pid) pid.fdUnread = true;
    else if (key === 'power') {
      const [name = '', tool = ''] = rest.split(' ');
      powerOf = { name, tool, lines: [] };
      cur = powerOf.lines;
    } else {
      markers.set(key, rest);
      sec.set(key, (cur = []));
    }
  }
  endPower();
  if (!markers.has('begin') || !markers.has('end') || !sec.has('a') || !sec.has('b') || !markers.has('procs')) throw new ActivityUnreadable('The host answered without the whole sample.');
  const io1 = parseDiskstats(sec.get('io1') ?? []);
  const io2 = parseDiskstats(sec.get('io2') ?? []);
  if (!io1.byName.size || !io2.byName.size) throw new ActivityUnreadable('/proc/diskstats could not be read.');
  const seconds = io1.uptime !== null && io2.uptime !== null && io2.uptime > io1.uptime ? Math.round((io2.uptime - io1.uptime) * 100) / 100 : ACTIVITY_SECONDS;
  const inv = parseInventory(sec.get('blk') ?? [], markers.get('parts') ?? '', markers.get('slaves') ?? '');
  const disks = diskIo(inv, io1, io2, power, seconds);
  const counts = (lines: string[]) => {
    const m = new Map<number, { r: number; w: number }>();
    for (const l of lines) {
      const x = /^(\d+)\/io:(read|write)_bytes:\s*(\d+)/.exec(l.trim());
      if (!x) continue;
      const c = m.get(Number(x[1])) ?? { r: 0, w: 0 };
      c[x[2] === 'read' ? 'r' : 'w'] = Number(x[3]);
      m.set(Number(x[1]), c);
    }
    return m;
  };
  const before = counts(sec.get('a') ?? []);
  const after = counts(sec.get('b') ?? []);
  const self = parseMountinfo(sec.get('selfmounts') ?? []);
  const map = new DiskMap(inv, io2, self);
  const selfNs = (markers.get('selfns') ?? '').trim();
  const moved = [...after]
    .map(([p, c]) => {
      const was = before.get(p) ?? { r: 0, w: 0 };
      return { pid: p, r: Math.max(0, c.r - was.r), w: Math.max(0, c.w - was.w) };
    })
    .filter((x) => x.r + x.w > 0)
    .sort((x, y) => y.r + y.w - (x.r + x.w))
    .slice(0, TOP);
  const top: ProcessIo[] = moved.map(({ pid: p, r, w }) => {
    const d = details.get(p);
    const mounts = d ? parseMountinfo(nsMounts.get(d.ns) ?? (d.ns === selfNs ? (sec.get('selfmounts') ?? []) : [])) : [];
    const files: OpenFile[] = d ? parseFds(d.fds).map((f) => ({ ...f, disks: mounts.length ? map.ofPath(f.path, mounts) : [] })) : [];
    files.sort((x, y) => Number(y.write) - Number(x.write));
    return {
      pid: p,
      name: d?.name ?? '',
      container: d ? containerOf(d.cg, names) : null,
      readBps: Math.round(r / seconds),
      writeBps: Math.round(w / seconds),
      files: files.slice(0, FILES),
      disks: [...new Set(files.flatMap((f) => f.disks))].sort(),
      moreFiles: Math.max(0, files.length - FILES),
      filesUnread: !d || !d.name || d.fdUnread,
    };
  });
  const [total = 0, readable = 0] = (markers.get('procs') ?? '').trim().split(/\s+/).map(Number);
  // No cgroup's io.stat read at all: not known (no cgroup v2), not "no container did I/O".
  const containers = sec.get('c1')?.length && sec.get('c2')?.length ? containerIo(sec.get('c1')!, sec.get('c2')!, io2, map, names, seconds) : null;
  return { seconds, asRoot: (markers.get('begin') ?? '').trim() === '0', processes: { total, readable }, top, disks, ...(containers ? { containers } : {}) };
}
