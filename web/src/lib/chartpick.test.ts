import { describe, expect, it } from 'vitest';
import { nearestIndex, placeOf } from './chartpick.js';

// A chart placed by time picks by time too: picked by index, the moment shown was not the one under
// the cursor where samples have a gap (report af0eec).
describe('chart picking', () => {
  const at = [0, 10, 20, 100]; // a gap before the last
  it('the place of a sample along the width', () => {
    expect(placeOf(at, 0)).toBe(0);
    expect(placeOf(at, 2)).toBe(0.2);
    expect(placeOf(at, 3)).toBe(1);
    expect(placeOf([5], 0)).toBe(0);
  });
  it('the sample nearest in time to a place, not by its index', () => {
    expect(nearestIndex(at, 0)).toBe(0);
    expect(nearestIndex(at, 0.14)).toBe(1);
    expect(nearestIndex(at, 0.5)).toBe(2);
    expect(nearestIndex(at, 0.7)).toBe(3);
    expect(nearestIndex(at, 1.4)).toBe(3);
    expect(nearestIndex(at, -1)).toBe(0);
  });
});
