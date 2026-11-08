import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In the Android app: the page talks to the app through its bridge
// (BurrowAndroid). A stand-in app answers each call as the app does and
// keeps what it was asked; what is checked is what the page asks of it and
// what it tells Burrow.
const app = vi.hoisted(() => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const answers: Record<string, (p: Record<string, unknown>) => unknown> = {};
  const store = new Map<string, string>([
    ['burrow.locale', 'en'],
    ['burrow.terminal', '{"fontSize":16}'],
  ]);
  const port = {
    onmessage: null as ((e: { data: string }) => void) | null,
    postMessage(raw: string) {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method, params });
      let result: unknown = null;
      let error: string | undefined;
      try {
        result = answers[method]?.(params) ?? null;
      } catch (e) {
        error = (e as Error).message;
      }
      setTimeout(() => port.onmessage?.({ data: JSON.stringify(error ? { id, error } : { id, result }) }), 0);
    },
  };
  const location = { hash: '', href: '', protocol: 'http:', host: 'burrow.test' };
  Object.assign(globalThis, {
    BurrowAndroid: port,
    document: { documentElement: { lang: 'en' }, hidden: false },
    location,
    window: { addEventListener() {} },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) Chrome/130.0 Mobile', language: 'en' }, configurable: true });
  const event = (name: string, data: unknown) => port.onmessage?.({ data: JSON.stringify({ event: name, data }) });
  return { calls, answers, store, event, location };
});

const { android, androidInfo, nativeSource, refreshAndroidInfo, syncWidgetKey } = await import('./android.js');
const { checkAppUpdate, installAppUpdate } = await import('./appupdate.svelte.js');
const { nativeDownloads, percentOf, retryDownload, stopDownload } = await import('./downloads.svelte.js');
const { checkPush, push, pushEndpoint, pushOff, pushOn } = await import('./push.svelte.js');
const { loadAll } = await import('./data.svelte.js');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = () => new Promise((r) => setTimeout(r, 5));
const called = (method: string) => app.calls.filter((c) => c.method === method);

/** A stand-in Burrow: the push devices it has, and what was asked of it. */
let devices: { id: number }[] = [];
let asked: string[] = [];
beforeEach(() => {
  asked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const m = init?.method ?? 'GET';
    asked.push(`${m} ${url}${init?.body ? ` ${init.body}` : ''}`);
    if (url === '/api/push/devices' && m === 'GET') return json(devices);
    if (url === '/api/push/devices' && m === 'POST') return json({ id: 41, kind: 'unifiedpush', label: 'x' });
    if (url === '/api/push/key') return json({ publicKey: 'BKEY' });
    if (url === '/api/android') return json({ apk: { versionName: '2.1.0', versionCode: 20100, sha256: 'ab', size: 1 } });
    if (url.startsWith('/api/push/devices/') && m === 'DELETE') return new Response(null, { status: 204 });
    return json([]);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the bridge at the start', () => {
  it("says hello at once, and hands the app this device's language and terminal settings for the direct route", async () => {
    await settle();
    expect(android).not.toBeNull();
    expect(called('hello')).toHaveLength(1);
    expect(called('uiPrefs')[0]!.params).toEqual({ values: { 'burrow.locale': 'en', 'burrow.terminal': '{"fontSize":16}' } });
  });

  it("the app's info is asked once and kept; asked again only when told to", async () => {
    app.answers.info = () => ({ version: '2.0.0', versionCode: 20000, qrCamera: true });
    expect((await androidInfo())?.versionCode).toBe(20000);
    await androidInfo();
    expect(called('info')).toHaveLength(1);
    app.answers.info = () => ({ version: '2.1.0', versionCode: 20100 });
    expect((await refreshAndroidInfo())?.versionCode).toBe(20100);
    expect(called('info')).toHaveLength(2);
  });

  it('a file the app holds is read in pieces of at most 1 MiB, and stops at its real end', async () => {
    const reads: number[] = [];
    app.answers.read = (p) => {
      reads.push(Number(p.length));
      return { data: Number(p.offset) >= 1_500_000 ? '' : btoa('x'.repeat(Number(p.length))) };
    };
    const blob = await nativeSource({ token: 't', name: 'v.mp4', mime: 'video/mp4', size: 3 << 20 }).slice(0, 3 << 20);
    expect(reads).toEqual([1 << 20, 1 << 20, 1 << 20]);
    expect(blob.size).toBe(2 << 20);
  });
});

describe('a newer app on this Burrow', () => {
  it('said once per version; nothing when the app is as new', async () => {
    app.answers.info = () => ({ version: '2.0.0', versionCode: 20000 });
    await refreshAndroidInfo();
    expect(await checkAppUpdate()).toBe('2.1.0');
    expect(await checkAppUpdate()).toBeNull();
    app.answers.info = () => ({ version: '2.1.0', versionCode: 20100 });
    await refreshAndroidInfo();
    app.store.delete('burrow.appUpdateTold');
    expect(await checkAppUpdate()).toBeNull();
  });

  it("handed to Android's installer by apps that can; older ones download it", async () => {
    app.answers.installUpdate = () => ({ state: 'installing' });
    const apk = { versionName: '2.1.0', versionCode: 20100, sha256: 'ab12', size: 1 };
    expect(await installAppUpdate(apk, 20000)).toBe('installing');
    expect(called('installUpdate').at(-1)!.params).toEqual({ sha256: 'ab12' });
    expect(await installAppUpdate(apk, 10500)).toBe('download');
    expect(app.location.href).toBe('/api/android/burrow.apk');
  });
});

describe("the app's own downloads", () => {
  it('the list as the app sends it; anything but a list is none', async () => {
    app.event('downloads', [{ id: 1, name: 'a.iso', done: 50, total: 200, state: 'running' }]);
    expect(nativeDownloads.items.map((d) => d.id)).toEqual([1]);
    app.event('downloads', null);
    expect(nativeDownloads.items).toEqual([]);
    expect(percentOf({ done: 50, total: 200 } as never)).toBe(25);
    expect(percentOf({ done: 300, total: 200 } as never)).toBe(100);
    expect(percentOf({ done: 5, total: 0 } as never)).toBeNull();
    stopDownload(1);
    retryDownload(2);
    await settle();
    expect([called('stopDownload').at(-1)!.params, called('retryDownload').at(-1)!.params]).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("Burrow's own push in the app", () => {
  const sub = { url: 'https://ntfy.lan/upX', p256dh: 'P', auth: 'A' };

  it("on: the phone asked with Burrow's key; the address it gives is told to Burrow as this phone", async () => {
    await pushOn();
    expect(called('pushRegister').at(-1)!.params).toEqual({ vapid: 'BKEY' });
    await pushEndpoint(sub);
    const told = JSON.parse(asked.find((a) => a.startsWith('POST /api/push/devices'))!.split(' ').slice(2).join(' ')) as Record<string, string>;
    expect(told).toMatchObject({ kind: 'unifiedpush', label: 'Burrow app | Android', endpoint: sub.url, p256dh: 'P', auth: 'A', lang: 'en' });
    expect(push.on).toBe(true);
    expect(app.store.get('burrow.pushDevice')).toBe('41');
    // The distributor took it back.
    await pushEndpoint(null);
    expect(push.on).toBe(false);
  });

  it('opened again: still known to Burrow, its address told again; removed in Burrow, the app lets go too (AUDIT2 WEB-10)', async () => {
    app.store.set('burrow.pushDevice', '41');
    app.answers.pushState = () => sub;
    devices = [{ id: 41 }];
    await checkPush();
    expect(push.on).toBe(true);
    expect(asked.filter((a) => a.startsWith('POST /api/push/devices'))).toHaveLength(1);

    devices = [];
    const before = called('pushUnregister').length;
    await checkPush();
    expect(push.on).toBe(false);
    expect(called('pushUnregister')).toHaveLength(before + 1);
    expect(app.store.has('burrow.pushDevice')).toBe(false);
    expect(asked.filter((a) => a.startsWith('POST /api/push/devices'))).toHaveLength(1);
  });

  it('off on the phone: nothing to tell; off here: unregistered on the phone and gone from Burrow', async () => {
    app.answers.pushState = () => null;
    await checkPush();
    expect(push.on).toBe(false);
    app.store.set('burrow.pushDevice', '41');
    await pushOff();
    expect(called('pushUnregister').length).toBeGreaterThan(0);
    expect(asked).toContain('DELETE /api/push/devices/41');
    expect(app.store.has('burrow.pushDevice')).toBe(false);
  });
});

describe('home screen shortcuts', () => {
  it('the favourites, then the hosts used last, four at most', async () => {
    const host = (id: number, favorite: boolean, lastUsedAt: string | null) => ({ id, name: `h${id}`, favorite, lastUsedAt });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/hosts' ? [host(1, false, '2026-10-01'), host(2, true, null), host(3, false, null), host(4, false, '2026-10-09'), host(5, true, '2026-01-01'), host(6, false, '2026-10-05')] : url === '/api/host-defaults' ? {} : [])));
    await loadAll();
    await settle();
    expect(called('shortcuts').at(-1)!.params).toEqual({ hosts: [{ id: 2, name: 'h2' }, { id: 5, name: 'h5' }, { id: 4, name: 'h4' }, { id: 6, name: 'h6' }] });
  });
});

describe("the widget's own key", () => {
  it('told to Burrow for this paired phone, only by an app that has one; a refusal is quiet', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const put = async (url: string, body: unknown) => void sent.push({ url, body });
    app.answers.widgetKey = () => ({ publicKey: 'MFkwEw' });
    app.answers.info = () => ({ version: '2.12.0', versionCode: 21200, deviceId: 7, widget: true });
    await refreshAndroidInfo();
    expect(await syncWidgetKey(put)).toBe(true);
    expect(sent).toEqual([{ url: '/api/account/devices/7/widget-key', body: { publicKey: 'MFkwEw' } }]);
    // Not paired, or an app without a widget: nothing asked, nothing sent.
    app.answers.info = () => ({ version: '2.12.0', versionCode: 21200, deviceId: null, widget: true });
    await refreshAndroidInfo();
    expect(await syncWidgetKey(put)).toBe(false);
    app.answers.info = () => ({ version: '2.10.0', versionCode: 21000, deviceId: 7 });
    await refreshAndroidInfo();
    expect(await syncWidgetKey(put)).toBe(false);
    expect(sent).toHaveLength(1);
    // Burrow refuses (signed in with a password on this phone): false, no error.
    app.answers.info = () => ({ version: '2.12.0', versionCode: 21200, deviceId: 7, widget: true });
    await refreshAndroidInfo();
    expect(await syncWidgetKey(async () => Promise.reject(new Error('wrong_device')))).toBe(false);
  });
});

