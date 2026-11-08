import { setDiagnostics } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { problemLines, problemNumbers } from './problems.js';

describe('problems on the line numbers', () => {
  const state = () => EditorState.create({ doc: 'one\ntwo\nthree\nfour', extensions: [problemNumbers] });

  it('marks each line with a problem once, by its worst one; gone with the problems', () => {
    let s = state();
    expect(problemLines(s)).toEqual([]);
    s = s.update(
      setDiagnostics(s, [
        { from: 4, to: 7, severity: 'warning', message: 'a' },
        { from: 5, to: 6, severity: 'error', message: 'b' },
        { from: 14, to: 18, severity: 'info', message: 'c' },
      ]),
    ).state;
    expect(problemLines(s)).toEqual([
      { line: 2, severity: 'error' },
      { line: 4, severity: 'info' },
    ]);
    s = s.update(setDiagnostics(s, [])).state;
    expect(problemLines(s)).toEqual([]);
  });

  it('follows its line as text is added above it', () => {
    let s = state();
    s = s.update(setDiagnostics(s, [{ from: 8, to: 13, severity: 'error', message: 'x' }])).state;
    s = s.update({ changes: { from: 0, insert: 'zero\n' } }).state;
    expect(problemLines(s)).toEqual([{ line: 4, severity: 'error' }]);
  });
});
