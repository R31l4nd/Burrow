import { Change, diff } from '@codemirror/merge';

// Two texts compared as people read them: line by line first, then character by character only
// within the lines that changed. CodeMirror's own diff works on characters and gives up after 500
// changed ones: with long lines (keys in a .env) it fell back to one change over the whole file,
// so lines the same in both read as changed and "show unchanged lines" had nothing to show
// (report b11968), and large files took long (report 2de305).

/** Each distinct line as one UTF-16 unit, never a surrogate: the line diff is a character diff of those. */
function codes(lines: string[], ids: Map<string, number>): string | null {
  let out = '';
  for (const l of lines) {
    let id = ids.get(l);
    if (id === undefined) {
      id = ids.size;
      ids.set(l, id);
    }
    // 0x100 up, the surrogates (0xD800-0xDFFF) left out: about 63,000 distinct lines.
    const unit = 0x100 + id < 0xd800 ? 0x100 + id : 0x100 + id + 0x800;
    if (unit > 0xffff) return null;
    out += String.fromCharCode(unit);
  }
  return out;
}

/** Where each line starts, and the text's end after the last. */
function starts(lines: string[]): number[] {
  const out = [0];
  for (const l of lines) out.push(out[out.length - 1]! + l.length + 1);
  return out;
}

/** The changes from a to b, for @codemirror/merge's diffConfig.override. */
export function lineFirstDiff(a: string, b: string): readonly Change[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const ids = new Map<string, number>();
  const ca = codes(la, ids);
  const cb = ca === null ? null : codes(lb, ids);
  // More distinct lines than units to stand for them: CodeMirror's own, bounded.
  if (ca === null || cb === null) return diff(a, b, { scanLimit: 500, timeout: 2000 });
  const sa = starts(la);
  const sb = starts(lb);
  // A line's range: from its start to the next line's start, the text's end for the last one.
  const at = (s: number[], text: string, line: number) => Math.min(s[line]!, text.length);
  const out: Change[] = [];
  for (const c of diff(ca, cb, { scanLimit: 5000, timeout: 1500 })) {
    let fromA = at(sa, a, c.fromA);
    const toA = at(sa, a, c.toA);
    let fromB = at(sb, b, c.fromB);
    const toB = at(sb, b, c.toB);
    // Lines added or removed at the end: the newline before them is part of the change.
    if (c.toA === la.length && c.toB === lb.length && fromA > 0 && fromB > 0 && (fromA === toA || fromB === toB)) {
      fromA--;
      fromB--;
    }
    const subA = a.slice(fromA, toA);
    const subB = b.slice(fromB, toB);
    // Within the changed lines, what changed in them: only where both sides have text, and not too much of it.
    if (subA && subB && subA.length + subB.length <= 20_000) {
      for (const d of diff(subA, subB, { scanLimit: 500, timeout: 200 })) out.push(new Change(fromA + d.fromA, fromA + d.toA, fromB + d.fromB, fromB + d.toB));
    } else out.push(new Change(fromA, toA, fromB, toB));
  }
  return out;
}

/** The diff configuration DiffView uses: line by line first. */
export const lineFirst = { override: lineFirstDiff };
