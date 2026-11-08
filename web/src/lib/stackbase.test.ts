import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@burrow/shared';

// A stack's compose file as it was when editing started, for the review's
// diff (A3-WEB-14): not kept for the next account on the tab, and not
// compared with when someone else changed the file since.
vi.hoisted(() => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
  };
  const el = { lang: 'en', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, appendChild() {} };
  Object.assign(globalThis, {
    sessionStorage: storage,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { documentElement: el, addEventListener() {}, querySelector: () => null, createElement: () => el, body: el },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { hash: '' } },
    location: { hash: '', protocol: 'http:', host: 'burrow.test' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
});
const { noteSaved, readBase, rememberBase } = await import('./stackbase.js');
const { setSession } = await import('./session.svelte.js');

const as = (id: number | null): AuthState => ({ setupRequired: false, user: id === null ? null : ({ id, username: `u${id}`, role: 'admin' } as AuthState['user']) }) as AuthState;

beforeEach(() => sessionStorage.clear());

describe("a stack's base for the review", () => {
  it('is kept while the file is as it was, or as this tab saved it', () => {
    rememberBase(1, '/s/compose.yaml', 'A', 'hA');
    noteSaved(1, '/s/compose.yaml', 'hB');
    // Editing again, the file as this tab left it: the base from the start stays.
    rememberBase(1, '/s/compose.yaml', 'B', 'hB');
    expect(readBase(1, '/s/compose.yaml')).toBe('A');
    rememberBase(1, '/s/compose.yaml', 'A', 'hA');
    expect(readBase(1, '/s/compose.yaml')).toBe('A');
  });

  it('is dropped when the file changed elsewhere since (a deploy from another place, days later)', () => {
    rememberBase(1, '/s/compose.yaml', 'A', 'hA');
    rememberBase(1, '/s/compose.yaml', 'C', 'hC');
    expect(readBase(1, '/s/compose.yaml')).toBe('C');
  });

  it('goes when another account signs in on the tab (it can hold secrets)', () => {
    setSession(as(1));
    rememberBase(1, '/s/compose.yaml', 'A', 'hA');
    setSession(as(null));
    setSession(as(2));
    expect(readBase(1, '/s/compose.yaml')).toBeNull();
  });
});
