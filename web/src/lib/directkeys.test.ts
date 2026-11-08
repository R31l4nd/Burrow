import { describe, expect, it, vi } from 'vitest';

// i18n sets the page's language; a bare stand-in of what it touches.
vi.hoisted(() => {
  Object.assign(globalThis, {
    document: { documentElement: { lang: 'en' } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});
const shown: [string, string][] = [];
vi.mock('./ui.svelte.js', () => ({ toast: (text: string, kind = 'info') => shown.push([kind, text]) }));
const { sayDirectKeys } = await import('./directkeys.js');

describe('phone keys left behind by a host change', () => {
  it('says which phones keep a key on the old account and which lost the route (AUDIT2 MON-01)', () => {
    sayDirectKeys(undefined);
    sayDirectKeys({ id: 1, name: 'h' });
    expect(shown).toEqual([]);
    sayDirectKeys({ directKeys: { left: ['Pixel', 'Tab'], notOn: ['Fold'] } });
    expect(shown).toEqual([
      ['error', expect.stringContaining('Pixel, Tab')],
      ['error', expect.stringContaining('Fold')],
    ]);
  });
});
