import { describe, expect, it } from 'vitest';
import { replaceInput, workspaceInput, workspaceSearchInput } from './workspace.js';

describe('workspace requests', () => {
  it('a workspace and a search start at an absolute folder', () => {
    expect(workspaceInput.safeParse({ hostId: 1, root: 'srv/app' }).success).toBe(false);
    expect(workspaceInput.parse({ hostId: 1, root: '/srv/app', name: ' app ' })).toEqual({ hostId: 1, root: '/srv/app', name: 'app' });
    expect(workspaceSearchInput.parse({ root: '/srv', query: 'TODO' })).toEqual({ root: '/srv', query: 'TODO', regex: false, caseSensitive: false });
    expect(workspaceSearchInput.safeParse({ root: '~/app', query: 'x' }).success).toBe(false);
  });

  it('a replace names the files it changes, at least one and at most a thousand', () => {
    const base = { root: '/srv', query: 'a', replacement: 'b' };
    expect(replaceInput.safeParse({ ...base, paths: [] }).success).toBe(false);
    expect(replaceInput.safeParse({ ...base, paths: Array.from({ length: 1001 }, (_, i) => `f${i}`) }).success).toBe(false);
    expect(replaceInput.parse({ ...base, paths: ['a.txt'] })).toMatchObject({ paths: ['a.txt'], regex: false });
  });
});
