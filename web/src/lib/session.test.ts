import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@burrow/shared';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { deviceName, onAccountChange, refreshSession, session, setSession, syncDirectRoute } = await import('./session.svelte.js');
const { put } = await import('./api.js');

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const as = (id: number | null) => ({ setupRequired: false, user: id === null ? null : { id, username: `u${id}` } }) as unknown as AuthState;

afterEach(() => vi.unstubAllGlobals());

describe('the signed-in state', () => {
  it("another account, or none, clears what the last one kept; the same account again does not (AUDIT2 WEB-01)", () => {
    const cleared: string[] = [];
    onAccountChange(() => cleared.push('kept'));
    setSession(as(1));
    expect(cleared).toEqual([]);
    setSession(as(1));
    expect(cleared).toEqual([]);
    expect(session.state?.user?.id).toBe(1);
    setSession(as(null));
    expect(cleared).toEqual(['kept']);
    setSession(as(2));
    // From nobody to someone: nothing of anyone's to clear.
    expect(cleared).toEqual(['kept']);
    setSession(as(3));
    expect(cleared).toEqual(['kept', 'kept']);
  });

  it('a save still waiting when another account signs in does not go out (AUDIT2 WEB-02)', async () => {
    setSession(as(5));
    let release!: () => void;
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      if (sent.length === 1) await new Promise<void>((r) => (release = r));
      return json({});
    }));
    const first = put('/api/settings/ui', { a: 1 });
    const second = put('/api/settings/ui', { a: 2 }).catch((e: { code: string }) => e.code);
    await new Promise((r) => setTimeout(r, 0));
    setSession(as(6));
    release();
    await first;
    expect(await second).toBe('signed_out');
    expect(sent).toEqual(['{"a":1}']);
  });

  it("is read from the server and kept", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(as(7))));
    expect((await refreshSession()).user?.id).toBe(7);
    expect(session.state?.user?.id).toBe(7);
  });

  it('in a browser (no app): no direct route to sync, nothing asked', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await syncDirectRoute();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a new passkey's name", () => {
  it('the system and the browser, from the user agent', () => {
    const named = (ua: string) => {
      vi.stubGlobal('navigator', { userAgent: ua });
      return deviceName();
    };
    expect(named('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Android | Chrome');
    expect(named('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iOS | Safari');
    expect(named('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Mac | Firefox');
    expect(named('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Windows | Edge');
    expect(named('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('Linux | Chrome');
    expect(named('curl/8.0')).toBe('Device');
  });
});
