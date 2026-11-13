// Phase 11: what a host itself is doing - CPU, memory, load, disks,
// temperatures - and how its disks are (SMART).

import { z } from 'zod';

export interface DiskUsage {
  mount: string;
  fs: string;
  device: string;
  sizeBytes: number;
  usedBytes: number;
}

export interface Temperature {
  label: string;
  celsius: number;
}

export interface HostStats {
  hostId: number;
  at: string;
  /** Percent of all cores over about a second. */
  cpu: number;
  cores: number;
  load: [number, number, number];
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  uptimeSeconds: number;
  disks: DiskUsage[];
  temps: Temperature[];
  /** The whole disks and what they did over the same second (/proc/diskstats); absent from an older server. */
  io?: DiskIo[];
  /** What could not be read for `io` (then `io` is empty): failed is not "no disks". */
  ioError?: string | null;
}

/** A hard disk, an SSD or an NVMe SSD (from the kernel's rotational flag and name). */
export type DiskKind = 'hdd' | 'ssd' | 'nvme';

/**
 * Whether a hard disk spins, read without waking it: asked the drive
 * (`hdparm -C` or `smartctl -n standby`, root only), the kernel spun it down
 * (runtime PM), or it did I/O just now. Otherwise unknown: nothing is run
 * that would spin a disk up to ask.
 */
export type DiskPower = 'active' | 'standby' | 'unknown';
export type DiskPowerFrom = 'hdparm' | 'smartctl' | 'kernel' | 'io';

/** A whole disk (not a partition) and its I/O over a short interval. */
export interface DiskIo {
  /** The kernel's name: sda, nvme0n1, mmcblk0. */
  name: string;
  kind: DiskKind;
  model: string | null;
  sizeBytes: number;
  readBps: number;
  writeBps: number;
  readIops: number;
  writeIops: number;
  /** Percent of the interval the disk was busy (io_ticks; iostat's %util). */
  util: number;
  /** Hard disks only; null for an SSD. */
  power: DiskPower | null;
  powerFrom: DiskPowerFrom | null;
}

/** One disk's rates averaged over a sample interval (five minutes). */
export interface DiskSample {
  at: string;
  readBps: number;
  writeBps: number;
  readIops: number;
  writeIops: number;
  util: number;
}

export interface DiskHistory {
  disk: string;
  samples: DiskSample[];
}

/** A file a process has open, and the whole disk(s) it is on (empty: not told - a network or memory filesystem, ZFS, a mount Burrow cannot see). */
export interface OpenFile {
  path: string;
  write: boolean;
  disks: string[];
}

/** A process that read or wrote during the sample (/proc/<pid>/io). */
export interface ProcessIo {
  pid: number;
  name: string;
  /** The container it runs in, by its cgroup: the name Burrow knows it by, else the short id. */
  container: string | null;
  readBps: number;
  writeBps: number;
  /** Regular files it has open, written ones first (a few). */
  files: OpenFile[];
  /** The disks of all its open files. */
  disks: string[];
  /** Open files not listed. */
  moreFiles: number;
  /** Its open files could not be read (it ended, or not allowed). */
  filesUnread: boolean;
}

/**
 * Who reads and writes, sampled on demand: every process's I/O counters
 * twice, a couple of seconds apart, and the disks' over the same seconds.
 */
export interface DiskActivity {
  hostId: number;
  at: string;
  /** The length of the sample. */
  seconds: number;
  /** Read as root: every process. Else only the SSH user's own. */
  asRoot: boolean;
  /** Why not as root (sudo's words), or null. */
  rootRefused: string | null;
  /** Processes on the host, and those whose counters could be read. */
  processes: { total: number; readable: number };
  /** The busiest, most first. */
  top: ProcessIo[];
  disks: DiskIo[];
  /**
   * Each container's bytes over the same seconds, per disk, from its cgroup's
   * io.stat (cgroup v2; written back from the page cache included, which a
   * process's own counters miss): busiest first (decision 6). Absent where the
   * host has no cgroup v2 io accounting.
   */
  containers?: ContainerIo[];
}

/** A process in a host's process overview (report 387b0e). */
export interface ProcessNow {
  pid: number;
  name: string;
  /** Its command line, cut short; '' for a kernel thread. */
  command: string;
  /** The user it runs as. */
  user: string;
  /** The container it runs in, by its cgroup: the name Burrow knows it by, else the short id. */
  container: string | null;
  /** CPU over the sample, as top counts it: 100 is one core in full. */
  cpu: number;
  /** Its memory in RAM (resident). */
  memBytes: number;
}

/**
 * The processes now, sampled on demand while someone looks: every process's
 * CPU time twice, a couple of seconds apart, and its memory.
 */
export interface ProcessList {
  hostId: number;
  at: string;
  /** The length of the sample. */
  seconds: number;
  cores: number;
  memTotal: number;
  /** Processes on the host (those the SSH user may see). */
  total: number;
  /** The busiest on CPU and the largest in memory, up to 15 of each. */
  top: ProcessNow[];
}

export interface ContainerIo {
  container: string;
  readBps: number;
  writeBps: number;
  /** The same per whole disk. */
  disks: { disk: string; readBps: number; writeBps: number }[];
}

export interface SmartDisk {
  device: string;
  model: string | null;
  serial: string | null;
  /** null: SMART does not say. */
  passed: boolean | null;
  celsius: number | null;
  powerOnHours: number | null;
  /** SATA: reallocated and pending sectors. */
  reallocated: number | null;
  pending: number | null;
  /** NVMe: wear in percent and media errors. */
  percentUsed: number | null;
  mediaErrors: number | null;
  /** SATA: reported uncorrectable errors (187), command timeouts (188), offline uncorrectable sectors (198). */
  uncorrectable?: number | null;
  timeouts?: number | null;
  offlineUncorrectable?: number | null;
  /** NVMe: the critical warning bits (0: none). */
  criticalWarning?: number | null;
  /** What smartctl said when it could not read the disk (a USB bridge it does not know). */
  note?: string;
  /** smartctl could not read it (its answer was an error): no health known. */
  unread?: boolean;
  /**
   * The disk was asleep (standby) at this check and was not woken
   * (`smartctl -n standby`, decision 5); its numbers are from the check at
   * readAt, when there was one.
   */
  asleep?: boolean;
  readAt?: string;
  /** Burrow's judgement (judgeDisk), and why. */
  verdict?: DiskVerdict;
  reasons?: DiskReason[];
}

/**
 * How a disk is judged. Backblaze's drive statistics found five SMART
 * attributes that go with failing disks: 5 (reallocated), 187 (reported
 * uncorrectable), 188 (command timeout), 197 (pending) and 198 (offline
 * uncorrectable). Above zero, a disk fails far more often: "watch". Getting
 * worse since a while ago, SMART's own verdict, or an NVMe disk that warns
 * critically or is worn out: "failing".
 */
export type DiskVerdict = 'good' | 'watch' | 'failing' | 'unknown';

export type DiskAttr = 'reallocated' | 'pending' | 'uncorrectable' | 'timeouts' | 'offlineUncorrectable' | 'mediaErrors';

export type DiskReason =
  | { code: 'smart_failed' }
  | { code: 'critical_warning'; value: number }
  | { code: 'worn'; value: number }
  | { code: 'worn_out'; value: number }
  | { code: 'attr'; attr: DiskAttr; value: number; was?: number; since?: string };

/** Backblaze's five, and NVMe's media errors; 188 alone is often harmless (a cable), so it only ever counts as "watch". */
export const DISK_ATTRS: DiskAttr[] = ['reallocated', 'pending', 'uncorrectable', 'offlineUncorrectable', 'mediaErrors', 'timeouts'];

/**
 * A disk now, against how it was some time ago: each count against the
 * oldest kept check of the same disk that has that count (AUDIT2 SMART-02:
 * an early check without it hid later growth), with the NVMe wear limit.
 */
export function judgeDisk(d: SmartDisk, history: { at: string; disk: SmartDisk }[], wearPercent: number): { verdict: DiskVerdict; reasons: DiskReason[] } {
  const reasons: DiskReason[] = [];
  let failing = false;
  let watch = false;
  if (d.passed === false) {
    reasons.push({ code: 'smart_failed' });
    failing = true;
  }
  if ((d.criticalWarning ?? 0) > 0) {
    reasons.push({ code: 'critical_warning', value: d.criticalWarning! });
    failing = true;
  }
  if (d.percentUsed != null && d.percentUsed >= 100) {
    reasons.push({ code: 'worn_out', value: d.percentUsed });
    failing = true;
  } else if (d.percentUsed != null && d.percentUsed >= wearPercent) {
    reasons.push({ code: 'worn', value: d.percentUsed });
    watch = true;
  }
  for (const attr of DISK_ATTRS) {
    const value = d[attr];
    if (value == null || value <= 0) continue;
    const base = history.find((h) => h.disk[attr] != null);
    const was = base?.disk[attr];
    const worse = was != null && value > was && attr !== 'timeouts';
    reasons.push(worse ? { code: 'attr', attr, value, was, since: base!.at } : { code: 'attr', attr, value });
    if (worse) failing = true;
    else watch = true;
  }
  const known = d.passed !== null || DISK_ATTRS.some((a) => d[a] != null) || d.percentUsed != null;
  return { verdict: failing ? 'failing' : watch ? 'watch' : known ? 'good' : 'unknown', reasons };
}

/** The same disk in an older report: by serial number, else by its device name. */
export function sameDisk(d: SmartDisk, list: SmartDisk[]): SmartDisk | null {
  return (d.serial ? list.find((x) => x.serial === d.serial) : null) ?? list.find((x) => x.device === d.device && (!d.serial || !x.serial)) ?? null;
}

export interface SmartReport {
  hostId: number;
  checkedAt: string;
  /** none: smartctl is not installed; denied: no sudo; ok: read. */
  state: 'ok' | 'none' | 'denied' | 'error';
  message: string | null;
  disks: SmartDisk[];
}

/** One sample in the history (every few minutes). */
export interface HostSample {
  at: string;
  cpu: number;
  memPercent: number;
  load1: number;
  /** The fullest disk, in percent. */
  diskPercent: number;
  /** The hottest sensor, or null. */
  maxCelsius: number | null;
}

// The kernel's names for temperature sensors, for people. Unknown ones keep
// their own name.
const SENSORS: [RegExp, { en: string; nl: string }][] = [
  [/^(x86_pkg_temp|coretemp|k10temp|zenpower|cpu[-_]?thermal|soc[-_]thermal|cpu)/i, { en: 'CPU', nl: 'CPU' }],
  [/^(nvme)/i, { en: 'NVMe SSD', nl: 'NVMe-SSD' }],
  [/^(drivetemp|sd[a-z]|hdd)/i, { en: 'Disk', nl: 'Schijf' }],
  [/^(spd5118|jc42|dimm)/i, { en: 'Memory', nl: 'Geheugen' }],
  [/^(amdgpu|nouveau|radeon|gpu)/i, { en: 'GPU', nl: 'GPU' }],
  [/^(iwlwifi|ath|mt7)/i, { en: 'Wi-Fi', nl: 'Wifi' }],
  [/^(acpitz|pch|nct|it87|thermal_zone)/i, { en: 'Mainboard', nl: 'Moederbord' }],
];

/** "x86_pkg_temp" -> "CPU", "acpitz" -> "Mainboard"; an unknown sensor as it is. */
export function sensorLabel(label: string, lang: 'en' | 'nl' = 'en'): string {
  const chip = label.split(':')[0]!;
  return SENSORS.find(([re]) => re.test(chip))?.[1][lang] ?? chip;
}

/** When a host's numbers raise an alert: its own limits, or Burrow's defaults. */
export interface HostLimits {
  cpuCelsius: number;
  diskCelsius: number;
  diskPercent: number;
}

export const hostLimitsInput = z.object({
  cpuCelsius: z.number().int().min(40).max(120).nullable(),
  diskCelsius: z.number().int().min(30).max(90).nullable(),
  diskPercent: z.number().int().min(50).max(100).nullable(),
});

export interface HostLimitsView {
  /** What counts for this host now. */
  limits: HostLimits;
  /** Burrow's defaults, for "reset" and as the fields' hint. */
  defaults: HostLimits;
  /** This host's own values (null: the default). */
  own: { cpuCelsius: number | null; diskCelsius: number | null; diskPercent: number | null };
}
