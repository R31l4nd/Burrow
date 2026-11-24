import { describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@burrow/shared';

// What one account saw, gone when another signs in on the same tab (audit 2026-11-23: an operator
// saw the admin's folder listing, keys, report count and sessions until each was read again).
vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } }, location: { hash: '', pathname: '/', search: '', protocol: 'http:', host: 'burrow.test' }, window: { addEventListener() {}, innerWidth: 1200, innerHeight: 800 } });
});
const { setSession } = await import('./session.svelte.js');
const { data } = await import('./data.svelte.js');
const { lastSeen, remember } = await import('./lastseen.js');
const { hints } = await import('./hints.svelte.js');
const { terms } = await import('./sessions.svelte.js');

const as = (id: number | null) => ({ setupRequired: false, user: id === null ? null : { id, username: `u${id}` } }) as unknown as AuthState;

describe('another account on the same tab', () => {
  it('starts from nothing of the last one', () => {
    setSession(as(1));
    Object.assign(data, { hosts: [{ id: 1, name: 'nas' }], keys: [{ id: 1, name: 'admin key' }], loaded: true });
    remember('files:3:/etc', ['shadow']);
    hints.h = { openReports: 4 } as never;
    terms.list = [{ id: 's1' }] as never;
    setSession(as(null), false);
    setSession(as(2));
    expect(data.hosts).toEqual([]);
    expect(data.keys).toEqual([]);
    expect(data.loaded).toBe(false);
    expect(lastSeen('files:3:/etc')).toBeNull();
    expect(hints.h).toBeNull();
    expect(terms.list).toEqual([]);
  });
});
