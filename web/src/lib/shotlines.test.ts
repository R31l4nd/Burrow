import { afterEach, describe, expect, it } from 'vitest';
import { keepLine, markLines, ONE_LINE, oneLine } from './shotlines.js';

// A report's picture showed words broken over two lines that stood on one on
// the screen (reports 0d33eb, 71b74a, 71a779: "breakin|g" in Edge at 125 %).
// The page is a stand-in: text nodes with their line boxes as the screen has them.
const line = (top: number, height = 20) => ({ top, bottom: top + height, height });

describe("one line on the screen, one line in a report's picture (report 0d33eb)", () => {
  it('line boxes on one line: also of different heights (a label with padding beside its text); two lines or a block under it are not', () => {
    expect(oneLine([line(100), line(98, 24), line(101, 18)])).toBe(true);
    expect(oneLine([line(100), line(120)])).toBe(false);
    // A block that wraps inside: its box starts on the line, ends two lines lower.
    expect(oneLine([line(100), line(100, 60)])).toBe(false);
    expect(oneLine([line(0, 0)])).toBe(false);
    expect(oneLine([])).toBe(false);
  });

  const g = globalThis as Record<string, unknown>;
  const had = { document: g.document, getComputedStyle: g.getComputedStyle };
  afterEach(() => Object.assign(g, had));

  it('marks what stands on one line, keeps it on one line in the copy, and takes the marks off the page again', () => {
    const attrs = (el: { a: Set<string> }) => ({ setAttribute: (n: string) => el.a.add(n), removeAttribute: (n: string) => el.a.delete(n), hasAttribute: (n: string) => el.a.has(n) });
    const make = (name: string, rects: ReturnType<typeof line>[], whiteSpace = 'normal') => {
      const el = { name, rects, whiteSpace, a: new Set<string>() };
      return Object.assign(el, attrs(el));
    };
    const tag = make('tag', [line(100)]);
    const para = make('para', [line(100), line(120)]);
    const pre = make('pre', [line(200)], 'pre');
    const hidden = make('hidden', [line(300)]);
    const texts = [
      { parentElement: tag, nodeValue: 'breaking' },
      { parentElement: tag, nodeValue: 'again' },
      { parentElement: para, nodeValue: 'a long text over two lines' },
      { parentElement: pre, nodeValue: 'kept as written' },
      { parentElement: hidden, nodeValue: 'left out' },
      { parentElement: null, nodeValue: 'x' },
      { parentElement: make('space', [line(400)]), nodeValue: '  ' },
    ];
    let range: (typeof texts)[number]['parentElement'] = null;
    let seenTag = 0;
    Object.assign(g, {
      document: {
        createTreeWalker: () => {
          let i = 0;
          return { nextNode: () => texts[i++] ?? null };
        },
        createRange: () => ({ selectNodeContents: (el: typeof tag) => ((range = el), el === tag && seenTag++), getClientRects: () => range!.rects }),
      },
      getComputedStyle: (el: typeof tag) => ({ whiteSpace: el.whiteSpace }),
    });
    const unmark = markLines({} as Element, (el) => (el as unknown as typeof tag).name === 'hidden');
    expect([tag, para, pre, hidden].filter((x) => x.a.has(ONE_LINE)).map((x) => x.name)).toEqual(['tag']);
    // An element with two text nodes is measured once.
    expect(seenTag).toBe(1);

    // The copy: the mark off, the line kept; another node (text, unmarked) as it was.
    const style = new Map<string, string>();
    const copy = Object.assign(make('copy', []), { nodeType: 1, style: { setProperty: (n: string, v: string) => style.set(n, v) } });
    copy.a.add(ONE_LINE);
    keepLine(copy as unknown as Node);
    expect(copy.a.has(ONE_LINE)).toBe(false);
    expect(style.get('white-space')).toBe('nowrap');
    const plain = Object.assign(make('plain', []), { nodeType: 1, style: { setProperty: (n: string, v: string) => style.set(`plain ${n}`, v) } });
    keepLine(plain as unknown as Node);
    keepLine({ nodeType: 3 } as Node);
    expect(style.size).toBe(1);

    unmark();
    expect(tag.a.has(ONE_LINE)).toBe(false);
  });
});
