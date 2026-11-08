import { describe, expect, it } from 'vitest';
import { renamedTab } from './wstabs.js';

describe("a workspace tab whose file was renamed (audit 2026-11-05)", () => {
  it('keeps its side of a split editor and its preview mark; its editor is made anew for the new path', () => {
    const state = { dirty: false, rev: 3 };
    const tab = { path: 'old.txt', state, group: 1 as const, preview: true, pane: { isDirty: () => false } };
    const next = renamedTab(tab, 'new.txt');
    expect(next).toEqual({ path: 'new.txt', state: { dirty: false, rev: 3 }, group: 1, preview: true });
    expect(next.state).not.toBe(state);
    expect('pane' in next).toBe(false);
  });
});
