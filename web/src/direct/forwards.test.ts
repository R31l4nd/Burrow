import { describe, expect, it } from 'vitest';
import { isHttps, keptSchemes, withScheme } from './forwards.js';

describe('the scheme a port forward opens with (AUDIT2 TERM-17)', () => {
  it('as chosen when started, whatever the port', () => {
    let s = withScheme({}, 'a', true);
    s = withScheme(s, 'b', false);
    expect(isHttps(s, { forwardId: 'a', targetPort: 8443 })).toBe(true);
    expect(isHttps(s, { forwardId: 'b', targetPort: 443 })).toBe(false);
  });

  it('guessed from the port only for a forward started elsewhere', () => {
    expect(isHttps({}, { forwardId: 'x', targetPort: 443 })).toBe(true);
    expect(isHttps({}, { forwardId: 'x', targetPort: 8080 })).toBe(false);
  });

  it('a stopped forward takes its choice along', () => {
    expect(keptSchemes({ a: true, b: false }, ['b'])).toEqual({ b: false });
  });
});
