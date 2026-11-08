import { describe, expect, it } from 'vitest';
import { asEditor, lineEnd, withLineEnd } from './eol.js';

describe("a file's own line ends", () => {
  it('finds the line end a file uses most', () => {
    expect(lineEnd('a\r\nb\r\n')).toBe('\r\n');
    expect(lineEnd('a\nb\n')).toBe('\n');
    expect(lineEnd('one line')).toBe('\n');
    expect(lineEnd('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(lineEnd('a\nb\nc\r\n')).toBe('\n');
  });

  it('the editor holds "\\n" only; saved with the file\'s own ends again', () => {
    expect(asEditor('a\r\nb\r\n')).toBe('a\nb\n');
    expect(withLineEnd('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
    expect(withLineEnd('a\nb\n', '\n')).toBe('a\nb\n');
    const file = 'x = 1\r\ny = 2\r\n';
    expect(withLineEnd(asEditor(file), lineEnd(file))).toBe(file);
  });
});
