import { CONTAINER_NAME, type LogTarget } from './docker.js';

// Log files as a source of log lines, beside a container's own output: a
// file on the host ("1::/var/log/app.log") or in a container ("1:web:/data/
// logs/app.log", read through the host's side of a mount when there is one,
// else inside the container). In a list of targets the path is URL-encoded,
// so a comma or a colon in it cannot split the list.

/** An absolute path, without the characters a line-based protocol cannot carry. */
export const LOG_FILE_PATH = /^\/[^\0\n\r]{0,1023}$/;

/**
 * The longest a log source's subject can be ("container:<encoded path>", as
 * alerts, mutes, report choices and rules name it): a container's name, a
 * colon and the longest path, each of its characters up to 9 once encoded.
 */
export const MAX_SOURCE_SUBJECT = 128 + 1 + 9 * 1024;

// A systemd unit's journal (journalctl -u) is a log source of the host like
// a file: its "file" is "journal:<unit>" (never an absolute path, so the two
// cannot be taken for each other), kept, followed, analysed, watched by the
// alert rules and read for the reports the same way.

/** A unit's name as systemctl lists it, systemd's escapes included ("dev-disk-by\\x2duuid-1.device"); no spaces or quotes. */
export const UNIT_NAME = /^[A-Za-z0-9_.@:\\-]{1,255}$/;
const JOURNAL = /^journal:([A-Za-z0-9_.@:\\-]{1,255})$/;

/** The source for a unit's journal. */
/** As many logs as one view merges (the server refuses more). */
export const MAX_LOG_TARGETS = 100;

export const journalSource = (unit: string): string => `journal:${unit}`;

/** The unit when `file` is a journal source, else null. */
export function journalUnit(file: string | null | undefined): string | null {
  return file ? (JOURNAL.exec(file)?.[1] ?? null) : null;
}

/** A source a host or container may keep: an absolute path without "..", or (the host's own) a unit's journal. */
export function validLogSource(container: string, file: string): boolean {
  if (journalUnit(file)) return container === '';
  return LOG_FILE_PATH.test(file) && !file.split('/').includes('..');
}

/** A target as it is written in a URL or a list: "host:container" or "host:container:path". */
export function targetKey(t: LogTarget): string {
  return t.file ? `${t.hostId}:${t.container}:${encodeURIComponent(t.file)}` : `${t.hostId}:${t.container}`;
}

/** The other way round; null for anything that is not a well-formed target. */
export function parseTarget(s: string): LogTarget | null {
  const m = /^(\d+):([^:]*)(?::(.+))?$/.exec(s.trim());
  if (!m) return null;
  const hostId = Number(m[1]);
  const container = m[2]!;
  if (container && !CONTAINER_NAME.test(container)) return null;
  if (m[3] === undefined) return container ? { hostId, container } : null;
  let file: string;
  try {
    file = decodeURIComponent(m[3]);
  } catch {
    return null;
  }
  return validLogSource(container, file) ? { hostId, container, file } : null;
}

/** What a person reads for a target: the container, or the file's name (and its container). */
export function targetLabel(t: LogTarget): string {
  if (!t.file) return t.container;
  const unit = journalUnit(t.file);
  if (unit) return `${unit} (journal)`;
  const name = t.file.split('/').filter(Boolean).pop() ?? t.file;
  return t.container ? `${name} (${t.container})` : name;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The time a log file's line was written, when the line says so near its
 * start: ISO 8601 ("2026-10-04T12:00:00.123Z", "2026-10-04 12:00:00,123"),
 * the common log format ("[04/Oct/2026:12:00:00 +0200]") or syslog ("Oct  4
 * 12:00:00", the year guessed). A time without a zone is in `zone`, the
 * source's own ("+0200", what `date +%z` says where the file is), else
 * local time where this runs. Fractions finer than a millisecond are kept,
 * so lines of the same millisecond keep their order. Null when the line has
 * none (a stack trace's next line): the caller keeps the time of the line
 * before.
 */
export function fileLineTime(text: string, now = new Date(), zone: string | null = null): string | null {
  const head = text.slice(0, 80);
  const source = zone !== null && Number.isFinite(zoneMs(zone)) ? zoneMs(zone) : null;
  // Wall-clock fields as a moment: in the line's zone, else the source's, else local time.
  const at = (y: number, mon: number, d: number, h: number, mi: number, sec: number, ms = 0, own?: string) => {
    if (own) return new Date(Date.UTC(y, mon, d, h, mi, sec, ms) - zoneMs(own));
    if (source !== null) return new Date(Date.UTC(y, mon, d, h, mi, sec, ms) - source);
    return new Date(y, mon, d, h, mi, sec, ms);
  };
  let m = /(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?\s?(Z|[+-]\d\d:?\d\d)?/.exec(head);
  if (m) {
    if (!realTime(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) return null;
    const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));
    const iso = valid(at(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, ms, m[8]));
    // Offsets are whole minutes: the milliseconds stay what the line said, the finer digits after them.
    return iso && m[7] && m[7].length > 3 ? iso.replace(/\.\d{3}Z$/, `.${m[7]}Z`) : iso;
  }
  m = /\[(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d{4})\]/.exec(head);
  if (m) {
    const mon = MONTHS.indexOf(m[2]!.toLowerCase());
    if (mon < 0 || !realTime(+m[3]!, mon, +m[1]!, +m[4]!, +m[5]!, +m[6]!)) return null;
    return valid(at(+m[3]!, mon, +m[1]!, +m[4]!, +m[5]!, +m[6]!, 0, m[7]!));
  }
  m = /^(?:<\d+>)?([A-Za-z]{3}) {1,2}(\d{1,2}) (\d\d):(\d\d):(\d\d)/.exec(head);
  if (m) {
    const mon = MONTHS.indexOf(m[1]!.toLowerCase());
    if (mon < 0) return null;
    let year = now.getFullYear();
    let d = at(year, mon, +m[2]!, +m[3]!, +m[4]!, +m[5]!);
    // No year: in the future by more than a day, it was last year's.
    if (d.getTime() - now.getTime() > 86_400_000) d = at(--year, mon, +m[2]!, +m[3]!, +m[4]!, +m[5]!);
    if (!realTime(year, mon, +m[2]!, +m[3]!, +m[4]!, +m[5]!)) return null;
    return valid(d);
  }
  return null;
}

/**
 * A log file's line split like a container's: its time (when the line
 * starts with one, ISO 8601 or syslog) and the rest, so the time shows once,
 * in its own column. A line with its time further in stays whole.
 */
export function splitFileLine(text: string, now = new Date(), zone: string | null = null): { ts: string | null; text: string } {
  const lead = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d{1,9})?\s?(?:Z|[+-]\d\d:?\d\d)?|[A-Za-z]{3} {1,2}\d{1,2} \d\d:\d\d:\d\d)\s+/.exec(text);
  const ts = fileLineTime(text, now, zone);
  if (!lead || !ts) return { ts, text };
  return { ts, text: text.slice(lead[0].length) };
}

/** Whether the fields name a real moment: no February 30, no 24:00 or minute 60 (Date would roll those over into another date). */
function realTime(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  return month >= 0 && month < 12 && day >= 1 && day <= new Date(Date.UTC(year, month + 1, 0)).getUTCDate() && hour < 24 && minute < 60 && second < 60;
}

/** The offset in milliseconds; NaN for one no zone has (over 14 hours, minute 60 or more). */
function zoneMs(z: string): number {
  if (z === 'Z') return 0;
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(z);
  if (!m || Number(m[2]) > 14 || Number(m[3]) > 59) return NaN;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

function valid(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A log file kept with a container (or a host: container ''). */
export interface LogFile {
  id: number;
  hostId: number;
  container: string;
  path: string;
}

/** A unit as systemctl lists it, for choosing a journal. */
export interface JournalUnit {
  unit: string;
  /** loaded, not-found, masked, ... */
  load: string;
  /** active, inactive, failed, ... */
  active: string;
  /** running, exited, dead, ... */
  sub: string;
  description: string;
}

/** `systemctl list-units --no-legend --plain` lines: unit, load, active, sub, then the description. */
export function parseUnits(out: string): JournalUnit[] {
  const units: JournalUnit[] = [];
  for (const line of out.split('\n')) {
    // A failed unit is marked with a dot (or an x) before its name in some versions.
    const m = /^\s*(?:[*\u25cf\u00d7x]\s+)?(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m || !UNIT_NAME.test(m[1]!) || !/\.(service|socket|timer|mount|automount|path|target|scope|slice|swap|device)$/.test(m[1]!)) continue;
    units.push({ unit: m[1]!, load: m[2]!, active: m[3]!, sub: m[4]!, description: m[5]!.trim() });
  }
  return units.sort((a, b) => a.unit.localeCompare(b.unit));
}
