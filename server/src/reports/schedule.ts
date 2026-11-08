import type { ReportSchedule } from '@burrow/shared';

// When a report runs: weekly (a day and a time), daily (a time) or a cron
// expression (minute hour day-of-month month day-of-week), in the
// schedule's time zone. Checked once a minute.

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedParts(at: number, timeZone: string): ZonedParts {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });
    formats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday!) };
}

// ---- cron

type Field = Set<number>;
export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  domAny: boolean;
  dowAny: boolean;
}

function field(s: string, min: number, max: number): Field {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`not a cron field: ${part}`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === '*' ? min : Number(m[2]);
    const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    if (from < min || to > max || from > to || step < 1) throw new Error(`out of range: ${part}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** "0 8 * * 1" (minute hour day-of-month month day-of-week); 7 is Sunday too. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute hour day month weekday.');
  // Read as 0..7, then 7 (Sunday too) becomes 0: rewriting the text first
  // turned "1-7" into "1-0" and "*/7" into "*/0" (audit BE-24).
  const dow = new Set([...field(parts[4]!, 0, 7)].map((d) => (d === 7 ? 0 : d)));
  return {
    minute: field(parts[0]!, 0, 59),
    hour: field(parts[1]!, 0, 23),
    dom: field(parts[2]!, 1, 31),
    month: field(parts[3]!, 1, 12),
    dow,
    // As classic (Vixie) cron: a field that starts with "*" ("*/2" too)
    // does not restrict the day, so "0 8 */2 * 1" is every other day that
    // is a Monday, not every other day or a Monday (AUDIT2 MON-20).
    domAny: parts[2]!.startsWith('*'),
    dowAny: parts[4]!.startsWith('*'),
  };
}

export function cronMatches(c: Cron, p: ZonedParts): boolean {
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false;
  // Classic cron: with both day fields restricted, either may match.
  if (!c.domAny && !c.dowAny) return c.dom.has(p.day) || c.dow.has(p.weekday);
  return c.dom.has(p.day) && c.dow.has(p.weekday);
}

type When = Pick<ReportSchedule, 'kind' | 'day' | 'time' | 'cron' | 'timeZone'>;

/** Does the schedule run in this minute? */
export function dueAt(s: When, at: number, cron?: Cron | null): boolean {
  const p = zonedParts(at, s.timeZone);
  if (s.kind === 'cron') {
    const c = cron === undefined ? tryCron(s.cron) : cron;
    if (!c) return false;
    if (cronMatches(c, p)) return true;
    // Minutes the clocks skipped (spring forward): what fell in them runs now, once.
    const before = zonedParts(at - 60_000, s.timeZone);
    const gap = p.hour * 60 + p.minute - (before.hour * 60 + before.minute);
    if (before.day !== p.day || gap <= 1) return false;
    for (let m = before.hour * 60 + before.minute + 1; m < p.hour * 60 + p.minute; m++) if (cronMatches(c, { ...p, hour: Math.floor(m / 60), minute: m % 60 })) return true;
    return false;
  }
  const [h, m] = s.time.split(':').map(Number) as [number, number];
  if (s.kind === 'weekly' && p.weekday !== s.day) return false;
  if (p.hour === h && p.minute === m) return true;
  // The clocks went forward over that time (02:30 on the last Sunday of
  // March does not exist in Europe): due in the first minute after the gap.
  const before = zonedParts(at - 60_000, s.timeZone);
  const mins = (x: ZonedParts) => x.hour * 60 + x.minute;
  return before.day === p.day && mins(p) - mins(before) > 1 && mins(before) < h * 60 + m && h * 60 + m < mins(p);
}

export function tryCron(expr: string | null): Cron | null {
  try {
    return parseCron(expr ?? '');
  } catch {
    return null;
  }
}

/** Could the schedule run on this local day (month, day, weekday)? */
function dayCanMatch(s: When, cron: Cron | null, p: ZonedParts): boolean {
  if (cron) {
    if (!cron.month.has(p.month)) return false;
    if (!cron.domAny && !cron.dowAny) return cron.dom.has(p.day) || cron.dow.has(p.weekday);
    return cron.dom.has(p.day) && cron.dow.has(p.weekday);
  }
  return s.kind !== 'weekly' || p.weekday === s.day;
}

/** Could it run in this local hour? */
function hourCanMatch(s: When, cron: Cron | null, p: ZonedParts): boolean {
  if (!dayCanMatch(s, cron, p)) return false;
  if (cron) return cron.hour.has(p.hour);
  return Number(s.time.split(':')[0]) === p.hour;
}

const HOUR = 3_600_000;
// About a year and a month: a yearly schedule always has its next run in it.
const HORIZON = 400 * 24 * HOUR;

/**
 * The next minute it runs, within about a year; null if never. Day by day
 * and hour by hour where it cannot run, minute by minute only in an hour
 * where it can: walking every minute took over a second for a yearly cron
 * and gave up after five weeks (audit BE-28). Each hour's first minute is
 * still asked (dueAt): after the clocks go forward, what fell in the gap
 * runs then.
 */
export function nextRun(s: When, from: number): number | null {
  const cron = s.kind === 'cron' ? tryCron(s.cron) : null;
  if (s.kind === 'cron' && !cron) return null;
  let t = Math.ceil((from + 1) / 60_000) * 60_000;
  const end = t + HORIZON;
  while (t < end) {
    if (dueAt(s, t, cron)) return t;
    const p = zonedParts(t, s.timeZone);
    const hourStart = t - p.minute * 60_000;
    if (hourCanMatch(s, cron, p)) t += 60_000;
    // Not this day: to 23:00, then hour by hour over midnight (a day of 23
    // or 25 hours lands there too, never past the next day's first hour).
    else if (!dayCanMatch(s, cron, p) && p.hour < 23) t = hourStart + (23 - p.hour) * HOUR;
    else t = hourStart + HOUR;
  }
  return null;
}

/**
 * A key for "this minute of this schedule", so a run happens once: the
 * local date and time, so the hour that comes twice when the clocks go
 * back (02:30 at 00:30 and again at 01:30 UTC) is one run, not two.
 */
export function runKey(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)} ${timeZone}`;
}
