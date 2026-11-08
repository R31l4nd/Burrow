import { describe, expect, it } from 'vitest';
import { stackOpInput } from './stacks.js';

describe('a stack operation', () => {
  it('only these services is at least one; left out is the default (AUDIT2 DO-22)', () => {
    expect(stackOpInput.safeParse({ op: 'update', services: [] }).success).toBe(false);
    expect(stackOpInput.safeParse({ op: 'update' }).success).toBe(true);
    expect(stackOpInput.parse({ op: 'update', services: ['web'] }).services).toEqual(['web']);
  });
});
