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

  it("keeps a line of several elements on one line: a name in bold and its pid beside it broke between them in the copy, the pid over the line under it (report 3767a7)", () => {
    type R = ReturnType<typeof line>;
    type El = { name: string; rects: R[]; whiteSpace: string; parentElement: El | null; a: Set<string>; setAttribute: (n: string) => void; removeAttribute: (n: string) => void };
    type Text = { parentElement: El; nodeValue: string; rects: R[] };
    // An element's range has its children's boxes in it too (a tall button's), a text's only its lines.
    const make = (name: string, rects: R[], parentElement: El | null = null, whiteSpace = 'normal'): El => {
      const el = { name, rects, whiteSpace, parentElement, a: new Set<string>() } as El;
      el.setAttribute = (n) => void el.a.add(n);
      el.removeAttribute = (n) => void el.a.delete(n);
      return el;
    };
    const root = make('root', [line(0), line(500)]);
    // A process: its line (name, pid) one line, the command line under it.
    const proc = make('proc', [line(100), line(120)], root);
    const pname = make('pname', [line(100), line(102, 16)], proc);
    const b = make('b', [line(100)], pname);
    const pid = make('pid', [line(102, 16)], pname);
    const cmd = make('cmd', [line(120)], proc);
    // A line kept as written (pre) is not marked, nor what holds it.
    const keep = make('keep', [line(200)], root, 'pre');
    const inPre = make('inPre', [line(200)], keep, 'pre');
    // A 40 px button beside a paragraph over two lines: the row is not one line (audit 2026-11-23:
    // the button's box set the tolerance, the paragraph passed as one line and was drawn so).
    const row = make('row', [line(300, 40), line(300), line(320)], root);
    const button = make('button', [line(300, 40)], row);
    const para = make('para', [line(300), line(320)], row);
    const texts: Text[] = [
      { parentElement: b, nodeValue: 'python3', rects: [line(100)] },
      { parentElement: pname, nodeValue: ' ', rects: [line(100)] },
      { parentElement: pid, nodeValue: 'pid 10 | root', rects: [line(102, 16)] },
      { parentElement: cmd, nodeValue: '/usr/bin/python3 -u -m worker', rects: [line(120)] },
      { parentElement: inPre, nodeValue: 'as written', rects: [line(200)] },
      { parentElement: button, nodeValue: 'Open', rects: [line(310)] },
      { parentElement: para, nodeValue: 'a text wrapping over two lines', rects: [line(300), line(320)] },
    ];
    const under = (t: Text, el: El) => {
      for (let x: El | null = t.parentElement; x; x = x.parentElement) if (x === el) return true;
      return false;
    };
    let range: El | Text | null = null;
    const measured: string[] = [];
    Object.assign(g, {
      document: {
        createTreeWalker: (at: El) => {
          const list = texts.filter((t) => under(t, at));
          let i = 0;
          return { nextNode: () => list[i++] ?? null };
        },
        createRange: () => ({ selectNodeContents: (x: El | Text) => ((range = x), 'name' in x && measured.push(x.name)), getClientRects: () => range!.rects }),
      },
      getComputedStyle: (el: El) => ({ whiteSpace: el.whiteSpace }),
    });
    const unmark = markLines(root as unknown as Element, () => false);
    expect([proc, pname, b, pid, cmd, keep, inPre, row, button, para].filter((x) => x.a.has(ONE_LINE)).map((x) => x.name)).toEqual(['pname', 'b', 'pid', 'cmd', 'button']);
    // Each element measured once, the root never (it is the page).
    expect(measured.filter((n, i) => measured.indexOf(n) !== i)).toEqual([]);
    expect(measured).not.toContain('root');
    unmark();
    expect([pname, b, pid, cmd, button].some((x) => x.a.has(ONE_LINE))).toBe(false);
  });
});
