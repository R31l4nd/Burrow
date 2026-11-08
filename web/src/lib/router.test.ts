import { describe, expect, it, vi } from 'vitest';

// The hash router against a small stand-in for the browser: a tab's history
// (entries with their state), location.hash, and hashchange fired a moment
// later as a browser does. What is checked is the router's: where the tab
// ends up, what the page sees, and when it asks before leaving unsaved work.
const tab = vi.hoisted(() => {
  const entries: { hash: string; state: unknown }[] = [{ hash: '#/hosts', state: null }];
  let at = 0;
  const listeners: (() => void)[] = [];
  const fire = () => setTimeout(() => listeners.forEach((l) => l()), 0);
  const location = {
    get hash() {
      return entries[at]!.hash;
    },
    set hash(h: string) {
      const next = h.startsWith('#') ? h : `#${h}`;
      if (next === entries[at]!.hash) return;
      entries.splice(at + 1);
      entries.push({ hash: next, state: null });
      at++;
      fire();
    },
  };
  const history = {
    get state() {
      return entries[at]!.state;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      entries[at] = { hash: url ?? entries[at]!.hash, state };
    },
    go(n: number) {
      const before = entries[at]!.hash;
      at = Math.max(0, Math.min(entries.length - 1, at + n));
      if (entries[at]!.hash !== before) fire();
    },
    back() {
      this.go(-1);
    },
  };
  const scroll = { y: 0, to: [] as number[] };
  Object.assign(globalThis, {
    document: { documentElement: { lang: 'en', scrollHeight: 5000 } },
    location,
    history,
    window: { addEventListener: (type: string, fn: () => void) => type === 'hashchange' && listeners.push(fn) },
    innerHeight: 800,
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    scrollTo: (_x: number, y: number) => (scroll.to.push(y), (scroll.y = y)),
  });
  Object.defineProperty(globalThis, 'scrollY', { get: () => scroll.y, configurable: true });
  /** A link followed or an address typed: a new entry, without the router's number on it. */
  const open = (hash: string) => (location.hash = hash);
  return { entries, open, at: () => at, location, history, scroll };
});

const { route, go, goFrom, guardLeave, here, to, unsavedHere, up } = await import('./router.svelte.js');
const { asking, answered } = await import('./confirm.svelte.js');

const settle = () => new Promise((r) => setTimeout(r, 5));
const asked = async () => {
  await vi.waitFor(() => expect(asking.q).not.toBeNull());
  return asking.q!.text;
};

describe('the hash router', () => {
  it('says whether a page holds unsaved work, whatever page would come next (audit 2026-11-05)', () => {
    expect(unsavedHere()).toBe(false);
    let dirty = true;
    const stop = guardLeave(() => (dirty ? 'Leave anyway?' : null));
    expect(unsavedHere()).toBe(true);
    dirty = false;
    expect(unsavedHere()).toBe(false);
    dirty = true;
    stop();
    expect(unsavedHere()).toBe(false);
  });

  it('reads the page, its parts and its query from the address; numbers each entry of the history', async () => {
    expect(route.path).toBe('/hosts');
    expect((tab.history.state as { burrowEntry: number }).burrowEntry).toBe(0);
    go('/files/3?p=%2Fetc&sort=name');
    await settle();
    expect(route.path).toBe('/files/3?p=%2Fetc&sort=name');
    expect(route.parts).toEqual(['files', '3']);
    expect(route.query).toEqual({ p: '/etc', sort: 'name' });
    expect(here()).toBe(route.path);
    expect((tab.history.state as { burrowEntry: number }).burrowEntry).toBe(1);
    expect(to('/files/3', { p: '/etc' })).toBe('/files/3?p=%2Fetc');
  });

  it('Back comes to where the page before was scrolled; a new page is left where it is (report 78bf46)', async () => {
    go('/settings');
    await settle();
    // Down the list, then into one of its parts.
    tab.scroll.y = 1200;
    go('/settings/users');
    await settle();
    tab.scroll.y = 0;
    tab.scroll.to.length = 0;
    tab.history.back();
    await settle();
    await vi.waitFor(() => expect(tab.scroll.to).toEqual([1200]));
    expect(route.path).toBe('/settings');
    // Forward again: where the part was (the top), not moved.
    tab.scroll.to.length = 0;
    tab.history.go(1);
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(tab.scroll.to).toEqual([]);
  });

  it('go to the page shown already makes no new entry', async () => {
    const n = tab.entries.length;
    go(route.path);
    await settle();
    expect(tab.entries.length).toBe(n);
  });

  it('after something slow, on to the next page only when the person is still where it started (AUDIT2 PAGE-17)', async () => {
    go('/hosts/1/edit');
    await settle();
    const from = here();
    go('/settings');
    await settle();
    goFrom(from, '/hosts');
    await settle();
    expect(route.path).toBe('/settings');
    goFrom('/settings', '/keys');
    await settle();
    expect(route.path).toBe('/keys');
  });

  it("a page's own Back goes back in history when the page before is its parent, else on to the parent (report 87f290)", async () => {
    go('/containers');
    await settle();
    go('/containers/1/abc');
    await settle();
    const n = tab.entries.length;
    up('/containers');
    await settle();
    expect(route.path).toBe('/containers');
    // Gone back, not a new entry: Forward is still there.
    expect(tab.entries.length).toBe(n);
    expect(tab.at()).toBe(n - 2);

    // Opened from elsewhere (a push, a link): its parent is opened as a new page.
    go('/alerts');
    await settle();
    go('/containers/1/abc');
    await settle();
    up('/containers');
    await settle();
    expect(route.path).toBe('/containers');
    expect(tab.entries.at(-1)!.hash).toBe('#/containers');
    expect(tab.entries.at(-2)!.hash).toBe('#/containers/1/abc');
  });

  it('unsaved work: the page stays while the app asks; kept, nothing changes, and the history has no extra entry (AUDIT2 WEB-13)', async () => {
    go('/hosts/2/edit');
    await settle();
    const n = tab.entries.length;
    const stop = guardLeave((next) => (next === '/hosts/2/edit' ? null : 'Leave without saving?'));
    go('/settings');
    expect(await asked()).toBe('Leave without saving?');
    await settle();
    // Back over the new entry while asking: the page and the address are the editor's.
    expect(tab.location.hash).toBe('#/hosts/2/edit');
    expect(route.path).toBe('/hosts/2/edit');
    answered(null);
    await settle();
    expect(route.path).toBe('/hosts/2/edit');
    expect(tab.at()).toBe(n - 1);
    stop();
  });

  it('unsaved work: "leave" goes on to where the person was going, asked once', async () => {
    const stop = guardLeave(() => 'Leave without saving?');
    go('/keys/9');
    await asked();
    answered('');
    await settle();
    await settle();
    expect(route.path).toBe('/keys/9');
    expect(asking.q).toBeNull();
    stop();
  });

  it('unsaved work and the browser\'s Back: undone by going forward again, then asked', async () => {
    go('/snippets');
    await settle();
    go('/snippets/4/edit');
    await settle();
    const stop = guardLeave((next) => (next === '/snippets/4/edit' ? null : 'Unsaved'));
    const n = tab.at();
    tab.history.back();
    await asked();
    await settle();
    expect(tab.at()).toBe(n);
    expect(route.path).toBe('/snippets/4/edit');
    answered('');
    await settle();
    await settle();
    expect(route.path).toBe('/snippets');
    stop();
  });

  it('unsaved work and an entry without the router\'s number (an address typed): back over it, and asked', async () => {
    const stop = guardLeave(() => 'Unsaved');
    const before = route.path;
    tab.open('#/audit');
    await asked();
    await settle();
    expect(route.path).toBe(before);
    expect(tab.location.hash).toBe(`#${before}`);
    answered(null);
    stop();
    await settle();
  });

  it('an entry without a number reached with no guard gets the next number', async () => {
    tab.open('#/reports');
    await settle();
    expect(route.path).toBe('/reports');
    expect(typeof (tab.history.state as { burrowEntry?: number }).burrowEntry).toBe('number');
  });

  it('the start page is "/"', async () => {
    tab.open('#');
    await settle();
    expect(route.path).toBe('/');
    expect(route.parts).toEqual([]);
  });
});
