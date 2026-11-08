import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import unicodePkg from '@xterm/addon-unicode11';
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { watchShell, type ServerMessage, type ShellState, type TerminalViewer } from '@burrow/shared';
import type { terminalSessions } from '../db/schema.js';

const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;
const { Unicode11Addon } = unicodePkg;

// One terminal that is open here (terminal/manager.ts): its SSH channel, the
// headless xterm that mirrors its screen, and the viewers attached to it.

const SCROLLBACK = 5000;
// A viewer this far behind is dropped; it reconnects and gets a fresh snapshot.
const MAX_BUFFERED = 4 << 20;

export interface ViewerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
}

export interface Viewer {
  id: string;
  device: string;
  socket: ViewerSocket;
  sessionIdHash: string;
  connectedAt: number;
  cols: number | null;
  rows: number | null;
  /** Someone the session is shared with, by name: watches only, never types (F3). */
  watching: string | null;
  /** That person's user id: the sweep keeps them while the session is still shared with them, whatever their role (A3-SRV-06). */
  watcherId: number | null;
}

export type Row = typeof terminalSessions.$inferSelect;

/**
 * The mouse's encoding, which the serializer leaves out: a tmux of the
 * person's own asks for SGR (1006), and a viewer that came back got the
 * mouse on in the old encoding, so tmux misread a finger's scroll.
 */
/**
 * What else the serializer leaves out (addon-serialize 0.14): a scroll region (a tmux's or vim's
 * status line kept still, DECSTBM) and a hidden cursor. A viewer that attached under such a program
 * scrolled its status line away and showed a cursor it had hidden (review 2026-10-24). Setting the
 * region moves the cursor home, so it is put back where it was.
 */
export function screenModes(term: InstanceType<typeof Terminal>): string {
  const core = (term as unknown as { _core?: { buffer?: { scrollTop?: number; scrollBottom?: number }; coreService?: { isCursorHidden?: boolean } } })._core;
  const top = core?.buffer?.scrollTop ?? 0;
  const bottom = core?.buffer?.scrollBottom ?? term.rows - 1;
  let out = '';
  if (top !== 0 || bottom !== term.rows - 1) out += `\x1b[${top + 1};${bottom + 1}r\x1b[${term.buffer.active.cursorY + 1};${term.buffer.active.cursorX + 1}H`;
  if (core?.coreService?.isCursorHidden) out += '\x1b[?25l';
  return out;
}

export function mouseEncoding(term: InstanceType<typeof Terminal>): string {
  const enc = (term as unknown as { _core?: { coreMouseService?: { activeEncoding?: string } } })._core?.coreMouseService?.activeEncoding;
  return enc === 'SGR' ? '\x1b[?1006h' : enc === 'SGR_PIXELS' ? '\x1b[?1016h' : '';
}

export function deviceLabel(ua: string | null): string {
  if (!ua) return 'unknown';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  // "Chrome on Android": one name per viewer, so a list of them joined by
  // commas does not mix with the " | " between a session's parts (it read
  // "tmux | Android | Chrome, Windows | Chrome").
  return br && os ? `${br} on ${os}` : br || os || 'browser';
}

// An Enter typed lets one command report through, for a minute (A3-SRV-13); a paste of many lines, at most this many.
const ENTER_VALID_MS = 60_000;
const MAX_ENTERS = 50;

export class LiveSession {
  readonly term: InstanceType<typeof Terminal>;
  readonly serializer: InstanceType<typeof SerializeAddon>;
  readonly viewers = new Map<string, Viewer>();
  ownerId: string | null = null;
  /** Its output being recorded (F3), or null. */
  recorder: import('./recorder.js').Recorder | null = null;
  /** Without tmux: the alternate screen's switches taken out, and whether a program is on it (scrolls as arrow keys). */
  alt: import('@burrow/shared').AltScreenFilter | null = null;
  client: Client | null = null;
  channel: ClientChannel | null = null;
  /** The start-up line (a folder to go to) still waiting for the shell's prompt: typed now (terminal/ready.ts). */
  startupNow: (() => void) | null = null;
  decoder: TextDecoder;
  // Set while the session is being torn down on purpose, so the channel's
  // close event is not reported as the shell ending.
  closing = false;
  shell: ShellState = { integration: false, atPrompt: false, cwd: null, prompt: null };
  // Scrolled into Burrow's tmux's history (its copy mode) by a finger.
  copyMode = false;
  /** Lines to scroll that wait for the scroll under way (one at a time). */
  scrollPending = 0;
  scrolling = false;
  /**
   * The tmux commands for this session, one after the other: leaving the
   * history always comes after the last scroll step (a step still on its
   * way took the pane back into copy mode, and the typing went there).
   */
  tmuxQueue: Promise<void> = Promise.resolve();
  /** Typed while tmux's history is being left: sent once it is (null: not leaving). */
  held: string | null = null;
  /** The typed part of `held` (a stored password sent meanwhile is not), for the history. */
  heldTyped = '';
  // The last command run here: the next one is learnt as following it.
  lastCommand: string | null = null;
  // Without the integration: the line typed since the last Enter, and
  // whether it can still be trusted (no cursor keys, Tab, paste of escapes).
  typed = '';
  typedClean = true;
  /** When Enter was typed and not yet matched by a command the integration reported (A3-SRV-13). */
  enters: number[] = [];
  sftp: Promise<SFTPWrapper> | null = null;

  constructor(
    readonly row: Row,
    readonly hostName: string,
    public cols: number,
    public rows: number,
    encoding: string,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.#watchShell();
    let dec: TextDecoder;
    try {
      dec = new TextDecoder(encoding);
    } catch {
      dec = new TextDecoder('utf-8');
    }
    this.decoder = dec;
  }

  onShellChange: (() => void) | null = null;
  onCommand: ((command: string) => void) | null = null;

  #setShell(patch: Partial<ShellState>): void {
    const next = { ...this.shell, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.shell)) return;
    this.shell = next;
    this.onShellChange?.();
  }

  /** The integration's escape sequences, parsed from the output stream. */
  #watchShell(): void {
    const decode = (b64: string) => {
      try {
        return Buffer.from(b64, 'base64').toString('utf8');
      } catch {
        return null;
      }
    };
    // A command the integration reports counts only when it starts after an Enter someone typed:
    // one per Enter, within a minute. A report in the output of a command (cat of a file, a log
    // line, the motd) is not one (A3-SRV-13).
    const commandStart = () => {
      const since = Date.now() - ENTER_VALID_MS;
      while (this.enters.length && this.enters[0]! < since) this.enters.shift();
      return this.enters.shift() !== undefined;
    };
    watchShell(this.term.parser, decode, { patch: (p) => this.#setShell(p), command: (cmd) => this.onCommand?.(cmd), commandStart });
  }

  /**
   * Best-effort line tracking for hosts without the integration; the Enters typed, for the integration's reports.
   * `seen`: what tmux showed just after leaving its history, its cursor row and its screen, for keys held
   * meanwhile: the server's copy still showed the history then, tmux's redraw on its way. null: not known
   * (that command failed), the lines typed now are not learnt.
   */
  trackTyped(data: string, seen?: { cursorY: number; screen: string[] } | null): void {
    for (const ch of data) if (ch === '\r' || ch === '\n') this.enters.push(Date.now());
    if (this.enters.length > MAX_ENTERS) this.enters.splice(0, this.enters.length - MAX_ENTERS);
    if (this.shell.integration) return;
    for (const ch of data) {
      if (ch === '\r') {
        const line = this.typed;
        const clean = this.typedClean;
        this.typed = '';
        this.typedClean = true;
        const buf = this.term.buffer.normal;
        if (!clean || !line.trim() || this.term.buffer.active.type !== 'normal' || seen === null) continue;
        const want = line.trimEnd();
        const top = buf.baseY;
        const row = seen ? top + Math.min(Math.max(seen.cursorY, 0), this.term.rows - 1) : buf.baseY + buf.cursorY;
        // Typed a key at a time, the echo is there already: on the cursor's line at Enter.
        if (!seen && this.#lineEndingAt(row).trimEnd().endsWith(want)) {
          this.onCommand?.(line);
          continue;
        }
        const before = seen ? seen.screen.filter((l) => l.trimEnd().endsWith(want)).length : this.#linesEndingWith(want, top, row - 1);
        this.#checkEcho(line, row, top, before);
      } else if (ch === '\x7f' || ch === '\b') {
        this.typed = this.typed.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x04' || ch === '\x15') {
        this.typed = '';
        this.typedClean = true;
      } else if (ch < ' ' || ch === '\x1b') {
        // Tab completion, arrows, history search: the shell changed the line
        // in ways the keystrokes do not show.
        this.typedClean = false;
      } else {
        this.typed += ch;
      }
    }
  }

  /** The text of the logical line that row ends: back over the rows it wrapped from. */
  #lineEndingAt(y: number): string {
    const buf = this.term.buffer.normal;
    let start = y;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let text = '';
    for (let r = start; r <= y; r++) text += buf.getLine(r)?.translateToString(r === y) ?? '';
    return text;
  }

  /** How many logical lines ending in rows `from` to `to` end with `want`. */
  #linesEndingWith(want: string, from: number, to: number): number {
    const buf = this.term.buffer.normal;
    let n = 0;
    for (let y = Math.max(from, 0); y <= to; y++) if (!buf.getLine(y + 1)?.isWrapped && this.#lineEndingAt(y).trimEnd().endsWith(want)) n++;
    return n;
  }

  /**
   * Record a typed line only if the terminal echoed it: a password typed at
   * a sudo or ssh prompt is not echoed, so it never ends up in the history.
   * Checked a moment later, because the echo may still be on its way. The
   * echo is the line the cursor was on at Enter or one after it (with the
   * rows a long line wrapped over), or one more line than before ending with
   * it, counted from the screen's top at Enter: tmux behind on fast output
   * redraws its screen rather than scrolling it, and the echo moved up over
   * the row of the Enter (a flaky integration test, reproduced under load).
   * The same text in the output above (a password just printed by pwgen,
   * then pasted at sudo's prompt) is not an echo: it was counted before.
   */
  #checkEcho(line: string, rowAtEnter: number, top: number, before: number, attempt = 0): void {
    // Looked for again a little later when not there yet: on a busy host (or
    // a tmux leaving its history first) the echo came after the first look
    // and the line was never learnt. Four looks within twelve seconds (a gate
    // beside other work: tmux leaving its history took longer than four).
    const waits = [300, 1000, 3000, 8000];
    setTimeout(() => {
      this.term.write('', () => {
        const buf = this.term.buffer.normal;
        const last = buf.baseY + buf.cursorY;
        const want = line.trimEnd();
        for (let y = rowAtEnter; y <= last; y++) if (this.#lineEndingAt(y).trimEnd().endsWith(want)) return this.onCommand?.(line);
        if (this.#linesEndingWith(want, top, last) > before) return this.onCommand?.(line);
        if (attempt + 1 < waits.length) this.#checkEcho(line, rowAtEnter, top, before, attempt + 1);
      });
    }, waits[attempt]! - (attempt ? waits[attempt - 1]! : 0));
  }

  send(v: Viewer, msg: ServerMessage): void {
    if (v.socket.bufferedAmount > MAX_BUFFERED) {
      v.socket.close(4008, 'too slow');
      return;
    }
    v.socket.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    for (const v of this.viewers.values()) this.send(v, msg);
  }

  viewerList(): TerminalViewer[] {
    return [...this.viewers.values()].map((v) => ({
      id: v.id,
      device: v.device,
      owner: v.id === this.ownerId,
      connectedAt: new Date(v.connectedAt).toISOString(),
      watching: v.watching,
    }));
  }
}
