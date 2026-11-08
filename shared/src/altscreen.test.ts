import { describe, expect, it } from 'vitest';
import { AltScreenFilter } from './altscreen.js';

describe('the alternate screen, left out of a session without tmux', () => {
  it('takes the switches out and keeps everything else', () => {
    const f = new AltScreenFilter();
    expect(f.write('before\x1b[?1049hdrawn\x1b[?1049lafter')).toBe('beforedrawnafter');
    expect(f.write('\x1b[?47h\x1b[?1047l\x1b[?25h')).toBe('\x1b[?25h');
    expect(f.write('\x1b[?1000h mouse on stays')).toBe('\x1b[?1000h mouse on stays');
  });

  it('a switch cut between two chunks is still taken out', () => {
    const f = new AltScreenFilter();
    expect(f.write('text\x1b[?10')).toBe('text');
    expect(f.write('49hmore')).toBe('more');
    expect(f.write('end\x1b')).toBe('end');
    expect(f.write('[1mbold')).toBe('\x1b[1mbold');
  });

  it('in a list with other modes too, those others kept; split anywhere (AUDIT2 AI-16)', () => {
    const seq = 'a\x1b[?25;1049hb\x1b[?1049;1000lc\x1b[?47h';
    expect(new AltScreenFilter().write(seq)).toBe('a\x1b[?25hb\x1b[?1000lc');
    for (let i = 1; i < seq.length; i++) {
      const f = new AltScreenFilter();
      expect(f.write(seq.slice(0, i)) + f.write(seq.slice(i)), `split at ${i}`).toBe('a\x1b[?25hb\x1b[?1000lc');
    }
  });
});

describe('whether a program is on its alternate screen (review 2026-10-24)', () => {
  it('follows the switches it takes out, also cut over chunks', () => {
    const f = new AltScreenFilter();
    expect(f.on).toBe(false);
    f.write('less x\r\n\x1b[?1049h');
    expect(f.on).toBe(true);
    f.write('\x1b[?10');
    f.write('49l$ ');
    expect(f.on).toBe(false);
    f.write('\x1b[?25;47h');
    expect(f.on).toBe(true);
  });
});
