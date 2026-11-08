// A problem report's picture draws the page again inside an SVG
// (modern-screenshot), each box as wide as measured on the screen, and the
// text in it a hair wider at some zooms (Edge at 125 %). Words then broke
// over two lines in the picture that stood on one on the screen ("breakin|g",
// a date over the line under it; reports 0d33eb, 71b74a, 71a779): the report
// showed a fault the person did not see. What stands on one line on the
// screen is marked before the copy is made, and kept on one line in it.

/** The attribute that marks an element whose text is on one line on the screen (taken off the copy again). */
export const ONE_LINE = 'data-shot-line';
/** Text nodes looked at, at most: a very long page is thinned before (thinLongLists). */
const MAX_TEXTS = 20_000;

/** Line boxes that are one line: their tops and bottoms within half the first one's height of it. */
export function oneLine(rects: ArrayLike<{ top: number; bottom: number; height: number }>): boolean {
  let first: { top: number; bottom: number; height: number } | null = null;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (r.height <= 0) continue;
    if (!first) first = r;
    else if (Math.abs(r.top - first.top) > first.height / 2 || Math.abs(r.bottom - first.bottom) > first.height / 2) return false;
  }
  return first !== null;
}

/**
 * Marks the elements under `root` with text of their own that stands on
 * one line (wrapping as usual: a <pre> or a line kept already is left as
 * it is). Returns what takes the marks off again.
 */
export function markLines(root: Element, skip: (el: Element) => boolean): () => void {
  const marked: Element[] = [];
  const seen = new Set<Element>();
  const walk = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const range = document.createRange();
  let n = walk.nextNode();
  for (let i = 0; n && i < MAX_TEXTS; n = walk.nextNode(), i++) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !/\S/.test(n.nodeValue ?? '')) continue;
    seen.add(el);
    if (skip(el) || getComputedStyle(el).whiteSpace !== 'normal') continue;
    range.selectNodeContents(el);
    if (!oneLine(range.getClientRects())) continue;
    el.setAttribute(ONE_LINE, '');
    marked.push(el);
  }
  return () => marked.forEach((el) => el.removeAttribute(ONE_LINE));
}

/** For each node of the copy: a marked one keeps its line (the copy lives in another document, so no instanceof). */
export function keepLine(cloned: Node): void {
  if (cloned.nodeType !== 1) return;
  const el = cloned as HTMLElement;
  if (!el.hasAttribute(ONE_LINE)) return;
  el.removeAttribute(ONE_LINE);
  el.style.setProperty('white-space', 'nowrap');
}
