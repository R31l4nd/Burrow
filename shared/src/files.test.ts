import { describe, expect, it } from 'vitest';
import { absPath } from './files.js';

describe('paths', () => {
  it('only absolute ones: a leading "-" was an option to find, du and tar on the host', () => {
    for (const ok of ['/', '/home/me/a b.txt', '/x/../y']) expect(absPath.safeParse(ok).success).toBe(true);
    for (const bad of ['-delete', '--help', 'work', '~/work', '', '/a\0b']) expect(absPath.safeParse(bad).success).toBe(false);
  });
});
