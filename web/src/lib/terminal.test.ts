import { describe, expect, it } from 'vitest';
import { applyModifiers, DEFAULT_BAR, parseBar, volumeUpKey } from './terminal.js';

describe('key bar', () => {
  it('parses named keys and literal characters', () => {
    const keys = parseBar(DEFAULT_BAR);
    expect(keys.map((k) => k.label)).toEqual(['Esc', 'Tab', 'Ctrl', 'Alt', 'Left', 'Down', 'Up', 'Right', '|', '~', '/', '-']);
    expect(keys[4]).toMatchObject({ icon: 'arrow-left' });
    expect(keys[0]).toMatchObject({ send: '\x1b' });
    expect(parseBar('ESC  pgup  x')).toMatchObject([{ label: 'Esc' }, { send: '\x1b[5~' }, { label: 'x', send: 'x' }]);
  });

  it('the keys that move or delete a step repeat when held; Enter, Esc, Tab and characters do not (report 0bc1fe)', () => {
    const held = (layout: string) => parseBar(layout).map((k) => !!k.repeat);
    expect(held('left down up right bs del pgup pgdn ctrl+left shift+up alt+bs')).toEqual(Array(11).fill(true));
    expect(held('esc tab enter ctrl alt home end f1 x ~ ctrl+c shift+tab')).toEqual(Array(12).fill(false));
  });

  it('applies sticky Ctrl and Alt', () => {
    expect(applyModifiers('c', true, false)).toBe('\x03');
    expect(applyModifiers('C', true, false)).toBe('\x03');
    expect(applyModifiers('[', true, false)).toBe('\x1b');
    expect(applyModifiers('b', false, true)).toBe('\x1bb');
    expect(applyModifiers('x', true, true)).toBe('\x1b\x18');
    // Ctrl does nothing to multi-character input such as a pasted word.
    expect(applyModifiers('ls', true, false)).toBe('ls');
  });
});

describe('key combinations', () => {
  const one = (tok: string) => parseBar(tok)[0]!;

  it('shift+tab sends back-tab', () => {
    expect(one('shift+tab')).toEqual({ label: 'Shift+Tab', send: '\x1b[Z' });
  });

  it('builds control characters, Alt prefixes and modified cursor keys', () => {
    expect(one('ctrl+c')).toEqual({ label: 'Ctrl+C', send: '\x03' });
    expect(one('Ctrl+D').send).toBe('\x04');
    expect(one('alt+bs')).toEqual({ label: 'Alt+Backspace', send: '\x1b\x7f', icon: 'backspace', prefix: 'Alt+', repeat: true });
    expect(one('ctrl+left').send).toBe('\x1b[1;5D');
    expect(one('shift+up').send).toBe('\x1b[1;2A');
    expect(one('ctrl+del').send).toBe('\x1b[3;5~');
    expect(one('alt+.').send).toBe('\x1b.');
  });

  it('knows backspace, delete and function keys', () => {
    expect(one('bs')).toEqual({ label: 'Backspace', send: '\x7f', icon: 'backspace', repeat: true });
    expect(one('del').send).toBe('\x1b[3~');
    expect(one('f1').send).toBe('\x1bOP');
    expect(one('f12').send).toBe('\x1b[24~');
  });

  it('treats anything unknown as literal text', () => {
    expect(one('+')).toEqual({ label: '+', send: '+' });
    expect(one('super+x')).toEqual({ label: 'super+x', send: 'super+x' });
    expect(one('ls')).toEqual({ label: 'ls', send: 'ls' });
  });
});

describe('volume up, then a key', () => {
  it('gives the keys a phone keyboard lacks', () => {
    expect(volumeUpKey('w')).toBe('\x1b[A');
    expect(volumeUpKey('A')).toBe('\x1b[D');
    expect(volumeUpKey('e')).toBe('\x1b');
    expect(volumeUpKey('t')).toBe('\t');
    expect(volumeUpKey('1')).toBe('\x1bOP');
    expect(volumeUpKey('9')).toBe('\x1b[20~');
    expect(volumeUpKey('x')).toBe('x');
  });
});
