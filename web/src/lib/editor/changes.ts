import { Chunk } from '@codemirror/merge';
import { RangeSet, RangeSetBuilder, StateEffect, StateField, Text, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, gutter, GutterMarker } from '@codemirror/view';

// What changed since the file was saved, in a thin column beside the line
// numbers: a bar on added lines (green) and changed ones (accent), a mark
// where lines were deleted (red). Like an IDE, so the person sees what a
// save would write before writing it.

/** The file as saved now (after a save or a reload); the marks are relative to it. */
export const setSaved = StateEffect.define<string>();

const saved = StateField.define<Text>({
  create: (s) => s.doc,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setSaved)) return Text.of(e.value.split(/\r\n?|\n/));
    return v;
  },
});

class Mark extends GutterMarker {
  constructor(readonly kind: 'add' | 'mod' | 'del') {
    super();
  }
  override eq(o: GutterMarker) {
    return o instanceof Mark && o.kind === this.kind;
  }
  override toDOM() {
    const d = document.createElement('div');
    d.className = `cm-change cm-change-${this.kind}`;
    return d;
  }
}
const ADD = new Mark('add');
const MOD = new Mark('mod');
const DEL = new Mark('del');

function build(state: EditorState): RangeSet<GutterMarker> {
  const doc = state.doc;
  const b = new RangeSetBuilder<GutterMarker>();
  for (const c of Chunk.build(state.field(saved), doc)) {
    if (c.fromB === c.toB) {
      // Only deleted: marked on the line where they were.
      const at = doc.lineAt(Math.min(c.fromB, doc.length));
      b.add(at.from, at.from, DEL);
      continue;
    }
    const first = doc.lineAt(c.fromB).number;
    const last = doc.lineAt(Math.max(c.fromB, Math.min(c.toB, doc.length) - 1)).number;
    const mark = c.fromA === c.toA ? ADD : MOD;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      b.add(line.from, line.from, mark);
    }
  }
  return b.finish();
}

const marks = StateField.define<RangeSet<GutterMarker>>({
  create: build,
  update: (v, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setSaved)) ? build(tr.state) : v),
});

/** Line number and kind of each mark (for tests). */
export function changeMarks(state: EditorState): { line: number; kind: string }[] {
  const out: { line: number; kind: string }[] = [];
  state.field(marks).between(0, state.doc.length, (from, _to, m) => void out.push({ line: state.doc.lineAt(from).number, kind: (m as Mark).kind }));
  return out;
}

/** The text as saved, for "Compare with saved". */
export const savedText = (state: EditorState) => state.field(saved).toString();

export const changeGutter: Extension = [
  saved,
  marks,
  gutter({ class: 'cm-changes', markers: (v) => v.state.field(marks) }),
  EditorView.baseTheme({
    '.cm-changes': { width: '4px', marginRight: '2px' },
    '.cm-changes .cm-gutterElement': { padding: '0' },
    '.cm-change': { width: '3px', height: '100%' },
    '.cm-change-add': { background: 'var(--ok, #1a7f37)' },
    '.cm-change-mod': { background: 'var(--accent, #1a7f37)', opacity: '0.7' },
    '.cm-change-del': { height: '0', borderTop: '2px solid var(--danger, #cf222e)', borderRight: '4px solid transparent' },
  }),
];
