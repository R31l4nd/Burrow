import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The little of a browser the module reads when it loads (the language).
vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: {}, hidden: false, addEventListener() {}, removeEventListener() {} } });
});

const { cancelUpload, clearClipboard, clearFinished, clipboard, followJob, formatBytes, openKind, rawUrl, setClipboard, transfers, upload } = await import('./files.svelte.js');
const { setLocale } = await import('./i18n/index.svelte.js');
const { setSession } = await import('./session.svelte.js');

// The transfer drawer's jobs and uploads, against a made-up server.

type Answer = { status: number; body?: unknown };
let answer: (method: string, url: string) => Answer;
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  transfers.items.length = 0;
  // A finished upload tells the page (burrow:uploaded).
  vi.stubGlobal('window', { dispatchEvent: () => true });
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const a = answer(method, url);
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('a copy job followed in the drawer', () => {
  it('that Burrow no longer knows ends as failed, said why, and is not asked for again (audit WL-05)', async () => {
    answer = () => ({ status: 404, body: { error: 'not_found', message: 'No such job.' } });
    await followJob({ id: 'job-1', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy');
    const tr = transfers.items.find((x) => x.id === 'job-1')!;
    expect(tr.status).toBe('failed');
    expect(tr.error).toMatch(/no longer knows this job/);
    expect(calls.filter((c) => c.includes('/api/files/jobs/job-1'))).toHaveLength(1);
  });
});

describe('a copy between hosts that did not match', () => {
  it("says so in the page's words with the files, not the server's English; one not checked says that too (AUDIT2 WEB-16)", async () => {
    answer = () => ({ status: 200, body: { id: 'job-2', status: 'failed', bytes: 10, error: 'Not the same on the destination after copying (sha256): a.txt', errorCode: 'verify_failed', errorDetail: 'a.txt', phase: null, verified: null, unverified: null } });
    await followJob({ id: 'job-2', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy');
    expect(transfers.items.find((x) => x.id === 'job-2')!.error).toBe('Not the same on the destination after copying (sha256): a.txt');
    answer = () => ({ status: 200, body: { id: 'job-3', status: 'done', bytes: 10, error: null, errorCode: null, errorDetail: null, phase: null, verified: null, unverified: 'destination' } });
    await followJob({ id: 'job-3', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy');
    expect(transfers.items.find((x) => x.id === 'job-3')).toMatchObject({ status: 'done', unverified: 'destination' });
  });
});

describe('a copy refused by the server', () => {
  it("says why in the reader's language, as an API error is (report 71b74a: in English in the Dutch app)", async () => {
    answer = () => ({ status: 200, body: { id: 'job-x', status: 'failed', bytes: 0, error: 'Already in the destination: gemini.txt, b.txt', errorCode: 'exists', errorDetail: null, phase: null, verified: null, unverified: null } });
    await setLocale('nl');
    try {
      await followJob({ id: 'job-x', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy');
      expect(transfers.items.find((x) => x.id === 'job-x')!.error).toBe('Staat al op de bestemming: gemini.txt, b.txt');
    } finally {
      await setLocale('en');
    }
  });
});

describe('an upload', () => {
  it('of a file that got shorter since it was picked fails, and the part on the host goes (audit WL-06)', async () => {
    answer = (method, url) => {
      if (method === 'POST' && url.endsWith('/uploads')) return { status: 200, body: { id: 'up-1', offset: 0 } };
      if (method === 'PUT') return { status: 200, body: { id: 'up-1', offset: 0 } };
      return { status: 204 };
    };
    // Twenty bytes said, none there any more.
    upload(1, '/tmp', [{ name: 'shrunk.bin', size: 20, slice: () => new Blob([]) }]);
    await vi.waitFor(() => expect(transfers.items[0]!.status).toBe('failed'));
    expect(transfers.items[0]!.error).toMatch(/got shorter/);
    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(0);
    await vi.waitFor(() => expect(calls).toContain('DELETE /api/files/uploads/up-1'));
  });

  it('whose file cannot be read any more fails alone; the next one in the queue still goes (AUDIT2 WEB-04)', async () => {
    answer = (method, url) => {
      if (method === 'POST' && url.endsWith('/uploads')) return { status: 200, body: { id: 'up-2', offset: 0 } };
      if (method === 'PUT') return { status: 200, body: { id: 'up-2', offset: 4 } };
      return { status: 204 };
    };
    upload(1, '/tmp', [
      { name: 'gone.bin', size: 4, slice: () => Promise.reject(new Error('permission revoked')) },
      { name: 'fine.bin', size: 4, slice: () => new Blob(['abcd']) },
    ]);
    await vi.waitFor(() => expect(transfers.items.map((t) => t.status)).toEqual(['failed', 'done']));
    expect(transfers.items[0]!.error).toMatch(/permission revoked/);
  });

  it('being put in place on the host cannot be stopped, and stays listed until it says how it went (AUDIT2 WEB-05)', async () => {
    const { cancelUpload } = await import('./files.svelte.js');
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    answer = (method, url) => {
      if (method === 'POST' && url.endsWith('/uploads')) return { status: 200, body: { id: 'up-3', offset: 0 } };
      if (method === 'PUT') return { status: 200, body: { id: 'up-3', offset: 4 } };
      return { status: 204 };
    };
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.endsWith('/finish')) await held;
      const a = answer(method, url);
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
    });
    upload(1, '/tmp', [{ name: 'last.bin', size: 4, slice: () => new Blob(['abcd']) }]);
    await vi.waitFor(() => expect(calls.some((c) => c.endsWith('/finish'))).toBe(true));
    cancelUpload(transfers.items[0]!.id);
    expect(transfers.items).toHaveLength(1);
    finish();
    await vi.waitFor(() => expect(transfers.items[0]!.status).toBe('done'));
    expect(calls).not.toContain('DELETE /api/files/uploads/up-3');
  });
});


describe('more of an upload', () => {
  it('one still waiting is stopped before it starts: nothing asked of the host for it', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    answer = (method, url) => (method === 'POST' && url.endsWith('/uploads') ? { status: 200, body: { id: 'up-q', offset: 0 } } : method === 'PUT' ? { status: 200, body: { id: 'up-q', offset: 4 } } : { status: 204 });
    let first = true;
    upload(1, '/tmp', [
      { name: 'first.bin', size: 4, slice: async () => (first && ((first = false), await held), new Blob(['abcd'])) },
      { name: 'second.bin', size: 4, slice: () => new Blob(['abcd']) },
    ]);
    await vi.waitFor(() => expect(transfers.items[0]!.status).toBe('running'));
    cancelUpload(transfers.items[1]!.id);
    release();
    await vi.waitFor(() => expect(transfers.items.map((t) => [t.label, t.status])).toEqual([['first.bin', 'done']]));
    expect(calls.filter((c) => c === 'POST /api/files/1/uploads')).toHaveLength(1);
  });

  it('one stopped while it runs: ends after the piece under way, and the part on the host goes', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let at = 0;
    answer = (method, url) => (method === 'POST' && url.endsWith('/uploads') ? { status: 200, body: { id: 'up-c', offset: 0 } } : method === 'PUT' ? { status: 200, body: { id: 'up-c', offset: (at += 4 << 20) } } : { status: 204 });
    let n = 0;
    upload(1, '/tmp', [{ name: 'big.bin', size: 12 << 20, slice: async (a, b) => (++n === 2 && (await held), new Blob([new Uint8Array(b - a)])) }]);
    await vi.waitFor(() => expect(n).toBe(2));
    cancelUpload(transfers.items[0]!.id);
    expect(transfers.items).toEqual([]);
    release();
    await vi.waitFor(() => expect(calls).toContain('DELETE /api/files/uploads/up-c'));
    // The piece under way still went; the third never did.
    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(2);
    expect(calls.some((c) => c.endsWith('/finish'))).toBe(false);
  });

  it('the connection gone a moment: paused, asked where to go on, and on from there', async () => {
    vi.useFakeTimers();
    try {
      let puts = 0;
      answer = (method, url) => {
        if (method === 'POST' && url.endsWith('/uploads')) return { status: 200, body: { id: 'up-n', offset: 0 } };
        if (method === 'PUT') return ++puts === 1 ? { status: 502, body: { error: 'bad_gateway', message: 'x' } } : { status: 200, body: { id: 'up-n', offset: 4 } };
        if (method === 'GET') return { status: 200, body: { id: 'up-n', offset: 0 } };
        return { status: 204 };
      };
      upload(1, '/tmp', [{ name: 'flaky.bin', size: 4, slice: () => new Blob(['abcd']) }]);
      await vi.waitFor(() => expect(transfers.items[0]!.status).toBe('paused'));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(transfers.items[0]!.status).toBe('done'));
      expect(calls).toContain('GET /api/files/uploads/up-n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refused by the host at the start (no room, not allowed): failed with its words; an empty file is only put in place', async () => {
    answer = () => ({ status: 507, body: { error: 'no_space', message: 'No space left on /tmp.' } });
    upload(1, '/tmp', [{ name: 'a.bin', size: 4, slice: () => new Blob(['abcd']) }]);
    await vi.waitFor(() => expect(transfers.items[0]).toMatchObject({ status: 'failed', error: 'No space left on /tmp.' }));
    answer = (method, url) => (method === 'POST' && url.endsWith('/uploads') ? { status: 200, body: { id: 'up-e', offset: 0 } } : { status: 204 });
    const arrived: number[] = [];
    upload(1, '/tmp', [{ name: 'empty.txt', size: 0, slice: () => new Blob([]) }], (i) => arrived.push(i));
    await vi.waitFor(() => expect(transfers.items[1]!.status).toBe('done'));
    expect(arrived).toEqual([0]);
    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
    // Cleared: the finished ones go, the failed one too.
    clearFinished();
    expect(transfers.items).toEqual([]);
  });

  it('an answer that is not Burrow\'s to a piece: a failure, not progress', async () => {
    vi.useFakeTimers();
    try {
      answer = (method, url) => (method === 'POST' && url.endsWith('/uploads') ? { status: 200, body: { id: 'up-x', offset: 0 } } : method === 'PUT' ? { status: 200, body: { hello: 1 } } : method === 'GET' ? { status: 200, body: { id: 'up-x', offset: 0 } } : { status: 204 });
      upload(1, '/tmp', [{ name: 'x.bin', size: 4, slice: () => new Blob(['abcd']) }]);
      await vi.advanceTimersByTimeAsync(200_000);
      await vi.waitFor(() => expect(transfers.items[0]!.status).toBe('failed'));
      expect(transfers.items[0]!.error).toMatch(/connection/i);
      expect(calls).toContain('DELETE /api/files/uploads/up-x');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('more of a copy job', () => {
  it('its progress followed until done, then what was waiting on it', async () => {
    let n = 0;
    answer = () => ({ status: 200, body: ++n < 2 ? { id: 'job-p', status: 'running', bytes: 5, error: null, phase: 'checking' } : { id: 'job-p', status: 'done', bytes: 10, error: null, verified: 3 } });
    let done = false;
    await followJob({ id: 'job-p', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy', () => (done = true));
    expect(transfers.items.find((x) => x.id === 'job-p')).toMatchObject({ status: 'done', bytes: 10, verified: 3, checking: false });
    expect(done).toBe(true);
  });

  it('no answer for five minutes: given up on, said so; one taken off the list is not followed further', async () => {
    vi.useFakeTimers();
    try {
      answer = () => ({ status: 502, body: { error: 'bad_gateway', message: 'x' } });
      const p = followJob({ id: 'job-u', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy');
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await p;
      expect(transfers.items.find((x) => x.id === 'job-u')).toMatchObject({ status: 'failed', error: expect.stringMatching(/./) });
      const q = followJob({ id: 'job-r', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy');
      transfers.items = transfers.items.filter((x) => x.id !== 'job-r');
      await vi.advanceTimersByTimeAsync(10_000);
      await q;
      const asked = calls.filter((c) => c.includes('job-r')).length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.filter((c) => c.includes('job-r')).length).toBe(asked);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a copy whose source changed meanwhile says which files, in the page's words", async () => {
    answer = () => ({ status: 200, body: { id: 'job-s', status: 'failed', bytes: 1, error: 'x', errorCode: 'source_changed', errorDetail: 'b.txt' } });
    await followJob({ id: 'job-s', status: 'running', bytes: 0, error: null } as never, 'copy', 'copy');
    expect(transfers.items.find((x) => x.id === 'job-s')!.error).toContain('b.txt');
  });
});

describe('the clipboard and another account', () => {
  it('paths copied on one host, cleared; another account at the page keeps none of them, nor the transfers (AUDIT2 WEB-01)', () => {
    setClipboard(3, 'nas', ['/a', '/b'], true);
    expect(clipboard).toMatchObject({ hostId: 3, hostName: 'nas', paths: ['/a', '/b'], move: true });
    clearClipboard();
    expect([clipboard.hostId, clipboard.paths]).toEqual([null, []]);
    setClipboard(3, 'nas', ['/a'], false);
    transfers.items.push({ id: 'x', label: 'x', kind: 'copy', status: 'done', bytes: 0, total: null, error: null });
    transfers.open = true;
    setSession({ setupRequired: false, user: { id: 1 } } as never);
    setSession({ setupRequired: false, user: { id: 2 } } as never);
    expect([clipboard.hostId, clipboard.paths, transfers.items, transfers.open]).toEqual([null, [], [], false]);
  });
});

describe('files by name', () => {
  it('sizes read easily; the raw address; what opening a file does', () => {
    expect([0, 1023, 1024, 1536, 15 * 1024, 5 * 1024 ** 3, 3 * 1024 ** 5].map(formatBytes)).toEqual(['0 B', '1023 B', '1.0 KB', '1.5 KB', '15 KB', '5.0 GB', '3072 TB']);
    expect(rawUrl(2, '/etc/a b.txt')).toBe('/api/files/2/raw?path=%2Fetc%2Fa%20b.txt');
    expect(rawUrl(2, '/x', true)).toBe('/api/files/2/raw?path=%2Fx&download=1');
    expect(['a.PNG', 'b.mkv', 'c.flac', 'd.pdf', 'e.tar.gz', 'f.iso', 'g.yml', 'Dockerfile'].map(openKind)).toEqual(['image', 'video', 'audio', 'pdf', 'archive', 'other', 'text', 'text']);
  });
});
