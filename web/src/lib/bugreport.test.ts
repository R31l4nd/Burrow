import { afterEach, describe, expect, it, vi } from 'vitest';

// What a problem report sends along besides its text and pictures: shown in
// the form before sending, so nothing goes unseen. Never the phone's file
// names, only on a terminal its debug state; the page's last errors.
const page = vi.hoisted(() => {
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const location = { hash: '#/files/phone?p=%2Fabc%2Fsecret-name.txt', protocol: 'http:', host: 'burrow.test' };
  Object.assign(globalThis, {
    document: { documentElement: { lang: 'en', dataset: {} }, hidden: false },
    location,
    history: { state: null, replaceState() {} },
    innerWidth: 412,
    innerHeight: 915,
    devicePixelRatio: 2.625,
    window: {
      addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Linux; Android 15) test', language: 'en', onLine: true }, configurable: true });
  const fire = (type: string, e: unknown) => handlers.get(type)?.forEach((f) => f(e));
  return { fire, location };
});

const { bug, bugContext, hiddenAreas, MAX_SHOT_HEIGHT, rowsInWindow, sendReport, setArmed, shotScale, shotWindow, watchErrors } = await import('./bugreport.svelte.js');
const { setSession } = await import('./session.svelte.js');

afterEach(() => vi.unstubAllGlobals());

describe('what goes along with a report', () => {
  it("the page without the phone's file names, the device, the version; no terminal state off a terminal", () => {
    const c = bugContext();
    expect(c.page).toBe('/files/phone');
    expect(c).toMatchObject({ userAgent: 'Mozilla/5.0 (Linux; Android 15) test', viewport: { width: 412, height: 915, dpr: 2.63 }, locale: 'en', android: false, online: true, terminal: null, dialog: null });
    expect(c.theme).toMatch(/^auto\/\w+$/);
    expect(c.timeZone).toMatch(/ [+-]\d\d:\d\d$/);
  });

  it("the page's last errors, thirty at most, each cut short", () => {
    watchErrors();
    page.fire('error', { message: 'x is undefined', filename: 'https://burrow.test/assets/index-abc.js', lineno: 3, colno: 9 });
    page.fire('unhandledrejection', { reason: new Error('load failed') });
    page.fire('unhandledrejection', { reason: 'plain' });
    expect(bugContext().errors).toEqual(['x is undefined (index-abc.js:3:9)', 'Unhandled: load failed', 'Unhandled: plain']);
    for (let i = 0; i < 40; i++) page.fire('error', { message: `e${i} ${'y'.repeat(600)}`, filename: '', lineno: 0, colno: 0 });
    const errors = bugContext().errors;
    expect(errors).toHaveLength(30);
    expect(errors[0]).toMatch(/^e10 /);
    expect(errors[0]!.length).toBe(500);
  });

  it('sent with the context as it is when sent', async () => {
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{"id":"r1"}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    bug.dialog = 'alert-rule';
    expect(await sendReport({ text: 'It broke.', screenshot: null, attachments: [], recording: null })).toBe('r1');
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as { text: string; context: { dialog: string; page: string } };
    expect(body).toMatchObject({ text: 'It broke.', context: { dialog: 'alert-rule', page: '/files/phone' } });
  });

  it("another account at this page: nothing of the last one's report (AUDIT2 WEB-01)", () => {
    setSession({ setupRequired: false, user: { id: 1 } } as never);
    Object.assign(bug, { armed: true, open: true, shot: 'data:image/png;base64,x', shotFull: 'data:image/png;base64,y', hidden: 2, dialog: 'x' });
    setSession({ setupRequired: false, user: { id: 2 } } as never);
    expect(bug).toMatchObject({ armed: false, open: false, shot: null, shotFull: null, hidden: 0, dialog: null, recording: null });
  });
});

describe("the picture's scale", () => {
  it("the screen's own density up to 2, less for a page too long or too wide for a canvas", () => {
    expect(shotScale(400, 900, 3)).toBe(2);
    expect(shotScale(1280, 800, 1)).toBe(1);
    // 30 000 px long: 16 000 px at most on a side.
    expect(shotScale(400, 30_000, 2)).toBeCloseTo(16_000 / 30_000);
    // Twelve million pixels at most.
    expect(shotScale(3000, 3000, 2)).toBeCloseTo(Math.sqrt(12_000_000 / 9_000_000));
  });
});

describe('the part of a very long page in the picture (report 8344c1: a folder of 4000+ files crashed the app)', () => {
  it('all of a page that is not too long; else the part around the screen, within the page', () => {
    expect(shotWindow(5000, 1200, 700)).toEqual({ top: 0, height: 5000 });
    // In the middle of 240 000 px: centred on the screen.
    expect(shotWindow(240_000, 120_000, 700)).toEqual({ top: 120_350 - MAX_SHOT_HEIGHT / 2, height: MAX_SHOT_HEIGHT });
    // At the top and at the bottom: the part starts or ends with the page.
    expect(shotWindow(240_000, 0, 700)).toEqual({ top: 0, height: MAX_SHOT_HEIGHT });
    expect(shotWindow(240_000, 239_300, 700)).toEqual({ top: 240_000 - MAX_SHOT_HEIGHT, height: MAX_SHOT_HEIGHT });
  });
  it('the rows of a long list kept: from the first to the last that touch the part drawn', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ top: i * 50, bottom: i * 50 + 50 }));
    expect(rowsInWindow(rows, { top: 1000, height: 500 })).toEqual({ first: 20, last: 29 });
    expect(rowsInWindow(rows, { top: 1010, height: 500 })).toEqual({ first: 20, last: 30 });
    expect(rowsInWindow(rows, { top: 9000, height: 500 })).toBeNull();
    // A header not drawn (hidden on a phone, at 0 0 as such) says nothing: it kept the whole list.
    expect(rowsInWindow([null, ...rows], { top: 1000, height: 500 })).toEqual({ first: 21, last: 30 });
  });
});

describe('what the picture hides (report 50a6f6: a whole .env readable in it)', () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
  it("each private part's box in the picture's pixels: from the page's corner, times the scale", () => {
    expect(hiddenAreas([box(100, 50, 400, 300)], box(0, -200, 1280, 2000), 2)).toEqual([{ x: 200, y: 500, w: 800, h: 600 }]);
  });
  it('a part out of sight or of no size is left out; one partly outside the page is cut to it', () => {
    expect(hiddenAreas([box(0, 0, 0, 100), box(10, 10, 100, 0)], box(0, 0, 500, 500), 1)).toEqual([]);
    expect(hiddenAreas([box(-50, 450, 200, 200)], box(0, 0, 500, 500), 1)).toEqual([{ x: 0, y: 450, w: 150, h: 50 }]);
  });
});

describe('the report button', () => {
  it('stays on this device until turned off; storage refused, on for this visit only (user 2026-10-30)', () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) });
    setArmed(true);
    expect(bug.armed).toBe(true);
    expect(kept.get('burrow.bugArmed')).toBe('1');
    setArmed(false);
    expect(bug.armed).toBe(false);
    expect(kept.has('burrow.bugArmed')).toBe(false);
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('refused'); }, removeItem() {} });
    setArmed(true);
    expect(bug.armed).toBe(true);
    setArmed(false);
  });
});
