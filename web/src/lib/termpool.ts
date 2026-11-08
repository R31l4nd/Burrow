import { TerminalConnection, type TerminalEvents } from './terminal.js';

// Terminal tabs stay connected (report cfdea9). Leaving a session's page
// keeps its WebSocket open and records what the server sends; coming back
// replays that at once instead of connecting again and waiting for the
// screen. The last few sessions are kept, each for a while unseen; a kept
// connection also keeps the server from closing its session as idle.

const KEEP = 4;
const KEEP_MS = 30 * 60_000;
// Output recorded after the last snapshot; past this the kept connection is
// closed instead (coming back connects again and gets a fresh snapshot).
const MAX_OUTPUT = 2_000_000;

type Step = ['output', string] | ['size', number, number, boolean];

interface Kept {
  conn: TerminalConnection;
  /** The page showing it; null while it is only kept. */
  on: TerminalEvents | null;
  snapshot: Parameters<TerminalEvents['snapshot']> | null;
  /** What came after the snapshot, in order. */
  steps: Step[];
  outLen: number;
  shell: Parameters<TerminalEvents['shell']>[0] | null;
  viewers: Parameters<TerminalEvents['viewers']>[0] | null;
  state: Parameters<TerminalEvents['state']> | null;
  stopped: boolean;
  /** More output than is recorded came since the snapshot: not kept, connected again next time. */
  overflow: boolean;
  alt: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const kept = new Map<string, Kept>();

function recorder(k: Kept): TerminalEvents {
  return {
    snapshot(...a) {
      k.snapshot = a;
      k.steps = [];
      k.outLen = 0;
      k.overflow = false;
      k.shell = a[4];
      k.on?.snapshot(...a);
    },
    output(d) {
      const last = k.steps.at(-1);
      if (last?.[0] === 'output') last[1] += d;
      else k.steps.push(['output', d]);
      k.outLen += d.length;
      k.on?.output(d);
      if (k.outLen <= MAX_OUTPUT) return;
      k.steps = [];
      k.overflow = true;
      if (!k.on) drop(k.conn.sessionId);
    },
    size(cols, rows, owner) {
      k.steps.push(['size', cols, rows, owner]);
      k.on?.size(cols, rows, owner);
    },
    shell(s) {
      k.shell = s;
      k.on?.shell(s);
    },
    viewers(list) {
      k.viewers = list;
      k.on?.viewers(list);
    },
    state(s, message) {
      k.state = [s, message];
      // Failed: not kept unseen; coming back to it makes a new attempt (A3-WEB-02).
      k.stopped = s === 'ended' || s === 'signed-out' || s === 'failed';
      k.on?.state(s, message);
      if (k.stopped && !k.on) drop(k.conn.sessionId);
    },
    notice(code) {
      k.on?.notice(code);
    },
    alt(on) {
      k.alt = on;
      k.on?.alt?.(on);
    },
    history(answer) {
      k.on?.history?.(answer);
    },
  };
}

/** The session's connection for the page that shows it: kept (replayed at once) or new. */
export function attach(sessionId: string, on: TerminalEvents): TerminalConnection {
  const k = kept.get(sessionId);
  if (k && !k.stopped && !k.overflow) {
    if (k.timer) clearTimeout(k.timer);
    k.timer = null;
    // The newest last: the oldest kept one goes first.
    kept.delete(sessionId);
    kept.set(sessionId, k);
    k.on = on;
    if (k.state) on.state(...k.state);
    if (k.snapshot) on.snapshot(...k.snapshot);
    for (const s of k.steps) {
      if (s[0] === 'output') on.output(s[1], true);
      else on.size(s[1], s[2], s[3]);
    }
    if (k.viewers) on.viewers(k.viewers);
    if (k.shell && k.shell !== k.snapshot?.[4]) on.shell(k.shell);
    on.alt?.(k.alt);
    // Kept unseen a while: make sure it is still there.
    k.conn.nudge();
    return k.conn;
  }
  if (k) drop(sessionId);
  // The record first: the connection reports its state while it is made.
  const made = { on, snapshot: null, steps: [], outLen: 0, shell: null, viewers: null, state: null, stopped: false, overflow: false, alt: false, timer: null } as Omit<Kept, 'conn'> as Kept;
  const conn = new TerminalConnection(sessionId, recorder(made));
  made.conn = conn;
  kept.set(sessionId, made);
  return conn;
}

/** The page is gone: keep the connection a while (the last few only). */
export function detach(sessionId: string): void {
  const k = kept.get(sessionId);
  if (!k) return;
  k.on = null;
  if (k.stopped || k.overflow) return drop(sessionId);
  k.timer = setTimeout(() => drop(sessionId), KEEP_MS);
  const unseen = [...kept.entries()].filter(([, v]) => !v.on);
  for (const [id] of unseen.slice(0, Math.max(0, unseen.length - KEEP))) drop(id);
}

function drop(sessionId: string): void {
  const k = kept.get(sessionId);
  if (!k) return;
  kept.delete(sessionId);
  if (k.timer) clearTimeout(k.timer);
  k.conn.close();
}

/** Signed out: nothing kept. */
export function dropAll(): void {
  for (const id of [...kept.keys()]) drop(id);
}
