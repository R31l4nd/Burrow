import { DIAL_MS, failedDials } from './dial.js';
import type { ClientMessage, ServerMessage, ShellState, TerminalMode, TerminalViewer } from '@burrow/shared';

// One WebSocket to one server-side session. Survives network drops: it
// reconnects with backoff and the server answers every (re)connect with a
// snapshot of the current screen, so nothing needs replaying here.

/** failed: the server could not attach (or refused): said with its message, tried again only when asked (A3-WEB-02). */
export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'ended' | 'signed-out' | 'failed';

export interface TerminalEvents {
  /** `again`: the screen drawn again on our asking (a redraw), not a new start: only the screen changes. */
  snapshot(data: string, cols: number, rows: number, mode: TerminalMode, shell: ShellState, again?: boolean): void;
  shell(state: ShellState): void;
  /** `replayed`: recorded earlier and played again (lib/termpool.ts), not new. */
  output(data: string, replayed?: boolean): void;
  size(cols: number, rows: number, owner: boolean): void;
  viewers(list: TerminalViewer[]): void;
  state(s: ConnState, message?: string): void;
  notice(code: 'no_password' | 'password_sent' | 'password_refused'): void;
  /** Without tmux: a program on its alternate screen (less, vim) or off it again. */
  alt?(on: boolean): void;
  /** The answer to a history request (the history layer). */
  history?(answer: { data: string; alt?: boolean; failed?: boolean }): void;
  /** Recording turned on or off (by the owner, or by itself at its size limit). */
  recording?(on: boolean): void;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const PENDING_MAX = 4096;
/** How long a nudged connection may take to answer before it counts as gone. */
const ALIVE_MS = 2500;
/** Nudged while dialling this long: dialled again at once (a switch of tabs nudges a socket just made too). */
const DIAL_NUDGE_MS = 1500;

export class TerminalConnection {
  #ws: WebSocket | null = null;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #lastSize: { cols: number; rows: number } | null = null;
  #alive: ReturnType<typeof setTimeout> | null = null;
  /** The server's reason it could not attach, said when the socket closes. */
  #failure: string | null = null;
  /** Typed while not connected (the phone just woke, connecting again): sent once open, in order. */
  #pending: string[] = [];
  #pendingSize = 0;
  #dialledAt = 0;
  #dial: ReturnType<typeof setTimeout> | null = null;
  #failed = false;
  /** Dials in a row that closed before they opened (lib/dial.ts: the sign-in may be gone). */
  #unopened = 0;

  constructor(
    readonly sessionId: string,
    private readonly on: TerminalEvents,
  ) {
    this.#open();
  }

  #open(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/terminal/sessions/${encodeURIComponent(this.sessionId)}/ws`);
    this.#ws = ws;
    this.on.state(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    this.#dialledAt = Date.now();
    if (this.#dial) clearTimeout(this.#dial);
    this.#dial = setTimeout(() => this.#dialAgain(ws), DIAL_MS);
    let opened = false;
    ws.onopen = () => {
      if (this.#dial) clearTimeout(this.#dial);
      this.#dial = null;
      this.#attempt = 0;
      opened = true;
      this.#unopened = 0;
      this.on.state('open');
      // Tell the server our size straight away.
      if (this.#lastSize) this.send({ t: 'resize', ...this.#lastSize });
      const typed = this.#pending;
      this.#pending = [];
      this.#pendingSize = 0;
      for (const d of typed) this.send({ t: 'input', d });
    };
    ws.onmessage = (e) => {
      // Anything heard: alive.
      if (this.#alive) clearTimeout(this.#alive);
      this.#alive = null;
      const m = JSON.parse(String(e.data)) as ServerMessage;
      switch (m.t) {
        case 'snapshot':
          this.on.snapshot(m.data, m.cols, m.rows, m.mode, m.shell, m.redraw === true);
          return this.on.alt?.(!!m.alt);
        case 'alt':
          return this.on.alt?.(m.on);
        case 'shell':
          return this.on.shell(m.shell);
        case 'output':
          return this.on.output(m.d);
        case 'size':
          return this.on.size(m.cols, m.rows, m.owner);
        case 'viewers':
          return this.on.viewers(m.viewers);
        case 'notice':
          return this.on.notice(m.code);
        case 'history':
          return this.on.history?.(m);
        case 'recording':
          return this.on.recording?.(m.on);
        case 'exit':
          if (m.reason === 'closed' || m.reason === 'ended') {
            this.#stopped = true;
            this.on.state('ended', m.message);
          } else if (m.reason !== 'lost') this.#failure = m.message ?? '';
          // lost: Burrow restarting, or its connection to the host gone; the session lives on in
          // tmux there, so connecting again is right (it went to "failed", Try again on every tab).
          return;
      }
    };
    ws.onclose = (e) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.#dial) clearTimeout(this.#dial);
      this.#dial = null;
      if (this.#stopped) return;
      if (e.code === 4401) {
        this.#stopped = true;
        this.on.state('signed-out');
        return;
      }
      // Refused by the server (it could not attach: the host away, SSH refused; no longer
      // shared): trying again by itself would dial the host for ever without a word. Said, and
      // tried again when asked. Only a slow viewer let go (4008) connects again by itself.
      if (this.#failure !== null || (e.code >= 4000 && e.code < 5000 && e.code !== 4008)) {
        this.#failed = true;
        this.on.state('failed', this.#failure || e.reason || undefined);
        this.#failure = null;
        return;
      }
      if (!opened) failedDials(++this.#unopened);
      const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)]!;
      this.#attempt++;
      this.on.state('reconnecting');
      this.#timer = setTimeout(() => this.#open(), delay);
    };
  }

  /**
   * A socket still dialling given up (lib/dial.ts says why: a WireGuard tunnel coming up), its close
   * ignored (it is no longer the one), and a new one dialled now. A switch of terminal tabs did
   * that by chance, so the other tab connected first.
   */
  #dialAgain(ws: WebSocket): void {
    if (this.#ws !== ws || ws.readyState !== WebSocket.CONNECTING || this.#stopped) return;
    if (this.#dial) clearTimeout(this.#dial);
    this.#dial = null;
    this.#ws = null;
    this.#attempt++;
    ws.close();
    this.#open();
  }

  send(msg: ClientMessage): void {
    if (msg.t === 'resize') this.#lastSize = { cols: msg.cols, rows: msg.rows };
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  input(data: string): void {
    if (this.#ws?.readyState === WebSocket.OPEN || this.#stopped || this.#failed) return this.send({ t: 'input', d: data });
    // A few keys, not a paste of a whole file into a connection that may never come.
    if (this.#pendingSize + data.length > PENDING_MAX) return;
    this.#pending.push(data);
    this.#pendingSize += data.length;
  }

  /**
   * Back in sight (or the network back): connect now when closed; when
   * open, make sure it still is. After a while in the background a
   * connection can look open and be gone (the phone froze the app, the
   * tunnel or the server dropped it): it then answers nothing, and is
   * replaced at once instead of after minutes.
   */
  nudge(): void {
    if (this.#stopped || this.#failed) return;
    const ws = this.#ws;
    if (!ws) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#open();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING && Date.now() - this.#dialledAt >= DIAL_NUDGE_MS) return this.#dialAgain(ws);
    if (ws.readyState !== WebSocket.OPEN || this.#alive) return;
    ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMessage));
    this.#alive = setTimeout(() => {
      this.#alive = null;
      if (this.#ws !== ws || this.#stopped) return;
      // Gone: a new one now, its close event ignored (it is no longer the one).
      this.#ws = null;
      this.#attempt = 0;
      ws.close();
      this.#open();
    }, ALIVE_MS);
  }

  /** Try again after a failure (the person's Try again): one new attempt. */
  retry(): void {
    if (this.#stopped || !this.#failed) return;
    this.#failed = false;
    this.#attempt = 0;
    if (this.#timer) clearTimeout(this.#timer);
    this.#open();
  }

  close(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#alive) clearTimeout(this.#alive);
    if (this.#dial) clearTimeout(this.#dial);
    this.#ws?.close(1000);
    this.#ws = null;
  }
}

// ---- mobile key bar
//
// A layout is a space-separated list of keys. A key is a name (esc, tab,
// up, f5, ...), a single character, or a combination with modifiers joined
// by "+": shift+tab, ctrl+c, alt+bs, ctrl+left. Plain "ctrl" and "alt" are
// sticky modifiers that apply to the next key typed.

export interface BarKey {
  /** In words (also the button's name for screen readers). */
  label: string;
  /** Drawn as this icon, after `prefix` ("Ctrl+"), instead of the label. */
  icon?: 'arrow-left' | 'arrow-right' | 'arrow-up' | 'arrow-down' | 'enter' | 'backspace';
  prefix?: string;
  // Bytes sent, or a modifier toggle.
  send?: string;
  mod?: 'ctrl' | 'alt';
  /** Held down, it goes again and again, as a keyboard's own key does (report 0bc1fe). */
  repeat?: boolean;
}

interface Base {
  label: string;
  icon?: BarKey['icon'];
  // Plain sequence.
  seq: string;
  // xterm style for modified cursor/edit keys: CSI 1;m X or CSI n;m ~
  csi?: { final: string; num?: number };
}

const BASES: Record<string, Base> = {
  esc: { label: 'Esc', seq: '\x1b' },
  tab: { label: 'Tab', seq: '\t' },
  enter: { label: 'Enter', icon: 'enter', seq: '\r' },
  bs: { label: 'Backspace', icon: 'backspace', seq: '\x7f' },
  backspace: { label: 'Backspace', icon: 'backspace', seq: '\x7f' },
  space: { label: 'Space', seq: ' ' },
  up: { label: 'Up', icon: 'arrow-up', seq: '\x1b[A', csi: { final: 'A' } },
  down: { label: 'Down', icon: 'arrow-down', seq: '\x1b[B', csi: { final: 'B' } },
  right: { label: 'Right', icon: 'arrow-right', seq: '\x1b[C', csi: { final: 'C' } },
  left: { label: 'Left', icon: 'arrow-left', seq: '\x1b[D', csi: { final: 'D' } },
  home: { label: 'Home', seq: '\x1b[H', csi: { final: 'H' } },
  end: { label: 'End', seq: '\x1b[F', csi: { final: 'F' } },
  ins: { label: 'Ins', seq: '\x1b[2~', csi: { final: '~', num: 2 } },
  del: { label: 'Del', seq: '\x1b[3~', csi: { final: '~', num: 3 } },
  pgup: { label: 'PgUp', seq: '\x1b[5~', csi: { final: '~', num: 5 } },
  pgdn: { label: 'PgDn', seq: '\x1b[6~', csi: { final: '~', num: 6 } },
  f1: { label: 'F1', seq: '\x1bOP', csi: { final: 'P' } },
  f2: { label: 'F2', seq: '\x1bOQ', csi: { final: 'Q' } },
  f3: { label: 'F3', seq: '\x1bOR', csi: { final: 'R' } },
  f4: { label: 'F4', seq: '\x1bOS', csi: { final: 'S' } },
  f5: { label: 'F5', seq: '\x1b[15~', csi: { final: '~', num: 15 } },
  f6: { label: 'F6', seq: '\x1b[17~', csi: { final: '~', num: 17 } },
  f7: { label: 'F7', seq: '\x1b[18~', csi: { final: '~', num: 18 } },
  f8: { label: 'F8', seq: '\x1b[19~', csi: { final: '~', num: 19 } },
  f9: { label: 'F9', seq: '\x1b[20~', csi: { final: '~', num: 20 } },
  f10: { label: 'F10', seq: '\x1b[21~', csi: { final: '~', num: 21 } },
  f11: { label: 'F11', seq: '\x1b[23~', csi: { final: '~', num: 23 } },
  f12: { label: 'F12', seq: '\x1b[24~', csi: { final: '~', num: 24 } },
};

export const DEFAULT_BAR = 'esc tab ctrl alt left down up right | ~ / -';

// The keys that move or delete a step at a time: held, they repeat. Not Enter, Esc or Tab: one
// press of those held a moment too long must not run a line twice or close a program.
const REPEATS = new Set(['up', 'down', 'left', 'right', 'bs', 'backspace', 'del', 'pgup', 'pgdn']);

function combo(tok: string): BarKey | null {
  const parts = tok.toLowerCase().split('+');
  // A lone "+" or "a+" is a literal, not a combination.
  if (parts.length < 2 || parts.some((p) => p === '')) return null;
  const baseName = parts.pop()!;
  const mods = new Set(parts);
  if ([...mods].some((m) => !['ctrl', 'alt', 'shift'].includes(m))) return null;
  const ctrl = mods.has('ctrl');
  const alt = mods.has('alt');
  const shift = mods.has('shift');
  const prefix = `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}`;
  const base = BASES[baseName];
  if (base) {
    let seq = base.seq;
    if (baseName === 'tab' && shift && !ctrl) seq = '\x1b[Z';
    else if (base.csi) {
      // xterm modifier parameter: 1 + shift + 2|alt + 4|ctrl.
      const m = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
      seq = base.csi.num ? `\x1b[${base.csi.num};${m}~` : `\x1b[1;${m}${base.csi.final}`;
      return { label: `${prefix}${base.label}`, send: seq, ...(base.icon ? { icon: base.icon, prefix } : {}), ...(REPEATS.has(baseName) ? { repeat: true } : {}) };
    }
    if (alt) seq = `\x1b${seq}`;
    return { label: `${prefix}${base.label}`, send: seq, ...(base.icon ? { icon: base.icon, prefix } : {}), ...(REPEATS.has(baseName) ? { repeat: true } : {}) };
  }
  if ([...baseName].length !== 1) return null;
  const ch = shift ? baseName.toUpperCase() : baseName;
  return { label: `${prefix}${ch.toUpperCase()}`, send: applyModifiers(ch, ctrl, alt) };
}

/** Parse a key bar layout into keys; unknown words are typed literally. */
export function parseBar(layout: string): BarKey[] {
  return layout
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const t = tok.toLowerCase();
      if (t === 'ctrl') return { label: 'Ctrl', mod: 'ctrl' } as BarKey;
      if (t === 'alt') return { label: 'Alt', mod: 'alt' } as BarKey;
      const base = BASES[t];
      if (base) return { label: base.label, send: base.seq, ...(base.icon ? { icon: base.icon } : {}), ...(REPEATS.has(t) ? { repeat: true } : {}) };
      return combo(tok) ?? { label: tok, send: tok };
    });
}

/** Apply sticky Ctrl/Alt to one typed key. */
export function applyModifiers(data: string, ctrl: boolean, alt: boolean): string {
  let out = data;
  if (ctrl && out.length === 1) {
    const c = out.toUpperCase().charCodeAt(0);
    // Ctrl+A..Z and the few symbols with a control code (@ [ \ ] ^ _).
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    else if (out === ' ') out = '\x00';
    else if (out === '?') out = '\x7f';
  }
  if (alt) out = `\x1b${out}`;
  return out;
}

/**
 * Volume up, then a key (as in Termux): the keys a phone's keyboard lacks.
 * W A S D are the arrows, E is Esc, T is Tab, 1 to 9 are F1 to F9, and
 * P and N are Page Up and Page Down. Anything else goes as it is.
 */
export function volumeUpKey(ch: string): string {
  const k = ch.toLowerCase();
  const arrows: Record<string, string> = { w: '\x1b[A', s: '\x1b[B', d: '\x1b[C', a: '\x1b[D' };
  if (arrows[k]) return arrows[k];
  if (k === 'e') return '\x1b';
  if (k === 't') return '\t';
  if (k === 'p') return '\x1b[5~';
  if (k === 'n') return '\x1b[6~';
  const f = ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~'];
  if (/^[1-9]$/.test(k)) return f[Number(k) - 1]!;
  return ch;
}

/** What the phone does while a terminal is shown (the Android app's side). */
export interface DeviceTerminal {
  /** Plain characters from the keyboard (no suggestions), the volume keys, the screen kept on. */
  terminal(mode: { input: boolean; keys: boolean; screen: boolean }): Promise<unknown>;
  /** "volumeKey" events: "down" or "up"; "selectionAction": "copy", "paste", "all" or "close". */
  on(event: string, fn: (data: unknown) => void): () => void;
  /** Android's floating menu over this box of the page, gone with null (apps from 1.8.0). */
  selectionMenu?(box: { x: number; y: number; w: number; h: number } | null): Promise<unknown>;
  info(): Promise<{ selectionMenu?: boolean } | null>;
}
