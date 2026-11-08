import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

// Wrapped lines hang under their own text (A3-WEB-15): with line wrapping on
// a phone, the rest of a long line went on at column 0, so a YAML list
// item's "-" stood alone above its value. Each line gets a left padding of
// its indentation (and list marker) and a negative first-line indent.

const MAX = 40;

/** How far the wrapped part of a line goes in: its indentation, plus "- " or "* " after it. */
export function hangOf(text: string, tabSize = 4): number {
  let n = 0;
  let i = 0;
  for (; i < text.length && (text[i] === ' ' || text[i] === '\t'); i++) n += text[i] === '\t' ? tabSize - (n % tabSize) : 1;
  if (/^[-*+] /.test(text.slice(i))) n += 2;
  return Math.min(n, MAX);
}

const cache = new Map<number, Decoration>();
const deco = (n: number) => {
  let d = cache.get(n);
  if (!d) cache.set(n, (d = Decoration.line({ attributes: { style: `padding-left: calc(${n}ch + 6px); text-indent: -${n}ch` } })));
  return d;
};

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const n = hangOf(line.text, view.state.tabSize);
      if (n) b.add(line.from, line.from, deco(n));
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
