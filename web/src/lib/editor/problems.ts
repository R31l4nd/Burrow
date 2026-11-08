import { forEachDiagnostic, type Diagnostic } from '@codemirror/lint';
import { RangeSet, RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state';
import { GutterMarker, gutterLineClass } from '@codemirror/view';

// A line with a problem is marked beside it: a band in the problem's colour
// across the line's side (number, fold arrow, change mark), its number bold in
// that colour with a bar at its left. No column of its own: a dot there was
// too small to see (report 279f73), made the side wide when empty (f15675) and
// moved the text when it came and went as a column that was only there with
// problems (413d6f).

const RANK: Record<Diagnostic['severity'], number> = { hint: 0, info: 1, warning: 2, error: 3 };

class ProblemLine extends GutterMarker {
  constructor(readonly severity: Diagnostic['severity']) {
    super();
    this.elementClass = `cm-problem cm-problem-${severity}`;
  }
  override eq(o: GutterMarker) {
    return o instanceof ProblemLine && o.severity === this.severity;
  }
}
const MARKS = { hint: new ProblemLine('hint'), info: new ProblemLine('info'), warning: new ProblemLine('warning'), error: new ProblemLine('error') };

function build(state: EditorState): RangeSet<GutterMarker> {
  // The worst problem on each line.
  const worst = new Map<number, Diagnostic['severity']>();
  forEachDiagnostic(state, (d, from) => {
    const line = state.doc.lineAt(Math.min(from, state.doc.length)).from;
    const had = worst.get(line);
    if (!had || RANK[d.severity] > RANK[had]) worst.set(line, d.severity);
  });
  const b = new RangeSetBuilder<GutterMarker>();
  for (const [at, s] of [...worst].sort((x, y) => x[0] - y[0])) b.add(at, at, MARKS[s]);
  return b.finish();
}

const lines = StateField.define<RangeSet<GutterMarker>>({
  create: build,
  // The diagnostics come as effects (set by a checker or the language server).
  update: (v, tr) => (tr.docChanged || tr.effects.length ? build(tr.state) : v),
  provide: (f) => gutterLineClass.from(f),
});

/** Line number and severity of each marked line (for tests). */
export function problemLines(state: EditorState): { line: number; severity: string }[] {
  const out: { line: number; severity: string }[] = [];
  state.field(lines).between(0, state.doc.length, (from, _to, m) => void out.push({ line: state.doc.lineAt(from).number, severity: (m as ProblemLine).severity }));
  return out;
}

export const problemNumbers: Extension = lines;
