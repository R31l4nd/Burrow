import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldable,
  foldedRanges,
  foldEffect,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  unfoldEffect,
} from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { locale, t } from '../i18n/index.svelte.js';
import { findPanel } from './find.svelte.js';
import type { MatchCount } from './searchcount.js';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type BlockInfo,
} from '@codemirror/view';

// codemirror's basicSetup, with Burrow's own folding: a small chevron in a
// narrow column, centred on its line (the default arrow sat low and wide),
// and a tap on a foldable line's number folds it too (a larger target on a
// phone than the chevron).

/** Fold the block that starts on this line, or unfold it; false when nothing folds there. */
export function toggleFoldAt(view: EditorView, line: BlockInfo): boolean {
  let unfolded = false;
  foldedRanges(view.state).between(line.from, line.to, (from, to) => {
    if (unfolded) return;
    view.dispatch({ effects: unfoldEffect.of({ from, to }) });
    unfolded = true;
  });
  if (unfolded) return true;
  const range = foldable(view.state, line.from, line.to);
  if (!range) return false;
  view.dispatch({ effects: foldEffect.of(range) });
  return true;
}

function chevron(open: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = `cm-fold-chevron${open ? '' : ' closed'}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  return span;
}

const foldTheme = EditorView.baseTheme({
  // On the line's first row, like its number: centred on a line that wraps
  // over two rows it sat between them (report 19c129).
  '.cm-foldGutter .cm-gutterElement': { width: '14px', padding: '0', textAlign: 'center' },
  '.cm-fold-chevron': { display: 'inline-flex', verticalAlign: 'middle', color: 'var(--text-dim, #888)', cursor: 'pointer' },
  '.cm-fold-chevron.closed': { transform: 'rotate(-90deg)', color: 'var(--accent, #1a7f37)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 2px 0 6px', minWidth: '2ch' },
});

// CodeMirror's own words (go to line, what a screen reader hears of a match
// and a fold), in sentence case like the rest of the app, and in Dutch. The
// find panel is the app's own (find.svelte.ts).
const EN_PHRASES: Record<string, string> = {
  close: 'Close',
  go: 'Go',
};
const NL_PHRASES: Record<string, string> = {
  close: 'Sluiten',
  'current match': 'huidige treffer',
  'on line': 'op regel',
  'Go to line': 'Ga naar regel',
  go: 'Ga',
  'Folded lines': 'Ingeklapte regels',
  'Unfolded lines': 'Uitgeklapte regels',
  'Fold line': 'Regel inklappen',
  'Unfold line': 'Regel uitklappen',
};
/** The find panel's count in the app's words: "3 of 12", "12 matches", "No results" (report dc29b4). */
const sayCount = (c: MatchCount): string => {
  if (!c.total) return t('editor.noMatches');
  const n = c.more ? `${c.total}+` : String(c.total);
  return c.current ? t('editor.matchOf', { i: c.current, n }) : t('editor.matchCount', { n: c.total, shown: n });
};

function editorPhrases(): Extension {
  return EditorState.phrases.of(locale() === 'nl' ? NL_PHRASES : EN_PHRASES);
}

/**
 * The editor's basics. A function, made for each editor: its texts (Find,
 * Replace) in the language set when it opens, not the one the page loaded
 * in (AUDIT2 TERM-18).
 */
export function editorSetup(): Extension {
  return [
    lineNumbers({ domEventHandlers: { click: (view, line) => toggleFoldAt(view, line) } }),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: chevron }),
    foldTheme,
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    editorPhrases(),
    findPanel(sayCount),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
    // A long file scrolls: its text reached by Tab by its tabindex, not only as an editable field
    // (axe's scrollable-region-focusable counts no contenteditable; first seen with report 202777).
    EditorView.contentAttributes.of({ tabindex: '0' }),
];
}
