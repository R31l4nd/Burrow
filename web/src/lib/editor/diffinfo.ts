import type { Chunk } from '@codemirror/merge';
import type { Text } from '@codemirror/state';

// What a comparison shows before anyone scrolls (user, 2026-10-23, VS Code as the reference): how many
// places differ, how many lines were added and removed, and where along the file each place is.

/** Lines a range of a document covers (an empty range at a line's start: none). */
function linesIn(doc: Text, from: number, to: number): number {
  if (to <= from) return 0;
  return doc.lineAt(Math.max(from, to - 1)).number - doc.lineAt(from).number + 1;
}

export function diffSummary(chunks: readonly Chunk[], a: Text, b: Text): { places: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of chunks) {
    added += linesIn(b, c.fromB, c.toB);
    removed += linesIn(a, c.fromA, c.toA);
  }
  return { places: chunks.length, added, removed };
}

/** Each place's position along the newer document, 0 at its top and 1 at its end. */
export function markPlaces(chunks: readonly Chunk[], b: Text): number[] {
  const lines = Math.max(1, b.lines);
  return chunks.map((c) => (b.lineAt(Math.min(c.fromB, b.length)).number - 1) / lines);
}

/** The place a position of the newer document is in or after; -1 before the first. */
export function chunkAt(chunks: readonly Chunk[], pos: number): number {
  let at = -1;
  for (const [i, c] of chunks.entries()) if (c.fromB <= pos) at = i;
  return at;
}
