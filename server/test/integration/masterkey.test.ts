import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Host } from '@burrow/shared';
import { checkMasterKey, MasterKeyError, SecretBox } from '../../src/crypto.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// The master key checked at start (2026-11-07 audit), against a database
// that holds what Burrow really seals: a host's password and a second
// factor. A lost key.file or a changed BURROW_SECRET is refused with what
// to do, before a new key is laid over secrets that then never open again.

let t: TestApp;
const other = new SecretBox('another-secret-that-is-long-enough-for-hkdf');
const check = (box: SecretBox) => checkMasterKey(t.ctx.db.$client, box, { source: 'secret.key', now: t.clock.now });

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  await t.json<Host>('POST', '/api/hosts', { name: 'sealed', address: '192.0.2.10', port: 22, username: 'tester', authMethod: 'password', password: 'a password sealed with the key' });
});

afterAll(async () => {
  await t.close();
});

describe('the master key at start', () => {
  it('an install from before the check: another key is refused on what it sealed; its own key writes the check', () => {
    expect(() => check(other)).toThrow(MasterKeyError);
    expect(() => check(other)).toThrow(/Restore secret\.key from a backup/);
    expect(check(t.ctx.box)).toBe('written');
  });

  it('with the check written: its own key passes, another is refused', () => {
    expect(check(t.ctx.box)).toBe('ok');
    expect(() => check(other)).toThrow(/not the key this database's secrets were sealed with/);
  });
});
