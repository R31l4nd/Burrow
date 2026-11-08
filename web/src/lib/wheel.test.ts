import { describe, expect, it } from 'vitest';
import { fingerSpeed, speedUp } from './wheel.js';

describe('a finger scrolling on the host', () => {
  it('goes line for line when slow, up to four times when fast, either way', () => {
    expect(speedUp(0)).toBe(1);
    expect(speedUp(0.3)).toBe(1);
    expect(speedUp(-0.3)).toBe(1);
    expect(speedUp(1.2)).toBeGreaterThan(1);
    expect(speedUp(1.2)).toBeLessThan(4);
    expect(speedUp(-1.2)).toBe(speedUp(1.2));
    expect(speedUp(5)).toBe(4);
  });

  it('reads the speed from the touches, not from one alone', () => {
    expect(fingerSpeed([])).toBe(0);
    expect(fingerSpeed([{ y: 100, t: 0 }])).toBe(0);
    expect(fingerSpeed([{ y: 100, t: 0 }, { y: 200, t: 50 }])).toBe(2);
    expect(fingerSpeed([{ y: 200, t: 0 }, { y: 150, t: 100 }])).toBe(-0.5);
  });
});
