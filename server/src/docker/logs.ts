import type { Client, ClientChannel } from 'ssh2';
import { CONTAINER_NAME, journalUnit, LOG_FILE_PATH, MAX_LOG_TARGETS, splitFileLine, splitTimestamp, UNIT_NAME, validLogSource, type LogLine, type LogServerMessage, type LogTarget } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { resolveTarget } from '../hosts/service.js';
import { endsWithChannel, exec, execChannel, openSsh } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';

// Streams `docker logs -t` of one or more containers, and log files (on the
// host, or in a container: through the host's side of a mount when there is
// one, else with `docker exec`), on one or more hosts, to a page. The page merges them by timestamp; this side only reads lines
// and sends them in small batches. One connection and one channel per host,
// however many of its containers: a small shell script runs a `docker logs`
// per container and marks each line with the container's index and stream
// (sshd allows only 10 channels per connection by default).

export const MAX_TARGETS = MAX_LOG_TARGETS;
const FLUSH_MS = 150;
const MAX_LINE = 16 * 1024;

/** Docker's --since/--until: a duration (15m, 2h, 30s) or an RFC 3339 time. */
export const TIME_ARG = /^(\d{1,6}[smh]|\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:\d\d))$/;

export interface LogOptions {
  since: string | null;
  until: string | null;
  tail: number;
  follow: boolean;
}

/**
 * "Since start" as a since: each source from its own last start, looked up on
 * the host (report c8d284: a merged view has no one start time, and the
 * range could not be chosen there at all). A container's output and its log
 * files: since the container started; a unit's journal: since the unit last
 * started (else this boot); a host's log file: since the host booted.
 */
export const SINCE_START = 'start';

/** A container's last start, as docker says it; empty for one never started (0001-01-01) or not found. */
const startedAt = (container: string) => `S=$(docker inspect --format '{{.State.StartedAt}}' -- ${container} 2>/dev/null); case "$S" in 0001-*) S= ;; esac;`;

export function logsCommand(container: string, o: LogOptions): string {
  if (!CONTAINER_NAME.test(container)) throw new Error('invalid container name');
  const q = (a: string) => (/^[\w.:+-]+$/.test(a) ? a : shellQuote(a));
  const start = o.since === SINCE_START;
  const args = ['docker', 'logs', '-t', '--tail', String(o.tail)].map(q);
  // Not found (S empty): docker logs says "No such container" itself.
  if (start) args.push('${S:+--since "$S"}');
  else if (o.since) args.push('--since', q(o.since));
  if (o.until) args.push('--until', q(o.until));
  if (o.follow) args.push('-f');
  args.push('--', q(container));
  const once = start ? `${startedAt(container)} ${args.join(' ')}` : args.join(' ');
  return o.follow && !o.until ? `${once};${followOn(q(container))}` : once;
}

/**
 * After a followed container's log ended well: on from that moment once it
 * runs again. Restarting, or gone (compose makes it anew under its name):
 * waited for up to a minute. Stopped: a few seconds (Restart stops it
 * first), then that is the end. The exit status is docker's last.
 */
const followOn = (name: string) =>
  ` R=$?; while [ $R -eq 0 ]; do T=$(date +%s.%N 2>/dev/null); case "$T" in *N*|'') T=$(date +%s);; esac; W=0; G=3; ` +
  `until S=$(docker inspect --format '{{.State.Status}}' -- ${name} 2>/dev/null); [ "$S" = running ]; do case "$S" in restarting|created|'') G=30;; esac; W=$((W+1)); [ $W -gt $G ] && break 2; sleep 2; done; ` +
  `docker logs -t --since "$T" -f -- ${name}; R=$?; done; (exit $R)`;

/** Where a container's path lies on the host, and the mount's own folder there: under the mount that holds it (the deepest), else null. */
export function mountedPath(mounts: { Source?: string; Destination?: string }[], file: string): { path: string; root: string } | null {
  let best: { src: string; dst: string } | null = null;
  for (const m of mounts) {
    if (!m.Source || !m.Destination) continue;
    const dst = m.Destination.replace(/\/+$/, '') || '/';
    if (file !== dst && !file.startsWith(dst === '/' ? '/' : `${dst}/`)) continue;
    if (!best || dst.length > best.dst.length) best = { src: m.Source, dst };
  }
  if (!best) return null;
  const root = best.src.replace(/\/+$/, '') || '/';
  return { path: (root === '/' ? '' : root) + file.slice(best.dst === '/' ? 0 : best.dst.length), root };
}

/**
 * A unit's journal, one line per entry with its time first (journalctl's
 * short-iso-precise). A user outside the journal's groups would see nothing
 * at all, which must not read as "no entries": sudo when that works without
 * a password, else a line saying why (as for a missing journalctl or unit).
 */
export function journalCommand(unit: string, o: LogOptions, now = Date.now()): string {
  if (!UNIT_NAME.test(unit)) throw new Error('invalid unit');
  const u = shellQuote(unit);
  const args = ['-q', '--no-pager', '-o', 'short-iso-precise', '-u', u, '-n', String(o.tail)];
  const start = o.since === SINCE_START;
  const since = start ? null : timeArgMs(o.since, now);
  const until = timeArgMs(o.until, now);
  if (since !== null) args.push('--since', `@${Math.floor(since / 1000)}`);
  if (until !== null) args.push('--until', `@${Math.ceil(until / 1000)}`);
  // Since the unit last started (systemd 248+ says it as @seconds); else since this boot.
  if (start) args.push('$B');
  if (o.follow) args.push('-f');
  return [
    '(',
    "command -v journalctl >/dev/null 2>&1 || { echo 'burrow-journal: journalctl is not on this host (no systemd journal)' >&2; exit 1; };",
    'J=journalctl;',
    // The real capability, not a guess from group names (AUDIT2 J-03): a user
    // outside the journal's groups gets a hint and no lines; then sudo, when
    // it may run journalctl without a password (a narrow sudoers line works).
    `if journalctl --no-pager -n 1 -u ${u} 2>&1 >/dev/null | grep -qiE 'insufficient permissions|not seeing messages|no journal files were opened'; then`,
    `if sudo -n journalctl --no-pager -n 1 -u ${u} >/dev/null 2>&1; then J='sudo -n journalctl'; else echo 'burrow-journal: no permission to read the journal (add the user to the systemd-journal group, or allow sudo journalctl without a password)' >&2; exit 1; fi;`,
    'fi;',
    // A unit that is gone but left entries is read (AUDIT2 J-04); one that
    // never was, with nothing in the journal, says so instead of an empty log.
    `if [ -z "$($J -q --no-pager -n 1 -u ${u} 2>/dev/null)" ] && command -v systemctl >/dev/null 2>&1 && ! systemctl cat -- ${u} >/dev/null 2>&1; then printf '%s\\n' ${shellQuote(`burrow-journal: no unit ${unit} on this host, and nothing in the journal for it`)} >&2; exit 1; fi;`,
    ...(start ? [`S=$(systemctl show -p ActiveEnterTimestamp --timestamp=unix --value -- ${u} 2>/dev/null); case "$S" in @[0-9]*) B="--since $S" ;; *) B=-b ;; esac;`] : []),
    `$J ${args.join(' ')}`,
    ')',
  ].join(' ');
}

/** A journal line without its host's name (the host is known): "proc[pid]: message", and without the unit's own name when given. */
export function journalText(text: string, unit?: string): string {
  const rest = text.replace(/^\S+ /, '');
  if (!unit) return rest;
  // "cron[812]: ..." in cron.service's own journal: the label names it already. Another's (systemd[1]) stays.
  const m = /^([^\s[:]+)(?:\[\d+\])?: /.exec(rest);
  const base = unit.replace(/\.service$/, '').replace(/@.*$/, '');
  return m && (m[1] === unit || m[1] === unit.replace(/\.service$/, '') || m[1] === base) ? rest.slice(m[0].length) : rest;
}

/**
 * Said instead of lines by a log file that is a link to the container's own
 * output (/dev/stderr, as nginx's images ship error.log): its lines are in
 * the container's log already, and tail on it waited until it timed out and
 * counted as unreadable (report 71d6c5).
 */
export const OUTPUT_MARK = '@@burrow-output';

/** A log file's first line: the zone where it is, as `date +%z` says ("+0200"). */
const ZONE_MARK = '@@burrow-zone';

/** Said first by a log file read "since start": when its container started, or when its host booted ("@seconds"). */
const SINCE_MARK = '@@burrow-since';

/** The start a log file's line says (ms; null when it could not be told), or undefined for any other line. */
export function sinceLine(text: string): number | null | undefined {
  const m = new RegExp(`^${SINCE_MARK} ?(\\S*)\\s*$`).exec(text);
  if (!m) return undefined;
  const v = m[1]!;
  if (/^@\d+$/.test(v)) return Number(v.slice(1)) * 1000;
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) || t <= 0 ? null : t;
}

/** The zone a log file's first line says ('' when date could not say), or null for any other line. */
export function zoneLine(text: string): string | null {
  const m = new RegExp(`^${ZONE_MARK} ?(\\S*)\\s*$`).exec(text);
  return m ? m[1]! : null;
}

/** `tail` of a log file: on the host (its own, or a container's through a mount), or inside the container; a unit's journal with journalctl. */
export function fileCommand(t: { container: string; file: string }, hostPath: { path: string; root: string } | null, o: LogOptions): string {
  const unit = journalUnit(t.file);
  if (unit) {
    if (t.container) throw new Error('invalid log file');
    return journalCommand(unit, o);
  }
  if (!LOG_FILE_PATH.test(t.file) || (t.container && !CONTAINER_NAME.test(t.container))) throw new Error('invalid log file');
  // First the zone where the file is (the host, or inside the container): its times without one are in it (AUDIT2 AI-12).
  const script = `case "$(readlink -f -- "$1" 2>/dev/null)" in /dev/*|/proc/*) echo ${OUTPUT_MARK}; exit 0;; esac; echo "${ZONE_MARK} $(date +%z 2>/dev/null)"; exec tail -n ${o.tail}${o.follow ? ' -F' : ''} -- "$1"`;
  const run = `sh -c ${shellQuote(script)} sh`;
  // "Since start": first when its container started (or the host booted), for the lines to be held to.
  const start = o.since !== SINCE_START ? '' : t.container ? `${startedAt(t.container)} echo "${SINCE_MARK} $S"; ` : `echo "${SINCE_MARK} @$(awk '/^btime/ {print $2}' /proc/stat 2>/dev/null)"; `;
  if (!t.container) return `${start}${run} ${shellQuote(t.file)}`;
  const inside = `docker exec -- ${t.container} ${run} ${shellQuote(t.file)}`;
  // The host's side of a mount when this user may read it; a Docker volume is root's alone, so else inside the container (AUDIT2 DO-18).
  // Only where it really lies inside the mount: a link the container put there (to the SSH user's keys) points at a file
  // the container could never read itself, and is read inside it instead (audit 2026-10-30).
  if (hostPath)
    return `${start}R=$(readlink -f -- ${shellQuote(hostPath.path)} 2>/dev/null); M=$(readlink -f -- ${shellQuote(hostPath.root)} 2>/dev/null); case "$R" in "$M"|"$M"/*) H=1;; *) H=;; esac; if [ -n "$M" ] && [ -n "$H" ] && [ -r "$R" ]; then ${run} "$R"; else ${inside}; fi`;
  return `${start}${inside}`;
}

/** The command that reads a log file now, its container's mounts looked at first (a file under a mount is read on the host). */
export async function fileTailCommand(client: Client, t: { container: string; file: string }, o: LogOptions): Promise<string> {
  let onHost: { path: string; root: string } | null = null;
  if (t.container && !journalUnit(t.file)) {
    if (!CONTAINER_NAME.test(t.container)) throw new Error('invalid container name');
    const r = await exec(client, `docker inspect --format '{{json .Mounts}}' -- ${t.container}`, 15_000, 1 << 20).catch(() => null);
    try {
      const mounts = r && r.code === 0 ? (JSON.parse(r.stdout) as { Source?: string; Destination?: string }[]) : [];
      onHost = mountedPath(Array.isArray(mounts) ? mounts : [], t.file);
    } catch {
      onHost = null;
    }
  }
  return fileCommand(t, onHost, o);
}

/** --since/--until as a time: a duration back from now, or the time itself (ms). */
export function timeArgMs(arg: string | null, now: number): number | null {
  if (!arg) return null;
  const d = /^(\d+)([smh])$/.exec(arg);
  if (d) return now - Number(d[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[d[2] as 's' | 'm' | 'h'];
  const t = Date.parse(arg);
  return Number.isNaN(t) ? null : t;
}

/**
 * The script for several sources of one host: each line comes out as
 * "<index> o|e <line>" (stdout, stderr), and "<index> x" when that
 * source ends. mawk buffers its input unless told otherwise.
 */
export function logsScript(targets: { i: number; command: string }[]): string {
  const lines = [
    `A=awk; [ -z "$(awk -W interactive 'BEGIN{}' </dev/null 2>&1)" ] && A='awk -W interactive'`,
    // The whole line as one string, one printf: one write, so the lines of
    // stdout and stderr never mix (mawk's interactive mode writes each
    // piece of a print on its own). A long line in parts of at most 1000
    // bytes ("<i> o+ part"), each written at once: a write to a pipe is whole
    // only up to 4096 bytes, and a longer one of another source could land
    // in the middle of it (review 2026-10-24). Bytes (LC_ALL=C), cut before
    // a UTF-8 continuation byte, never inside a character.
    `p() { LC_ALL=C $A -v p="$1" '{s=$0; while (length(s) > 1000) { n=1000; while (n > 1 && substr(s, n+1, 1) >= "\\200" && substr(s, n+1, 1) < "\\300") n--; printf "%s", p "+ " substr(s, 1, n) "\\n"; fflush(); s=substr(s, n+1) } printf "%s", p " " s "\\n"; fflush()}'; }`,
    // The source's own exit status, as a last stderr line: one that fails is not an ordinary end (AUDIT2 DO-19).
    ...targets.map(({ i, command }) => `( { { { { ${command}; } 2>&1 1>&3; echo "${EXIT_MARK} $?"; } | p '${i} e' 1>&4; } 3>&1 | p '${i} o'; } 4>&1; echo '${i} x' ) &`),
    'wait',
  ];
  return lines.join('\n');
}

const EXIT_MARK = '@@burrow-exit';

/** A source's exit status from its last stderr line, or null for any other line. */
export function exitLine(text: string): number | null {
  const m = new RegExp(`^${EXIT_MARK} (\\d+)$`).exec(text.trim());
  return m ? Number(m[1]) : null;
}

type ScriptLine = { i: number; s: 'o' | 'e'; text: string } | { i: number; end: true };

/** A line of logsScript's output: whose, which stream, and the line (null at the end of one). A part of a long one ("o+") is null here; scriptLines joins them. */
export function scriptLine(line: string): ScriptLine | null {
  const m = /^(\d+) ([oex])(?: (.*))?$/.exec(line);
  if (!m) return null;
  if (m[2] === 'x') return { i: Number(m[1]), end: true };
  return { i: Number(m[1]), s: m[2] as 'o' | 'e', text: m[3] ?? '' };
}

/** scriptLine for one stream, the parts of a long line joined again (at most MAX_LINE of it kept). */
export function scriptLines(): (line: string) => ScriptLine | null {
  const parts = new Map<string, string>();
  return (line) => {
    const m = /^(\d+) ([oe])\+ (.*)$/.exec(line);
    if (m) {
      const k = `${m[1]} ${m[2]}`;
      const had = parts.get(k) ?? '';
      if (had.length < MAX_LINE) parts.set(k, had + m[3]);
      return null;
    }
    const l = scriptLine(line);
    if (!l || 'end' in l) return l;
    const k = `${l.i} ${l.s}`;
    const had = parts.get(k);
    if (had === undefined) return l;
    parts.delete(k);
    return { ...l, text: had + l.text };
  };
}

/** Splits a byte stream into lines (keeping a partial last line for later). */
export class LineSplitter {
  #rest = '';
  readonly #decoder = new TextDecoder();
  push(chunk: Buffer): string[] {
    const s = this.#rest + this.#decoder.decode(chunk, { stream: true });
    const parts = s.split('\n');
    this.#rest = parts.pop() ?? '';
    if (this.#rest.length > MAX_LINE) {
      parts.push(this.#rest);
      this.#rest = '';
    }
    return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  }
  end(): string[] {
    const r = this.#rest + this.#decoder.decode();
    this.#rest = '';
    return r ? [r] : [];
  }
}

export class LogStream {
  readonly #clients: Client[] = [];
  readonly #channels: ClientChannel[] = [];
  #batch: LogLine[] = [];
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly targets: LogTarget[],
    private readonly opts: LogOptions,
    private readonly send: (m: LogServerMessage) => void,
  ) {}

  async start(): Promise<void> {
    this.ctx.log.info({ containers: this.targets.map((t) => `${t.hostId}:${t.container}`), follow: this.opts.follow }, `logs: streaming ${this.targets.length} container(s)`);
    const byHost = new Map<number, number[]>();
    this.targets.forEach((t, i) => byHost.set(t.hostId, [...(byHost.get(t.hostId) ?? []), i]));
    await Promise.all([...byHost.entries()].map(([hostId, idx]) => this.#connect(hostId, idx)));
  }

  async #connect(hostId: number, indexes: number[]): Promise<void> {
    const fail = (message: string) => indexes.forEach((i) => this.send({ t: 'error', i, message }));
    let conn;
    try {
      conn = await openSsh(this.ctx, resolveTarget(this.ctx, hostId));
    } catch (err) {
      return fail((err as Error).message);
    }
    if (!('client' in conn)) return fail('message' in conn ? conn.message : `host key: ${conn.status}`);
    const client = conn.client;
    if (this.#closed) return void client.end();
    this.#clients.push(client);
    client.on('error', () => {});
    this.#exec(client, indexes);
  }

  /** Each source's command; a container's file read on the host when a mount holds it. */
  async #commands(client: Client, indexes: number[]): Promise<{ i: number; command: string }[]> {
    return Promise.all(
      indexes.map(async (i) => {
        const t = this.targets[i]!;
        return { i, command: t.file ? await fileTailCommand(client, { container: t.container, file: t.file }, this.opts) : logsCommand(t.container, this.opts) };
      }),
    );
  }

  #exec(client: Client, indexes: number[]): void {
    const valid = indexes.filter((i) => {
      const t = this.targets[i]!;
      if (t.file ? validLogSource(t.container, t.file) && (!t.container || CONTAINER_NAME.test(t.container)) : CONTAINER_NAME.test(t.container)) return true;
      this.send({ t: 'error', i, message: t.file ? 'invalid log file' : 'invalid container name' });
      return false;
    });
    if (!valid.length) return;
    // A source whose command cannot be made (a host gone while its mounts were read): an error for
    // each, not a rejection nobody handles (that ended the process).
    void this.#commands(client, valid)
      .then((commands) => this.#run(client, valid, logsScript(commands)))
      .catch((err: Error) => {
        if (!this.#closed) valid.forEach((i) => this.send({ t: 'error', i, message: err.message }));
      });
  }

  #run(client: Client, valid: number[], cmd: string): void {
    if (this.#closed) return;
    // A file's lines carry their time in the text, or not at all (the next
    // line of a stack trace): then the line before's. --since/--until apply
    // to them here, as docker applies them to a container's.
    const now = Date.now();
    const start = this.opts.since === SINCE_START;
    const since = start ? null : timeArgMs(this.opts.since, now);
    const until = timeArgMs(this.opts.until, now);
    // "Since start": each log file's own start, from its first line.
    const starts = new Map<number, number | null>();
    const last = new Map<number, string>();
    // Per log file: the zone of where it is, from its first line.
    const zones = new Map<number, string>();
    // execChannel: ssh2 throws "Not connected" at once for a connection gone meanwhile, and waits a moment for a free channel.
    void execChannel(client, endsWithChannel(cmd)).then((ch) => {
      if (this.#closed) return void ch.close();
      this.#channels.push(ch);
      const out = new LineSplitter();
      const read = scriptLines();
      const ended = new Set<number>();
      // Sources that said why they failed already; one that only exits non-zero is said here.
      const said = new Set<number>();
      const exits = new Map<number, number>();
      const end = (i: number) => {
        if (ended.has(i) || this.#closed) return;
        ended.add(i);
        this.#flush();
        const code = exits.get(i);
        if (code !== undefined && code !== 0 && !said.has(i)) this.send({ t: 'error', i, message: `It ended with exit code ${code}.` });
        this.send({ t: 'end', i });
      };
      const take = (lines: string[]) => {
        for (const raw of lines) {
          const l = read(raw);
          if (!l || !valid.includes(l.i)) continue;
          if ('end' in l) {
            end(l.i);
            continue;
          }
          if (l.s === 'e') {
            const code = exitLine(l.text);
            if (code !== null) {
              exits.set(l.i, code);
              continue;
            }
          }
          if (this.targets[l.i]!.file) {
            // tail's or docker's own complaint (no such file, no such container), or why a journal cannot be read.
            if (l.s === 'e' && /^(tail: |Error|OCI runtime|burrow-journal: |journalctl: |Failed to )/i.test(l.text)) {
              said.add(l.i);
              this.send({ t: 'error', i: l.i, message: l.text.replace(/^burrow-journal: /, '') });
              continue;
            }
            if (l.text.trim() === OUTPUT_MARK) {
              this.send({ t: 'output', i: l.i });
              continue;
            }
            const began = start && l.s === 'o' && !starts.has(l.i) ? sinceLine(l.text) : undefined;
            if (began !== undefined) {
              starts.set(l.i, began);
              continue;
            }
            const zone = l.s === 'o' ? zoneLine(l.text) : null;
            if (zone !== null) {
              zones.set(l.i, zone);
              continue;
            }
            const unit = journalUnit(this.targets[l.i]!.file);
            const split = splitFileLine(l.text, undefined, zones.get(l.i) ?? null);
            if (unit) split.text = journalText(split.text, unit);
            const undated = !split.ts && !last.has(l.i);
            const ts = split.ts ?? last.get(l.i) ?? new Date().toISOString();
            last.set(l.i, ts);
            const at = Date.parse(ts);
            const from = start ? (starts.get(l.i) ?? null) : since;
            if ((from !== null && at < from) || (until !== null && at > until)) continue;
            this.#push({ i: l.i, s: l.s, ts, text: split.text.slice(0, MAX_LINE), ...(undated ? { undated: true as const } : {}) });
            continue;
          }
          const p = splitTimestamp(l.text);
          // Docker's own complaint ("No such container") has no timestamp.
          if (!p && l.s === 'e' && /^Error|no such container/i.test(l.text)) {
            said.add(l.i);
            this.send({ t: 'error', i: l.i, message: l.text });
            continue;
          }
          this.#push({ i: l.i, s: l.s, ts: p?.ts ?? new Date().toISOString(), text: (p?.text ?? l.text).slice(0, MAX_LINE) });
        }
      };
      ch.on('data', (d: Buffer) => take(out.push(d)));
      // The script's own trouble (a shell without awk): for the server's log.
      ch.stderr.on('data', (d: Buffer) => this.ctx.log.warn(`logs: ${String(d).slice(0, 300)}`));
      ch.on('close', () => {
        take(out.end());
        // Closed before a source said it ended: the connection went (the host, the network), not the log (AUDIT2 DO-19).
        for (const i of valid) {
          if (!ended.has(i) && !this.#closed && !said.has(i)) {
            said.add(i);
            this.send({ t: 'error', i, message: 'The connection to the host was lost.' });
          }
          end(i);
        }
      });
    }, (err: Error) => {
      if (!this.#closed) valid.forEach((i) => this.send({ t: 'error', i, message: err.message }));
    });
  }

  #push(l: LogLine): void {
    this.#batch.push(l);
    if (this.#batch.length >= 500) this.#flush();
    else this.#timer ??= setTimeout(() => this.#flush(), FLUSH_MS);
  }

  #flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#batch.length || this.#closed) return;
    const lines = this.#batch;
    this.#batch = [];
    this.send({ t: 'lines', lines });
  }

  close(): void {
    if (!this.#closed) this.ctx.log.debug('logs: stream closed');
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    for (const ch of this.#channels) ch.close();
    for (const c of this.#clients) c.end();
  }
}
