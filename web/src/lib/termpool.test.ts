import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEvents } from './terminal.js';
import { attach, detach, dropAll } from './termpool.js';

// A WebSocket the test drives: the server's messages are pushed by hand.
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  send(d: string) {
    this.sent.push(d);
    if (JSON.parse(d).t === 'ping') setTimeout(() => this.push({ t: 'pong' }), 10);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

const shell = { cwd: '/root', atPrompt: true, integration: true, lastCommand: null };
const snapshot = (data: string) => ({ t: 'snapshot', data, cols: 80, rows: 24, mode: 'tmux', shell });

// What a page saw, in order.
function page() {
  const seen: string[] = [];
  const on: TerminalEvents = {
    snapshot: (d) => seen.push(`snapshot ${d}`),
    output: (d, replayed) => seen.push(`${replayed ? 'replayed' : 'output'} ${d}`),
    size: (c, r) => seen.push(`size ${c}x${r}`),
    shell: () => seen.push('shell'),
    viewers: (l) => seen.push(`viewers ${l.length}`),
    state: (s) => seen.push(`state ${s}`),
    notice: (c) => seen.push(`notice ${c}`),
  };
  return { on, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'burrow.test' });
});
afterEach(() => {
  dropAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('terminal tabs stay connected (report cfdea9)', () => {
  it('back on a tab: no new connection, the screen and what came since at once', () => {
    attach('a', page().on);
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.push(snapshot('$ '));
    ws.push({ t: 'output', d: 'ls\r\n' });
    detach('a');
    // Unseen meanwhile: still recorded.
    ws.push({ t: 'output', d: 'file\r\n' });
    ws.push({ t: 'size', cols: 100, rows: 30, owner: false });
    ws.push({ t: 'viewers', viewers: [{ id: 'v1' }] });
    const back = page();
    attach('a', back.on);
    expect(FakeSocket.all).toHaveLength(1);
    expect(ws.closed).toBe(false);
    expect(back.seen).toEqual(['state open', 'snapshot $ ', 'replayed ls\r\nfile\r\n', 'size 100x30', 'viewers 1']);
    // And live from then on.
    ws.push({ t: 'output', d: 'x' });
    expect(back.seen.at(-1)).toBe('output x');
  });

  it('a new snapshot (a reconnect while unseen) replaces what was recorded', () => {
    attach('b', page().on);
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.push(snapshot('old'));
    ws.push({ t: 'output', d: 'gone' });
    detach('b');
    ws.push(snapshot('new'));
    const back = page();
    attach('b', back.on);
    expect(back.seen).toEqual(['state open', 'snapshot new']);
  });

  it('only the last few are kept; the oldest unseen one is closed', () => {
    for (const id of ['1', '2', '3', '4', '5']) {
      attach(id, page().on);
      FakeSocket.all.at(-1)!.open();
      detach(id);
    }
    expect(FakeSocket.all.map((w) => w.closed)).toEqual([true, false, false, false, false]);
  });

  it('a kept one closes after a while unseen, so the server can close an idle session', () => {
    attach('c', page().on);
    FakeSocket.all[0]!.open();
    detach('c');
    vi.advanceTimersByTime(29 * 60_000);
    expect(FakeSocket.all[0]!.closed).toBe(false);
    vi.advanceTimersByTime(2 * 60_000);
    expect(FakeSocket.all[0]!.closed).toBe(true);
    attach('c', page().on);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('an ended session is not kept', () => {
    attach('d', page().on);
    const ws = FakeSocket.all[0]!;
    ws.open();
    detach('d');
    ws.push({ t: 'exit', reason: 'closed' });
    expect(ws.closed).toBe(true);
    attach('d', page().on);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('too much output unseen: dropped, and the next visit connects again', () => {
    attach('e', page().on);
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.push(snapshot('$ '));
    detach('e');
    ws.push({ t: 'output', d: 'y'.repeat(2_100_000) });
    expect(ws.closed).toBe(true);
    attach('e', page().on);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('back on a tab checks the kept connection is still alive', () => {
    attach('f', page().on);
    const ws = FakeSocket.all[0]!;
    ws.open();
    detach('f');
    attach('f', page().on);
    expect(ws.sent.map((s) => JSON.parse(s).t)).toContain('ping');
  });

  it('what changed while unseen comes back in order: its size, who watches, a new working folder; a passing notice does not', () => {
    attach('h', page().on);
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.push(snapshot('$ '));
    detach('h');
    ws.push({ t: 'size', cols: 120, rows: 40, owner: true });
    ws.push({ t: 'output', d: 'a' });
    ws.push({ t: 'output', d: 'b' });
    ws.push({ t: 'viewers', viewers: [{ id: 1 }, { id: 2 }] });
    ws.push({ t: 'shell', shell: { ...shell, cwd: '/tmp' } });
    ws.push({ t: 'notice', code: 'resized_by_other' });
    const back = page();
    attach('h', back.on);
    expect(back.seen).toEqual(['state open', 'snapshot $ ', 'size 120x40', 'replayed ab', 'viewers 2', 'shell']);
    expect(FakeSocket.all).toHaveLength(1);
    // Seen again: each passes straight through.
    ws.push({ t: 'notice', code: 'x' });
    ws.push({ t: 'shell', shell });
    expect(back.seen.slice(-2)).toEqual(['notice x', 'shell']);
  });

  it('refused by the server while unseen: not kept, and the next visit tries again (A3-WEB-02)', () => {
    attach('i', page().on);
    const ws = FakeSocket.all[0]!;
    ws.open();
    detach('i');
    ws.onclose?.({ code: 4403 });
    const again = page();
    attach('i', again.on);
    expect(FakeSocket.all).toHaveLength(2);
    expect(again.seen).toEqual(['state connecting']);
  });

  it('signed out: nothing kept', () => {
    attach('g', page().on);
    FakeSocket.all[0]!.open();
    detach('g');
    dropAll();
    expect(FakeSocket.all[0]!.closed).toBe(true);
  });
});
