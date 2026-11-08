import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { AI_TURNS_KEPT, AltScreenFilter, effectiveConnection, isTermReply, type AiTurn, type PathEntry, type SharedSession, type TerminalMode, type TerminalSessionInfo } from '@burrow/shared';
import { recordCommand } from '../history/service.js';
import { audit, type Actor } from '../audit.js';
import { hostDefaults } from '../hosts/defaults.js';
import type { Ctx } from '../context.js';
import { terminalSessions, users } from '../db/schema.js';
import { getHost, groupMap, hostPassword, resolveTarget, touchHost } from '../hosts/service.js';
import { HttpError } from '../http.js';
import { exec, openSsh } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { deviceLabel, LiveSession, mouseEncoding, screenModes, type Row, type Viewer, type ViewerSocket } from './live.js';
import { Recorder } from './recorder.js';
import { closeOrphanRecordings } from './recordings.js';
import { DETACHED, GONE, TMUX, tmuxAttachScript, tmuxCreateScript } from './tmux.js';
import { typeWhenReady } from './ready.js';

// The server owns every terminal: the SSH connection, the PTY and a headless
// xterm that mirrors the screen. Browser tabs are viewers that attach and
// detach; a viewer that (re)connects gets the exact current screen from the
// headless terminal instead of a replay of raw bytes.
//
// tmux mode runs the shell inside tmux on the host, on a tmux server of its
// own (`tmux -L burrow`), so the session also survives a restart of Burrow and
// never touches the user's own tmux sessions or ~/.tmux.conf. Memory mode is
// the fallback without tmux: the shell lives only as long as this process.

// Lines of scrollback sent to a viewer that attaches.
const SNAPSHOT_SCROLLBACK = 2000;
// The history layer (history()): tmux's history-limit, at most this much of it, and the exit code for "a program on the alternate screen".
const HISTORY_LINES = 10_000;
const HISTORY_BYTES = 3 << 20;
const HISTORY_ALT = 47;
// No tmux of the person's own attached in a session without Burrow's tmux (ownTmuxHistoryCommand).
const OWN_NONE = 48;
// Output not yet parsed by the server's copy of the screen at which the channel pauses, and resumes.
const PENDING_HIGH = 4 << 20;
const PENDING_LOW = 1 << 20;

/**
 * The history layer's lines on the host. Burrow's tmux: its pane's history. A tmux of the person's own
 * attached in it (Claude Code in it, the person's own setup): that tmux's pane on the screen, found by
 * its client's terminal, which is Burrow's pane's; Burrow's pane holds only its screen then. A program
 * on the alternate screen (less, vim; in either tmux) has no history: HISTORY_ALT, scrolled as before.
 * So does one that took the mouse (`mouse`) in Burrow's own pane: its wheel is its own.
 */
export function historyCommand(name: string, mouse: boolean): string {
  const capture = (target: string, tmux: string) => `H=$(${tmux} capture-pane -p -e -J -S -${HISTORY_LINES} -t ${target}) || exit 1; printf '%s\\n' "$H" | tail -c ${HISTORY_BYTES}`;
  return [
    `I=$(${TMUX} display-message -p -t ${name} '#{alternate_on}:#{pane_current_command}:#{pane_tty}') || exit 1`,
    'case "$I" in',
    // Its own tmux: the person's default server (no TMUX here: an SSH command's own environment).
    `  1:tmux:*) T=\${I#1:tmux:}; P=$(tmux list-clients -F '#{client_tty} #{pane_id} #{alternate_on}' 2>/dev/null | awk -v t="$T" '$1 == t { print $2, $3; exit }')`,
    `    [ -n "$P" ] || exit ${HISTORY_ALT}; set -- $P; [ "$2" = 1 ] && exit ${HISTORY_ALT}; ${capture('"$1"', 'tmux')} ;;`,
    `  1:*) exit ${HISTORY_ALT} ;;`,
    `  *) ${mouse ? `exit ${HISTORY_ALT}` : capture(name, TMUX)} ;;`,
    'esac',
  ].join('\n');
}

/**
 * The history layer's lines in a session without Burrow's tmux: a tmux of the person's own attached
 * in it (`tmux attach`, the person's own setup; 2.20.0 found one only inside Burrow's tmux). Its client
 * is on the session's terminal, which is the one of the shell beside this command: Burrow opens an SSH
 * connection per session, so the shell and this command are both children of its sshd ($PPID). Read
 * from /proc (no ps on a slim host). No such tmux: OWN_NONE, and the session's own copy is used.
 */
export function ownTmuxHistoryCommand(): string {
  const capture = `H=$(tmux capture-pane -p -e -J -S -${HISTORY_LINES} -t "$1") || exit 1; printf '%s\\n' "$H" | tail -c ${HISTORY_BYTES}`;
  return [
    'T=',
    // Its parent's id: the fields after the name, which can hold spaces and ends at the last ")".
    'for d in /proc/[0-9]*; do { read -r s < "$d/stat"; } 2>/dev/null || continue; s=${s##*) }; set -- $s; [ "$2" = "$PPID" ] || continue',
    '  t=$(readlink "$d/fd/0" 2>/dev/null); case "$t" in /dev/pts/*|/dev/tty*) T=$t; break ;; esac; done',
    `[ -n "$T" ] || exit ${OWN_NONE}`,
    `P=$(tmux list-clients -F '#{client_tty} #{pane_id} #{alternate_on}' 2>/dev/null | awk -v t="$T" '$1 == t { print $2, $3; exit }')`,
    `[ -n "$P" ] || exit ${OWN_NONE}; set -- $P; [ "$2" = 1 ] && exit ${HISTORY_ALT}`,
    capture,
  ].join('\n');
}

export interface ManagerOptions {
  maxSessions: number;
  idleMinutes: number;
}

export class TerminalManager {
  readonly #live = new Map<string, LiveSession>();
  // Attach in progress per session, so two viewers never reconnect twice.
  readonly #connecting = new Map<string, Promise<LiveSession>>();
  // The AI dialog's questions and suggestions per session (report 411dbe): in memory only,
  // masked, the newest AI_TURNS_KEPT; forgotten with the session.
  readonly #ai = new Map<string, AiTurn[]>();
  #idleTimer: NodeJS.Timeout | null = null;
  /** A database write failed (the data disk full, OPS-W-02): for the disk watch to be told. */
  onWriteFailed: ((err: unknown) => void) | null = null;
  // Said once until a write works again: not a log line per keystroke.
  #writeFailing = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: ManagerOptions,
  ) {}

  /**
   * At start-up: memory sessions died with the previous process, and so did whatever recorded.
   * Not fatal when it cannot be written (the data disk full): it threw out of start, and Burrow
   * never got to say the disk is full, started again, and threw again.
   */
  start(): void {
    this.#safely('the sessions of the last run', () => {
      const lost = this.ctx.db.delete(terminalSessions).where(eq(terminalSessions.mode, 'memory')).returning().all();
      for (const r of lost) {
        audit(this.ctx, { userId: r.userId, username: null, ip: null }, 'terminal.lost', r.id, { hostId: r.hostId });
      }
    });
    this.#safely('the recordings of the last run', () => closeOrphanRecordings(this.ctx));
    // Always swept: the limit can be set while Burrow runs (Settings -> System); 0 closes nothing.
    this.#idleTimer = setInterval(() => this.#closeIdle(), 60_000);
    this.#idleTimer.unref();
  }

  /** At shutdown: disconnect, but leave tmux sessions running on the hosts. */
  stop(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    for (const s of this.#live.values()) {
      s.closing = true;
      s.recorder?.stop();
      s.broadcast({ t: 'exit', reason: 'lost', message: 'Burrow is restarting.' });
      for (const v of s.viewers.values()) v.socket.close(1012, 'restart');
      s.client?.end();
    }
    this.#live.clear();
    this.#safely('the sessions at shutdown', () => this.ctx.db.delete(terminalSessions).where(eq(terminalSessions.mode, 'memory')).run());
  }

  /**
   * A database write from an SSH or WebSocket event (a keystroke, output, a channel that closed)
   * or start-up: one that throws (the data disk full) is said, never thrown there, where it ended
   * the process and every session in it.
   */
  #safely(what: string, write: () => unknown): void {
    try {
      write();
      this.#writeFailing = false;
    } catch (err) {
      this.#writeFailed(what, err);
    }
  }

  #writeFailed(what: string, err: unknown): void {
    this.onWriteFailed?.(err);
    if (this.#writeFailing) return;
    this.#writeFailing = true;
    this.ctx.log.error({ err }, `terminals: ${what} could not be saved; the sessions go on`);
  }

  /**
   * The sessions of one Burrow user: a session is its opener's. Another admin
   * typed into it, shared it, recorded or closed it, with no step-up (audit
   * 2026-11-05); now they watch it only when it is shared with them (F3).
   */
  list(userId: number): TerminalSessionInfo[] {
    const rows = this.ctx.db.select().from(terminalSessions).all().filter((r) => r.userId === userId);
    return rows
      .map((r) => this.#info(r))
      .filter((x): x is TerminalSessionInfo => x !== null)
      // In the order they were opened: tabs that swapped places with every
      // bit of activity were hard to find again.
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Refused as not there unless the session is this user's own: what it is, is not said to anyone else. */
  own(id: string, userId: number): void {
    if (this.#row(id)?.userId !== userId) throw new HttpError(404, 'not_found');
  }

  get(id: string): TerminalSessionInfo {
    const r = this.#row(id);
    const info = r && this.#info(r);
    if (!info) throw new HttpError(404, 'not_found');
    return info;
  }

  /** The AI dialog's conversation of a session, oldest first. */
  aiTurns(id: string): AiTurn[] {
    if (!this.#row(id)) throw new HttpError(404, 'not_found');
    return this.#ai.get(id) ?? [];
  }

  addAiTurn(id: string, turn: AiTurn): void {
    if (!this.#row(id)) return;
    this.#ai.set(id, [...(this.#ai.get(id) ?? []), turn].slice(-AI_TURNS_KEPT));
  }

  clearAi(id: string): void {
    if (!this.#row(id)) throw new HttpError(404, 'not_found');
    this.#ai.delete(id);
  }

  #row(id: string): Row | undefined {
    return this.ctx.db.select().from(terminalSessions).where(eq(terminalSessions.id, id)).get();
  }

  #info(r: Row): TerminalSessionInfo | null {
    const live = this.#live.get(r.id);
    let hostName: string;
    try {
      hostName = live?.hostName ?? getHost(this.ctx, r.hostId).name;
    } catch {
      return null;
    }
    return {
      id: r.id,
      hostId: r.hostId,
      hostName,
      mode: r.mode,
      title: r.title,
      createdAt: new Date(r.createdAt).toISOString(),
      lastActivityAt: new Date(r.lastActivityAt).toISOString(),
      attached: live !== undefined,
      cols: live?.cols ?? 80,
      rows: live?.rows ?? 24,
      viewers: live?.viewerList() ?? [],
      sharedWith: sharedOf(r),
      recording: r.recording,
    };
  }

  /** Open a new session on a host. */
  async create(
    actor: Actor & { userId: number },
    hostId: number,
    cols: number,
    rows: number,
    cwd?: string,
    /** Run this instead of staying in the shell (a container's shell); the session ends with it. */
    run?: { command: string; title: string },
    /** Unlike the host's setting, for this session only. */
    tmuxOverride?: 'always' | 'never',
  ): Promise<TerminalSessionInfo> {
    // The ones still being made count too: checked before any was stored,
    // several opened at once all passed (audit BE-26).
    if (this.ctx.db.select({ id: terminalSessions.id }).from(terminalSessions).all().length + this.#creating >= this.opts.maxSessions) {
      throw new HttpError(409, 'too_many_sessions', `At most ${this.opts.maxSessions} sessions can be open. Close one first.`);
    }
    this.#creating++;
    try {
      return await this.#create(actor, hostId, cols, rows, cwd, run, tmuxOverride);
    } finally {
      this.#creating--;
    }
  }

  #creating = 0;

  async #create(
    actor: Actor & { userId: number },
    hostId: number,
    cols: number,
    rows: number,
    cwd: string | undefined,
    run: { command: string; title: string } | undefined,
    tmuxOverride: 'always' | 'never' | undefined,
  ): Promise<TerminalSessionInfo> {
    const host = getHost(this.ctx, hostId);
    const eff = effectiveConnection(host, groupMap(this.ctx), hostDefaults(this.ctx));
    const target = resolveTarget(this.ctx, hostId);
    const conn = await openSsh(this.ctx, target);
    if (!('client' in conn)) {
      // In words the app has in both languages, not "Host key check: unknown_host_key" (W-FUNC-02).
      const keyWords: Record<string, string> = {
        unknown_host_key: "This host's key is not trusted yet: check its fingerprint in the host's menu, then trust it.",
        host_key_mismatch: 'A different key is already trusted for this host. Remove it first.',
      };
      throw new HttpError(conn.status === 'auth_failed' ? 401 : 502, conn.status, 'message' in conn ? conn.message : (keyWords[conn.status] ?? conn.status));
    }
    const client = conn.client;
    try {
      let mode: TerminalMode = 'memory';
      const tmux = tmuxOverride ?? eff.tmux;
      if (tmux !== 'never') {
        const probe = await exec(client, 'command -v tmux >/dev/null 2>&1 && echo yes || echo no', 10_000);
        const hasTmux = probe.stdout.trim() === 'yes';
        if (hasTmux) mode = 'tmux';
        else if (tmux === 'always') {
          throw new HttpError(409, 'tmux_missing', 'This host is set to always use tmux, but tmux is not installed.');
        }
      }
      const id = randomBytes(9).toString('base64url');
      const now = this.ctx.now();
      const row: Row = {
        id,
        hostId,
        userId: actor.userId,
        mode,
        // Letters and digits only: the name goes into shell commands.
        tmuxName: mode === 'tmux' ? `burrow-${id.replace(/[^A-Za-z0-9]/g, 'x')}` : null,
        title: run?.title ?? null,
        createdAt: now,
        lastActivityAt: now,
        sharedWith: '[]',
        recording: false,
      };
      const live = new LiveSession(row, host.name, cols, rows, eff.encoding);
      live.client = client;
      const pty = { term: eff.term, cols, rows };
      // The host's startup command first, then the requested directory (in tmux its session starts there).
      const startup = run ? null : [eff.startupCommand, cwd && mode !== 'tmux' ? `cd -- ${shellQuote(cwd)}` : null].filter(Boolean).join('; ') || null;
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const cb = (err: Error | undefined, ch: ClientChannel) => (err ? reject(err) : resolve(ch));
        if (mode === 'tmux') client.exec(tmuxCreateScript(row.tmuxName!, cols, rows, startup, run?.command, run ? undefined : cwd), { pty }, cb);
        else if (run) client.exec(run.command, { pty }, cb);
        else client.shell(pty, cb);
      });
      if (mode === 'memory' && startup) live.startupNow = typeWhenReady(channel, `${startup}\n`);
      this.ctx.db.insert(terminalSessions).values(row).run();
      this.#wire(live, channel);
      touchHost(this.ctx, hostId);
      audit(this.ctx, actor, 'terminal.open', host.name, { session: id, mode, ...(run ? { run: run.title } : {}) });
      return this.#info(row)!;
    } catch (err) {
      client.end();
      throw err;
    }
  }

  #wire(live: LiveSession, channel: ClientChannel): void {
    live.channel = channel;
    this.#live.set(live.row.id, live);
    live.onShellChange = () => live.broadcast({ t: 'shell', shell: live.shell });
    live.onCommand = (cmd) => {
      try {
        recordCommand(this.ctx, live.row.hostId, cmd, this.ctx.now(), live.lastCommand);
        live.lastCommand = cmd;
        live.shell = { ...live.shell, lastCommand: cmd };
        live.broadcast({ t: 'shell', shell: live.shell });
      } catch (err) {
        this.#writeFailed('a command for the history', err);
      }
    };
    // Broadcast from the write callback: the headless terminal parses in
    // order, so a snapshot taken in a later callback plus every broadcast
    // after it is exactly the stream, with nothing lost or doubled.
    // Without tmux: no alternate screen, so what came before stays in the scrollback (altscreen.ts).
    const alt = live.row.mode === 'memory' ? new AltScreenFilter() : null;
    live.alt = alt;
    // Flow control, as xterm advises: the headless terminal parses at its own pace and throws once
    // 50 MB wait unparsed ("write data discarded"), out of the SSH event, which ended the process (a
    // shell printing faster than it parses: `yes`, a big cat). The channel pauses meanwhile, and
    // SSH's window holds the program on the host back.
    let pending = 0;
    let paused = false;
    const onData = (d: Buffer) => {
      const decoded = live.decoder.decode(d, { stream: true });
      const was = alt?.on;
      const text = alt ? alt.write(decoded) : decoded;
      const now = alt?.on;
      pending += text.length;
      if (pending > PENDING_HIGH && !paused) {
        paused = true;
        channel.pause();
        channel.stderr.pause();
      }
      if (text)
        live.term.write(text, () => {
          pending -= text.length;
          if (paused && pending < PENDING_LOW) {
            paused = false;
            channel.resume();
            channel.stderr.resume();
          }
          live.broadcast({ t: 'output', d: text });
          live.recorder?.output(text);
          if (now !== was) live.broadcast({ t: 'alt', on: !!now });
        });
      else if (now !== was) live.term.write('', () => live.broadcast({ t: 'alt', on: !!now }));
    };
    channel.on('data', onData);
    channel.stderr.on('data', onData);
    channel.on('close', (code: number | null) => this.#channelClosed(live, code));
    live.client!.on('error', () => {
      // A dropped connection closes the channel too; handled there.
    });
  }

  #channelClosed(live: LiveSession, code: number | null): void {
    if (this.#live.get(live.row.id) !== live) return;
    this.#live.delete(live.row.id);
    live.recorder?.stop();
    live.client?.end();
    if (live.closing) return;
    const row = this.#row(live.row.id);
    // tmux attach ends with 0 when the shell in tmux exits and the session is
    // gone; anything else in tmux mode is a lost connection: keep the row so
    // the next viewer re-attaches.
    const ended = live.row.mode === 'memory' || code === 0 || code === GONE;
    if (ended) {
      if (row) this.#safely('an ended session', () => this.ctx.db.delete(terminalSessions).where(eq(terminalSessions.id, live.row.id)).run());
      this.#ai.delete(live.row.id);
      live.broadcast({ t: 'exit', reason: 'ended' });
      this.#safely('an ended session', () => audit(this.ctx, { userId: live.row.userId, username: null, ip: null }, 'terminal.ended', live.hostName, { session: live.row.id, code }));
    } else {
      // Kept: a viewer connects again and attaches anew (also after a detach on the host).
      live.broadcast({ t: 'exit', reason: 'lost', message: code === DETACHED ? 'Detached on the host.' : 'Connection to the host was lost.' });
    }
    for (const v of live.viewers.values()) v.socket.close(1000, 'ended');
  }

  /** Bring a detached tmux session back after a restart or a dropped connection. */
  async #reattach(row: Row): Promise<LiveSession> {
    const pending = this.#connecting.get(row.id);
    if (pending) return pending;
    const p = (async () => {
      if (row.mode !== 'tmux' || !row.tmuxName) throw new HttpError(410, 'session_gone');
      const host = getHost(this.ctx, row.hostId);
      const eff = effectiveConnection(host, groupMap(this.ctx), hostDefaults(this.ctx));
      const conn = await openSsh(this.ctx, resolveTarget(this.ctx, row.hostId));
      if (!('client' in conn)) throw new HttpError(502, conn.status, 'message' in conn ? conn.message : conn.status);
      // At the size the window has on the host: attached at 80x24, a full-screen program drew itself
      // twice (shrunk, then grown to the viewer's), and the snapshot came at 80x24 (review 2026-10-24).
      const had = await exec(conn.client, `${TMUX} display-message -p -t ${row.tmuxName} '#{window_width} #{window_height}'`, 5_000)
        .then((r) => /^(\d+) (\d+)$/.exec(r.stdout.trim()))
        .catch(() => null);
      const cols = had ? Math.min(Math.max(Number(had[1]), 20), 500) : 80;
      const rows = had ? Math.min(Math.max(Number(had[2]), 5), 300) : 24;
      const live = new LiveSession(row, host.name, cols, rows, eff.encoding);
      live.client = conn.client;
      let channel: ClientChannel;
      try {
        channel = await new Promise<ClientChannel>((resolve, reject) =>
          conn.client.exec(tmuxAttachScript(row.tmuxName!), { pty: { term: eff.term, cols, rows } }, (err, ch) => (err ? reject(err) : resolve(ch))),
        );
      } catch (err) {
        // No channel (the host refused it): the connection is not left open.
        conn.client.end();
        throw err;
      }
      // Closed while it connected: not brought back as a session no one can see (AUDIT2 FS-15).
      if (!this.#row(row.id)) {
        channel.close();
        conn.client.end();
        throw new HttpError(410, 'session_gone');
      }
      this.#wire(live, channel);
      // Recorded before it was lost: a new recording from here on (the gap is not in one). One that
      // cannot start (the data disk full) does not keep the session from its viewer.
      if (this.#row(row.id)?.recording) {
        try {
          this.#record(live);
        } catch (err) {
          this.#writeFailed('a new recording', err);
        }
      }
      audit(this.ctx, { userId: row.userId, username: null, ip: null }, 'terminal.reattach', host.name, { session: row.id });
      return live;
    })();
    this.#connecting.set(row.id, p);
    try {
      return await p;
    } finally {
      this.#connecting.delete(row.id);
    }
  }

  /** Attach a viewer; it receives a snapshot and then the live stream. */
  async attach(id: string, socket: ViewerSocket, meta: { userAgent: string | null; sessionIdHash: string; watcher?: { userId: number; username: string } }): Promise<string> {
    const row = this.#row(id);
    if (!row) throw new HttpError(404, 'not_found');
    // Watching only what was shared with this person (F3).
    if (meta.watcher && !sharedOf(row).includes(meta.watcher.userId)) throw new HttpError(404, 'not_found');
    const live = this.#live.get(id) ?? (await this.#reattach(row));
    const viewer: Viewer = {
      id: randomBytes(6).toString('base64url'),
      device: deviceLabel(meta.userAgent),
      socket,
      sessionIdHash: meta.sessionIdHash,
      connectedAt: this.ctx.now(),
      cols: null,
      rows: null,
      watching: meta.watcher?.username ?? null,
      watcherId: meta.watcher?.userId ?? null,
    };
    await new Promise<void>((resolve) =>
      live.term.write('', () => {
        live.viewers.set(viewer.id, viewer);
        live.send(viewer, {
          t: 'snapshot',
          data: live.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }) + screenModes(live.term) + mouseEncoding(live.term),
          cols: live.cols,
          rows: live.rows,
          mode: live.row.mode,
          shell: live.shell,
          ...(live.alt?.on ? { alt: true } : {}),
        });
        resolve();
      }),
    );
    // Closed while the snapshot was made: this viewer goes too, not left on a session that is gone (AUDIT2 FS-15).
    if (live.closing || this.#live.get(id) !== live) {
      live.viewers.delete(viewer.id);
      socket.close(1000, 'closed');
      throw new HttpError(410, 'session_gone');
    }
    live.broadcast({ t: 'viewers', viewers: live.viewerList() });
    return viewer.id;
  }

  detach(id: string, viewerId: string): void {
    const live = this.#live.get(id);
    if (!live?.viewers.delete(viewerId)) return;
    if (live.ownerId === viewerId) live.ownerId = null;
    live.broadcast({ t: 'viewers', viewers: live.viewerList() });
  }

  /**
   * A finger's scroll in Burrow's tmux: its copy mode, so the whole history
   * is there (tmux redraws fast output instead of scrolling it, and the
   * viewer's own scrollback stayed nearly empty). Scrolled back to the
   * bottom, copy mode ends by itself (-e).
   */
  scroll(id: string, viewerId: string, lines: number): void {
    const live = this.#live.get(id);
    // Someone watching scrolls their own view only; tmux's history is the session's.
    if (live?.viewers.get(viewerId)?.watching) return;
    const name = live?.row.tmuxName;
    // Typed meanwhile: the keys win, the rest of the swipe is dropped.
    if (!live || !name || !live.client || !lines || live.held !== null) return;
    live.copyMode = true;
    // One tmux command at a time: each is a round trip and a process on the
    // host; what the finger adds meanwhile goes with the next one.
    live.scrollPending += lines;
    if (live.scrolling) return;
    live.scrolling = true;
    const step = async (): Promise<void> => {
      const n = live.scrollPending;
      live.scrollPending = 0;
      const dir = n > 0 ? 'scroll-up' : 'scroll-down';
      // A full-screen program on its alternate screen (less, man, vim without the mouse): arrow keys,
      // as xterm's alternate scroll does; tmux's history only had what came before it. Not a tmux of
      // the person's own: its shell would take them for its history.
      const keys = `send-keys -t ${name} -N ${Math.abs(n)} ${n > 0 ? 'Up' : 'Down'}`;
      const back = `copy-mode -e -t ${name} ; send-keys -t ${name} -X -N ${Math.abs(n)} ${dir}`;
      const cmd = `${TMUX} if-shell -F -t ${name} '#{&&:#{alternate_on},#{!=:#{pane_current_command},tmux}}' '${keys}' '${back}'`;
      if (n && live.client) await exec(live.client, cmd, 5_000).catch(() => {});
      if (live.scrollPending) return step();
      live.scrolling = false;
    };
    live.tmuxQueue = live.tmuxQueue.then(step);
  }

  /**
   * The session's history at once, for the viewer's own history layer: a
   * finger then scrolls it on the phone at the screen's rate, not a tmux
   * command over SSH per step (report: scrolling felt like a slow screen).
   * Burrow's tmux: its history and screen (capture-pane, colours, wrapped
   * lines joined); without tmux: the server's copy of the screen. A program
   * on tmux's alternate screen (less, man) has no history there: `alt`, and
   * the viewer scrolls it as before (arrow keys).
   */
  async history(id: string, viewerId: string, mouse = false): Promise<void> {
    const live = this.#live.get(id);
    const v = live?.viewers.get(viewerId);
    if (!live || !v) return;
    const name = live.row.tmuxName;
    if (!name) {
      // A full screen (a tmux attach puts the terminal on one) or a program with the mouse: a tmux of the person's own?
      if ((mouse || live.alt?.on) && live.client) {
        const r = await exec(live.client, ownTmuxHistoryCommand(), 10_000, HISTORY_BYTES + 1024).catch(() => null);
        if (r?.code === 0) return live.send(v, { t: 'history', data: Buffer.byteLength(r.stdout) >= HISTORY_BYTES ? r.stdout.slice(r.stdout.indexOf('\n') + 1) : r.stdout });
        if (r?.code === HISTORY_ALT) return live.send(v, { t: 'history', data: '', alt: true });
        if (r && r.code !== OWN_NONE) return live.send(v, { t: 'history', data: '', failed: true });
        // None (or the host could not be asked): as before. A program that took the mouse or holds the screen keeps its wheel or keys.
        return live.send(v, { t: 'history', data: '', alt: true });
      }
      return live.send(v, { t: 'history', data: live.serializer.serialize({ scrollback: HISTORY_LINES, excludeModes: true, excludeAltBuffer: true }) });
    }
    if (!live.client) return live.send(v, { t: 'history', data: '', failed: true });
    const r = await exec(live.client, historyCommand(name, mouse), 10_000, HISTORY_BYTES + 1024).catch(() => null);
    if (r?.code === HISTORY_ALT) return live.send(v, { t: 'history', data: '', alt: true });
    // Failed is not empty: the viewer says so instead of showing no history.
    if (!r || r.code !== 0) return live.send(v, { t: 'history', data: '', failed: true });
    // Cut at the size limit on the host (tail): the oldest lines go, not the screen's, and the first one cut is dropped whole.
    const data = Buffer.byteLength(r.stdout) >= HISTORY_BYTES ? r.stdout.slice(r.stdout.indexOf('\n') + 1) : r.stdout;
    live.send(v, { t: 'history', data });
  }

  input(id: string, viewerId: string, data: string): void {
    const live = this.#live.get(id);
    const v = live?.viewers.get(viewerId);
    // Someone watching never types (F3).
    if (!live || !v || !live.channel || v.watching) return;
    // Another device's terminal answering a program's question (every browser does), or its focus
    // moving: not typing. Only the active device's go to the program; vim got the others as keys,
    // and a laptop tab losing focus took the session's size (review 2026-10-24).
    if (live.ownerId !== viewerId && isTermReply(data)) return;
    // Typing makes this device the active one: the session takes its size.
    if (live.ownerId !== viewerId) this.#takeOwnership(live, v);
    this.#touch(live);
    this.#write(live, data, true);
  }

  /** To the shell, out of tmux's history first if a finger scrolled into it. */
  /**
   * `typed`: what someone typed, for the history; tracked when it really
   * goes to the shell (held while tmux leaves its history, the line's echo
   * was looked for before it could be there).
   */
  #write(live: LiveSession, data: string, typed = false): void {
    if (!live.channel) return;
    // Leaving tmux's history: what is typed meanwhile waits, in order (a
    // keyboard sends a key at a time; the later keys overtook the first).
    if (live.held !== null) {
      live.held += data;
      if (typed) live.heldTyped += data;
      return;
    }
    // Scrolled back into tmux's history: out of it first, so what is typed
    // reaches the shell and not tmux's copy mode. After the scroll steps
    // still queued (the rest of the swipe is dropped), and only when the
    // pane is in a mode at all.
    const name = live.row.tmuxName;
    if ((live.copyMode || live.scrolling) && name && live.client) {
      const client = live.client;
      live.copyMode = false;
      live.scrollPending = 0;
      live.held = data;
      live.heldTyped = typed ? data : '';
      // Then its cursor row and screen: the server's copy still shows the history until tmux's redraw
      // comes, and what is on the screen before the held keys is not their echo (trackTyped).
      const leave = `${TMUX} if-shell -F -t ${name} '#{pane_in_mode}' 'send-keys -t ${name} -X cancel' 2>/dev/null; ${TMUX} display-message -p -t ${name} '#{cursor_y}' && ${TMUX} capture-pane -p -J -t ${name}`;
      live.tmuxQueue = live.tmuxQueue
        .then(() => exec(client, leave, 5_000))
        .then(
          (r) => {
            const [cursor, ...screen] = r.stdout.split('\n');
            return r.code === 0 && /^\d+$/.test(cursor ?? '') ? { cursorY: Number(cursor), screen } : null;
          },
          () => null,
        )
        .then((seen) => {
          const d = live.held ?? '';
          const t = live.heldTyped;
          live.held = null;
          live.heldTyped = '';
          if (t) live.trackTyped(t, seen);
          if (d) live.channel?.write(d);
        });
      return;
    }
    if (typed) live.trackTyped(data);
    live.startupNow?.();
    live.channel.write(data);
  }

  /**
   * Type the host's stored password, without Enter: at a sudo prompt the
   * user confirms, anywhere else nothing runs by accident.
   */
  pastePassword(id: string, viewerId: string, who: Actor): void {
    const live = this.#live.get(id);
    const v = live?.viewers.get(viewerId);
    if (!live || !v || !live.channel || v.watching) return;
    // Where the cursor is not at a prompt that hides what is typed, the password is echoed: not
    // while someone else watches or the screen is recorded (A3-SRV-19).
    if (sharedOf(live.row).length > 0 || live.row.recording) return live.send(v, { t: 'notice', code: 'password_refused' });
    const pw = hostPassword(this.ctx, live.row.hostId);
    if (!pw) return live.send(v, { t: 'notice', code: 'no_password' });
    // Like typing (in tmux's history it went to copy mode's keys), but never
    // into the line tracked for the history.
    this.#write(live, pw);
    live.send(v, { t: 'notice', code: 'password_sent' });
    this.#safely('the audit of a pasted password', () => audit(this.ctx, who, 'terminal.password_paste', live.hostName, { session: id }));
  }

  resize(id: string, viewerId: string, cols: number, rows: number, active: boolean): void {
    const live = this.#live.get(id);
    const v = live?.viewers.get(viewerId);
    // Someone watching sees the session at its size; never sets it.
    if (!live || !v || v.watching) return;
    v.cols = cols;
    v.rows = rows;
    if (active || live.ownerId === viewerId || live.ownerId === null) this.#takeOwnership(live, v);
  }

  #takeOwnership(live: LiveSession, v: Viewer): void {
    const changedOwner = live.ownerId !== v.id;
    live.ownerId = v.id;
    if (v.cols && v.rows && (v.cols !== live.cols || v.rows !== live.rows)) {
      live.cols = v.cols;
      live.rows = v.rows;
      live.term.resize(v.cols, v.rows);
      live.channel?.setWindow(v.rows, v.cols, 0, 0);
      live.recorder?.resize(v.cols, v.rows);
    } else if (!changedOwner) {
      return;
    }
    for (const x of live.viewers.values()) live.send(x, { t: 'size', cols: live.cols, rows: live.rows, owner: x.id === live.ownerId });
    if (changedOwner) live.broadcast({ t: 'viewers', viewers: live.viewerList() });
  }

  #touch(live: LiveSession): void {
    const now = this.ctx.now();
    // At most one write per 10 s; the list shows minutes, not milliseconds.
    if (now - live.row.lastActivityAt < 10_000) return;
    live.row.lastActivityAt = now;
    this.#safely('the last activity of a session', () => this.ctx.db.update(terminalSessions).set({ lastActivityAt: now }).where(eq(terminalSessions.id, live.row.id)).run());
  }

  /**
   * Who may watch the session, read-only (F3): Burrow users, picked by its
   * owner. Someone taken off the list stops watching at once.
   */
  share(id: string, userIds: number[], actor: Actor): TerminalSessionInfo {
    const row = this.#row(id);
    if (!row) throw new HttpError(404, 'not_found');
    const known = new Set(this.ctx.db.select({ id: users.id }).from(users).all().map((u) => u.id));
    const list = [...new Set(userIds)].filter((u) => known.has(u) && u !== row.userId);
    const sharedWith = JSON.stringify(list);
    this.ctx.db.update(terminalSessions).set({ sharedWith }).where(eq(terminalSessions.id, id)).run();
    const live = this.#live.get(id);
    if (live) {
      live.row.sharedWith = sharedWith;
      const names = new Set(this.ctx.db.select({ id: users.id, username: users.username }).from(users).all().filter((u) => list.includes(u.id)).map((u) => u.username));
      for (const v of [...live.viewers.values()]) if (v.watching && !names.has(v.watching)) v.socket.close(4003, 'no longer shared');
    }
    audit(this.ctx, actor, 'terminal.share', this.#hostName(row), { session: id, users: list.length });
    return this.#info({ ...row, sharedWith })!;
  }

  /** The sessions shared with this person, to watch. */
  sharedWith(userId: number): SharedSession[] {
    const names = new Map(this.ctx.db.select({ id: users.id, username: users.username }).from(users).all().map((u) => [u.id, u.username]));
    return this.ctx.db
      .select()
      .from(terminalSessions)
      .all()
      .filter((r) => sharedOf(r).includes(userId))
      .map((r) => ({ id: r.id, hostName: this.#hostName(r), title: r.title, owner: names.get(r.userId) ?? '?', recording: r.recording }));
  }

  /** Record its output from now on, or stop (F3). Viewers see the red dot. */
  setRecording(id: string, on: boolean, actor: Actor): TerminalSessionInfo {
    const row = this.#row(id);
    if (!row) throw new HttpError(404, 'not_found');
    this.ctx.db.update(terminalSessions).set({ recording: on }).where(eq(terminalSessions.id, id)).run();
    const live = this.#live.get(id);
    if (live) {
      const wasOn = live.row.recording;
      live.row.recording = on;
      if (on && !live.recorder?.active && !wasOn) this.#record(live);
      if (!on) {
        live.recorder?.stop();
        live.recorder = null;
      }
      live.broadcast({ t: 'recording', on });
    }
    audit(this.ctx, actor, on ? 'terminal.record' : 'terminal.record_stop', this.#hostName(row), { session: id });
    return this.#info({ ...row, recording: on })!;
  }

  #record(live: LiveSession): void {
    const rec = new Recorder(this.ctx, { id: live.row.id, hostName: live.hostName, title: live.row.title, userId: live.row.userId }, live.cols, live.rows);
    // What is on the screen now first, so the recording does not start on a
    // blank one; taken in the write queue's order, and the recorder takes
    // output only after it (what was queued before is in that screen already).
    live.recorder = null;
    rec.onEnd = () => this.#recorderEnded(live, rec);
    live.term.write('', () => {
      if (!live.row.recording || live.closing) return rec.stop();
      rec.output(live.serializer.serialize({ scrollback: 0 }) + screenModes(live.term));
      live.recorder = rec;
    });
  }

  /**
   * Its recorder stopped by itself (at its size limit, its file not writable): the session no
   * longer records, so its viewers lose the red dot. It kept showing, and the flag stayed on.
   */
  #recorderEnded(live: LiveSession, rec: Recorder): void {
    if (live.closing || !live.row.recording || (live.recorder !== null && live.recorder !== rec)) return;
    live.recorder = null;
    live.row.recording = false;
    this.#safely('the end of a recording', () => this.ctx.db.update(terminalSessions).set({ recording: false }).where(eq(terminalSessions.id, live.row.id)).run());
    live.broadcast({ t: 'recording', on: false });
  }

  /** A session's own name (null: its host's name again). */
  rename(id: string, title: string | null, actor: Actor): TerminalSessionInfo {
    const row = this.#row(id);
    if (!row) throw new HttpError(404, 'not_found');
    this.ctx.db.update(terminalSessions).set({ title }).where(eq(terminalSessions.id, id)).run();
    audit(this.ctx, actor, 'terminal.rename', this.#hostName(row), { session: id, title });
    return this.#info({ ...row, title })!;
  }

  /**
   * Close on purpose: ends the shell (and the tmux session) for every viewer.
   * A tmux session on the host is seen ended before the session is forgotten:
   * a host away or a kill that did not take is said, and the session stays
   * (it was gone from Burrow while it ran on, AUDIT2 FS-14). `force` forgets it
   * all the same (the person chose so; the host is being deleted).
   */
  async close(id: string, actor: Actor, reason = 'closed', force = false): Promise<void> {
    const row = this.#row(id);
    if (!row) throw new HttpError(404, 'not_found');
    const live = this.#live.get(id);
    if (row.tmuxName) {
      const ended = await this.#endTmux(row, live?.client ?? null);
      if (ended !== true && !force) throw ended;
    }
    this.ctx.db.delete(terminalSessions).where(eq(terminalSessions.id, id)).run();
    this.#ai.delete(id);
    if (live) {
      live.closing = true;
      this.#live.delete(id);
      live.recorder?.stop();
      live.broadcast({ t: 'exit', reason: 'closed' });
      for (const v of live.viewers.values()) v.socket.close(1000, 'closed');
      live.client?.end();
    }
    audit(this.ctx, actor, 'terminal.close', this.#hostName(row), { session: id, reason, ...(force ? { force } : {}) });
  }

  /** The session's tmux session on the host, ended and seen gone: true, or why not. */
  async #endTmux(row: Row, client: Client | null): Promise<true | HttpError> {
    const kill = `${TMUX} kill-session -t ${row.tmuxName} 2>/dev/null; ${TMUX} has-session -t ${row.tmuxName} 2>/dev/null && echo @@alive; true`;
    const unreachable = new HttpError(503, 'host_unreachable', 'The host cannot be reached, so its tmux session was not ended.');
    let own: Client | null = null;
    try {
      if (!client) {
        // Detached tmux session: connect once to remove it from the host.
        const conn = await openSsh(this.ctx, resolveTarget(this.ctx, row.hostId)).catch(() => null);
        if (!conn || !('client' in conn)) return unreachable;
        own = conn.client;
      }
      const r = await exec((client ?? own)!, kill, 10_000).catch(() => null);
      if (!r) return unreachable;
      return r.stdout.includes('@@alive') ? new HttpError(409, 'not_ended', 'The tmux session on the host did not end.') : true;
    } finally {
      own?.end();
    }
  }

  #hostName(row: Row): string {
    try {
      return getHost(this.ctx, row.hostId).name;
    } catch {
      return `host ${row.hostId}`;
    }
  }

  #liveOrThrow(id: string): LiveSession {
    const live = this.#live.get(id);
    if (!live?.client) throw new HttpError(409, 'session_not_attached', 'Open the session first.');
    return live;
  }

  /**
   * Live and open on a screen of this sign-in (`viewedBy`: its session's hash): the completion
   * helpers run nothing for a sign-in that is not one of the session's viewers, whom the session
   * lists. A stolen sign-in could otherwise run commands on it out of everyone's sight (audit
   * 2026-10-30); typing into it shows on every screen.
   */
  #viewedOrThrow(id: string, viewedBy: string): LiveSession {
    const live = this.#liveOrThrow(id);
    if (![...live.viewers.values()].some((v) => v.sessionIdHash === viewedBy && !v.watching)) throw new HttpError(409, 'not_viewing', 'Open the session on this device first.');
    return live;
  }

  /**
   * Run a completion generator on the session's own SSH connection, in the
   * session's directory. Short timeout: a slow suggestion is no suggestion.
   */
  async runForCompletion(id: string, viewedBy: string, script: string[] | string, cwd: string | null): Promise<string> {
    const live = this.#viewedOrThrow(id, viewedBy);
    const cmd = Array.isArray(script) ? script.map(shellQuote).join(' ') : script;
    const dir = cwd ?? live.shell.cwd;
    const full = dir ? `cd ${shellQuote(dir)} 2>/dev/null; ${cmd}` : cmd;
    const r = await exec(live.client!, full, 5000, 512 * 1024);
    return r.stdout;
  }

  /** List a directory over SFTP on the session's connection. */
  async listPath(id: string, viewedBy: string, path: string, cwd: string | null): Promise<{ dir: string; entries: PathEntry[] }> {
    const live = this.#viewedOrThrow(id, viewedBy);
    live.sftp ??= new Promise<SFTPWrapper>((resolve, reject) => live.client!.sftp((err, s) => (err ? reject(err) : resolve(s))));
    let sftp: SFTPWrapper;
    try {
      sftp = await live.sftp;
    } catch (err) {
      live.sftp = null;
      throw new HttpError(502, 'sftp_unavailable', (err as Error).message);
    }
    const home = await new Promise<string>((resolve) => sftp.realpath('.', (err, p) => resolve(err ? '/' : p)));
    const base = cwd ?? live.shell.cwd ?? home;
    // "~" and "~/..." are the home; "~name" (another user's) is left as typed.
    let dir = path === '~' || path.startsWith('~/') ? home + path.slice(1) : path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`;
    if (!dir) dir = base;
    const list = await new Promise<{ filename: string; longname: string; attrs: { mode: number } }[]>((resolve, reject) =>
      sftp.readdir(dir, (err, l) => (err ? reject(err) : resolve(l))),
    ).catch(() => []);
    const entries = list
      .slice(0, 1000)
      .map((e) => ({
        name: e.filename,
        dir: (e.attrs.mode & 0o170000) === 0o040000,
        link: (e.attrs.mode & 0o170000) === 0o120000,
      }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { dir, entries };
  }

  /** Before a host is deleted: end its sessions (the rows cascade anyway). */
  async closeForHost(hostId: number, actor: Actor): Promise<void> {
    const rows = this.ctx.db.select().from(terminalSessions).where(eq(terminalSessions.hostId, hostId)).all();
    for (const r of rows) await this.close(r.id, actor, 'host_deleted', true).catch(() => {});
  }

  /**
   * A person removed, or no longer an admin: their sessions end, tmux on the host too, and
   * they watch nothing any more. The rows cascaded away with the account and left the shells
   * running on the hosts, out of anyone's sight (A3-SRV-09).
   */
  async closeForUser(userId: number, actor: Actor, reason: string, removed: boolean): Promise<void> {
    const rows = this.ctx.db.select().from(terminalSessions).all();
    for (const r of rows.filter((x) => x.userId === userId)) await this.close(r.id, actor, reason, true).catch(() => {});
    if (!removed) return;
    // A user id can come back for a new account: no share is inherited.
    for (const r of rows.filter((x) => x.userId !== userId && sharedOf(x).includes(userId))) {
      const sharedWith = JSON.stringify(sharedOf(r).filter((u) => u !== userId));
      this.ctx.db.update(terminalSessions).set({ sharedWith }).where(eq(terminalSessions.id, r.id)).run();
      const live = this.#live.get(r.id);
      if (live) live.row.sharedWith = sharedWith;
    }
  }

  /** Revoked login session: its sockets go, the terminals stay. */
  dropViewersOf(sessionIdHash: string): void {
    for (const live of this.#live.values()) {
      for (const v of [...live.viewers.values()]) {
        if (v.sessionIdHash === sessionIdHash) {
          v.socket.close(4401, 'signed out');
          this.detach(live.row.id, v.id);
        }
      }
    }
  }

  /**
   * Viewers whose login session no longer holds, or whose user is no longer an admin, are let go.
   * Someone watching a shared session may be an operator: kept while their sign-in holds and the
   * session is still shared with them (they were all dropped within a minute, A3-SRV-06).
   */
  sweepViewers(valid: Map<string, string>): void {
    for (const live of this.#live.values()) {
      for (const v of [...live.viewers.values()]) {
        const role = valid.get(v.sessionIdHash);
        if (v.watcherId !== null ? role !== undefined && sharedOf(live.row).includes(v.watcherId) : role === 'admin') continue;
        v.socket.close(4401, 'signed out');
        this.detach(live.row.id, v.id);
      }
    }
  }

  #closeIdle(): void {
    if (this.opts.idleMinutes <= 0) return;
    const cutoff = this.ctx.now() - this.opts.idleMinutes * 60_000;
    for (const r of this.ctx.db.select().from(terminalSessions).all()) {
      const live = this.#live.get(r.id);
      if (r.lastActivityAt < cutoff && (!live || live.viewers.size === 0)) {
        void this.close(r.id, { userId: null, username: null, ip: null }, 'idle').catch(() => {});
      }
    }
  }
}

/** The user ids a session is shared with (F3). */
export function sharedOf(r: Row): number[] {
  try {
    const v = JSON.parse(r.sharedWith) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
