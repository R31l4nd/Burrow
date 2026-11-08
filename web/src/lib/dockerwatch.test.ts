import { afterEach, describe, expect, it, vi } from 'vitest';

// The container overview's store (A3-WEB-20): a host no longer watched is
// not written back by a read or a snapshot that was on its way.
vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } }, location: { protocol: 'http:', host: 'burrow.test' } });
});
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', FakeSocket);
const { DockerWatch, formatBytesShort } = await import('./docker.svelte.js');

const snap = (hostId: number) => ({ hostId, hostName: `h${hostId}`, containers: [], stats: {}, history: {}, error: null, at: new Date().toISOString() });

afterEach(() => vi.unstubAllGlobals());

describe('DockerWatch', () => {
  it('a read still on its way when its host is no longer watched does not put it back', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (await held, new Response(JSON.stringify(snap(Number(/docker\/(\d+)/.exec(url)![1]))), { status: 200 }))));
    const w = new DockerWatch();
    w.watch([1, 2]);
    const reading = w.refresh();
    w.watch([2]);
    release();
    await reading;
    expect(Object.keys(w.hosts).sort()).toEqual(['2']);
    w.close();
  });

  it('a snapshot of a host not watched (any more) is not stored', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const w = new DockerWatch();
    w.watch([2]);
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ t: 'host', host: snap(5) }) });
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ t: 'host', host: snap(2) }) });
    expect(Object.keys(w.hosts)).toEqual(['2']);
    w.close();
  });
});

/** A socket the test drives, keeping what was sent; every one made is kept. */
class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    Socket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  host(hostId: number) {
    this.onmessage?.({ data: JSON.stringify({ t: 'host', host: snap(hostId) }) });
  }
}

describe('the overview socket', () => {
  it('says which hosts it watches when it opens and when they change; other messages are ignored', () => {
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    const w = new DockerWatch();
    const ws = Socket.all[0]!;
    expect(ws.url).toBe('ws://burrow.test/api/docker/ws');
    w.watch([3]);
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(w.connected).toBe(true);
    w.watch([3, 4]);
    expect(ws.sent).toEqual([{ t: 'watch', hostIds: [3] }, { t: 'watch', hostIds: [3, 4] }]);
    ws.onmessage?.({ data: JSON.stringify({ t: 'error', message: 'x' }) });
    expect(w.hosts).toEqual({});
    ws.host(4);
    expect(w.fresh).toEqual({ 4: true });
    w.close();
  });

  it("disconnected: what it shows is no longer fresh, and it connects again, waiting longer each time (AUDIT2 WEB-07)", () => {
    vi.useFakeTimers();
    try {
      Socket.all = [];
      vi.stubGlobal('WebSocket', Socket);
      const w = new DockerWatch();
      w.watch([6]);
      Socket.all[0]!.open();
      Socket.all[0]!.host(6);
      Socket.all[0]!.close();
      expect([w.connected, w.fresh, Object.keys(w.hosts)]).toEqual([false, {}, ['6']]);
      vi.advanceTimersByTime(499);
      expect(Socket.all).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(Socket.all).toHaveLength(2);
      Socket.all[1]!.close();
      vi.advanceTimersByTime(999);
      expect(Socket.all).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(Socket.all).toHaveLength(3);
      // Opened again: the waiting starts over, and it says what it watches.
      Socket.all[2]!.open();
      expect(Socket.all[2]!.sent).toEqual([{ t: 'watch', hostIds: [6] }]);
      // Signed out: not again.
      Socket.all[2]!.close(4401);
      vi.advanceTimersByTime(60_000);
      expect(Socket.all).toHaveLength(3);
      w.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closed by the page: no reconnect, and a close of an old socket changes nothing', () => {
    vi.useFakeTimers();
    try {
      Socket.all = [];
      vi.stubGlobal('WebSocket', Socket);
      const w = new DockerWatch();
      const ws = Socket.all[0]!;
      ws.open();
      w.close();
      vi.advanceTimersByTime(60_000);
      expect(Socket.all).toHaveLength(1);
      ws.onclose?.({ code: 1006 });
      expect(Socket.all).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('another page watching a host seen before shows its last snapshot at once, not yet fresh', () => {
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    const first = new DockerWatch();
    first.watch([8]);
    Socket.all[0]!.open();
    Socket.all[0]!.host(8);
    first.close();
    const next = new DockerWatch();
    next.watch([8]);
    expect(next.hosts[8]!.hostName).toBe('h8');
    expect(next.fresh).toEqual({});
    next.close();
  });

  it('pull to refresh: each watched host read now; the ones that could not be read are named (AUDIT2 WEB-08)', async () => {
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/docker/10/') ? new Response(JSON.stringify(snap(10)), { status: 200 }) : new Response('{"error":"host_unreachable","message":"away"}', { status: 502 }))));
    const w = new DockerWatch();
    w.watch([10, 11]);
    expect(await w.refresh()).toEqual([11]);
    expect(w.fresh).toEqual({ 10: true });
    w.close();
  });
});

describe('the sign-in gone (audit 2026-11-05)', () => {
  it('dials that never open: the sign-in read again every third one; signed out (4401) or not allowed (4403): read at once, not dialled again', async () => {
    vi.useFakeTimers();
    const { onSessionDoubt } = await import('./dial.js');
    const doubt = vi.fn();
    onSessionDoubt(doubt);
    try {
      Socket.all = [];
      vi.stubGlobal('WebSocket', Socket);
      const w = new DockerWatch();
      for (let i = 0; i < 3; i++) {
        Socket.all[i]!.close();
        vi.advanceTimersByTime(2000);
      }
      expect(doubt).toHaveBeenCalledOnce();
      Socket.all[3]!.open();
      Socket.all[3]!.close(4403);
      expect(doubt).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      expect(Socket.all).toHaveLength(4);
      w.close();
      const v = new DockerWatch();
      Socket.all[4]!.open();
      Socket.all[4]!.close(4401);
      expect(doubt).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(60_000);
      expect(Socket.all).toHaveLength(5);
      v.close();
    } finally {
      onSessionDoubt(() => {});
      vi.useRealTimers();
    }
  });
});

describe('changes only (decision 19, OPS-W-03)', () => {
  const box = (id: string, state = 'running') => ({ id, name: id, image: 'x:1', imageId: 'sha256:1', state, health: null, restarts: 0, startedAt: null, finishedAt: null, exitCode: 0, oomKilled: false, createdAt: '', project: null, service: null, configFiles: null, workingDir: null });

  it('a delta applies to the snapshot before it: changed, gone, and a new sample on the sparklines', () => {
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    const w = new DockerWatch();
    w.watch([12]);
    const ws = Socket.all[0]!;
    ws.open();
    const host = { ...snap(12), containers: [box('a'), box('b')], stats: { a: { cpu: 1, memBytes: 5, memLimitBytes: 9 } }, history: { a: { at: [1], cpu: [1], mem: [5] } } };
    ws.onmessage?.({ data: JSON.stringify({ t: 'host', host }) });
    ws.onmessage?.({ data: JSON.stringify({ t: 'delta', d: { hostId: 12, hostName: 'h12', at: 'later', error: null, changed: [box('a', 'exited')], removed: ['b'], order: ['a'], stats: { a: { cpu: 2.345, memBytes: 6, memLimitBytes: 9 } }, sampleAt: 2 } }) });
    expect(w.hosts[12]!.containers.map((c) => [c.id, c.state])).toEqual([['a', 'exited']]);
    expect(w.hosts[12]!.history.a).toEqual({ at: [1, 2], cpu: [1, 2.35], mem: [5, 6] });
    expect(w.hosts[12]!.at).toBe('later');
    w.close();
  });

  it('a host that says nothing for 20 s while the socket is up is marked silent, and no longer once it answers (OPS-W-04)', () => {
    vi.useFakeTimers();
    try {
      Socket.all = [];
      vi.stubGlobal('WebSocket', Socket);
      const w = new DockerWatch();
      w.watch([13, 14]);
      const ws = Socket.all[0]!;
      ws.open();
      ws.host(13);
      ws.host(14);
      vi.advanceTimersByTime(15_000);
      ws.onmessage?.({ data: JSON.stringify({ t: 'delta', d: { hostId: 14, hostName: 'h14', at: 'x', error: null } }) });
      vi.advanceTimersByTime(10_000);
      expect(w.silent).toEqual({ 13: 25 });
      ws.host(13);
      vi.advanceTimersByTime(5000);
      expect(w.silent).toEqual({});
      w.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hosts changed elsewhere (W-FUNC-09)', () => {
  it('the hosts are read again when the server says they changed', async () => {
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    const fetch = vi.fn(async (url: string) => new Response(url.endsWith('/api/hosts') ? JSON.stringify([{ id: 21, name: 'new' }]) : url.endsWith('host-defaults') ? '{}' : '[]', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { data } = await import('./data.svelte.js');
    const w = new DockerWatch();
    Socket.all[0]!.open();
    Socket.all[0]!.onmessage?.({ data: JSON.stringify({ t: 'hosts-changed' }) });
    await vi.waitFor(() => expect(data.hosts.map((h) => h.id)).toEqual([21]));
    expect(fetch.mock.calls.map((c) => String(c[0]))).toContain('/api/hosts');
    w.close();
  });
});

describe('sizes in the overview', () => {
  it('KB below a megabyte, MB below a gigabyte, GB with one decimal', () => {
    expect([1536, 5 * 1024 ** 2, 3.25 * 1024 ** 3].map(formatBytesShort)).toEqual(['2 KB', '5 MB', '3.3 GB']);
  });
});
