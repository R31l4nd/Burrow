import { generateKeyPairSync } from 'node:crypto';
import { Client } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, DeviceHostResult, DirectCache, Host } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { deviceHosts, devices, users } from '../../src/db/schema.js';
import { resolveTarget } from '../../src/hosts/service.js';
import { exec, openSsh } from '../../src/ssh/connect.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';
import { phoneSshKey } from '../sshkey.js';

// The direct route's key handling against the test sshd: Burrow puts the
// phone's key on a host, the phone can then log in with it on its own, and
// unpairing takes it off again.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;
const phone = phoneSshKey();

/** Log in as the phone would: its own key, no Burrow involved. */
function phoneLogin(privateKey = phone.privatePem): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () =>
      c.exec('echo direct-ok', (err, ch) => {
        if (err) return reject(err);
        let out = '';
        ch.on('data', (d: Buffer) => (out += d.toString()));
        ch.on('close', () => {
          c.end();
          resolve(out.trim());
        });
      }),
    );
    c.on('error', reject);
    c.connect({ host: SSHD_HOST, port: PORT, username: 'tester', privateKey, readyTimeout: 10_000 });
  });
}

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'direct-host', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
});
afterAll(async () => {
  await t.close();
});

describe('direct route', () => {
  let deviceId = 0;
  let browser: string | null = null;
  let appCookie: string | null = null;

  it('pairs a phone that reports its SSH key', async () => {
    const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
    browser = t.cookie;
    t.cookie = null;
    const dk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    deviceId = (await t.json<{ deviceId: number }>('POST', '/api/auth/pair', { code, name: 'Pixel', publicKey: dk })).deviceId;
    await t.json('PUT', '/api/account/devices/current/ssh-key', { publicKey: phone.line });
    appCookie = t.cookie;
    t.cookie = browser;
  });

  it('refuses the phone key until Burrow installs it', async () => {
    await expect(phoneLogin()).rejects.toThrow();
  });

  it('installs the key on a chosen host; the phone logs in on its own', async () => {
    // A host that never had an authorized_keys file (the removal of old
    // lines that goes first must not stop the install).
    await t.json('POST', '/api/snippets/run', { hostIds: [h.id], command: 'rm -f ~/.ssh/authorized_keys' });
    const r = await t.json<{ hostIds: number[]; results: DeviceHostResult[] }>('PUT', `/api/account/devices/${deviceId}/hosts`, { hostIds: [h.id] });
    expect(r.results).toEqual([expect.objectContaining({ hostId: h.id, ok: true })]);
    expect(r.hostIds).toEqual([h.id]);
    expect(await phoneLogin()).toBe('direct-ok');
  });

  it('gives the app a cache with the host key Burrow trusts', async () => {
    t.cookie = appCookie;
    const cache = await t.json<DirectCache>('GET', '/api/android/cache');
    t.cookie = browser;
    expect(cache.hosts).toHaveLength(1);
    expect(cache.hosts[0]).toMatchObject({ id: h.id, address: SSHD_HOST, port: PORT, username: 'tester' });
    expect(cache.hosts[0]!.hostKeys.length).toBeGreaterThan(0);
  });

  it('unpairing takes the key off the host', async () => {
    const r = await t.json<{ leftOn: DeviceHostResult[] }>('DELETE', `/api/account/devices/${deviceId}`);
    expect(r.leftOn).toEqual([]);
    await expect(phoneLogin()).rejects.toThrow();
  });
});


describe('phone keys on an account', () => {
  const sh = async (hostId: number, command: string) => {
    const conn = await openSsh(t.ctx, resolveTarget(t.ctx, hostId));
    if (!('client' in conn)) throw new Error(conn.status);
    try {
      return await exec(conn.client, command);
    } finally {
      conn.client.end();
    }
  };
  const count = async (hostId: number, pattern: string) => (await sh(hostId, `grep -c '${pattern}' ~/.ssh/authorized_keys || true`)).stdout.trim();
  const userId = () => t.ctx.db.select().from(users).get()!.id;
  const phoneDevice = (name: string, key: string) =>
    t.ctx.db.insert(devices).values({ userId: userId(), name, publicKey: 'x', createdAt: Date.now(), sshPublicKey: key }).returning().get().id;
  const grant = (id: number, hostIds: number[]) => t.json<{ results: DeviceHostResult[] }>('PUT', `/api/account/devices/${id}/hosts`, { hostIds });

  it('phones put on and taken off at once all end up right (AUDIT2 MON-02)', async () => {
    await sh(h.id, 'rm -f ~/.ssh/authorized_keys');
    const ids = Array.from({ length: 6 }, (_, i) => phoneDevice(`race-${i}`, phoneSshKey().line));
    const rs = await Promise.all(ids.map((id) => grant(id, [h.id])));
    expect(rs.flatMap((r) => r.results).every((r) => r.ok)).toBe(true);
    // Half of them taken off again while the others are put on again.
    await Promise.all(ids.map((id, i) => grant(id, i % 2 ? [] : [h.id])));
    expect(await count(h.id, 'burrow-direct:')).toBe('3');
    for (const [i, id] of ids.entries()) expect(await count(h.id, `burrow-direct:${id}:`)).toBe(i % 2 ? '0' : '1');
    expect((await sh(h.id, 'ls -a ~/.ssh | grep -c burrow- || true')).stdout.trim()).toBe('0');
    await Promise.all(ids.map((id) => grant(id, [])));
  });

  let app: string | null = null;
  let browser: string | null = null;
  let id = 0;
  const report = async (publicKey: string) => {
    t.cookie = app;
    try {
      return await t.json<{ changed: boolean; results: DeviceHostResult[] }>('PUT', '/api/account/devices/current/ssh-key', { publicKey });
    } finally {
      t.cookie = browser;
    }
  };
  const second = phoneSshKey();

  it('a new phone key is not put on when the old line could not come off (AUDIT2 MON-03)', async () => {
    const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
    browser = t.cookie;
    t.cookie = null;
    const dk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    id = (await t.json<{ deviceId: number }>('POST', '/api/auth/pair', { code, name: 'Rotating', publicKey: dk })).deviceId;
    app = t.cookie;
    t.cookie = browser;
    const first = phoneSshKey();
    await report(first.line);
    expect((await grant(id, [h.id])).results[0]!.ok).toBe(true);
    // ~/.ssh read only: the old line cannot be written out; appending the new one still could.
    await sh(h.id, 'chmod 500 ~/.ssh');
    try {
      const r = await report(second.line);
      expect(r.results).toEqual([expect.objectContaining({ hostId: h.id, ok: false })]);
    } finally {
      await sh(h.id, 'chmod 700 ~/.ssh');
    }
    expect(await count(h.id, `burrow-direct:${id}:`)).toBe('1');
    await expect(phoneLogin(second.privatePem)).rejects.toThrow();
  });

  it('a host that missed the phone key gets it when the phone reports it again (AUDIT2 MON-04)', async () => {
    const r = await report(second.line);
    expect(r.results).toEqual([expect.objectContaining({ hostId: h.id, ok: true })]);
    expect(await phoneLogin(second.privatePem)).toBe('direct-ok');
    // Once there, the same key again is nothing to do.
    expect(await report(second.line)).toEqual({ changed: false, results: [] });
    await grant(id, []);
  });

  it('a host deleted or pointed at another account takes the phone keys off first (AUDIT2 MON-01)', async () => {
    const PORT2 = Number(process.env.SSHD2_PORT ?? 2298);
    const pid = phoneDevice('moving', phoneSshKey().line);
    const copy = await t.json<Host>('POST', `/api/hosts/${h.id}/copy`);
    expect((await grant(pid, [copy.id])).results[0]!.ok).toBe(true);
    expect(await count(h.id, `burrow-direct:${pid}:`)).toBe('1');
    // The second sshd known first, so the key can go on there.
    const other = await t.json<Host>('POST', '/api/hosts', { name: 'second-sshd', address: SSHD_HOST, port: PORT2, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
    const r = await t.json<ConnectResult>('POST', `/api/hosts/${other.id}/test`);
    if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${other.id}/trust`, { fingerprint: r.fingerprint });
    const moved = await t.json<Host & { directKeys?: unknown }>('PUT', `/api/hosts/${copy.id}`, { name: copy.name, address: SSHD_HOST, port: PORT2, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
    expect(moved.directKeys).toBeUndefined();
    expect(await count(h.id, `burrow-direct:${pid}:`)).toBe('0');
    expect(await count(other.id, `burrow-direct:${pid}:`)).toBe('1');
    expect(t.ctx.db.select().from(deviceHosts).where(eq(deviceHosts.deviceId, pid)).all().map((g) => g.hostId)).toEqual([copy.id]);
    // Deleted: off the account it pointed at.
    expect((await t.request('DELETE', `/api/hosts/${copy.id}`)).statusCode).toBe(204);
    expect(await count(other.id, `burrow-direct:${pid}:`)).toBe('0');
    await t.json('DELETE', `/api/hosts/${other.id}`);
  });
});
