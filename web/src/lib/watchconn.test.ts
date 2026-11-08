import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchConnection, type WatchState } from './watchconn.js';
import { onSessionDoubt } from './dial.js';

// Watching a session shared with you (F3): a dropped connection is not the session's end.
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
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
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let states: WatchState[] = [];
let seen: string[] = [];
const watch = () => new WatchConnection('w1', { message: (m) => seen.push(m.t), state: (s) => states.push(s) });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  states = [];
  seen = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'burrow.test' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a shared session watched (audit 2026-11-05)', () => {
  it('a connection dropped without the session ending: lost, then connected again with backoff, the screen anew', () => {
    const c = watch();
    expect(FakeSocket.all[0]!.url).toBe('wss://burrow.test/api/terminal/shared/w1/ws');
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.say({ t: 'snapshot', data: '', cols: 80, rows: 24 });
    FakeSocket.all[0]!.close();
    // Not "ended": it went away without the session saying so.
    expect(states.at(-1)).toBe('lost');
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.close();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.open();
    FakeSocket.all[2]!.say({ t: 'snapshot', data: '', cols: 80, rows: 24 });
    expect(seen).toEqual(['snapshot', 'snapshot']);
    c.close();
  });

  it('the session ended (an exit first) or no longer shared (4003): said, not dialled again; Burrow restarting (exit lost) is dialled again', () => {
    const c = watch();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.say({ t: 'exit', reason: 'lost', message: 'Burrow is restarting.' });
    FakeSocket.all[0]!.close(1012);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.say({ t: 'exit', reason: 'ended' });
    FakeSocket.all[1]!.close(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(seen).toEqual(['exit', 'exit']);
    c.close();
    const d = watch();
    FakeSocket.all[2]!.open();
    FakeSocket.all[2]!.close(4003);
    expect(states.at(-1)).toBe('unshared');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
    d.close();
  });

  it('dials that never open: the sign-in is read again every third one; closed by the page: not dialled again', () => {
    const doubt = vi.fn();
    onSessionDoubt(doubt);
    const c = watch();
    for (let i = 0; i < 3; i++) {
      FakeSocket.all[i]!.close();
      vi.advanceTimersByTime(2000);
    }
    expect(doubt).toHaveBeenCalledOnce();
    c.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(4);
    onSessionDoubt(() => {});
  });

  it('pings while open, to keep a proxy from closing a quiet one', () => {
    const c = watch();
    FakeSocket.all[0]!.open();
    vi.advanceTimersByTime(25_000);
    expect(FakeSocket.all[0]!.sent.map((d) => JSON.parse(d).t)).toEqual(['ping']);
    c.close();
  });
});
