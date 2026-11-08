import { describe, expect, it } from 'vitest';
import { notesLabel } from './notescount.js';

describe('what is new over several updates', () => {
  it('says how many of the updates have notes when not all do (report 2fe705)', () => {
    // 18 updates, ollama without notes: "17 updates" read as a miscount.
    expect(notesLabel(17, 18)).toEqual({ key: 'changelog.openSome', n: 17, total: 18 });
  });
  it('says the number alone when every update has notes', () => {
    expect(notesLabel(5, 5)).toEqual({ key: 'changelog.openAll', n: 5, total: 5 });
  });
});
