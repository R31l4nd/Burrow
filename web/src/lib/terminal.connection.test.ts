import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalConnection, type TerminalEvents } from './terminal.js';
import { onSessionDoubt } from './dial.js';

// A WebSocket that does what the test says: opens, answers, or stays silent
// (a connection that died while the phone had the app in the background).
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  answers = true;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(d: string) {
    this.sent.push(d);
    if (this.answers && JSON.parse(d).t === 'ping') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: 'pong' }) }), 10);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const events = (): TerminalEvents => ({ snapshot() {}, shell() {}, output() {}, size() {}, viewers() {}, state() {}, notice() {} });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'burrow.test' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('back from the background', () => {
  it('a connection that still looks open but answers nothing is replaced at once', () => {
    const c = new TerminalConnection('s1', events());
    FakeSocket.all[0]!.open();
    // Gone while the app was away: open on paper, silent in fact.
    FakeSocket.all[0]!.answers = false;
    c.nudge();
    expect(FakeSocket.all[0]!.sent.map((s) => JSON.parse(s).t)).toContain('ping');
    vi.advanceTimersByTime(3000);
    expect(FakeSocket.all).toHaveLength(2);
    c.close();
  });

  it('a live one that answers is left alone', () => {
    const c = new TerminalConnection('s2', events());
    FakeSocket.all[0]!.open();
    c.nudge();
    vi.advanceTimersByTime(3000);
    expect(FakeSocket.all).toHaveLength(1);
    c.close();
  });

  it('a socket that never opens (dialled before the tunnel was up) is given up and dialled again', () => {
    const c = new TerminalConnection('s4', events());
    // Its first packets went nowhere: it neither opens nor closes for a minute or more.
    vi.advanceTimersByTime(4500);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(2);
    c.close();
  });

  it('nudged while still dialling for a while (back in sight, a tab switched, the network back): dialled again now', () => {
    const c = new TerminalConnection('s5', events());
    vi.advanceTimersByTime(1000);
    // Just made: left alone (a switch of tabs nudges every time).
    c.nudge();
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    c.nudge();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]!.readyState).toBe(3);
    c.close();
  });

  it('a closed one waiting out its backoff connects now', () => {
    const c = new TerminalConnection('s3', events());
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.close();
    vi.advanceTimersByTime(500);
    FakeSocket.all[1]!.close();
    vi.advanceTimersByTime(1000);
    FakeSocket.all[2]!.close();
    // Waiting 2 s for the next try; back in sight: now.
    c.nudge();
    expect(FakeSocket.all).toHaveLength(4);
    c.close();
  });
});

describe('the server cannot attach (A3-WEB-02)', () => {
  it('an exit with an error stops: its message said, no reconnecting for ever; Try again makes one new attempt', () => {
    const states: [string, string | undefined][] = [];
    const c = new TerminalConnection('s4', { ...events(), state: (s, m) => states.push([s, m]) });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ t: 'exit', reason: 'error', message: 'The host does not answer.' }) });
    ws.readyState = 3;
    ws.onclose?.({ code: 4000 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(states.at(-1)).toEqual(['failed', 'The host does not answer.']);
    // Back in sight: still no attempt of its own (the host would be dialled again and again).
    c.nudge();
    expect(FakeSocket.all).toHaveLength(1);
    c.retry();
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    expect(states.at(-1)).toEqual(['open', undefined]);
    c.close();
  });

  it('a refusal without a message stops too; a slow viewer let go (4008) connects again', () => {
    const states: string[] = [];
    const c = new TerminalConnection('s5', { ...events(), state: (s) => states.push(s) });
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.onclose?.({ code: 4008 });
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.onclose?.({ code: 4003, reason: 'no longer shared' });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(states.at(-1)).toBe('failed');
    c.close();
  });
});

describe('Burrow restarting, or the host connection lost, under a kept session (review 2026-10-24)', () => {
  it('connects again by itself: the session lives on in tmux on the host', () => {
    const states: string[] = [];
    const c = new TerminalConnection('s6', { ...events(), state: (s) => states.push(s) });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ t: 'exit', reason: 'lost', message: 'Burrow is restarting.' }) });
    ws.readyState = 3;
    ws.onclose?.({ code: 1012 });
    expect(states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    expect(states.at(-1)).toBe('open');
    c.close();
  });
});

describe('typed while connecting again (review 2026-10-24)', () => {
  it('is kept and sent once connected, in order; not when the session ended', () => {
    const c = new TerminalConnection('s7', events());
    // The phone woke: the old connection is gone, the new one not yet open.
    c.input('l');
    c.input('s\r');
    const ws = FakeSocket.all[0]!;
    ws.open();
    expect(ws.sent.map((d) => JSON.parse(d)).filter((m) => m.t === 'input')).toEqual([
      { t: 'input', d: 'l' },
      { t: 'input', d: 's\r' },
    ]);
    c.close();
    c.input('x');
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('refused before it opens: the sign-in gone (audit 2026-11-05)', () => {
  it('dials that close before they open, again and again: who is signed in is read again every third one (an upgrade refused with 401 is a 1006 to the page)', () => {
    const doubt = vi.fn();
    onSessionDoubt(doubt);
    const c = new TerminalConnection('s9', events());
    FakeSocket.all[0]!.close();
    vi.advanceTimersByTime(500);
    FakeSocket.all[1]!.close();
    expect(doubt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    FakeSocket.all[2]!.close();
    expect(doubt).toHaveBeenCalledOnce();
    // One that opens starts the count over.
    vi.advanceTimersByTime(2000);
    FakeSocket.all[3]!.open();
    FakeSocket.all[3]!.close();
    vi.advanceTimersByTime(500);
    FakeSocket.all[4]!.close();
    vi.advanceTimersByTime(1000);
    FakeSocket.all[5]!.close();
    expect(doubt).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    FakeSocket.all[6]!.close();
    expect(doubt).toHaveBeenCalledTimes(2);
    c.close();
    onSessionDoubt(() => {});
  });
});

describe('a recording that stops by itself (2026-11-07)', () => {
  it("is passed on, so the owner's checkbox and red dot follow without a reload", () => {
    const seen: boolean[] = [];
    const c = new TerminalConnection('s9', { ...events(), recording: (on) => seen.push(on) });
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.onmessage?.({ data: JSON.stringify({ t: 'recording', on: false }) });
    expect(seen).toEqual([false]);
    c.close();
  });
});
