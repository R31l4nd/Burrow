import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { changeGutter, changeMarks, savedText, setSaved } from './changes.js';

describe('changes since the save', () => {
  const state = () => EditorState.create({ doc: 'one\ntwo\nthree\nfour', extensions: [changeGutter] });

  it('marks added, changed and deleted lines', () => {
    let s = state();
    expect(changeMarks(s)).toEqual([]);
    // "two" changed, a line added after "three", "four" deleted.
    s = s.update({ changes: [{ from: 4, to: 7, insert: 'TWO' }, { from: 13, to: 18, insert: '\nnew' }] }).state;
    expect(s.doc.toString()).toBe('one\nTWO\nthree\nnew');
    const marks = changeMarks(s);
    expect(marks).toContainEqual({ line: 2, kind: 'mod' });
    expect(marks.some((m) => m.line === 4)).toBe(true);
    expect(marks.find((m) => m.line === 1)).toBeUndefined();
  });

  it('starts over from what was saved', () => {
    let s = state().update({ changes: { from: 0, insert: 'zero\n' } }).state;
    expect(changeMarks(s)).toEqual([{ line: 1, kind: 'add' }]);
    s = s.update({ effects: setSaved.of(s.doc.toString()) }).state;
    expect(changeMarks(s)).toEqual([]);
    expect(savedText(s)).toBe('zero\none\ntwo\nthree\nfour');
  });

  it('lines only deleted: marked where they were, on the line after them', () => {
    const s = state().update({ changes: { from: 4, to: 8 } }).state;
    expect(s.doc.toString()).toBe('one\nthree\nfour');
    expect(changeMarks(s)).toEqual([{ line: 2, kind: 'del' }]);
  });

  it('several lines added at once are each marked', () => {
    const s = state().update({ changes: { from: 8, insert: 'a\nb\nc\n' } }).state;
    expect(changeMarks(s)).toEqual([
      { line: 3, kind: 'add' },
      { line: 4, kind: 'add' },
      { line: 5, kind: 'add' },
    ]);
  });
});


describe('changes since the save of a file with Windows line ends', () => {
  it('marks nothing on the saved text itself', () => {
    let s = EditorState.create({ doc: 'one\ntwo', extensions: [changeGutter] });
    s = s.update({ effects: setSaved.of('one\r\ntwo') }).state;
    expect(changeMarks(s)).toEqual([]);
  });
});
