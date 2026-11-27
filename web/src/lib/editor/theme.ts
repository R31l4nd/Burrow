import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

// Burrow's look for every CodeMirror view. Colours are CSS variables
// (app.css, per theme), so switching light/dark needs no rebuild; and
// basicSetup's own highlighting (dark blue keys, #00f) was unreadable on
// the dark theme.

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName), tags.attributeName], color: 'var(--syn-key)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: 'var(--syn-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName, tags.labelName], color: 'var(--syn-type)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--syn-fn)' },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation, tags.special(tags.variableName)], color: 'var(--syn-meta)' },
  { tag: [tags.heading], color: 'var(--syn-keyword)', fontWeight: '700' },
  { tag: [tags.link, tags.url], color: 'var(--syn-string)', textDecoration: 'underline' },
  { tag: [tags.invalid], color: 'var(--danger)' },
]);

export const burrowEditorTheme = [
  EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--bg-sunken)', color: 'var(--text)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-raised)', color: 'var(--text-dim)', borderRight: '1px solid var(--border)' },
    '.cm-content': { fontFamily: 'var(--mono)', fontSize: '14px', caretColor: 'var(--accent)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent) !important' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-raised)', color: 'var(--text-dim)', border: '1px solid var(--border)' },
    '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--text)' },
    '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    // Light tints with an outline: at 30-40% the coloured words on them fell under 4.5:1 (axe, with the find count's test).
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 14%, transparent)', outline: '1px solid color-mix(in srgb, var(--warn) 55%, transparent)', borderRadius: '2px' },
    '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)', outline: '2px solid var(--accent)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border)' },
    // One column of a comparison: the lines gone numbered as in the older file, in the colour of a removal.
    '.cm-deletedNumbersGutter': { color: 'var(--danger)', backgroundColor: 'color-mix(in srgb, var(--danger) 8%, transparent)' },
  }),
  syntaxHighlighting(highlight),
];

/**
 * A comparison as VS Code shows one (report b11968: code-server's was clearer): changed lines tinted,
 * the changed words in them coloured behind (CodeMirror's own thin line under them was hard to see,
 * on the dark theme most), and a hatched gap facing lines only the other side has. In Burrow's
 * colours; "&.cm-editor" outweighs @codemirror/merge's own light and dark rules.
 */
export const diffTheme = EditorView.theme({
  '&.cm-editor.cm-merge-a .cm-changedLine, &.cm-editor .cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--danger) 10%, transparent)' },
  '&.cm-editor.cm-merge-b .cm-changedLine, &.cm-editor .cm-inlineChangedLine': { backgroundColor: 'color-mix(in srgb, var(--ok) 10%, transparent)' },
  '&.cm-editor.cm-merge-a .cm-changedText, &.cm-editor .cm-deletedChunk .cm-deletedText': { background: 'color-mix(in srgb, var(--danger) 26%, transparent)', borderRadius: '2px' },
  '&.cm-editor.cm-merge-b .cm-changedText, &.cm-editor .cm-inlineChangedLine .cm-changedText': { background: 'color-mix(in srgb, var(--ok) 26%, transparent)', borderRadius: '2px' },
  '&.cm-editor .cm-mergeSpacer': { backgroundImage: 'repeating-linear-gradient(-45deg, transparent 0 6px, color-mix(in srgb, var(--text-dim) 22%, transparent) 6px 7px)' },
  '&.cm-editor.cm-merge-a .cm-changedLineGutter, &.cm-editor .cm-deletedLineGutter': { background: 'var(--danger)' },
  '&.cm-editor.cm-merge-b .cm-changedLineGutter': { background: 'var(--ok)' },
  '&.cm-editor .cm-collapsedLines': { color: 'var(--text-dim)', background: 'var(--bg-raised)', borderBlock: '1px solid var(--border)', fontFamily: 'var(--font, inherit)', fontSize: '13px' },
});

/** The text area's name for screen readers: the file, or what the diff shows. */
export const editorLabel = (label: string) => EditorView.contentAttributes.of({ 'aria-label': label });
