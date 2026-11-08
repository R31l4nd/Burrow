import { EditorSelection, EditorState } from '@codemirror/state';
import { search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { describe, expect, it } from 'vitest';
import { matchCount } from './searchcount.js';

// Finding in a file said how often the text is there and which one is chosen (report dc29b4).
describe('matchCount', () => {
  const withQuery = (doc: string, q: string, at?: [number, number], opts: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) => {
    let s = EditorState.create({ doc, extensions: [search()], ...(at ? { selection: EditorSelection.single(at[0], at[1]) } : {}) });
    s = s.update({ effects: setSearchQuery.of(new SearchQuery({ search: q, ...opts })) }).state;
    return s;
  };

  it('how many, and which one the selection is', () => {
    expect(matchCount(withQuery('a foo b foo c foo', 'foo'))).toEqual({ current: 0, total: 3, more: false });
    expect(matchCount(withQuery('a foo b foo c foo', 'foo', [8, 11]))).toEqual({ current: 2, total: 3, more: false });
    expect(matchCount(withQuery('a foo b', 'bar'))).toEqual({ current: 0, total: 0, more: false });
  });

  it('nothing to find, or a broken expression: no count', () => {
    expect(matchCount(withQuery('abc', ''))).toBeNull();
    expect(matchCount(withQuery('abc', '(', undefined, { regexp: true }))).toBeNull();
  });

  it('stops counting at a bound in a huge file', () => {
    const r = matchCount(withQuery('x '.repeat(20_000), 'x'))!;
    expect(r.total).toBe(10_000);
    expect(r.more).toBe(true);
  });
});
