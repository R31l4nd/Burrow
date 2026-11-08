// What a phone's keyboard types into the terminal, sent once and exactly.
//
// xterm.js reads a soft keyboard from its hidden textarea and guesses what
// changed around each keydown with keyCode 229 and each composition. With
// Gboard and friends that guess goes wrong: a correction or a picked
// suggestion rewrites part of the textarea, and xterm sent text again that
// had been sent already, or spaces and backspaces twice (xterm.js issues
// #3600, #675, #6045). Terminal apps on Android avoid it by asking the
// keyboard for plain characters (Termux: TYPE_NULL or a visible password
// field, which the Android app does too); a web page cannot, so here every
// edit of the textarea, composing or not, is compared with what the
// terminal was last given, and the difference goes out as backspaces plus
// the new text. A correction becomes "delete the word, type it right".

/** The edit from `before` to `after`: how many characters to take back at the end of the common start, and what to add. */
export function diffEdit(before: string, after: string): { back: number; text: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  // Never in the middle of a character: two emoji can share their first
  // half, and the second half alone was sent (AUDIT2 TERM-07).
  if (start > 0 && start < max && /[\uD800-\uDBFF]/.test(before[start - 1]!)) start--;
  // The terminal's cursor is at the end of what it was given: everything
  // after the common start is taken back and typed again.
  return { back: [...before.slice(start)].length, text: after.slice(start) };
}

/** Bytes for the terminal: a backspace per character taken back, then the text (line breaks as Enter). */
export function editBytes(edit: { back: number; text: string }): string {
  return '\x7f'.repeat(edit.back) + edit.text.replace(/\r?\n/g, '\r');
}

/** Text that is a paste rather than typing: a line break before its end (a line and its Enter is typing). */
export const isPaste = (text: string): boolean => /[\r\n]/.test(text.replace(/[\r\n]+$/, ''));

// Past this the textarea starts over (the keyboard's context goes with it).
const MAX_KEPT = 400;

// Keys that move or end the shell's editing rather than type.
const NAVIGATION = new Set(['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Takes the soft keyboard's text input away from xterm: listeners in the
 * capture phase on an ancestor run before xterm's own on the textarea and
 * stop them. Keys that are real key presses (a hardware keyboard, and
 * Enter or Backspace where the keyboard sends them as keys) stay xterm's.
 * Returns the way to stop.
 */
/**
 * `send` returns true when it typed the text with a held modifier (the key bar's Ctrl or Alt): the
 * shell got a control key, not the letter, and the field starts over as after a real Ctrl key.
 */
export function attachTextInput(root: HTMLElement, textarea: HTMLTextAreaElement, send: (data: string) => boolean | void, paste: (text: string) => void): () => void {
  // What the terminal has been given of the textarea's text.
  let given = textarea.value;
  // A hardware key's character: xterm sends it from its keypress.
  let pressed = false;
  // The keyboard said this edit is a paste (its clipboard): a paste whatever
  // it holds, also one line ending in a line break (that became a raw Enter
  // and ran the line; AUDIT2 TERM-03).
  let fromPaste = false;
  const mine = (e: Event) => e.target === textarea;

  const startOver = () => {
    textarea.value = '';
    given = '';
  };
  const sync = () => {
    const now = textarea.value;
    if (now === given) return;
    const edit = diffEdit(given, now);
    given = now;
    // Several lines at once (the keyboard's clipboard): a paste, which the
    // terminal marks as one when the program asks (bracketed paste), not
    // typing with an Enter per line (a program in a tmux took each line
    // for a message of its own).
    const pasted = fromPaste;
    fromPaste = false;
    if (pasted || isPaste(edit.text)) {
      if (edit.back) send('\x7f'.repeat(edit.back));
      paste(edit.text);
      startOver();
      return;
    }
    const bytes = editBytes(edit);
    if (bytes && send(bytes) === true) startOver();
  };

  const onBeforeInput = (e: InputEvent) => {
    if (!mine(e)) return;
    e.stopPropagation();
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') fromPaste = true;
    // Enter: sent as Enter, and the line is done (a fresh start for the keyboard).
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      sync();
      send('\r');
      startOver();
      return;
    }
    // Backspace (not inside a word being composed): one character back,
    // done here rather than left to the browser, so it also counts on an
    // empty line (a new line, or after a start over) and never twice.
    if (e.inputType === 'deleteContentBackward' && !e.isComposing && textarea.selectionStart === textarea.selectionEnd) {
      e.preventDefault();
      sync();
      const chars = [...textarea.value];
      if (chars.length && textarea.selectionEnd === textarea.value.length) {
        textarea.value = chars.slice(0, -1).join('');
        given = textarea.value;
      }
      send('\x7f');
    }
  };
  const onInput = (e: Event) => {
    if (!mine(e)) return;
    e.stopPropagation();
    if (pressed) {
      pressed = false;
      given = textarea.value;
      return;
    }
    sync();
    // A paste that changed nothing: the next edit is typing again.
    fromPaste = false;
    if (!(e as InputEvent).isComposing && textarea.value.length > MAX_KEPT) startOver();
  };
  // A composition (a word being typed, underlined) goes out as it grows,
  // through the input events above; xterm's own handling stays out.
  const onComposition = (e: Event) => {
    if (!mine(e)) return;
    e.stopPropagation();
    if (e.type === 'compositionend') queueMicrotask(sync);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!mine(e)) return;
    // 229: "the keyboard is composing", no real key. xterm would diff the
    // textarea after it; the input event does that here.
    if (e.keyCode === 229 || e.isComposing) {
      e.stopPropagation();
      return;
    }
    // A key that changes the shell's line in ways the field cannot follow
    // (Ctrl+U, Ctrl+C, Escape, Tab, the arrows): xterm sends it, and the
    // keyboard starts over now. Taken later (a moment after), the field's
    // old text was still the measure for the next typing, and its first
    // character went missing ("echo hi" after Ctrl+U arrived as "cho hi").
    if (e.ctrlKey || e.altKey || e.metaKey || NAVIGATION.has(e.key)) return void startOver();
    // Another real key: xterm sends it. Whatever it does to the textarea is not typing.
    setTimeout(() => (given = textarea.value));
  };
  const onKeyPress = (e: KeyboardEvent) => {
    if (mine(e)) pressed = true;
  };
  const onFocus = () => (given = textarea.value);

  const opts = { capture: true };
  root.addEventListener('beforeinput', onBeforeInput as EventListener, opts);
  root.addEventListener('input', onInput, opts);
  for (const t of ['compositionstart', 'compositionupdate', 'compositionend']) root.addEventListener(t, onComposition, opts);
  root.addEventListener('keydown', onKeyDown, opts);
  root.addEventListener('keypress', onKeyPress, opts);
  textarea.addEventListener('focus', onFocus);
  return () => {
    root.removeEventListener('beforeinput', onBeforeInput as EventListener, opts);
    root.removeEventListener('input', onInput, opts);
    for (const t of ['compositionstart', 'compositionupdate', 'compositionend']) root.removeEventListener(t, onComposition, opts);
    root.removeEventListener('keydown', onKeyDown, opts);
    root.removeEventListener('keypress', onKeyPress, opts);
    textarea.removeEventListener('focus', onFocus);
  };
}
