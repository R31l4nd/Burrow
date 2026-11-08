import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lspTransport } from './lsp.js';

// The language server's socket while the editor that asked for it goes away.

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

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

describe('the language server connection (audit WL-09)', () => {
  it('the editor closed while it connects: refused, and the socket closed', async () => {
    const gone = new AbortController();
    const p = lspTransport('yaml', 'e1', () => {}, gone.signal);
    gone.abort();
    await expect(p).rejects.toThrow();
    expect(FakeSocket.all[0]!.closed).toBe(true);
    // Opening late changes nothing.
    FakeSocket.all[0]!.open();
  });

  it('refused for the limit per person: said as that, also after the socket opened, as the bridge refuses (report 76bcda)', async () => {
    type Closing = { onclose: ((e: { code: number; reason: string }) => void) | null };
    const p = lspTransport('yaml', 'e4', () => {});
    (FakeSocket.all[0]! as unknown as Closing).onclose?.({ code: 4404, reason: 'Close an editor first.' });
    await expect(p).rejects.toThrow('too_many');
    // The bridge accepts the socket first and closes it then: told with why, not as a connection that went.
    const told: [string, string | undefined][] = [];
    const q = lspTransport('yaml', 'e5', (s, why) => told.push([s, why]));
    FakeSocket.all[1]!.open();
    await q;
    (FakeSocket.all[1]! as unknown as Closing).onclose?.({ code: 4404, reason: 'Close an editor first.' });
    expect(told).toEqual([['open', undefined], ['closed', 'too_many']]);
  });

  it('closed before it opened: refused, not left waiting for ever', async () => {
    const p = lspTransport('yaml', 'e2', () => {});
    FakeSocket.all[0]!.close();
    await expect(p).rejects.toThrow();
  });

  it('no answer at all: given up on after a while, and closed', async () => {
    const p = lspTransport('yaml', 'e3', () => {});
    const settled = expect(p).rejects.toThrow(/too slow/);
    await vi.advanceTimersByTimeAsync(16_000);
    await settled;
    expect(FakeSocket.all[0]!.closed).toBe(true);
  });

  it('opened: works, and a later close is told', async () => {
    const states: string[] = [];
    const p = lspTransport('yaml', 'e4', (s) => states.push(s));
    FakeSocket.all[0]!.open();
    const t = await p;
    t.close();
    expect(states).toEqual(['open', 'closed']);
  });

  it('opened, then an error and its close: told closed, once (AUDIT2 TERM-13)', async () => {
    const states: string[] = [];
    const p = lspTransport('yaml', 'e5', (s) => states.push(s));
    const ws = FakeSocket.all[0]!;
    ws.open();
    await p;
    ws.onerror?.();
    ws.close();
    expect(states).toEqual(['open', 'closed']);
  });
});
