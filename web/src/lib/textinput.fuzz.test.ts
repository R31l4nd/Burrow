import { describe, expect, it } from 'vitest';
import { diffEdit, editBytes } from './textinput.js';

// Whatever a soft keyboard does to its field (typing, a correction, a
// picked suggestion, backspace, a word deleted, a paste, emoji), the
// terminal's line must end up exactly as the field: thousands of random
// edits, each applied to a stand-in for the shell's line editor.

/** A line editor as a shell has one: backspace takes one character, the rest is typed. */
function applyToLine(line: string[], bytes: string): string[] {
  const out = [...line];
  for (const ch of bytes) {
    if (ch === '\x7f') out.pop();
    else out.push(ch);
  }
  return out;
}

// A seeded random, so a failure can be run again.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const WORDS = ['ls', 'echo', 'docker', 'ps', 'git', 'status', 'tmux', 'attach', '-t', 'claude', 'sturen', 'wrld', 'world', 'grep', '|', '"quoted"', 'naive', 'café', '\u{1f44d}', 'ü', '$HOME', '&&'];

function edit(field: string, r: () => number): string {
  const chars = [...field];
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  switch (Math.floor(r() * 7)) {
    case 0: // a character typed
      return field + pick([...'abcdefghijklmnopqrstuvwxyz0123456789 -./|$é\u{1f44d}']);
    case 1: // backspace
      return chars.slice(0, -1).join('');
    case 2: // a word typed or a suggestion picked
      return field + pick(WORDS) + (r() < 0.5 ? ' ' : '');
    case 3: { // a correction: the last word replaced
      const at = field.trimEnd().lastIndexOf(' ') + 1;
      return field.slice(0, at) + pick(WORDS) + (field.endsWith(' ') ? ' ' : '');
    }
    case 4: { // the last word deleted (a long press on backspace)
      const at = field.trimEnd().lastIndexOf(' ') + 1;
      return field.slice(0, at);
    }
    case 5: // a paste
      return field + pick(WORDS) + ' ' + pick(WORDS);
    default: { // a change in the middle (the keyboard moved its cursor)
      const at = Math.floor(r() * (chars.length + 1));
      return [...chars.slice(0, at), pick([...'xyz']), ...chars.slice(at)].join('');
    }
  }
}

describe('soft keyboard edits, at random', () => {
  it('the shell line always equals the keyboard field', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      let field = '';
      let line: string[] = [];
      for (let step = 0; step < 60; step++) {
        const next = edit(field, r);
        line = applyToLine(line, editBytes(diffEdit(field, next)));
        field = next;
        expect(line.join(''), `seed ${seed}, step ${step}`).toBe(field);
      }
    }
  });

  it('never sends anything for no change, and never more backspaces than there is text', () => {
    const r = rng(7);
    let field = '';
    for (let step = 0; step < 2000; step++) {
      const next = edit(field, r);
      const e = diffEdit(field, next);
      expect(e.back).toBeLessThanOrEqual([...field].length);
      if (next === field) expect(editBytes(e)).toBe('');
      field = next;
    }
  });
});
