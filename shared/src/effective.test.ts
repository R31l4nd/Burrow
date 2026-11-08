import { describe, expect, it } from 'vitest';
import { effectiveConnection, groupChain, inheritedFrom } from './effective.js';
import type { Group } from './schemas.js';

const group = (id: number, parentId: number | null, defaults: Group['defaults']): Group => ({
  id,
  name: `g${id}`,
  parentId,
  defaults,
  sort: 0,
});

const bare = {
  groupId: null,
  port: null,
  username: null,
  authMethod: null,
  keyId: null,
  startupCommand: null,
  tmux: null,
  term: null,
  encoding: null,
};

describe('effectiveConnection', () => {
  it('falls back to built-in defaults', () => {
    const e = effectiveConnection(bare, new Map());
    expect(e).toMatchObject({ port: 22, tmux: 'auto', term: 'xterm-256color', username: null });
  });

  it('takes the nearest group value and lets the host override', () => {
    const groups = new Map([
      [1, group(1, null, { username: 'root', port: 2222 })],
      [2, group(2, 1, { username: 'admin' })],
    ]);
    const e = effectiveConnection({ ...bare, groupId: 2 }, groups);
    expect(e.username).toBe('admin');
    expect(e.port).toBe(2222);
    expect(effectiveConnection({ ...bare, groupId: 2, username: 'me' }, groups).username).toBe('me');
  });

  it('treats an empty string as unset', () => {
    const groups = new Map([[1, group(1, null, { username: 'root' })]]);
    expect(effectiveConnection({ ...bare, groupId: 1, username: '' }, groups).username).toBe('root');
  });

  it('survives a cycle in the group tree', () => {
    const groups = new Map([
      [1, group(1, 2, {})],
      [2, group(2, 1, { port: 2200 })],
    ]);
    expect(groupChain(1, groups).map((g) => g.id)).toEqual([1, 2]);
    expect(effectiveConnection({ ...bare, groupId: 1 }, groups).port).toBe(2200);
  });

  it('all hosts come after the groups and before the built-in defaults', () => {
    const all = { username: 'ana', tmux: 'always' as const, keyId: 7 };
    const groups = new Map([[1, group(1, null, { username: 'root' })]]);
    // A host without a group: all hosts' settings.
    expect(effectiveConnection(bare, groups, all)).toMatchObject({ username: 'ana', tmux: 'always', keyId: 7, port: 22 });
    // A group wins over all hosts; the host over both.
    expect(effectiveConnection({ ...bare, groupId: 1 }, groups, all).username).toBe('root');
    expect(effectiveConnection({ ...bare, groupId: 1, username: 'me' }, groups, all).username).toBe('me');
    // Where it comes from, for the form's hint.
    expect(inheritedFrom(1, groups, all, 'username')).toBe('g1');
    expect(inheritedFrom(1, groups, all, 'keyId')).toBe('all');
    expect(inheritedFrom(null, groups, {}, 'port')).toBeNull();
  });
});
