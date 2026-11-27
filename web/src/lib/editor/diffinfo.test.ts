import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { chunkAt, deletedLines, diffSummary, markKind, markPlaces } from './diffinfo.js';

// Comparing two files said at once where they differ and how much (user, 2026-10-23, as VS Code):
// the places, the lines added and removed, and marks along the scrollbar.
describe('diff information', () => {
  // Files end with a line break, as files do.
  const a = Text.of(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', '']);
  const b = Text.of(['one', 'TWO', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', '']);
  const chunks = Chunk.build(a, b);

  it('the places that differ, the lines added and removed', () => {
    expect(diffSummary(chunks, a, b)).toEqual({ places: 2, added: 3, removed: 1 });
    expect(diffSummary(Chunk.build(a, a), a, a)).toEqual({ places: 0, added: 0, removed: 0 });
  });

  it('where each place is along the newer file (0 at the top, 1 at the end)', () => {
    const p = markPlaces(chunks, b);
    expect(p).toHaveLength(2);
    expect(p[0]!).toBeCloseTo(1 / b.lines, 2);
    expect(p[1]!).toBeCloseTo(10 / b.lines, 2);
  });

  it("what kind of place each is, its mark coloured so (as VS Code's ruler): lines changed, added, removed", () => {
    expect(chunks.map(markKind)).toEqual(['changed', 'added']);
    const gone = Text.of(['one', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', '']);
    expect(Chunk.build(a, gone).map(markKind)).toEqual(['removed']);
  });

  it('which place the cursor is in or after', () => {
    expect(chunkAt(chunks, 0)).toBe(-1);
    expect(chunkAt(chunks, b.line(2).from)).toBe(0);
    expect(chunkAt(chunks, b.line(5).from)).toBe(0);
    expect(chunkAt(chunks, b.line(11).from)).toBe(1);
  });

  it("one column: the older file's numbers of the lines gone, beside them (asked 2026-11-17)", () => {
    const old = Text.of(['one', 'two', 'three', 'four', 'five', '']);
    const now = Text.of(['one', 'four', 'FIVE', '']);
    const c = Chunk.build(old, now);
    // two and three gone: shown above "four", numbered 2 and 3; five changed: its old line numbered 5.
    expect(deletedLines(c, old, now.line(2).from)).toEqual({ first: 2, count: 2 });
    expect(deletedLines(c, old, now.line(3).from)).toEqual({ first: 5, count: 1 });
    // Nothing gone there, or only lines added: no numbers.
    expect(deletedLines(c, old, 0)).toBeNull();
    expect(deletedLines(chunks, a, b.line(11).from)).toBeNull();
  });
});
