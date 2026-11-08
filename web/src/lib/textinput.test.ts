import { describe, expect, it, vi } from 'vitest';
import { attachTextInput, diffEdit, editBytes, isPaste } from './textinput.js';

// What a soft keyboard does to the textarea, and what the terminal gets.
describe('soft keyboard edits', () => {
  const bytes = (a: string, b: string) => editBytes(diffEdit(a, b));

  it('one emoji for another that shares its first half: the whole character taken back and typed (AUDIT2 TERM-07)', () => {
    // U+1F600 and U+1F601: \uD83D\uDE00 and \uD83D\uDE01.
    const e = diffEdit('a\u{1F600}', 'a\u{1F601}');
    expect(e).toEqual({ back: 1, text: '\u{1F601}' });
  });

  it('sends what was typed, once', () => {
    expect(bytes('', 'l')).toBe('l');
    expect(bytes('l', 'ls')).toBe('s');
    expect(bytes('ls', 'ls ')).toBe(' ');
    expect(bytes('ls', 'ls')).toBe('');
  });

  it('a correction is taking back and typing again, not the text twice', () => {
    // The report's case: "sturenx" corrected; before, the whole sentence came again.
    expect(bytes('ik zal hier zo een voorbeeld van sturenx', 'ik zal hier zo een voorbeeld van sturen ')).toBe('\x7f' + ' ');
    expect(bytes('echo wrld', 'echo world')).toBe('\x7f\x7f\x7f' + 'orld');
    // A picked suggestion replaces the word being typed.
    expect(bytes('git sta', 'git status ')).toBe('tus ');
  });

  it('backspace takes back one character, also a wide one', () => {
    expect(bytes('abc', 'ab')).toBe('\x7f');
    expect(bytes('ok \u{1f44d}', 'ok ')).toBe('\x7f');
  });

  it('a line break is Enter', () => {
    expect(bytes('ls', 'ls\n')).toBe('\r');
  });

  it('several lines at once are a paste; a line and its Enter are typing', () => {
    expect(isPaste('one\ntwo')).toBe(true);
    expect(isPaste('one\r\ntwo\n')).toBe(true);
    expect(isPaste('ls\n')).toBe(false);
    expect(isPaste('\n')).toBe(false);
    expect(isPaste('word')).toBe(false);
  });
});

// The whole path: a stand-in for the hidden textarea (an EventTarget with a
// value) and for the shell's line, which gets what is sent.
describe('the keyboard app after a real key', () => {
  function setup(start: string) {
    const ta = Object.assign(new EventTarget(), { value: start, selectionStart: start.length, selectionEnd: start.length }) as unknown as HTMLTextAreaElement;
    let line = [...start];
    const send = (bytes: string) => {
      for (const ch of bytes) {
        if (ch === '\x7f') line.pop();
        else if (ch === '\x15') line = [];
        else line.push(ch);
      }
    };
    const pasted: string[] = [];
    const sent: string[] = [];
    const stop = attachTextInput(ta as unknown as HTMLElement, ta, (b) => (sent.push(b), send(b)), (text) => pasted.push(text));
    const fire = (type: string, props: Record<string, unknown>) => ta.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), props));
    const typeApp = (text: string) => {
      for (const ch of text) {
        fire('keydown', { keyCode: 229, key: 'Unidentified' });
        fire('beforeinput', { inputType: 'insertText', data: ch });
        ta.value += ch;
        fire('input', { inputType: 'insertText', data: ch, isComposing: false });
      }
    };
    return { ta, fire, typeApp, line: () => line.join(''), send, pasted, sent, stop };
  }

  it('Ctrl+U, xterm clearing its field, then typing: the shell gets the new line, nothing of the old', () => {
    const t = setup('echo lat');
    // A real key with Ctrl: xterm sends it (^U clears the shell's line) and empties its field.
    t.fire('keydown', { keyCode: 85, key: 'u', ctrlKey: true });
    t.send('\x15');
    t.ta.value = '';
    t.typeApp('echo hi');
    expect(t.line()).toBe('echo hi');
  });

  it('Ctrl+U with the field left as it was: still only the new line', () => {
    const t = setup('echo lat');
    t.fire('keydown', { keyCode: 85, key: 'u', ctrlKey: true });
    t.send('\x15');
    t.typeApp('echo hi');
    expect(t.line()).toBe('echo hi');
  });

  it("a letter typed with the key bar's Ctrl held: the field starts over, as after a real Ctrl key (review 2026-10-24)", () => {
    const ta = Object.assign(new EventTarget(), { value: 'echo ', selectionStart: 5, selectionEnd: 5 }) as unknown as HTMLTextAreaElement;
    let ctrl = true;
    const sent: string[] = [];
    // The terminal's own send: a held Ctrl turns the letter into its control code, and says so.
    attachTextInput(ta as unknown as HTMLElement, ta, (b) => {
      const was = ctrl;
      ctrl = false;
      sent.push(was ? String.fromCharCode(b.charCodeAt(b.length - 1) & 31) : b);
      return was;
    }, () => {});
    ta.dispatchEvent(Object.assign(new Event('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'insertText', data: 'c' }));
    ta.value += 'c';
    ta.dispatchEvent(Object.assign(new Event('input', { bubbles: true }), { inputType: 'insertText', data: 'c', isComposing: false }));
    expect(sent).toEqual(['\x03']);
    // Not a "c" on the shell's line: the keyboard's next correction of that word must not take it back.
    expect(ta.value).toBe('');
  });

  it("the keyboard's clipboard with several lines: one paste, not a line and an Enter each", () => {
    const t = setup('echo ');
    const log = 'Backups: ok\nDocker: healthy\n';
    t.fire('beforeinput', { inputType: 'insertFromPaste', data: log });
    t.ta.value += log;
    t.fire('input', { inputType: 'insertFromPaste', data: log, isComposing: false });
    expect(t.pasted).toEqual([log]);
    expect(t.line()).toBe('echo ');
    // The field starts over: typing after it is new typing.
    expect(t.ta.value).toBe('');
    t.typeApp('x');
    expect(t.line()).toBe('echo x');
  });

  it("the keyboard's clipboard with one line and its line break: a paste (marked where the program asks), never a raw Enter (AUDIT2 TERM-03)", () => {
    const t = setup('');
    const clip = 'rm -rf ./build\n';
    t.fire('beforeinput', { inputType: 'insertFromPaste', data: clip });
    t.ta.value += clip;
    t.fire('input', { inputType: 'insertFromPaste', data: clip, isComposing: false });
    expect(t.pasted).toEqual([clip]);
    expect(t.line()).not.toContain('\r');
    expect(t.line()).toBe('');
  });

  it("Enter from the keyboard: what was typed, then Enter, and the field starts over", () => {
    const t = setup('');
    t.typeApp('ls');
    const enter = t.fire('beforeinput', { inputType: 'insertLineBreak' });
    expect(enter).toBe(false);
    expect(t.sent.join('')).toBe('ls\r');
    expect(t.ta.value).toBe('');
    t.typeApp('pwd');
    expect(t.sent.join('')).toBe('ls\rpwd');
  });

  it('Backspace: one character back, also on an empty line; inside a word being composed it is the keyboard\'s', () => {
    const t = setup('');
    t.typeApp('ab');
    // The cursor at the end of the field.
    Object.assign(t.ta, { selectionStart: 2, selectionEnd: 2 });
    expect(t.fire('beforeinput', { inputType: 'deleteContentBackward', isComposing: false })).toBe(false);
    expect(t.ta.value).toBe('a');
    t.fire('beforeinput', { inputType: 'deleteContentBackward', isComposing: false });
    t.fire('beforeinput', { inputType: 'deleteContentBackward', isComposing: false });
    // Two characters typed, three taken back: the last one went to the shell's line before.
    expect(t.sent.filter((b) => b === '\x7f')).toHaveLength(3);
    expect(t.fire('beforeinput', { inputType: 'deleteContentBackward', isComposing: true })).toBe(true);
  });

  it('a word being composed goes out as it grows and once more when it ends', async () => {
    const t = setup('');
    t.fire('compositionstart', {});
    t.ta.value = 'hel';
    t.fire('input', { inputType: 'insertCompositionText', isComposing: true });
    t.ta.value = 'hello';
    t.fire('compositionend', {});
    await Promise.resolve();
    expect(t.line()).toBe('hello');
  });

  it("a hardware key's character is xterm's to send: not sent twice", () => {
    vi.useFakeTimers();
    try {
      const t = setup('');
      t.fire('keydown', { keyCode: 65, key: 'a' });
      t.fire('keypress', { key: 'a' });
      t.ta.value = 'a';
      t.fire('input', { inputType: 'insertText', data: 'a', isComposing: false });
      expect(t.sent).toEqual([]);
      vi.runAllTimers();
      // A key that moves along the line: the field starts over.
      t.fire('keydown', { keyCode: 37, key: 'ArrowLeft' });
      expect(t.ta.value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a paste over a selection takes the selection back first', () => {
    const t = setup('');
    t.typeApp('echo old');
    t.fire('beforeinput', { inputType: 'insertFromPaste' });
    t.ta.value = 'echo new';
    t.fire('input', { inputType: 'insertFromPaste', isComposing: false });
    expect(t.pasted).toEqual(['new']);
    expect(t.sent.at(-1)).toBe('\x7f\x7f\x7f');
  });

  it('a long line: the field starts over past its limit (the keyboard keeps no huge context)', () => {
    const t = setup('');
    t.ta.value = 'x'.repeat(401);
    t.fire('input', { inputType: 'insertText', isComposing: false });
    expect(t.line()).toBe('x'.repeat(401));
    expect(t.ta.value).toBe('');
  });

  it("events of another field are not its own; once stopped, nothing more is taken", () => {
    const t = setup('');
    const other = new EventTarget();
    const ev = Object.assign(new Event('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'insertLineBreak' });
    // Dispatched at the field's root with another target: the root here is the field itself, so a foreign target is simulated.
    Object.defineProperty(ev, 'target', { value: other });
    t.ta.dispatchEvent(ev);
    expect(t.sent).toEqual([]);
    t.stop();
    t.ta.value = 'gone';
    t.fire('input', { inputType: 'insertText', isComposing: false });
    t.fire('focus', {});
    expect(t.sent).toEqual([]);
  });

  it('focus takes the field as it is: nothing in it is sent again', () => {
    const t = setup('');
    t.ta.value = 'left over';
    t.fire('focus', {});
    t.ta.value = 'left over!';
    t.fire('input', { inputType: 'insertText', isComposing: false });
    expect(t.sent).toEqual(['!']);
  });
});

