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
  }),
  syntaxHighlighting(highlight),
];

/** The text area's name for screen readers: the file, or what the diff shows. */
export const editorLabel = (label: string) => EditorView.contentAttributes.of({ 'aria-label': label });
