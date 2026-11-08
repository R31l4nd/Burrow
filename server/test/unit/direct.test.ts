import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirectCache, Host } from '@burrow/shared';
import { keyLine, parseDevicePublicKey, pendingKeyRemovals, removeKeyCommand } from '../../src/android/direct.js';
import { desc, eq } from 'drizzle-orm';
import { auditLog, deviceHosts, devices, users } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';
import { phoneSshKey } from '../sshkey.js';

describe('the phone key', () => {
  it('accepts only a well-formed ecdsa-sha2-nistp256 key', () => {
    const { line } = phoneSshKey();
    expect(parseDevicePublicKey(`${line} some comment`)).toBe(line);
    expect(parseDevicePublicKey(line.replace('ecdsa-sha2-nistp256', 'ssh-ed25519'))).toBeNull();
    expect(parseDevicePublicKey('ecdsa-sha2-nistp256 AAAAB3NzaC1yc2EAAAADAQABAAABAQ==')).toBeNull();
    expect(parseDevicePublicKey("ecdsa-sha2-nistp256 x' ; rm -rf /")).toBeNull();
  });

  it('marks its authorized_keys line with the device id only', () => {
    expect(keyLine(12, 'Pixel 7 (Alice)', 'ecdsa-sha2-nistp256 AAAA')).toBe('ecdsa-sha2-nistp256 AAAA burrow-direct:12:Pixel-7-Alice');
    // Device 1 must not remove device 12's line.
    expect(removeKeyCommand(1)).toContain("grep -vF ' burrow-direct:1:'");
  });

  it('takes only its own line off, and never leaves half a file', () => {
    const home = mkdtempSync(join(tmpdir(), 'burrow-keys-'));
    const ssh = join(home, '.ssh');
    mkdirSync(ssh, { mode: 0o700 });
    const file = join(ssh, 'authorized_keys');
    const run = (cmd: string) => spawnSync('sh', ['-c', cmd], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
    try {
      writeFileSync(file, 'ssh-ed25519 AAAA me@laptop\necdsa-sha2-nistp256 BBBB burrow-direct:1:Pixel\necdsa-sha2-nistp256 CCCC burrow-direct:12:Tab\n');
      expect(run(removeKeyCommand(1)).status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('ssh-ed25519 AAAA me@laptop\necdsa-sha2-nistp256 CCCC burrow-direct:12:Tab\n');
      // The last line gone: an empty file, not an error.
      writeFileSync(file, 'ecdsa-sha2-nistp256 BBBB burrow-direct:1:Pixel\n');
      expect(run(removeKeyCommand(1)).status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('');
      // Keys managed elsewhere: written where the link points, the link stays.
      const real = join(home, 'managed_keys');
      writeFileSync(real, 'ssh-ed25519 AAAA me@laptop\necdsa-sha2-nistp256 BBBB burrow-direct:1:Pixel\n');
      rmSync(file);
      symlinkSync(real, file);
      expect(run(removeKeyCommand(1)).status).toBe(0);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, 'utf8')).toBe('ssh-ed25519 AAAA me@laptop\n');
      // grep cannot read it (it failed): the file is left as it was.
      rmSync(file);
      writeFileSync(file, 'ssh-ed25519 AAAA me@laptop\necdsa-sha2-nistp256 BBBB burrow-direct:1:Pixel\n');
      chmodSync(file, 0o000);
      expect(run(removeKeyCommand(1)).status).not.toBe(0);
      chmodSync(file, 0o600);
      expect(readFileSync(file, 'utf8')).toContain('me@laptop');
      expect(readdirSync(ssh)).toEqual(['authorized_keys']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('direct route routes', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    await setupAdmin(t);
  });
  afterEach(async () => t.close());

  async function pairedApp() {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
    t.cookie = null;
    const r = await t.json<{ deviceId: number }>('POST', '/api/auth/pair', { code, name: 'Pixel', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
    return { deviceId: r.deviceId };
  }

  it('only the paired app itself reports its key', async () => {
    const { line } = phoneSshKey();
    expect((await t.request('PUT', '/api/account/devices/current/ssh-key', { publicKey: line })).json()).toMatchObject({ error: 'not_a_device' });
    const { deviceId } = await pairedApp();
    expect(await t.json('PUT', '/api/account/devices/current/ssh-key', { publicKey: line })).toEqual({ changed: true, results: [] });
    expect(await t.json('PUT', '/api/account/devices/current/ssh-key', { publicKey: line })).toEqual({ changed: false, results: [] });
    expect(await t.json('GET', `/api/account/devices/${deviceId}/hosts`)).toEqual({ hasKey: true, hostIds: [] });
    expect((await t.request('PUT', '/api/account/devices/current/ssh-key', { publicKey: 'ssh-rsa AAAA' })).statusCode).toBe(400);
  });

  it('a new key from the paired app needs a fresh step-up; the same key again does not (A3-SRV-03)', async () => {
    const first = phoneSshKey();
    await pairedApp();
    expect(await t.json('PUT', '/api/account/devices/current/ssh-key', { publicKey: first.line })).toEqual({ changed: true, results: [] });
    // Long after the pairing: a stolen device cookie cannot put its own key in place.
    t.advance(60 * 60_000);
    const other = phoneSshKey();
    const r = await t.request('PUT', '/api/account/devices/current/ssh-key', { publicKey: other.line });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('step_up_required');
    expect(t.ctx.db.select().from(devices).get()!.sshPublicKey).toBe(first.line);
    expect(await t.json('PUT', '/api/account/devices/current/ssh-key', { publicKey: first.line })).toEqual({ changed: false, results: [] });
  });

  it('caches only the direct hosts, with host keys and history, and no credentials', async () => {
    const a = await t.json<Host>('POST', '/api/hosts', { name: 'a', address: 'a.lan', username: 'me', authMethod: 'password', password: 'secret-pw' });
    await t.json<Host>('POST', '/api/hosts', { name: 'b', address: 'b.lan', username: 'me' });
    const { deviceId } = await pairedApp();
    t.ctx.db.insert(deviceHosts).values({ deviceId, hostId: a.id, installedAt: t.clock.now }).run();
    const cache = await t.json<DirectCache>('GET', '/api/android/cache');
    expect(cache.hosts.map((h) => h.name)).toEqual(['a']);
    expect(cache.hosts[0]).toMatchObject({ address: 'a.lan', port: 22, username: 'me', hostKeys: [], history: [] });
    expect(JSON.stringify(cache)).not.toContain('secret-pw');
  });

  it('an admin demoted or removed loses the direct route on every host', async () => {
    // Port 1 refuses at once: the key cannot come off, and that is recorded.
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', port: 1, username: 'me' });
    const other = (id: number, name: string) => {
      t.ctx.db.insert(users).values({ id, username: name, role: 'admin', totpConfirmed: false, incomplete: false, createdAt: t.clock.now }).run();
      const d = t.ctx.db.insert(devices).values({ userId: id, name: `${name}'s phone`, publicKey: 'x', createdAt: t.clock.now, sshPublicKey: phoneSshKey().line }).returning().get();
      t.ctx.db.insert(deviceHosts).values({ deviceId: d.id, hostId: h.id, installedAt: t.clock.now }).run();
    };
    const lastAudit = () => t.ctx.db.select().from(auditLog).orderBy(desc(auditLog.id)).get()!;
    other(50, 'bob');
    expect((await t.request('PUT', '/api/users/50', { role: 'operator' })).statusCode).toBe(200);
    expect(lastAudit()).toMatchObject({ action: 'user.update' });
    expect(JSON.parse(lastAudit().details!)).toEqual({ role: 'operator', keyLeftOn: [h.id] });
    // The grant itself is gone at once, also where the key could not come off
    // (kept apart to take off later): a key the phone reports next is put on
    // no host (AUDIT2 AUTH-03: the left grant let a demoted user's new key back on).
    const bobsDevice = t.ctx.db.select().from(devices).where(eq(devices.userId, 50)).get()!;
    expect(t.ctx.db.select().from(deviceHosts).where(eq(deviceHosts.deviceId, bobsDevice.id)).all()).toEqual([]);
    expect(pendingKeyRemovals(t.ctx)).toEqual([{ deviceId: bobsDevice.id, hostId: h.id }]);
    other(51, 'carol');
    expect((await t.request('DELETE', '/api/users/51')).statusCode).toBe(204);
    expect(JSON.parse(lastAudit().details!)).toEqual({ keyLeftOn: [h.id] });
  });

  it('the cache is for the app only', async () => {
    expect((await t.request('GET', '/api/android/cache')).statusCode).toBe(403);
  });
});
