import { Change, diff } from '@codemirror/merge';

// Two texts compared as people read them: line by line first, then character by character only
// within the lines that changed. CodeMirror's own diff works on characters and gives up after 500
// changed ones: with long lines (keys in a .env) it fell back to one change over the whole file,
// so lines the same in both read as changed and "show unchanged lines" had nothing to show
// (report b11968), and large files took long (report 2de305).
//
// The lines are matched as git's patience diff does (docs/PRIOR-ART.md): lines found once in each
// text tie the two together, in order, and what lies between two such lines is matched the same
// way. A character diff of the lines (each line one character) gave up on a large file with many
// changed lines too: 30,000 lines, 3,000 of them changed, came out as one change (report 2de305).

// Time for what changed within lines, in all; and the most text one such comparison takes.
const INNER_BUDGET_MS = 600;
const INNER_MAX = 8000;

/** Line ranges, end exclusive: lines fromA..toA of a became lines fromB..toB of b. */
type LineChange = { fromA: number; toA: number; fromB: number; toB: number };

/** Each line as a number, the same number for the same line in either text. */
function ids(la: string[], lb: string[]): [Int32Array, Int32Array] {
  const map = new Map<string, number>();
  const of = (lines: string[]) => {
    const out = new Int32Array(lines.length);
    lines.forEach((l, i) => {
      let id = map.get(l);
      if (id === undefined) map.set(l, (id = map.size));
      out[i] = id;
    });
    return out;
  };
  return [of(la), of(lb)];
}

/** The longest run of pairs rising in b as they rise in a (pairs given in a's order): patience sorting. */
function rising(pairs: [number, number][]): [number, number][] {
  const tops: number[] = [];
  const back = new Int32Array(pairs.length);
  pairs.forEach(([, j], k) => {
    let lo = 0;
    let hi = tops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tops[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    back[k] = lo > 0 ? tops[lo - 1]! : -1;
    tops[lo] = k;
  });
  const out: [number, number][] = [];
  for (let k = tops.length ? tops[tops.length - 1]! : -1; k >= 0; k = back[k]!) out.push(pairs[k]!);
  return out.reverse();
}

/** The same lines in both, as pairs in order (a's line, b's line). */
function matchLines(ia: Int32Array, ib: Int32Array): [number, number][] {
  const out: [number, number][] = [];
  // No line once in each (repeated lines only): CodeMirror's diff on that stretch, a line a character.
  const small = (aLo: number, aHi: number, bLo: number, bHi: number) => {
    if ((aHi - aLo) * (bHi - bLo) > 4_000_000) return;
    const units = new Map<number, string>();
    const unit = (id: number) => {
      let u = units.get(id);
      if (u === undefined) units.set(id, (u = String.fromCharCode(0x100 + units.size)));
      return u;
    };
    let sa = '';
    for (let i = aLo; i < aHi; i++) sa += unit(ia[i]!);
    let sb = '';
    for (let j = bLo; j < bHi; j++) sb += unit(ib[j]!);
    // More distinct lines than units (the surrogates start at 0xd800): left as changed.
    if (units.size > 0xd800 - 0x100) return;
    let a = 0;
    let b = 0;
    for (const c of diff(sa, sb, { scanLimit: 5000, timeout: 500 })) {
      while (a < c.fromA && b < c.fromB) out.push([aLo + a++, bLo + b++]);
      a = c.toA;
      b = c.toB;
    }
    while (a < sa.length && b < sb.length) out.push([aLo + a++, bLo + b++]);
  };
  const work = (aLo: number, aHi: number, bLo: number, bHi: number) => {
    // The same at the start and at the end.
    while (aLo < aHi && bLo < bHi && ia[aLo] === ib[bLo]) out.push([aLo++, bLo++]);
    const tail: [number, number][] = [];
    while (aLo < aHi && bLo < bHi && ia[aHi - 1] === ib[bHi - 1]) tail.push([--aHi, --bHi]);
    if (aLo < aHi && bLo < bHi) {
      // Lines once in each: the anchors.
      const seen = new Map<number, { na: number; nb: number; a: number; b: number }>();
      for (let i = aLo; i < aHi; i++) {
        const s = seen.get(ia[i]!);
        if (s) s.na++;
        else seen.set(ia[i]!, { na: 1, nb: 0, a: i, b: -1 });
      }
      for (let j = bLo; j < bHi; j++) {
        const s = seen.get(ib[j]!);
        if (s) {
          s.nb++;
          s.b = j;
        }
      }
      const once: [number, number][] = [];
      for (const s of seen.values()) if (s.na === 1 && s.nb === 1) once.push([s.a, s.b]);
      once.sort((x, y) => x[0] - y[0]);
      const anchors = rising(once);
      if (anchors.length) {
        let a = aLo;
        let b = bLo;
        for (const [i, j] of anchors) {
          work(a, i, b, j);
          out.push([i, j]);
          a = i + 1;
          b = j + 1;
        }
        work(a, aHi, b, bHi);
      } else small(aLo, aHi, bLo, bHi);
    }
    for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]!);
  };
  work(0, ia.length, 0, ib.length);
  return out;
}

/** The lines that differ, between the lines the same in both. */
function lineChanges(la: string[], lb: string[]): LineChange[] {
  const [ia, ib] = ids(la, lb);
  const out: LineChange[] = [];
  let a = 0;
  let b = 0;
  for (const [i, j] of [...matchLines(ia, ib), [la.length, lb.length] as [number, number]]) {
    if (i > a || j > b) out.push({ fromA: a, toA: i, fromB: b, toB: j });
    a = i + 1;
    b = j + 1;
  }
  return out;
}

/** Where each line starts, and the text's end after the last. */
function starts(lines: string[]): number[] {
  const out = [0];
  for (const l of lines) out.push(out[out.length - 1]! + l.length + 1);
  return out;
}

// The last answer: the count above a comparison, its view, a switch to one column and "show
// unchanged lines" each ask for the same two texts (each built its own before, report 2de305).
let last: { a: string; b: string; changes: readonly Change[] } | null = null;

/** The changes from a to b, for @codemirror/merge's diffConfig.override. */
export function lineFirstDiff(a: string, b: string): readonly Change[] {
  if (last && last.a === a && last.b === b) return last.changes;
  const changes = compute(a, b);
  last = { a, b, changes };
  return changes;
}

function compute(a: string, b: string): readonly Change[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const sa = starts(la);
  const sb = starts(lb);
  // A line's range: from its start to the next line's start, the text's end for the last one.
  const at = (s: number[], text: string, line: number) => Math.min(s[line]!, text.length);
  const out: Change[] = [];
  // What changed within the lines: as long as there is time for it (each block its own character
  // diff added up to seconds on a large file of long random lines, report 2de305); after that the
  // lines are marked whole, as changed.
  const until = Date.now() + INNER_BUDGET_MS;
  const inner = (fromA: number, toA: number, fromB: number, toB: number) => {
    const subA = a.slice(fromA, toA);
    const subB = b.slice(fromB, toB);
    if (!subA || !subB || subA.length + subB.length > INNER_MAX || Date.now() > until) return void out.push(new Change(fromA, toA, fromB, toB));
    // The same start and end left out; what is between marked as one when the two have little in
    // common (two keys): pieces that happen to match only scattered the marks (report b11968).
    let p = 0;
    while (p < subA.length && p < subB.length && subA[p] === subB[p]) p++;
    let q = 0;
    while (q < subA.length - p && q < subB.length - p && subA[subA.length - 1 - q] === subB[subB.length - 1 - q]) q++;
    const midA = subA.slice(p, subA.length - q);
    const midB = subB.slice(p, subB.length - q);
    const found = midA && midB ? diff(midA, midB, { scanLimit: 500, timeout: 50 }) : [new Change(0, midA.length, 0, midB.length)];
    const kept = midA.length - found.reduce((n, d) => n + d.toA - d.fromA, 0);
    if (midA.length + midB.length && (2 * kept) / (midA.length + midB.length) < 0.5) return void out.push(new Change(fromA + p, toA - q, fromB + p, toB - q));
    for (const d of found) out.push(new Change(fromA + p + d.fromA, fromA + p + d.toA, fromB + p + d.fromB, fromB + p + d.toB));
  };
  for (const c of lineChanges(la, lb)) {
    let fromA = at(sa, a, c.fromA);
    const toA = at(sa, a, c.toA);
    let fromB = at(sb, b, c.fromB);
    const toB = at(sb, b, c.toB);
    // Lines added or removed after the last line of the other (no newline after it): the newline
    // before them is part of the change, on the side that has them; the other is at its end already.
    if (c.fromA === la.length && fromB > 0) fromB--;
    else if (c.fromB === lb.length && fromA > 0) fromA--;
    // As many lines on each side: line against line, as VS Code does (a block's lines compared as
    // one text matched parts of one line with another).
    const rows = c.toA - c.fromA;
    if (rows > 1 && rows === c.toB - c.fromB && fromA === at(sa, a, c.fromA)) {
      for (let k = 0; k < rows; k++) {
        const endA = c.fromA + k + 1 === la.length ? a.length : sa[c.fromA + k + 1]! - 1;
        const endB = c.fromB + k + 1 === lb.length ? b.length : sb[c.fromB + k + 1]! - 1;
        inner(sa[c.fromA + k]!, endA, sb[c.fromB + k]!, endB);
      }
    } else inner(fromA, toA, fromB, toB);
  }
  return out;
}

/** The diff configuration DiffView uses: line by line first. */
export const lineFirst = { override: lineFirstDiff };
