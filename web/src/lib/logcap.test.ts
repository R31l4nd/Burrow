import { describe, expect, it } from 'vitest';
import { capLines } from './logcap.js';

describe('the lines of a merged log view (decision 3)', () => {
  it('at most so many of each source: a loud one loses its oldest, a quiet one keeps all; and a cap in all', () => {
    // Source 0 says 8 lines, source 1 says 3, mixed in time.
    const lines = [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0].map((i, n) => ({ i, n }));
    const keys = lines.map((l) => String(l.n).padStart(3, '0'));
    expect(capLines(lines, keys, 5, 100)).toBe(3);
    expect(lines.filter((l) => l.i === 1)).toHaveLength(3);
    expect(lines.filter((l) => l.i === 0).map((l) => l.n)).toEqual([5, 6, 7, 9, 10]);
    expect(keys).toEqual(lines.map((l) => String(l.n).padStart(3, '0')));
    expect(capLines(lines, keys, 5, 4)).toBe(4);
    expect(lines.map((l) => l.n)).toEqual([7, 8, 9, 10]);
  });
});
