import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Host, SshKey } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// "All hosts": the layer above the groups. No SSH needed: only what a host's
// connection would use, and what may not be deleted while it is used.
let t: TestApp;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterAll(async () => {
  await t.close();
});

describe('All hosts', () => {
  it('fills in what neither the host nor its groups set, below the groups', async () => {
    expect(await t.json('GET', '/api/host-defaults')).toEqual({});
    const key = await t.json<SshKey>('POST', '/api/keys/generate', { name: 'everywhere' });
    // An unknown key is refused; empty values are not kept.
    expect((await t.request('PUT', '/api/host-defaults', { keyId: 9999 })).statusCode).toBe(400);
    expect(await t.json('PUT', '/api/host-defaults', { username: 'everyone', keyId: key.id, tmux: 'always', startupCommand: '' })).toEqual({ username: 'everyone', keyId: key.id, tmux: 'always' });

    const loose = await t.json<Host & { effective: { username: string; keyId: number; tmux: string; port: number } }>('POST', '/api/hosts', { name: 'loose', address: '192.0.2.10' });
    const got = await t.json<{ effective: { username: string; keyId: number; tmux: string; port: number } }>('GET', `/api/hosts/${loose.id}`);
    expect(got.effective).toMatchObject({ username: 'everyone', keyId: key.id, tmux: 'always', port: 22 });

    // A group's own user wins; the host's over both.
    const g = await t.json<{ id: number }>('POST', '/api/groups', { name: 'Servers', parentId: null, defaults: { username: 'admin' } });
    const inGroup = await t.json<Host>('POST', '/api/hosts', { name: 'grouped', address: '192.0.2.11', groupId: g.id });
    expect((await t.json<{ effective: { username: string; keyId: number } }>('GET', `/api/hosts/${inGroup.id}`)).effective).toMatchObject({ username: 'admin', keyId: key.id });

    // The key is in use for all hosts: not deleted.
    const del = await t.request('DELETE', `/api/keys/${key.id}`);
    expect(del.statusCode).toBe(409);
    expect(del.body).toContain('All hosts');
    await t.json('PUT', '/api/host-defaults', {});
    expect((await t.request('DELETE', `/api/keys/${key.id}`)).statusCode).toBe(204);
  });
});
