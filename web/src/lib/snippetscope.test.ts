import { describe, expect, it } from 'vitest';
import type { Snippet } from '@burrow/shared';
import { snippetsFor } from './snippetscope.js';

const s = (id: number, o: Partial<Snippet>): Snippet => ({ id, name: `s${id}`, command: 'x', description: null, hostId: null, groupId: null, ...o }) as Snippet;

describe('the snippets for a host', () => {
  it('those of every group above it too, the same for the completion as for the picker (AUDIT2 TERM-20)', () => {
    const groups = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: null }];
    const all = [s(1, {}), s(2, { groupId: 1 }), s(3, { groupId: 2 }), s(4, { groupId: 3 }), s(5, { hostId: 7 }), s(6, { hostId: 8 })];
    expect(snippetsFor(all, { id: 7, groupId: 2 }, groups).map((x) => x.id)).toEqual([1, 2, 3, 5]);
  });
});
