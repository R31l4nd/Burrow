// What a problem report from a terminal page says about typing and the
// suggestions: never the text itself, only yes or no, lengths and counts,
// and the keyboard's last events by kind (a keyboard app that types in its
// own way, FUTO or Gboard, shows here).

import { namedKey } from './inputlog.js';

export const termDebug = {
  compose: false,
  buffer: 'normal' as 'normal' | 'alternate',
  integration: false,
  atPrompt: false,
  promptKnown: false,
  cursorLineLength: 0,
  inputFound: false,
  inputLength: 0,
  suggestions: 0,
  completeRuns: 0,
  keys: [] as string[],
};

/**
 * One keyboard event on the terminal, by kind only ("keydown Enter",
 * "keydown 229", "beforeinput insertText"): a named key by its name, an
 * IME's 229, never the code of a letter or digit typed (80 was "p"; AUDIT2
 * TERM-01).
 */
export function noteKey(e: Event): void {
  const k = e as KeyboardEvent & InputEvent;
  const key = namedKey(k.key) ? ` ${k.key}` : k.keyCode === 229 ? ' 229' : '';
  const what = e.type.startsWith('key') ? `${e.type}${key}${k.isComposing ? ' composing' : ''}` : `${e.type} ${k.inputType ?? ''}${k.isComposing ? ' composing' : ''}`;
  termDebug.keys.push(what.trim());
  if (termDebug.keys.length > 40) termDebug.keys.shift();
}
