import { describe, expect, it } from 'vitest';
import { cellCount, ordered, rangeText, wordAt, type CellLine, type Lines } from './termselect.js';

// Lines as xterm keeps them: [text, wrapped onto from the line before].
const lines = (rows: [string, boolean][]): Lines => ({
  getLine: (row) => {
    const r = rows[row];
    return r && { isWrapped: r[1], translateToString: (_trim, start = 0, end = r[0].length) => r[0].slice(start, end) };
  },
});

describe('selecting with a finger', () => {
  it('puts the ends in reading order, whichever came first', () => {
    const a = { col: 5, row: 2 };
    const b = { col: 1, row: 1 };
    expect(ordered(a, b)).toEqual({ from: b, to: a });
    expect(ordered(b, a)).toEqual({ from: b, to: a });
    expect(ordered({ col: 7, row: 3 }, { col: 2, row: 3 })).toEqual({ from: { col: 2, row: 3 }, to: { col: 7, row: 3 } });
  });

  it('counts the cells as xterm selects them, both ends in', () => {
    expect(cellCount({ from: { col: 2, row: 0 }, to: { col: 2, row: 0 } }, 80)).toBe(1);
    expect(cellCount({ from: { col: 78, row: 0 }, to: { col: 1, row: 1 } }, 80)).toBe(4);
  });

  it('takes the word under the finger, not the spaces around it', () => {
    const line = cells('ls -la /var/log  done');
    expect(wordAt(line, 9)).toEqual({ from: 7, to: 14 });
    expect(wordAt(line, 0)).toEqual({ from: 0, to: 1 });
    expect(wordAt(line, 20)).toEqual({ from: 17, to: 20 });
    // Just past a word (a finger is not that precise): that word too.
    expect(wordAt(line, 15)).toEqual({ from: 7, to: 15 });
    // Just before a word: that word too.
    expect(wordAt(line, 16)).toEqual({ from: 16, to: 20 });
    expect(wordAt(cells('a   b'), 2)).toEqual({ from: 2, to: 2 });
  });

  it('joins a wrapped line, keeps a real line break, drops spaces at line ends', () => {
    const l = lines([
      ['$ echo a-very-long-', false],
      ['word   ', true],
      ['second line   ', false],
    ]);
    expect(rangeText(l, { from: { col: 2, row: 0 }, to: { col: 13, row: 2 } }, 20)).toBe('echo a-very-long-word\nsecond line');
    // Part of one line.
    expect(rangeText(l, { from: { col: 7, row: 2 }, to: { col: 10, row: 2 } }, 20)).toBe('line');
  });

  it('counts in cells, not in letters: wide characters take two, a combining mark none (AUDIT2 TERM-16)', () => {
    // ls, three CJK characters, .txt: each of the three takes two cells, so .txt starts at column 9.
    const line = cells('ls \u65e5\u672c\u8a9e.txt x');
    expect(wordAt(line, 5)).toEqual({ from: 3, to: 12 });
    expect(wordAt(line, 4)).toEqual({ from: 3, to: 12 });
    expect(wordAt(line, 14)).toEqual({ from: 14, to: 14 });
    // An emoji (two cells) before the word, a letter with a combining accent in it (one cell).
    expect(wordAt(cells('\u{1F600} cafe\u0301 x'), 4)).toEqual({ from: 3, to: 6 });
  });
});

/** A line as xterm's cells: a wide character takes two (the second of width 0), a combining mark joins the letter before. */
function cells(text: string): CellLine {
  const out: { chars: string; width: number }[] = [];
  for (const ch of text) {
    if (/\p{M}/u.test(ch)) {
      out[out.length - 1]!.chars += ch;
      continue;
    }
    const wide = /[\u3000-\u9fff\u{1F300}-\u{1FAFF}]/u.test(ch);
    out.push({ chars: ch, width: wide ? 2 : 1 });
    if (wide) out.push({ chars: '', width: 0 });
  }
  return { length: out.length, getCell: (x) => (out[x] ? { getChars: () => out[x]!.chars, getWidth: () => out[x]!.width } : undefined) };
}

