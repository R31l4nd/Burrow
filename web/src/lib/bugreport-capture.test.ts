import { describe, expect, it, vi } from 'vitest';

// The picture a problem report takes: what files, terminals and logs show
// covered in the one sent unless the person ticks it (report 50a6f6: a whole
// .env readable in a report's picture). The page is a stand-in: the parts
// marked private, the library that draws it, a canvas that records.
const page = vi.hoisted(() => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const state = { private: [] as ReturnType<typeof box>[], drawn: [] as string[], covered: [] as number[][] };
  const el = (r: ReturnType<typeof box>) => ({ getClientRects: () => [r], closest: () => null, getBoundingClientRect: () => r });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => state.drawn.push('picture'),
      fillRect: (x: number, y: number, w: number, h: number) => state.covered.push([x, y, w, h]),
      fillText: (text: string) => state.drawn.push(text),
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
      body: { scrollWidth: 1280, scrollHeight: 800, style: {}, getBoundingClientRect: () => box(0, 0, 1280, 800) },
      querySelectorAll: (sel: string) => (sel === '[data-private]' ? state.private.map(el) : []),
      createElement: () => canvas,
      createTreeWalker: () => ({ nextNode: () => null }),
      createRange: () => ({}),
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(1, 2, 3)', getPropertyValue: (name: string) => (name === '--bg-sunken' ? '#ddd' : '') }),
    Image: class {
      src = '';
      naturalWidth = 2560;
      naturalHeight = 1600;
      decode = () => Promise.resolve();
    },
    location: { hash: '#/hosts', protocol: 'http:', host: 'burrow.test' },
    history: { state: null, replaceState() {} },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', language: 'en', onLine: true }, configurable: true });
  return { state, box };
});

vi.mock('modern-screenshot', () => ({
  domToPng: () => Promise.resolve('data:image/png;base64,AS-IT-WAS'),
  domToJpeg: () => Promise.resolve('data:image/jpeg;base64,AS-IT-WAS'),
}));

const { captureScreen } = await import('./bugreport.svelte.js');

describe("a report's picture (report 50a6f6)", () => {
  it('nothing private on the screen: one picture, nothing covered', async () => {
    page.state.private = [];
    expect(await captureScreen()).toEqual({ full: 'data:image/png;base64,AS-IT-WAS', masked: 'data:image/png;base64,AS-IT-WAS', hidden: 0 });
  });

  it("an editor on the screen: the picture sent by default has its box covered, in the picture's pixels, and says so", async () => {
    page.state.private = [page.box(100, 50, 600, 400)];
    page.state.covered = [];
    page.state.drawn = [];
    const shot = await captureScreen();
    expect(shot).toEqual({ full: 'data:image/png;base64,AS-IT-WAS', masked: 'data:image/png;base64,COVERED', hidden: 1 });
    // Twice the page's size (the screen's density): the box twice as big, from twice as far.
    expect(page.state.covered).toEqual([[200, 100, 1200, 800]]);
    expect(page.state.drawn).toEqual(['picture', 'Hidden in the report']);
  });
});
