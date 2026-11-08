import { describe, expect, it } from 'vitest';
import { hangOf } from './hanging.js';

// A wrapped line goes on under its own text, not at column 0: a YAML list
// item's "-" stood alone above its value on a phone (A3-WEB-15).
describe('hangOf', () => {
  it('the indentation, and a list marker after it', () => {
    expect(hangOf('plain')).toBe(0);
    expect(hangOf('    key: value')).toBe(4);
    expect(hangOf('    - ${SERVER_IP:?SERVER_IP is not set}')).toBe(6);
    expect(hangOf('* item')).toBe(2);
    expect(hangOf('\tx', 4)).toBe(4);
    expect(hangOf('-not a list')).toBe(0);
  });

  it('never more than half a narrow screen', () => {
    expect(hangOf(' '.repeat(200) + 'x')).toBe(40);
  });
});
