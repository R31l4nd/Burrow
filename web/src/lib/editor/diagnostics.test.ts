import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { fromBurrow, mapThrough } from './diagnostics.js';

describe("one source's diagnostics", () => {
  it('move with an edit before them, so another source updating does not put them back (AUDIT2 TERM-12)', () => {
    const s = EditorState.create({ doc: 'FROM x\nRUN y\n' });
    const marked = [{ from: 7, to: 12, severity: 'warning' as const, message: 'RUN' }];
    // Two lines typed above it.
    const tr = s.update({ changes: { from: 0, insert: 'A\nB\n' } });
    const moved = mapThrough(marked, tr.changes);
    expect(tr.state.doc.sliceString(moved[0]!.from, moved[0]!.to)).toBe('RUN y');
  });
});

describe("Burrow's own diagnostics (hadolint, compose)", () => {
  it('lines and columns from 1 as ranges to the end of the line; past the end held to the last line; the code before the words', () => {
    const view = { state: EditorState.create({ doc: 'FROM x\nRUN apt-get install y\n' }) } as never;
    const [a, b, c, d] = fromBurrow(view, [
      { line: 2, column: 5, severity: 'warning', source: 'hadolint', code: 'DL3008', message: 'Pin versions' },
      { line: 1, column: 1, severity: 'error', source: 'compose', message: 'bad' },
      { line: 99, column: 1, severity: 'info', source: 'compose', message: 'far' },
      { line: 1, column: 50, severity: 'info', source: 'compose', message: 'wide' },
    ] as never);
    expect([a!.from, a!.to, a!.message]).toEqual([11, 28, 'DL3008: Pin versions']);
    expect([b!.from, b!.to, b!.message, b!.severity]).toEqual([0, 6, 'bad', 'error']);
    // The last line is the empty one after the last line break.
    expect([c!.from, c!.to]).toEqual([29, 29]);
    expect([d!.from, d!.to]).toEqual([6, 6]);
  });
});
