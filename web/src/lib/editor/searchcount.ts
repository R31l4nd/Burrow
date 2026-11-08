import { getSearchQuery } from '@codemirror/search';
import type { EditorState } from '@codemirror/state';

// How often the text found is in the file, and which one is chosen ("3 of 12"), in the find panel:
// CodeMirror's own panel said neither (report dc29b4; VS Code and every browser say both).

/** Counting stops here: a count over a huge file is not worth a pause at every key. */
export const MAX_COUNT = 10_000;

/** The matches of the panel's query, and which one the selection is (1-based, 0: none); null without a query. */
export function matchCount(state: EditorState): { current: number; total: number; more: boolean } | null {
  const q = getSearchQuery(state);
  if (!q.search || !q.valid) return null;
  const sel = state.selection.main;
  const cursor = q.getCursor(state);
  let total = 0;
  let current = 0;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total += 1;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= MAX_COUNT) return { current, total, more: true };
  }
  return { current, total, more: false };
}

export type MatchCount = NonNullable<ReturnType<typeof matchCount>>;
