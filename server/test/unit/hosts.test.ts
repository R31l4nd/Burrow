import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import type { Group, Host, ImportCandidate, SshKey } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { sshKeys } from '../../src/db/schema.js';
import { generateEd25519, getKey, unsealKey } from '../../src/keys/vault.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

const { utils } = ssh2;

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => {
  await t.close();
});

describe('groups and inheritance', () => {
  it('a host inherits user and port from nested groups', async () => {
    const home = await t.json<Group>('POST', '/api/groups', { name: 'Home', defaults: { username: 'alice', port: 2222 } });
    const servers = await t.json<Group>('POST', '/api/groups', { name: 'Servers', parentId: home.id, defaults: { tmux: 'never' } });
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'server2', address: '192.168.1.20', groupId: servers.id });
    const detail = await t.json<{ effective: Record<string, unknown> }>('GET', `/api/hosts/${h.id}`);
    expect(detail.effective).toMatchObject({ username: 'alice', port: 2222, tmux: 'never', term: 'xterm-256color' });
  });

  it('refuses a cycle', async () => {
    const a = await t.json<Group>('POST', '/api/groups', { name: 'A' });
    const b = await t.json<Group>('POST', '/api/groups', { name: 'B', parentId: a.id });
    const r = await t.request('PUT', `/api/groups/${a.id}`, { name: 'A', parentId: b.id });
    expect(r.json()).toMatchObject({ error: 'group_cycle' });
  });

  it('deleting a group moves its hosts and subgroups up', async () => {
    const a = await t.json<Group>('POST', '/api/groups', { name: 'A' });
    const b = await t.json<Group>('POST', '/api/groups', { name: 'B', parentId: a.id });
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: 'h.lan', groupId: b.id });
    await t.json('DELETE', `/api/groups/${b.id}`);
    expect((await t.json<Host>('GET', `/api/hosts/${h.id}`)).groupId).toBe(a.id);
  });
});

describe('hosts', () => {
  it('normalises tags, hides the password and copies', async () => {
    const h = await t.json<Host & { password?: string }>('POST', '/api/hosts', {
      name: 'nas',
      address: 'nas.lan',
      tags: ['Storage', 'storage', ' backup '],
      password: 'hunter2',
      favorite: true,
    });
    expect(h.tags).toEqual(['backup', 'storage']);
    expect(h.hasPassword).toBe(true);
    expect(JSON.stringify(h)).not.toContain('hunter2');

    // Omitting the password on update keeps it; an empty string clears it.
    const kept = await t.json<Host>('PUT', `/api/hosts/${h.id}`, { name: 'nas', address: 'nas.lan', tags: [] });
    expect(kept.hasPassword).toBe(true);
    const cleared = await t.json<Host>('PUT', `/api/hosts/${h.id}`, { name: 'nas', address: 'nas.lan', password: '' });
    expect(cleared.hasPassword).toBe(false);

    const copy = await t.json<Host>('POST', `/api/hosts/${h.id}/copy`);
    expect(copy).toMatchObject({ name: 'nas (copy)', address: 'nas.lan', favorite: false });
    expect(await t.json<Host[]>('GET', '/api/hosts')).toHaveLength(2);
  });

  it('forgets a stored password on request', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'p', address: 'p.lan', password: 'pw' });
    expect((await t.json<Host>('DELETE', `/api/hosts/${h.id}/password`)).hasPassword).toBe(false);
    expect((await t.request('DELETE', '/api/hosts/999/password')).statusCode).toBe(404);
  });

  it('lists hosts and groups as people read names: xl-2 before xl-19, case aside (A3-WEB-11)', async () => {
    for (const name of ['xl-19-node', 'Zeta', 'xl-2-node', 'alpha']) await t.json('POST', '/api/hosts', { name, address: `${name.toLowerCase()}.lan` });
    const names = (await t.json<Host[]>('GET', '/api/hosts')).map((x) => x.name).filter((n) => ['xl-19-node', 'Zeta', 'xl-2-node', 'alpha'].includes(n));
    expect(names).toEqual(['alpha', 'xl-2-node', 'xl-19-node', 'Zeta']);
    for (const name of ['g10', 'G9']) await t.json('POST', '/api/groups', { name, defaults: {} });
    expect((await t.json<{ name: string }[]>('GET', '/api/groups')).map((g) => g.name).filter((n) => /^g\d+$/i.test(n))).toEqual(['G9', 'g10']);
  });

  it('validates input', async () => {
    const r = await t.request('POST', '/api/hosts', { name: '', address: 'bad host; rm -rf' });
    expect(r.statusCode).toBe(400);
    expect((await t.request('POST', '/api/hosts', { name: 'x', address: 'x', keyId: 999 })).json()).toMatchObject({ error: 'unknown_key' });
  });

  it('explains what is missing before trying to connect', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'x', address: '127.0.0.1' });
    expect((await t.request('POST', `/api/hosts/${h.id}/test`)).json()).toMatchObject({ error: 'no_username' });
    await t.json('PUT', `/api/hosts/${h.id}`, { name: 'x', address: '127.0.0.1', username: 'me' });
    expect((await t.request('POST', `/api/hosts/${h.id}/test`)).json()).toMatchObject({ error: 'no_credentials' });
  });
});

describe('key vault', () => {
  it('generates ed25519 keys and never returns the private half', async () => {
    const k = await t.json<SshKey>('POST', '/api/keys/generate', { name: 'main' });
    expect(k.type).toBe('ssh-ed25519');
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ burrow-main$/);
    expect(JSON.stringify(await t.json('GET', '/api/keys'))).not.toMatch(/PRIVATE KEY/);
    expect((await t.request('POST', '/api/keys/generate', { name: 'main' })).statusCode).toBe(409);
  });

  it('imports a key, with and without passphrase', async () => {
    const plain = generateEd25519('laptop').pair;
    const k = await t.json<SshKey>('POST', '/api/keys/import', { name: 'laptop', privateKey: plain.private });
    expect(k.publicKey).toContain('laptop');

    // ssh2 now and then drops a leading zero from an ed25519 public key and
    // cannot read its own key back (see generateEd25519): generate until it can.
    let locked = utils.generateKeyPairSync('ed25519', { passphrase: 'pp', cipher: 'aes256-ctr', rounds: 4 } as never);
    while (utils.parseKey(locked.private, 'pp') instanceof Error) {
      locked = utils.generateKeyPairSync('ed25519', { passphrase: 'pp', cipher: 'aes256-ctr', rounds: 4 } as never);
    }
    const bad = await t.request('POST', '/api/keys/import', { name: 'locked', privateKey: locked.private, passphrase: 'wrong' });
    expect(bad.statusCode).toBe(400);
    const ok = await t.request('POST', '/api/keys/import', { name: 'locked', privateKey: locked.private, passphrase: 'pp' });
    expect(ok.statusCode).toBe(200);

    const pub = await t.request('POST', '/api/keys/import', { name: 'pub', privateKey: plain.public });
    expect(pub.statusCode).toBe(400);
  });

  it('refuses to delete a key that a host or group uses', async () => {
    const k = await t.json<SshKey>('POST', '/api/keys/generate', { name: 'main' });
    const g = await t.json<Group>('POST', '/api/groups', { name: 'G', defaults: { keyId: k.id } });
    expect((await t.request('DELETE', `/api/keys/${k.id}`)).json()).toMatchObject({ error: 'key_in_use' });
    await t.json('PUT', `/api/groups/${g.id}`, { name: 'G', defaults: {} });
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: 'h', keyId: k.id });
    expect((await t.request('DELETE', `/api/keys/${k.id}`)).json()).toMatchObject({ error: 'key_in_use' });
    await t.json('DELETE', `/api/hosts/${h.id}`);
    // The key all hosts use by default.
    await t.json('PUT', '/api/host-defaults', { keyId: k.id });
    expect((await t.request('DELETE', `/api/keys/${k.id}`)).json()).toMatchObject({ error: 'key_in_use', message: expect.stringContaining('All hosts') });
    await t.json('PUT', '/api/host-defaults', {});
    expect((await t.request('DELETE', `/api/keys/${k.id}`)).statusCode).toBe(204);
    expect((await t.request('DELETE', `/api/keys/${k.id}`)).statusCode).toBe(404);
  });

  it('keeps a passphrase sealed beside its key, and opens both only for a connection', async () => {
    const PP = 'burrow-test-passphrase';
    let locked = utils.generateKeyPairSync('ed25519', { passphrase: PP, cipher: 'aes256-ctr', rounds: 4 } as never);
    while (utils.parseKey(locked.private, PP) instanceof Error) {
      locked = utils.generateKeyPairSync('ed25519', { passphrase: PP, cipher: 'aes256-ctr', rounds: 4 } as never);
    }
    const k = await t.json<SshKey>('POST', '/api/keys/import', { name: 'locked', privateKey: locked.private, passphrase: PP });
    const row = t.ctx.db.select().from(sshKeys).where(eq(sshKeys.id, k.id)).get()!;
    // At rest: neither in the clear.
    expect(row.privateKeyEnc).not.toContain('PRIVATE KEY');
    expect(row.passphraseEnc).not.toBeNull();
    expect(row.passphraseEnc).not.toContain(PP);
    const open = unsealKey(t.ctx, k.id)!;
    expect(open.passphrase).toBe(PP);
    expect(utils.parseKey(open.privateKey, open.passphrase)).not.toBeInstanceOf(Error);
    // A key without one has none.
    const plain = await t.json<SshKey>('POST', '/api/keys/generate', { name: 'plain' });
    expect(unsealKey(t.ctx, plain.id)).not.toHaveProperty('passphrase');
    expect(unsealKey(t.ctx, 999)).toBeNull();
    expect(getKey(t.ctx, k.id)).toMatchObject({ name: 'locked', fingerprint: k.fingerprint });
    expect(getKey(t.ctx, 999)).toBeNull();
  });

  it('installing a key the vault does not have is refused before anything is sent to the host', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', port: 1 });
    const r = await t.request('POST', `/api/hosts/${h.id}/install-key`, { keyId: 999, password: 'x' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'unknown_key' });
  });
});

describe('ssh_config import', () => {
  it('previews with key matching and duplicate detection, then applies', async () => {
    const k = await t.json<SshKey>('POST', '/api/keys/generate', { name: 'id_ed25519' });
    await t.json('POST', '/api/hosts', { name: 'existing', address: '10.0.0.5', username: 'alice' });
    const text = 'Host server2\n  HostName 192.168.1.20\n  User alice\n  IdentityFile ~/.ssh/id_ed25519\n\nHost old\n  HostName 10.0.0.5\n  User alice\n';
    const preview = await t.json<ImportCandidate[]>('POST', '/api/import/ssh-config/preview', { text });
    expect(preview[0]).toMatchObject({ alias: 'server2', matchedKeyId: k.id, duplicateOf: null });
    expect(preview[1]?.duplicateOf).not.toBeNull();

    const created = await t.json<Host[]>('POST', '/api/import/ssh-config/apply', {
      entries: [{ alias: 'server2', address: '192.168.1.20', port: null, username: 'alice', keyId: k.id }],
    });
    expect(created[0]).toMatchObject({ name: 'server2', keyId: k.id, authMethod: 'key' });
  });
});
