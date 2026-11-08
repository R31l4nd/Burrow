import { describe, expect, it } from 'vitest';
import { shownAt, stepFrom } from './gallery.js';

// The picture viewer over a folder that is read again by itself (Files, every ten seconds): the
// picture shown is followed by its path, not by its place in the list (audit 2026-11-05).
describe('the picture shown in a gallery', () => {
  const a = { path: '/p/a.png' };
  const b = { path: '/p/b.png' };
  const c = { path: '/p/c.png' };

  it('a picture added before it: still the same one, at its new place', () => {
    expect(shownAt([a, c], c.path)).toBe(1);
    expect(shownAt([a, b, c], c.path)).toBe(2);
  });

  it('steps from where it is now, round at the ends', () => {
    expect(stepFrom([a, b, c], b.path, 1)).toBe(c);
    expect(stepFrom([a, b, c], a.path, -1)).toBe(c);
    expect(stepFrom([a, b, c], c.path, 1)).toBe(a);
  });

  it('gone from the folder: not in the list (it stays on screen until closed); a step goes to the first', () => {
    expect(shownAt([a, c], b.path)).toBe(-1);
    expect(stepFrom([a, c], b.path, 1)).toBe(a);
    expect(stepFrom([], b.path, 1)).toBeUndefined();
  });
});
