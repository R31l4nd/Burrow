import { describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@burrow/shared';

// The stores need a page; a bare stand-in of what they touch.
vi.hoisted(() => {
  const el = { lang: 'en', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, appendChild() {} };
  Object.assign(globalThis, {
    document: { documentElement: el, addEventListener() {}, querySelector: () => null, createElement: () => el, body: el },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { hash: '' } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '', protocol: 'http:', host: 'burrow.test' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
});
const { bug } = await import('./bugreport.svelte.js');
const { clipboard, transfers } = await import('./files.svelte.js');
const { activity } = await import('./activity.svelte.js');
const { keepWhenUnsaved, session, setSession } = await import('./session.svelte.js');

const as = (id: number | null): AuthState => ({ setupRequired: false, user: id === null ? null : ({ id, username: `u${id}`, role: 'admin' } as AuthState['user']) }) as AuthState;

describe('one account after another in the same page', () => {
  it("leaves nothing of the first: its report, screenshot, recording, copied files, transfers or activity (AUDIT2 WEB-01)", () => {
    setSession(as(1));
    bug.open = true;
    bug.shot = 'data:image/png;base64,AAAA';
    bug.dialog = 'files-1';
    clipboard.hostId = 3;
    clipboard.paths = ['/etc/secret'];
    transfers.items.push({ id: 't1' } as never);
    activity.ops = [{ id: 'op' } as never];
    // Signed out (or the session ran out), then someone else signs in.
    setSession(as(null));
    setSession(as(2));
    expect(bug).toMatchObject({ open: false, shot: null, dialog: null, recording: null });
    expect(clipboard).toMatchObject({ hostId: null, paths: [] });
    expect(transfers.items).toEqual([]);
    expect(activity.ops).toEqual([]);
  });
});

describe('signed out while a page holds unsaved work (audit 2026-11-05)', () => {
  it('the page is kept for the same person, nothing of the account reset; another who signs in gets nothing of it', () => {
    let unsaved = true;
    keepWhenUnsaved(() => unsaved);
    setSession(as(1));
    clipboard.hostId = 3;
    clipboard.paths = ['/etc/kept'];
    // The sign-in ran out: kept, with the sign-in over it.
    setSession(as(null));
    expect(session.keptFor).toBe(1);
    expect(session.state?.user).toBeNull();
    expect(clipboard.paths).toEqual(['/etc/kept']);
    // Asked again meanwhile (another socket, another read): still kept, even with the work no longer counted.
    unsaved = false;
    setSession(as(null));
    expect(session.keptFor).toBe(1);
    // The same person signs in again: the page as it was.
    setSession(as(1));
    expect(session.keptFor).toBeNull();
    expect(clipboard.paths).toEqual(['/etc/kept']);
    // Kept again, and then someone else signs in: nothing of the first.
    unsaved = true;
    setSession(as(null));
    setSession(as(2));
    expect(session.keptFor).toBeNull();
    expect(clipboard).toMatchObject({ hostId: null, paths: [] });
    // Signed out on purpose: not kept.
    setSession(as(null), false);
    expect(session.keptFor).toBeNull();
    keepWhenUnsaved(() => false);
  });
});
