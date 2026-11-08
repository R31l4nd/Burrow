import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' }, hidden: false }, location: { protocol: 'https:', host: 'burrow.test' } });
});
const { checkOf, checkUpdates, followOp, loadUpdates, shortDigest, updateCount, updates } = await import('./updates.svelte.js');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const check = (hostId: number, image: string, status: string) => ({ hostId, image, status });

afterEach(() => vi.unstubAllGlobals());

describe('image updates', () => {
  it('the last check: how many have an update, and the one for a container', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ checks: [check(1, 'nginx:1', 'update'), check(1, 'redis:7', 'current'), check(2, 'nginx:1', 'update')] })));
    await loadUpdates();
    expect(updateCount()).toBe(2);
    expect(checkOf(1, 'redis:7')).toMatchObject({ status: 'current' });
    expect(checkOf(3, 'nginx:1')).toBeUndefined();
  });

  it('not an admin, or offline: the badge stays as it was, no error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'forbidden', message: 'Admins only.' }, 403)));
    expect((await loadUpdates())?.checks).toHaveLength(3);
  });

  it('a check asked for: the hosts and images go along, the answer is the new state', async () => {
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => json({ checks: [] }));
    vi.stubGlobal('fetch', fetch);
    await checkUpdates([1, 2], ['nginx:1']);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ hostIds: [1, 2], images: ['nginx:1'] });
    await checkUpdates([3]);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ hostIds: [3] });
    expect(updates.overview?.checks).toEqual([]);
    expect(updateCount()).toBe(0);
  });

  it('a digest short, or a question mark when there is none', () => {
    expect(shortDigest('sha256:1f9b3fc4fe12abcdef')).toBe('1f9b3fc4fe12');
    expect(shortDigest(null)).toBe('?');
  });
});

describe("a stack operation's output", () => {
  class Socket {
    static last: Socket;
    onmessage: ((e: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: ((e?: { code: number }) => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      Socket.last = this;
    }
    close() {
      this.closed = true;
    }
  }

  it('followed until it ends; a connection that drops before the end says so with an empty error', () => {
    vi.stubGlobal('WebSocket', Socket);
    const got: unknown[] = [];
    const stop = followOp({ id: 'op9' } as never, (m) => got.push(m));
    expect(Socket.last.url).toBe('wss://burrow.test/api/docker/ops/op9/ws');
    Socket.last.onmessage?.({ data: JSON.stringify({ t: 'output', d: 'pulling' }) });
    Socket.last.onclose?.();
    expect(got).toEqual([{ t: 'output', d: 'pulling' }, { t: 'error', message: '' }]);

    const done: unknown[] = [];
    followOp({ id: 'op10' } as never, (m) => done.push(m));
    Socket.last.onmessage?.({ data: JSON.stringify({ t: 'exit', code: 0 }) });
    Socket.last.onclose?.();
    expect(done).toEqual([{ t: 'exit', code: 0 }]);
    stop();
  });

  it('a dropped connection is made again, and the output read again from the start: never stuck at "running"', () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('WebSocket', Socket);
      const got: unknown[] = [];
      let again = 0;
      const stop = followOp({ id: 'op11' } as never, (m) => got.push(m), () => again++);
      const first = Socket.last;
      first.onopen?.();
      expect(again).toBe(0);
      first.onmessage?.({ data: JSON.stringify({ t: 'output', d: 'pulling' }) });
      first.onclose?.();
      vi.advanceTimersByTime(1000);
      const second = Socket.last;
      expect(second).not.toBe(first);
      expect(second.url).toBe('wss://burrow.test/api/docker/ops/op11/ws');
      // The server sends all output so far again: the page starts its copy over.
      second.onopen?.();
      expect(again).toBe(1);
      second.onmessage?.({ data: JSON.stringify({ t: 'output', d: 'pulling\ndone' }) });
      second.onmessage?.({ data: JSON.stringify({ t: 'exit', code: 0 }) });
      second.onclose?.();
      expect(got.at(-1)).toEqual({ t: 'exit', code: 0 });
      // Stopped by the page: no new connection.
      stop();
      const n = Socket.last;
      vi.advanceTimersByTime(60_000);
      expect(Socket.last).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an operation the server no longer knows (Burrow restarted) is not asked for again', () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('WebSocket', Socket);
      const got: unknown[] = [];
      followOp({ id: 'op12' } as never, (m) => got.push(m));
      const first = Socket.last;
      first.onmessage?.({ data: JSON.stringify({ t: 'error', message: 'This operation is not known (any more).' }) });
      first.onclose?.({ code: 4404 });
      vi.advanceTimersByTime(60_000);
      expect(Socket.last).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
