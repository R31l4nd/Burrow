import { describe, expect, it } from 'vitest';
import { cssToHex } from './colorhex.js';

describe('cssToHex', () => {
  it('a colour mixed with the accent, as the browser computes it, as #rrggbb (the status bar ignored it)', () => {
    expect(cssToHex('color(srgb 0.0903922 0.126275 0.109216)')).toBe('#17201c');
    expect(cssToHex('rgb(245, 245, 242)')).toBe('#f5f5f2');
    expect(cssToHex('rgba(0, 0, 0, 1)')).toBe('#000000');
    expect(cssToHex('#ABCDEF')).toBe('#abcdef');
  });
  it('null for what is not a computed colour', () => {
    expect(cssToHex('color-mix(in srgb, #090909 95%, var(--tint))')).toBeNull();
    expect(cssToHex('')).toBeNull();
  });
});
