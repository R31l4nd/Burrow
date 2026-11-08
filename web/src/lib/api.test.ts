import { afterEach, describe, expect, it, vi } from 'vitest';

// The messages need a page's language; there is no page here.
vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { ApiFailure, backInSight, del, errorMessage, get, newAccount, noConnection, onStepUpRequired, onUnauthenticated, post, put, recentFailures } = await import('./api.js');
const { t } = await import('./i18n/index.svelte.js');
type ApiFailure = InstanceType<typeof ApiFailure>;

// What a request gets back when it is not Burrow that answers: a reverse
// proxy's own page while Burrow restarts (SWAG's "domain not available",
// status 200). Reported: the app's WebView cached that page for
// /api/terminal/sessions, the list became null and the Terminal tab broke.

const answer = (body: string, status: number, type: string) => new Response(body, { status, headers: { 'content-type': type } });

afterEach(() => vi.unstubAllGlobals());

describe('a step-up turned down', () => {
  it('is a quiet "cancelled", not an error to show (report 1d2fd4: "step up required" after closing it on purpose)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(JSON.stringify({ error: 'step_up_required', message: 'step up required' }), 403, 'application/json')));
    onStepUpRequired(async () => false);
    const err = (await post('/api/terminal/sessions', { hostId: 1 }).catch((e: unknown) => e)) as ApiFailure;
    expect(err.code).toBe('step_up_cancelled');
    expect(errorMessage(err)).toBe('');
  });
});

describe('api', () => {
  it('a proxy page with status 200 is an error, not data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('<!doctype html><title>Domein niet beschikbaar</title>', 200, 'text/html')));
    const err = await get('/api/terminal/sessions').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe('not_json');
  });

  it('never answers from the HTTP cache', async () => {
    const fetch = vi.fn(async (..._args: [string, RequestInit?]) => answer('[]', 200, 'application/json'));
    vi.stubGlobal('fetch', fetch);
    expect(await get('/api/terminal/sessions')).toEqual([]);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: 'no-store' });
  });

  it("Burrow's own error still says what went wrong", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(JSON.stringify({ error: 'forbidden', message: 'No.' }), 403, 'application/json')));
    const err = (await get('/api/users').catch((e: unknown) => e)) as ApiFailure;
    expect([err.status, err.code, err.message]).toEqual([403, 'forbidden', 'No.']);
  });

  it('a proxy page with an error status is that status, said in words with the code small (A3-WEB-05: "http 502")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('<html>502 Bad Gateway</html>', 502, 'text/html')));
    const err = (await get('/api/hosts').catch((e: unknown) => e)) as ApiFailure;
    expect([err.status, err.code]).toEqual([502, 'http_502']);
    expect(errorMessage(err)).toBe('Burrow is not answering (502), perhaps because it is restarting or updating. Try again in a moment.');
  });

  it("Burrow's own error without words of its own is said in words, not as its code", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(JSON.stringify({ error: 'internal' }), 500, 'application/json')));
    const err = (await get('/api/hosts').catch((e: unknown) => e)) as ApiFailure;
    expect(errorMessage(err)).toBe('Something went wrong in Burrow.');
  });

  it('saves to one address go one after the other; other addresses do not wait; a failed one does not hold up the next', async () => {
    const log: string[] = [];
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = String(init?.body);
        log.push(`start ${url} ${body}`);
        if (body.includes('"first"')) await held;
        log.push(`end ${url} ${body}`);
        return body.includes('"bad"') ? answer('{"error":"x"}', 500, 'application/json') : answer('{}', 200, 'application/json');
      }),
    );
    const a = put('/api/x', { v: 'first' });
    const b = put('/api/x', { v: 'second' });
    const other = put('/api/y', { v: 'other' });
    await other;
    // The second save waits for the first; another address went ahead.
    expect(log).toEqual(['start /api/x {"v":"first"}', 'start /api/y {"v":"other"}', 'end /api/y {"v":"other"}']);
    release();
    await Promise.all([a, b]);
    expect(log.slice(3)).toEqual(['end /api/x {"v":"first"}', 'start /api/x {"v":"second"}', 'end /api/x {"v":"second"}']);
    // A failure does not stop what comes after it.
    const bad = put('/api/z', { v: 'bad' }).catch(() => 'failed');
    const after = put('/api/z', { v: 'after' });
    expect(await bad).toBe('failed');
    await expect(after).resolves.toEqual({});
  });
});

describe('answers that are no answer (AUDIT2 WEB-03)', () => {
  it('a body that breaks off while read is an error, not "saved"', async () => {
    const broken = new Response(new ReadableStream({ start: (c) => c.error(new Error('connection reset')) }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async () => broken));
    const err = (await put('/api/settings/ai', {}).catch((e: unknown) => e)) as ApiFailure;
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err.code).toBe('read_failed');
  });

  it('an empty 200 to a read is an error; 204 and JSON null are what they say', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('', 200, 'application/json')));
    expect(((await get('/api/hosts').catch((e: unknown) => e)) as ApiFailure).code).toBe('empty_answer');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await post('/api/x')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => answer('null', 200, 'application/json')));
    expect(await get('/api/x')).toBeNull();
  });
});

describe('a read that never answers (AUDIT2 WEB-06)', () => {
  it('gives up after its time, as an error', async () => {
    vi.useFakeTimers();
    let err: ApiFailure;
    try {
      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))));
      const p = get('/api/hosts').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(130_000);
      err = (await p) as ApiFailure;
    } finally {
      vi.useRealTimers();
    }
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err.code).toBe('timeout');
  });
});

describe('another account signed in meanwhile (AUDIT2 WEB-02)', () => {
  it("a save still waiting its turn does not go out as the next account", async () => {
    let release!: () => void;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url} ${init?.body}`);
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
      return answer('{}', 200, 'application/json');
    }));
    const first = put('/api/settings/ui', { a: 1 });
    const second = put('/api/settings/ui', { a: 2 }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    newAccount();
    release();
    await first;
    expect(((await second) as ApiFailure).code).toBe('signed_out');
    expect(calls).toHaveLength(1);
  });
});

describe('too many requests (429)', () => {
  it('a read waits as told and asks again, twice at most; a change is not repeated', async () => {
    vi.useFakeTimers();
    try {
      const busy = () => new Response('{}', { status: 429, headers: { 'retry-after': '3', 'content-type': 'application/json' } });
      let n = 0;
      const fetch = vi.fn(async () => (++n < 3 ? busy() : answer('[1]', 200, 'application/json')));
      vi.stubGlobal('fetch', fetch);
      const p = get<number[]>('/api/hosts');
      await vi.advanceTimersByTimeAsync(2_900);
      // Not asked again before the time it was told.
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_200);
      expect(await p).toEqual([1]);
      expect(fetch).toHaveBeenCalledTimes(3);

      // Still too many after the second try: that is the answer.
      const always = vi.fn(async () => busy());
      vi.stubGlobal('fetch', always);
      const q = get('/api/hosts').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(((await q) as ApiFailure).status).toBe(429);
      expect(always).toHaveBeenCalledTimes(3);

      const change = vi.fn(async () => busy());
      vi.stubGlobal('fetch', change);
      const r = (await post('/api/hosts', {}).catch((e: unknown) => e)) as ApiFailure;
      expect(r.status).toBe(429);
      expect(change).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a step-up given', () => {
  it('the request goes again once and its answer is the answer', async () => {
    let n = 0;
    const fetch = vi.fn(async () => (++n === 1 ? answer(JSON.stringify({ error: 'step_up_required', message: 'step up required' }), 403, 'application/json') : answer('{"id":"s9"}', 200, 'application/json')));
    vi.stubGlobal('fetch', fetch);
    const asked = vi.fn(async () => true);
    onStepUpRequired(asked);
    expect(await post<{ id: string }>('/api/terminal/sessions', { hostId: 1 })).toEqual({ id: 's9' });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('another 403 is not a step-up: no dialog, the error as it came', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(JSON.stringify({ error: 'forbidden', message: 'Admins only.' }), 403, 'application/json')));
    const asked = vi.fn(async () => true);
    onStepUpRequired(asked);
    expect(errorMessage(await del('/api/users/2').catch((e: unknown) => e))).toBe('Admins only.');
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('the session gone', () => {
  it('a 401 "unauthenticated" tells the app shell; another 401 does not', async () => {
    const gone = vi.fn();
    onUnauthenticated(gone);
    vi.stubGlobal('fetch', vi.fn(async () => answer(JSON.stringify({ error: 'bad_code', message: 'Wrong code.' }), 401, 'application/json')));
    await post('/api/auth/totp', {}).catch(() => {});
    expect(gone).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => answer(JSON.stringify({ error: 'unauthenticated', message: 'Sign in.' }), 401, 'application/json')));
    await get('/api/hosts').catch(() => {});
    expect(gone).toHaveBeenCalledTimes(1);
  });
});

describe('failures kept for a problem report', () => {
  it('the path without its query, the code, and whether the page answers it itself', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(JSON.stringify({ error: 'needs_sudo', message: 'Only root may read it.' }), 403, 'application/json')));
    await get('/api/files/1/text?path=%2Froot%2Fsecret', ['needs_sudo']).catch(() => {});
    expect(recentFailures.at(-1)).toMatchObject({ method: 'GET', path: '/api/files/1/text', status: 403, code: 'needs_sudo', handled: true });
    await get('/api/files/1/text?path=%2Fetc', []).catch(() => {});
    expect(recentFailures.at(-1)!.handled).toBeUndefined();
    // Thirty at most: the oldest go.
    for (let i = 0; i < 40; i++) await get(`/api/x/${i}`).catch(() => {});
    expect(recentFailures).toHaveLength(30);
    expect(recentFailures[0]!.path).toBe('/api/x/10');
  });
});

describe('what an error says', () => {
  it("Burrow's catalogue words in the app's language only when the server said exactly those; details of its own stay (A3-WEB-13)", () => {
    // Said as the catalogue holds it, or by its code alone: the words in the app's language.
    expect(errorMessage(new ApiFailure(400, 'binary', 'This looks like a binary file.'))).toBe(t('error.binary'));
    expect(errorMessage(new ApiFailure(400, 'binary', 'binary'))).toBe(t('error.binary'));
    // The host's own words kept, within a sentence of the app's (W-FUNC-06).
    expect(errorMessage(new ApiFailure(400, 'host_unreachable', 'Connection refused on 10.0.0.9:22'))).toBe(t('error.host_unreachable', { detail: 'Connection refused on 10.0.0.9:22' }));
    expect(errorMessage(new ApiFailure(400, 'some_new_code', 'some_new_code'))).toBe('some new code');
  });

  it("fetch's own words for no answer, the same in every browser; anything else as it is", () => {
    for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) expect(errorMessage(new TypeError(m))).toBe(t('common.noConnection'));
    expect(errorMessage(new TypeError('x is undefined'))).toBe('x is undefined');
    expect(errorMessage('plain')).toBe('plain');
  });

  it('no connection: not an HTTP error, not a request called off', () => {
    expect(noConnection(new TypeError('Failed to fetch'))).toBe(true);
    expect(noConnection(new ApiFailure(500, 'internal'))).toBe(false);
    expect(noConnection(new DOMException('stop', 'AbortError'))).toBe(false);
  });
});

describe('back in sight', () => {
  it('in sight: a moment later; hidden: only once the page is seen again', async () => {
    vi.useFakeTimers();
    const doc = document as unknown as { hidden: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
    const on = new Set<() => void>();
    Object.assign(doc, { hidden: false, addEventListener: (_: string, f: () => void) => on.add(f), removeEventListener: (_: string, f: () => void) => on.delete(f) });
    try {
      let done = false;
      void backInSight(500).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);

      doc.hidden = true;
      done = false;
      void backInSight(500).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(done).toBe(false);
      // Still hidden: a change of something else, not yet.
      on.forEach((f) => f());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(done).toBe(false);
      doc.hidden = false;
      on.forEach((f) => f());
      expect(on.size).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
