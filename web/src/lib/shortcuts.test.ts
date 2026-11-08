import { describe, expect, it, vi } from 'vitest';
import { en } from './i18n/en.js';
import { onShortcutKey, shortcutGroups, shortcuts } from './shortcuts.svelte.js';

// "?" opens the overview of the keyboard's shortcuts, unless it is typed into something.
const key = (k: string, inside: string | null, mods: Partial<KeyboardEvent> = {}) => {
  const preventDefault = vi.fn();
  const e = { key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: { closest: (sel: string) => (inside && sel.includes(inside) ? {} : null) }, ...mods, preventDefault };
  onShortcutKey(e as unknown as KeyboardEvent);
  return preventDefault.mock.calls.length > 0;
};

describe('the shortcuts overview', () => {
  it('"?" on the page opens it; typed into a field, the terminal, the editor or a dialog it is a question mark', () => {
    shortcuts.open = false;
    for (const where of ['input', 'textarea', '.xterm', '.cm-editor', 'dialog[open]']) expect(key('?', where)).toBe(false);
    expect(key('?', null, { ctrlKey: true })).toBe(false);
    expect(key('?', null, { defaultPrevented: true })).toBe(false);
    expect(key('/', null)).toBe(false);
    expect(shortcuts.open).toBe(false);
    expect(key('?', null)).toBe(true);
    expect(shortcuts.open).toBe(true);
  });

  it('every group and every shortcut is said in words the app has', () => {
    const groups = shortcutGroups();
    expect(groups.length).toBeGreaterThan(3);
    for (const g of groups) {
      expect(en[g.title]).toBeTruthy();
      for (const s of g.items) {
        expect(en[s.what]).toBeTruthy();
        expect(s.keys.length).toBeGreaterThan(0);
      }
    }
    // Not on a Mac here: Ctrl.
    expect(groups.flatMap((g) => g.items).find((s) => s.what === 'shortcuts.save')!.keys).toEqual(['Ctrl+S']);
  });
});
