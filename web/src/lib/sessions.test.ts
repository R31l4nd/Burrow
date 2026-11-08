import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } }, location: { hash: '', pathname: '/', search: '' }, window: { addEventListener() {}, innerWidth: 1200, innerHeight: 800 } });
});
const { closeSession, connectHost, newSession, loadSessions, recordSession, renameSession, shareSession, terms } = await import('./sessions.svelte.js');
const { asking, answered } = await import('./confirm.svelte.js');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('terminal sessions', () => {
  it('one made is made, even when reading the list after it fails: no second shell on a retry (AUDIT2 WEB-12)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'POST' ? json({ id: 's1', hostId: 1, title: null }) : json({ error: 'internal', message: 'list failed' }, 500))));
    const s = await newSession(1);
    expect(s.id).toBe('s1');
    expect(terms.list.map((x) => x.id)).toContain('s1');
  });

  it('an older answer coming after a newer one does not put back its list (AUDIT2 WEB-11)', async () => {
    let first!: (r: Response) => void;
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(() => (++n === 1 ? new Promise<Response>((r) => (first = r)) : Promise.resolve(json([{ id: 'new' }])))));
    const older = loadSessions();
    await loadSessions();
    first(json([{ id: 'old' }]));
    await older;
    expect(terms.list.map((x) => x.id)).toEqual(['new']);
  });
});

/** A stand-in server: the sessions it has, and what was asked of it. */
function server(list: { id: string; hostId: number; lastActivityAt: string; title?: string | null }[] | 'slow') {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const m = init?.method ?? 'GET';
    calls.push(`${m} ${url}${init?.body && m !== 'GET' ? ` ${init.body}` : ''}`);
    // The list read again behind a change, still on its way.
    if (m === 'GET') return list === 'slow' ? new Promise<Response>(() => {}) : json(list);
    if (m === 'POST') return json({ id: 'new1', hostId: 9, title: null });
    if (url.endsWith('/share')) return json({ id: 's1', sharedWith: [{ id: 4, username: 'ann' }] });
    return new Response(null, { status: 204 });
  }));
  return calls;
}

describe('one tap on a host', () => {
  it("back to the host's session used last; with none, or asked for a fresh one, a new session sized to the window", async () => {
    const calls = server([
      { id: 'old', hostId: 2, lastActivityAt: '2026-10-16T08:00:00Z' },
      { id: 'recent', hostId: 2, lastActivityAt: '2026-10-16T09:00:00Z' },
      { id: 'other', hostId: 3, lastActivityAt: '2026-10-16T10:00:00Z' },
    ]);
    await connectHost(2);
    expect(location.hash).toBe('/term/recent');
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    await connectHost(9);
    expect(location.hash).toBe('/term/new1');
    // 1200x800 at 14 px: about 142 columns, 38 rows.
    expect(JSON.parse(calls.find((c) => c.startsWith('POST'))!.split(' ').slice(2).join(' '))).toEqual({ hostId: 9, cols: 142, rows: 38 });
    await connectHost(2, true);
    expect(location.hash).toBe('/term/new1');
    await connectHost(2, false, '/srv/app', 'never');
    expect(calls.at(-2)).toContain('"cwd":"/srv/app","tmux":"never"');
  });
});

describe("a session's own changes", () => {
  it('a name (empty: the host name again), who may watch, recording: in the list at once', async () => {
    const calls = server('slow');
    terms.list = [{ id: 's1', hostId: 1, title: 'old', recording: false, sharedWith: [] } as never];
    await renameSession('s1', 'build box');
    expect(terms.list[0]!.title).toBe('build box');
    await renameSession('s1', '');
    expect(terms.list[0]!.title).toBeNull();
    await shareSession('s1', [4]);
    expect(terms.list[0]!.sharedWith).toEqual([{ id: 4, username: 'ann' }]);
    await recordSession('s1', true);
    expect(terms.list[0]!.recording).toBe(true);
    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([
      'PUT /api/terminal/sessions/s1/title {"title":"build box"}',
      'PUT /api/terminal/sessions/s1/title {"title":""}',
      'PUT /api/terminal/sessions/s1/share {"userIds":[4]}',
      'PUT /api/terminal/sessions/s1/recording {"on":true}',
    ]);
  });
});

describe('closing a session (AUDIT2 FS-14)', () => {
  const refuse = (code: string, message: string) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'DELETE' && !url.includes('force=1')) return json({ error: code, message }, 502);
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json([]);
    }));
    return calls;
  };

  it('its host away: asked whether to forget it anyway; yes forgets it', async () => {
    terms.list = [{ id: 'x1' } as never];
    const calls = refuse('host_unreachable', 'nas is not answering.');
    const closing = closeSession('x1');
    await vi.waitFor(() => expect(asking.q).not.toBeNull());
    expect(asking.q!.text).toMatch(/^nas is not answering\. /);
    answered('');
    await closing;
    expect(calls).toContain('DELETE /api/terminal/sessions/x1?force=1');
    expect(terms.list).toEqual([]);
  });

  it('no is a quiet stop: kept, and nothing to say', async () => {
    terms.list = [{ id: 'x2' } as never];
    const calls = refuse('not_ended', 'tmux did not end.');
    const closing = closeSession('x2').catch((e: { code: string; message: string }) => e);
    await vi.waitFor(() => expect(asking.q).not.toBeNull());
    answered(null);
    expect(await closing).toMatchObject({ code: 'step_up_cancelled', message: '' });
    expect(calls.some((c) => c.includes('force=1'))).toBe(false);
    expect(terms.list.map((x) => x.id)).toEqual(['x2']);
  });

  it('any other refusal is the error it is, nothing asked', async () => {
    refuse('forbidden', 'Not yours.');
    await expect(closeSession('x3')).rejects.toMatchObject({ code: 'forbidden' });
    expect(asking.q).toBeNull();
  });
});
