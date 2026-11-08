import { describe, expect, it, vi } from 'vitest';

// In the Android app a report's picture is the screen as the app shows it, taken by the app ("the
// picture is not the screen I see"); what files, terminals and logs show still covered unless ticked.
// The app, the page and a canvas are stand-ins.
const page = vi.hoisted(() => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const bar = { style: { visibility: '' } };
  const state = { private: [] as ReturnType<typeof box>[], covered: [] as number[][], asked: [] as number[], shot: null as null | (() => Promise<{ picture: string; width: number; height: number }>), barSeen: [] as string[] };
  const el = (r: ReturnType<typeof box>) => ({ getClientRects: () => [r], closest: () => null, getBoundingClientRect: () => r });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      fillRect: (x: number, y: number, w: number, h: number) => state.covered.push([x, y, w, h]),
      fillText() {},
      set fillStyle(_: string) {},
      set font(_: string) {},
      set textAlign(_: string) {},
      set textBaseline(_: string) {},
    }),
    toDataURL: (type: string) => `data:${type};base64,COVERED`,
  };
  Object.assign(globalThis, {
    document: {
      documentElement: { lang: 'en', dataset: {}, scrollHeight: 800, classList: { add() {}, remove() {} } },
      hidden: false,
      styleSheets: [],
      body: { scrollWidth: 412, scrollHeight: 800, style: {}, getBoundingClientRect: () => box(0, 0, 412, 800) },
      querySelectorAll: (sel: string) => (sel === '[data-private]' ? state.private.map(el) : sel === '.bugbar' ? [bar] : []),
      createElement: () => canvas,
      createTreeWalker: () => ({ nextNode: () => null }),
      createRange: () => ({}),
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(1, 2, 3)', getPropertyValue: () => '' }),
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    Image: class {
      src = '';
      naturalWidth = 824;
      naturalHeight = 1830;
      decode = () => Promise.resolve();
    },
    location: { hash: '#/hosts', protocol: 'http:', host: 'burrow.test' },
    history: { state: null, replaceState() {} },
    innerWidth: 412,
    innerHeight: 915,
    devicePixelRatio: 2.625,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', language: 'en', onLine: true }, configurable: true });
  return { state, box, bar };
});

vi.mock('./android.js', () => ({
  android: {
    screenshot: (maxWidth: number) => {
      page.state.asked.push(maxWidth);
      page.state.barSeen.push(page.bar.style.visibility);
      return page.state.shot!();
    },
    on() {},
  },
  androidInfo: () => Promise.resolve(null),
}));
vi.mock('modern-screenshot', () => ({
  domToPng: () => Promise.resolve('data:image/png;base64,DRAWN'),
  domToJpeg: () => Promise.resolve('data:image/jpeg;base64,DRAWN'),
}));

const { captureScreen } = await import('./bugreport.svelte.js');

describe("a report's picture in the app", () => {
  it("is the app's own, at most twice the screen's width, without the report's button", async () => {
    page.state.private = [];
    page.state.shot = () => Promise.resolve({ picture: 'data:image/jpeg;base64,SCREEN', width: 824, height: 1830 });
    expect(await captureScreen()).toEqual({ full: 'data:image/jpeg;base64,SCREEN', masked: 'data:image/jpeg;base64,SCREEN', hidden: 0 });
    expect(page.state.asked.at(-1)).toBe(824);
    expect(page.state.barSeen.at(-1)).toBe('hidden');
    expect(page.bar.style.visibility).toBe('');
  });

  it("covers a terminal on it in the picture's pixels", async () => {
    page.state.private = [page.box(0, 100, 412, 500)];
    page.state.covered = [];
    page.state.shot = () => Promise.resolve({ picture: 'data:image/jpeg;base64,SCREEN', width: 824, height: 1830 });
    expect(await captureScreen()).toEqual({ full: 'data:image/jpeg;base64,SCREEN', masked: 'data:image/jpeg;base64,COVERED', hidden: 1 });
    expect(page.state.covered).toEqual([[0, 200, 824, 1000]]);
  });

  it('an app that cannot (before 2.9.2, a failed copy): the page draws its own', async () => {
    page.state.private = [];
    page.state.shot = () => Promise.reject(new Error('unknown method screenshot'));
    expect(await captureScreen()).toEqual({ full: 'data:image/png;base64,DRAWN', masked: 'data:image/png;base64,DRAWN', hidden: 0 });
    expect(page.bar.style.visibility).toBe('');
  });
});
