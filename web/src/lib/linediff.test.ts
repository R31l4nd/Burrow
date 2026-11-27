import { describe, expect, it } from 'vitest';
import { lineFirstDiff } from './linediff.js';

// Two files compared as people read them: line by line, then within a changed line.
const unchanged = (a: string, b: string, changes: ReturnType<typeof lineFirstDiff>, line: string) => {
  const at = a.indexOf(line);
  return changes.every((c) => c.toA <= at || c.fromA >= at + line.length);
};
// A key of its own per line and side, as two .env files with other secrets have: little in common.
const key = (n: number, side: string) => Array.from({ length: 100 }, (_, i) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(n * 7919 + i * 104729 + side.charCodeAt(0) * 31) % 62]).join('');

describe('a comparison line by line first', () => {
  it('lines the same in both are unchanged, also among long changed lines: the whole file read as one change (report b11968)', () => {
    const a = ['# GENERAL', "PUID='1000'", "PGID='1000'", ...Array.from({ length: 40 }, (_, i) => `KEY_${i}='${key(i, 'a')}'`), "TZ='Europe/Amsterdam'"].join('\n');
    const b = ['# ===== ALGEMEEN =====', "PUID='1000'", "PGID='1000'", ...Array.from({ length: 40 }, (_, i) => `KEY_${i}='${key(i, 'b')}'`), "TZ='Europe/Amsterdam'"].join('\n');
    const changes = lineFirstDiff(a, b);
    for (const line of ["PUID='1000'", "PGID='1000'", "TZ='Europe/Amsterdam'"]) expect(unchanged(a, b, changes, line), line).toBe(true);
    // A changed line: only what differs in it, not the whole line ("# " is the same in both).
    expect(changes.filter((c) => c.fromA < a.indexOf('\n')).every((c) => c.fromA >= 2)).toBe(true);
  });

  it('two values with nothing in common (other keys): what differs marked as one, not scattered pieces that happen to match; the same start and end left out (report b11968)', () => {
    // Two keys drawn at random (a seeded generator: the same every run).
    const random = (seed: number) => {
      let x = seed;
      return Array.from({ length: 100 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[((x = (x * 1103515245 + 12345) % 2 ** 31) >> 8) % 62]).join('');
    };
    const a = `PORT=1\nAPI_KEY='Q${random(1)}Z'\nUSER=demo`;
    const b = `PORT=1\nAPI_KEY='R${random(2)}Y'\nUSER=demo`;
    const changes = lineFirstDiff(a, b);
    expect(changes).toHaveLength(1);
    const start = a.indexOf("API_KEY='") + "API_KEY='".length;
    expect(changes[0]!.fromA).toBe(start);
    expect(changes[0]!.toA).toBe(start + 102);
    // A small change in a line still marked as just that.
    const small = lineFirstDiff("EMAIL_PORT='587'", "EMAIL_PORT='465'");
    expect(small.map((c) => "EMAIL_PORT='587'".slice(c.fromA, c.toA)).join('')).toBe('587');
  });

  it('applied to the old text the changes give the new one: lines changed, added, removed, at the start and the end, line against line', () => {
    const cases: [string, string][] = [
      ['one\ntwo\nthree\nfour\nfive', 'one\n2\nthree\nfour and more\nsix\nfive'],
      ['x\n1\n2\n3\ny', 'x\n1a\n2b\n3c\ny'],
      ['a\nb\nc', 'a\nB\nC'],
      ['a\nb\nc\n', 'z\na\nb\nc\nd\n'],
      ['a\na\na\nb', 'a\nb\na\na'],
      ['', 'new\nfile'],
      ['old\nfile', ''],
    ];
    for (const [a, b] of cases) {
      let out = '';
      let at = 0;
      for (const c of lineFirstDiff(a, b)) {
        out += a.slice(at, c.fromA) + b.slice(c.fromB, c.toB);
        at = c.toA;
      }
      expect(out + a.slice(at), JSON.stringify([a, b])).toBe(b);
    }
  });

  it('a large file with changes here and there: each found, quickly (the tab hung on large files, report 2de305)', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'a'.repeat(i % 80)}`).join('\n');
    const b = Array.from({ length: 20_000 }, (_, i) => (i % 67 ? `line ${i} ${'a'.repeat(i % 80)}` : `line ${i} changed`)).join('\n');
    const t0 = performance.now();
    const changes = lineFirstDiff(a, b);
    expect(performance.now() - t0).toBeLessThan(2000);
    // 299 lines changed, each its own place (not one change over the file).
    expect(changes.length).toBeGreaterThanOrEqual(299);
    expect(changes.every((c) => c.toA - c.fromA < 200)).toBe(true);
  });

  it('many places with long lines that differ: within changed lines only as long as there is time, the whole answer bounded (report 2de305)', () => {
    // Random-looking long lines, a block of them changed every few lines: each block's own comparison is slow.
    const noise = (n: number) => Array.from({ length: 300 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(n * 7919 + i * 104729 + ((n * i) % 13)) % 36]).join('');
    const a = Array.from({ length: 6000 }, (_, i) => (i % 31 === 0 ? 'same ' + i : noise(i))).join('\n');
    const b = Array.from({ length: 6000 }, (_, i) => (i % 31 === 0 ? 'same ' + i : noise(i + 100_000))).join('\n');
    const t0 = performance.now();
    const changes = lineFirstDiff(a, b);
    expect(performance.now() - t0).toBeLessThan(1500);
    // Every changed block found, the same lines between them unchanged.
    expect(changes.length).toBeGreaterThanOrEqual(190);
  });

  it('the same two texts asked again (the count, the view, a switch to one column): the answer kept, not worked out again', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'a'.repeat(i % 80)}`).join('\n');
    const b = Array.from({ length: 20_000 }, (_, i) => (i % 3 ? `line ${i} ${'a'.repeat(i % 80)}` : `changed ${i}`)).join('\n');
    const first = lineFirstDiff(a, b);
    const t0 = performance.now();
    expect(lineFirstDiff(a, b)).toBe(first);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('a large file with many changed lines: each one found, not the whole file read as one change (report 2de305)', () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `line ${i + 1}`).join('\n');
    const b = Array.from({ length: 30_000 }, (_, i) => (String(i + 1).endsWith('7') ? `line ${i + 1} changed` : `line ${i + 1}`)).join('\n');
    const t0 = performance.now();
    const changes = lineFirstDiff(a, b);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(changes.length).toBe(3000);
    expect(changes.every((c) => c.toB - c.fromB === ' changed'.length && c.toA === c.fromA)).toBe(true);
  });

  it('two large files that differ everywhere: an answer in bounded time, not a hung tab', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'a'.repeat(i % 80)}`).join('\n');
    const b = Array.from({ length: 20_000 }, (_, i) => (i % 3 ? `line ${i} ${'a'.repeat(i % 80)}` : `changed ${i} ${'b'.repeat(i % 70)}`)).join('\n');
    const t0 = performance.now();
    lineFirstDiff(a, b);
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});
