import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetPages, lastPages, navOf, navTarget, notePage } from './navmemory.js';

afterEach(() => vi.unstubAllGlobals());

describe('each section keeps its place (report d6ea6c)', () => {
  it('knows the section a page belongs to', () => {
    expect(navOf('/files/2?p=%2Fdata')).toBe('files');
    expect(navOf('/edit/2?p=%2Fdata%2Fa.txt')).toBe('files');
    expect(navOf('/stacks/2/data')).toBe('containers');
    expect(navOf('/logs?t=2:web')).toBe('containers');
    expect(navOf('/logs?t=2::ssh.service')).toBe('hosts');
    expect(navOf('/keys')).toBe('settings');
    expect(navOf('/term/abc')).toBe('term');
    expect(navOf('/hosts/3/stats')).toBe('hosts');
  });
  it("from another section: back where it was; within it, a press goes to the section's start", () => {
    const last = { files: '/files/2?p=%2Fdata' } as Record<string, string>;
    // A folder open, a visit to the terminal, then Files: that folder again.
    expect(navTarget('files', '/term/abc', last)).toBe('/files/2?p=%2Fdata');
    // In Files already: its start.
    expect(navTarget('files', '/files/2?p=%2Fdata', last)).toBe('/files');
    // Never been there: its start.
    expect(navTarget('containers', '/term/abc', last)).toBe('/containers');
  });
});

describe('the last page of each section, this tab', () => {
  it('kept per section; the start page and pages of no section are not; forgotten on sign-out', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    notePage('/files/2?p=%2Fdata');
    notePage('/hosts/3/stats');
    notePage('/');
    notePage('');
    notePage('/nowhere');
    notePage('/files/2?p=%2Fetc');
    expect(lastPages()).toEqual({ files: '/files/2?p=%2Fetc', hosts: '/hosts/3/stats' });
    forgetPages();
    expect(lastPages()).toEqual({});
  });

  it('storage off or broken: nothing kept, every button to its start, nothing thrown', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => '{not json', setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('off'); } });
    expect(lastPages()).toEqual({});
    expect(() => notePage('/files/1')).not.toThrow();
    expect(() => forgetPages()).not.toThrow();
    expect(navTarget('files', '/term/abc', lastPages())).toBe('/files');
  });

  it('every section and the pages that belong to it', () => {
    expect(['/', '/groups/2', '/import', '/sessions', '/apps', '/alerts', '/reports/1', '/snippets', '/audit', '/settings?s=ai', '/share'].map(navOf)).toEqual(['hosts', 'hosts', 'hosts', 'term', 'containers', 'containers', 'containers', 'settings', 'settings', 'settings', null]);
    // Logs of a host's service and a container's together: the containers'.
    expect(navOf('/logs?t=2::ssh.service,3:web')).toBe('containers');
  });
});
