import { describe, expect, it } from 'vitest';
import { composePlan, oneLine, pasteSafely } from './pastesafe.js';

describe('putting text on the line without running it', () => {
  it('an AI answer with a carriage return in it: no Enter goes out', () => {
    expect(oneLine('echo harmless\r echo unexpected')).toBe('echo harmless  echo unexpected');
    expect(oneLine('ls\x1b[2J\x03')).toBe('ls[2J');
  });

  it('a multi-line snippet pasted: to the text box, also where the shell asks for marked pastes (a tmux hands them over unmarked)', () => {
    expect(pasteSafely('echo a\necho b')).toEqual({ stage: 'echo a\necho b' });
    expect(pasteSafely('echo a\r\necho b')).toEqual({ stage: 'echo a\necho b' });
    expect(pasteSafely('echo one')).toEqual({ send: 'echo one' });
    expect(pasteSafely('a\x1b[201~')).toEqual({ send: 'a[201~' });
  });
});

describe("the text box's Send", () => {
  it('held (onto the line, not run) with several lines and no bracketed paste: nothing runs, the text stays in the box (AUDIT2 TERM-02)', () => {
    expect(composePlan('echo one\necho two', false, false)).toEqual({ keep: true });
  });
  it('several lines as one marked paste where the program asks; run: each line with its Enter otherwise; one line as typed', () => {
    expect(composePlan('echo one\necho two', true, true)).toEqual({ paste: 'echo one\necho two', enter: true });
    // Held: not even as a marked paste (a tmux hands it over unmarked when the pane's shell does not ask).
    expect(composePlan('echo one\necho two', false, true)).toEqual({ keep: true });
    expect(composePlan('echo one\r\necho two', true, false)).toEqual({ type: 'echo one\recho two\r' });
    expect(composePlan('echo one', false, false)).toEqual({ type: 'echo one' });
    expect(composePlan('echo one', true, false)).toEqual({ type: 'echo one\r' });
  });
});
