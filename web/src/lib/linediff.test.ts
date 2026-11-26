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

  it('applied to the old text the changes give the new one', () => {
    const a = 'one\ntwo\nthree\nfour\nfive';
    const b = 'one\n2\nthree\nfour and more\nsix\nfive';
    let out = '';
    let at = 0;
    for (const c of lineFirstDiff(a, b)) {
      out += a.slice(at, c.fromA) + b.slice(c.fromB, c.toB);
      at = c.toA;
    }
    expect(out + a.slice(at)).toBe(b);
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

  it('two large files that differ everywhere: an answer in bounded time, not a hung tab', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'a'.repeat(i % 80)}`).join('\n');
    const b = Array.from({ length: 20_000 }, (_, i) => (i % 3 ? `line ${i} ${'a'.repeat(i % 80)}` : `changed ${i} ${'b'.repeat(i % 70)}`)).join('\n');
    const t0 = performance.now();
    lineFirstDiff(a, b);
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});
