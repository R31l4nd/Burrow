import { describe, expect, it } from 'vitest';
import { idPart, textPart } from './routeparts.js';

describe('parts of the address (audit WP-04)', () => {
  it('a malformed escape is no name, not an error', () => {
    expect(textPart('%')).toBeNull();
    expect(textPart('%E0%A4%A')).toBeNull();
    expect(textPart('my%20app')).toBe('my app');
    expect(textPart(undefined)).toBeNull();
  });

  it('an id is a positive whole number', () => {
    expect(idPart('12')).toBe(12);
    expect(idPart('0')).toBeNull();
    expect(idPart('-1')).toBeNull();
    expect(idPart('1e3')).toBeNull();
    expect(idPart('abc')).toBeNull();
  });
});
