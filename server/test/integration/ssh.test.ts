import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import type { ConnectResult, Host, KnownHost, SshKey } from '@burrow/shared';
import { knownHosts } from '../../src/db/schema.js';
import { resolveTarget } from '../../src/hosts/service.js';
import { generateEd25519 } from '../../src/keys/vault.js';
import { exec, openSsh } from '../../src/ssh/connect.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

const { utils } = ssh2;

// Runs against the throwaway sshd from test/sshd (scripts/test-integration.sh).
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);
const PASSWORD = 'burrow-test-password';

let t: TestApp;
let host: Host;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  host = await t.json<Host>('POST', '/api/hosts', {
    name: 'sshd',
    address: SSHD_HOST,
    port: SSHD_PORT,
    username: 'tester',
    authMethod: 'password',
    password: PASSWORD,
  });
});
afterAll(async () => {
  await t.close();
});

const test = () => t.json<ConnectResult>('POST', `/api/hosts/${host.id}/test`);

describe('trust on first use', () => {
  let fingerprint = '';

  it('stops at an unknown host key and shows its fingerprint', async () => {
    const r = await test();
    expect(r.status).toBe('unknown_host_key');
    if (r.status !== 'unknown_host_key') return;
    expect(r.fingerprint).toMatch(/^SHA256:/);
    fingerprint = r.fingerprint;
  });

  it('refuses to trust a fingerprint the host does not present', async () => {
    const r = await t.request('POST', `/api/hosts/${host.id}/trust`, { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(r.json()).toMatchObject({ error: 'fingerprint_changed' });
  });

  it('trusts the confirmed key, then connects and detects facts', async () => {
    const kh = await t.json<KnownHost>('POST', `/api/hosts/${host.id}/trust`, { fingerprint });
    expect(kh).toMatchObject({ host: SSHD_HOST, port: SSHD_PORT, fingerprint });
    const r = await test();
    // The test sshd has a stand-in docker CLI (test/sshd/docker).
    expect(r).toMatchObject({ status: 'ok', facts: { hasTmux: true, hasDocker: true } });
    if (r.status === 'ok') expect(r.facts.os).toMatch(/Debian/);
    expect((await t.json<Host>('GET', `/api/hosts/${host.id}`)).facts?.hasTmux).toBe(true);
  });

  it('blocks hard when the stored key no longer matches', async () => {
    const other = utils.parseKey(generateEd25519('other').pair.public);
    if (other instanceof Error) throw other;
    const original = t.ctx.db.select().from(knownHosts).get()!;
    t.ctx.db.update(knownHosts).set({ keyB64: other.getPublicSSH().toString('base64'), fingerprint: 'SHA256:old' }).run();

    const r = await test();
    expect(r).toMatchObject({ status: 'host_key_mismatch', knownFingerprint: 'SHA256:old' });
    const trust = await t.request('POST', `/api/hosts/${host.id}/trust`, { fingerprint: original.fingerprint });
    expect(trust.json()).toMatchObject({ error: 'host_key_mismatch' });

    // Removing the stale entry is the way out.
    await t.json('DELETE', `/api/known-hosts/${original.id}`);
    expect((await test()).status).toBe('unknown_host_key');
    await t.json('POST', `/api/hosts/${host.id}/trust`, { fingerprint: original.fingerprint });
    expect((await test()).status).toBe('ok');
  });
});

describe('credentials', () => {
  it('reports a wrong password as auth_failed', async () => {
    const bad = await t.json<Host>('POST', `/api/hosts/${host.id}/copy`);
    await t.json('PUT', `/api/hosts/${bad.id}`, {
      name: 'bad',
      address: SSHD_HOST,
      port: SSHD_PORT,
      username: 'tester',
      authMethod: 'password',
      password: 'wrong',
    });
    expect((await t.json<ConnectResult>('POST', `/api/hosts/${bad.id}/test`)).status).toBe('auth_failed');
    await t.json('DELETE', `/api/hosts/${bad.id}`);
  });

  it('keeps the way in that works when sshd refuses the installed key (AUDIT2 MON-05)', async () => {
    const sh = async (command: string) => {
      const conn = await openSsh(t.ctx, resolveTarget(t.ctx, host.id));
      if (!('client' in conn)) throw new Error(conn.status);
      await exec(conn.client, command).finally(() => conn.client.end());
    };
    const key = await t.json<SshKey>('POST', '/api/keys/generate', { name: 'refused' });
    // A home anyone may write to: sshd (StrictModes) takes no key from it
    // (Debian allows group-writable for a group of the user alone).
    await sh('chmod o+w ~');
    try {
      const r = await t.json<ConnectResult>('POST', `/api/hosts/${host.id}/install-key`, { keyId: key.id, password: PASSWORD });
      expect(r.status).toBe('auth_failed');
    } finally {
      await sh('chmod o-w ~');
    }
    expect(await t.json<Host>('GET', `/api/hosts/${host.id}`)).toMatchObject({ authMethod: 'password', keyId: null });
    expect((await test()).status).toBe('ok');
    await sh("sed -i '/burrow-refused/d' ~/.ssh/authorized_keys");
  });

  it('installs a vault key with the password, then logs in with the key', async () => {
    const key = await t.json<SshKey>('POST', '/api/keys/generate', { name: 'burrow' });
    const r = await t.json<ConnectResult>('POST', `/api/hosts/${host.id}/install-key`, { keyId: key.id, password: PASSWORD });
    expect(r.status).toBe('ok');
    const h = await t.json<Host>('GET', `/api/hosts/${host.id}`);
    expect(h).toMatchObject({ authMethod: 'key', keyId: key.id });

    // Remove the password: the key alone must work.
    await t.json('PUT', `/api/hosts/${host.id}`, { name: 'sshd', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'key', keyId: key.id, password: '' });
    expect((await test()).status).toBe('ok');

    // Installing twice does not duplicate the line.
    await t.json('PUT', `/api/hosts/${host.id}`, { name: 'sshd', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'key', keyId: key.id });
    expect((await t.json<ConnectResult>('POST', `/api/hosts/${host.id}/install-key`, { keyId: key.id, password: PASSWORD })).status).toBe('ok');
    const conn = await openSsh(t.ctx, resolveTarget(t.ctx, host.id));
    if (!('client' in conn)) throw new Error(conn.status);
    const out = await exec(conn.client, 'grep -c burrow-burrow ~/.ssh/authorized_keys; stat -c %a ~/.ssh ~/.ssh/authorized_keys');
    conn.client.end();
    expect(out.stdout.trim().split('\n')).toEqual(['1', '700', '600']);
  });
});

describe('reachability', () => {
  it('reports a closed port as unreachable, and the TCP check agrees', async () => {
    const dead = await t.json<Host>('POST', '/api/hosts', { name: 'dead', address: '127.0.0.1', port: 1, username: 'x', password: 'x' });
    expect((await t.json<ConnectResult>('POST', `/api/hosts/${dead.id}/test`)).status).toBe('unreachable');
    expect((await t.status.checkOne(dead.id, '127.0.0.1', 1)).reachable).toBe(false);
    expect((await t.status.checkOne(host.id, SSHD_HOST, SSHD_PORT)).reachable).toBe(true);
  });
});

describe('round trips', () => {
  it('a small request is answered without waiting for a delayed ACK (TCP_NODELAY, OPS-W-01)', async () => {
    const conn = await openSsh(t.ctx, resolveTarget(t.ctx, host.id));
    if (!('client' in conn)) throw new Error(conn.status);
    try {
      const sftp = await new Promise<ssh2.SFTPWrapper>((resolve, reject) => conn.client.sftp((err, s) => (err ? reject(err) : resolve(s))));
      const stat = () => new Promise<void>((resolve, reject) => sftp.stat('.', (err) => (err ? reject(err) : resolve())));
      await stat();
      const ms: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        await stat();
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      // Nagle with the host's delayed ACK made each one about 40 ms; on this machine's network it is well under 1 ms.
      expect(ms[7]).toBeLessThan(15);
    } finally {
      conn.client.end();
    }
  });
});

describe('a command that does not end in time (audit 2026-11-05)', () => {
  it('is ended on the host, its session freed: more time-outs than sshd gives a connection sessions leave it usable', async () => {
    const conn = await openSsh(t.ctx, resolveTarget(t.ctx, host.id));
    if (!('client' in conn)) throw new Error(conn.status);
    try {
      const tag = `burrow-hang-${Date.now()}`;
      // Twelve: sshd gives a connection ten (MaxSessions); each one left running held one.
      for (let i = 0; i < 12; i++) await expect(exec(conn.client, `sleep 300; : ${tag}`, 300)).rejects.toThrow('timed out');
      // Nothing of them runs there any more ([g]: the looking shell's own command line does not match).
      const running = async () => (await exec(conn.client, `grep -l 'burrow-han[g]-${tag.slice(12)}' /proc/[0-9]*/cmdline 2>/dev/null | wc -l`)).stdout.trim();
      await expect.poll(running, { timeout: 10_000 }).toBe('0');
      expect((await exec(conn.client, 'echo ok')).stdout).toBe('ok\n');
    } finally {
      conn.client.end();
    }
  });
});
