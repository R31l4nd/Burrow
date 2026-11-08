import { describe, expect, it } from 'vitest';
import type { Host } from '@burrow/shared';
import { RECENT_FROM, recentHosts } from './recenthosts.js';

const host = (id: number, lastUsedAt: string | null, favorite = false) => ({ id, name: `h${id}`, lastUsedAt, favorite }) as unknown as Host;

describe('recentHosts', () => {
  it('none with a few hosts: they are all in the list right below (live UI round)', () => {
    const few = [host(1, '2026-10-08T10:00:00Z'), host(2, '2026-10-08T11:00:00Z'), host(3, null), host(4, '2026-10-07T09:00:00Z')];
    expect(recentHosts(few)).toEqual([]);
  });
  it('with many: the last used first, favourites and never used left out, at most five', () => {
    const many = Array.from({ length: RECENT_FROM + 2 }, (_, i) => host(i + 1, i < 7 ? `2026-10-0${i + 1}T00:00:00Z` : null, i === 6));
    expect(recentHosts(many).map((h) => h.id)).toEqual([6, 5, 4, 3, 2]);
  });
});
