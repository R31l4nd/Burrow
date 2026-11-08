import { describe, expect, it } from 'vitest';
import { lastSeen, remember } from './lastseen.js';

// What a page showed last, shown at once when it opens again.
describe('what a page showed last', () => {
  it('kept by its key; the oldest go after a few hundred', () => {
    expect(lastSeen('stack:1:web')).toBeNull();
    expect(remember('stack:1:web', { services: 2 })).toEqual({ services: 2 });
    expect(lastSeen('stack:1:web')).toEqual({ services: 2 });
    for (let i = 0; i < 300; i++) remember(`folder:${i}`, i);
    expect(lastSeen('stack:1:web')).toBeNull();
    expect(lastSeen('folder:0')).toBe(0);
    expect(lastSeen('folder:299')).toBe(299);
    remember('folder:300', 300);
    expect(lastSeen('folder:0')).toBeNull();
  });
});
