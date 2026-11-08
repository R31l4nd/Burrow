import { describe, expect, it } from 'vitest';
import { compareVersions } from './version.js';

describe('compareVersions', () => {
  it('orders by number, not by text: an older version is not an update (UIA-21)', () => {
    expect(compareVersions('1.2.0', '2.0.2')).toBe(-1);
    expect(compareVersions('2.0.10', '2.0.9')).toBe(1);
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0);
    expect(compareVersions('2.1.0-rc.1', '2.1.0')).toBe(0);
  });
});
