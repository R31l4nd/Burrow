import { beforeEach, describe, expect, it, vi } from 'vitest';

// Favourite folders of the phone (report 9980fa): kept on the phone, never sent anywhere.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });

beforeEach(() => {
  store.clear();
  vi.resetModules();
});

describe("the phone's favourite folders (report 9980fa)", () => {
  it('a folder starred is kept on the phone, and starred again is taken off', async () => {
    const { isPhoneFavorite, phoneFavorites, togglePhoneFavorite } = await import('./phonefavorites.svelte.js');
    const f = { path: '/0123456789abcdef/Download', name: 'Download', root: 'Internal storage' };
    expect(togglePhoneFavorite(f)).toBe(true);
    expect(isPhoneFavorite(f.path)).toBe(true);
    expect(JSON.parse(store.get('burrow.phoneFavorites')!)).toEqual([f]);
    expect(togglePhoneFavorite(f)).toBe(false);
    expect(phoneFavorites.list).toEqual([]);
  });

  it('what was kept comes back; anything that is not a phone folder is left out', async () => {
    store.set('burrow.phoneFavorites', JSON.stringify([{ path: '/0123456789abcdef/Music', name: 'Music', root: 'Internal storage' }, { path: '/etc', name: 'etc', root: 'x' }, null, 'x']));
    const { phoneFavorites } = await import('./phonefavorites.svelte.js');
    expect(phoneFavorites.list.map((f) => f.name)).toEqual(['Music']);
  });

  it('a broken store reads as none', async () => {
    store.set('burrow.phoneFavorites', '{not json');
    const { phoneFavorites } = await import('./phonefavorites.svelte.js');
    expect(phoneFavorites.list).toEqual([]);
  });
});
