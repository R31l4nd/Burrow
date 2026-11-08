import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMasterKey, humanCode, loadMasterSecret, MasterKeyError, normalizeCode, SEALED_PROBES, SecretBox } from '../../src/crypto.js';
import { openDb } from '../../src/db/index.js';
import { recordCommand } from '../../src/history/service.js';
import { makeApp, setupAdmin } from '../helpers.js';

const box = new SecretBox('a'.repeat(40));

describe('SecretBox', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const a = box.seal('private key', 'ctx');
    const b = box.seal('private key', 'ctx');
    expect(a).not.toBe(b);
    expect(a).not.toContain('private');
    expect(box.open(a, 'ctx')).toBe('private key');
  });

  it('refuses a ciphertext moved to another context', () => {
    expect(() => box.open(box.seal('x', 'hosts.password'), 'ssh_keys.private_key')).toThrow();
  });

  it('refuses a tampered ciphertext or a different key', () => {
    const sealed = box.seal('secret', 'ctx');
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    raw[raw.length - 1]! ^= 1;
    expect(() => box.open(`v1.${raw.toString('base64url')}`, 'ctx')).toThrow();
    expect(() => new SecretBox('b'.repeat(40)).open(sealed, 'ctx')).toThrow();
  });

  it('rejects a short secret', () => {
    expect(() => new SecretBox('short')).toThrow();
  });
});

describe('loadMasterSecret', () => {
  it('generates a 0600 key file once and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-'));
    const generated: string[] = [];
    const a = loadMasterSecret({ secret: undefined, secretFile: undefined, dataDir: dir, onGenerated: (p) => generated.push(p) });
    const b = loadMasterSecret({ secret: undefined, secretFile: undefined, dataDir: dir });
    expect(a).toBe(b);
    expect(generated).toHaveLength(1);
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'secret.key'), 'utf8').trim()).toBe(a);
  });

  it('refuses a key file readable by others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-'));
    const f = join(dir, 'k');
    writeFileSync(f, 'x'.repeat(40));
    chmodSync(f, 0o644);
    expect(() => loadMasterSecret({ secret: undefined, secretFile: f, dataDir: dir })).toThrow(/chmod 600/);
  });

  it('prefers BURROW_SECRET', () => {
    expect(loadMasterSecret({ secret: 's'.repeat(32), secretFile: '/nonexistent', dataDir: '/nonexistent' })).toBe('s'.repeat(32));
  });
});

describe('the master key checked against the database', () => {
  const at = { source: '/data/secret.key', now: 1 };

  it('a new database gets a check value; the same key opens it, another key is refused saying why and what to do', () => {
    const db = openDb(':memory:');
    expect(checkMasterKey(db.$client, box, at)).toBe('written');
    expect(checkMasterKey(db.$client, box, at)).toBe('ok');
    const other = new SecretBox('b'.repeat(40));
    expect(() => checkMasterKey(db.$client, other, { source: 'BURROW_SECRET', now: 2 })).toThrow(MasterKeyError);
    expect(() => checkMasterKey(db.$client, other, { source: 'BURROW_SECRET', now: 2 })).toThrow(/master key \(BURROW_SECRET\) is not the key.*Restore secret\.key from a backup.*set BURROW_SECRET back/);
  });

  it('an install from before the check value: written when its sealed secrets open, refused (and none written) when a lost key was replaced by a new one', async () => {
    const t = await makeApp();
    try {
      await setupAdmin(t);
      await t.json('POST', '/api/hosts', { name: 'nas', address: 'nas.lan', username: 'me', authMethod: 'password', password: 'hunter2' });
      await t.json('POST', '/api/keys/generate', { name: 'main' });
      recordCommand(t.ctx, 1, 'ls -la');
      const sqlite = t.ctx.db.$client;
      // The probes' contexts are the ones these were sealed with: each table holds one that opens.
      for (const [table, column, context] of SEALED_PROBES) {
        const v = (sqlite.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).get() as { v: string } | undefined)?.v;
        expect(v, table).toBeDefined();
        expect(() => t.ctx.box.open(v!, context), table).not.toThrow();
      }
      const generated = new SecretBox('c'.repeat(40));
      expect(() => checkMasterKey(sqlite, generated, at)).toThrow(MasterKeyError);
      expect(sqlite.prepare("SELECT count(*) AS n FROM app_settings WHERE key = 'crypto.keyCheck'").get()).toEqual({ n: 0 });
      expect(checkMasterKey(sqlite, t.ctx.box, at)).toBe('written');
      expect(checkMasterKey(sqlite, t.ctx.box, at)).toBe('ok');
    } finally {
      await t.close();
    }
  });

  it('a check value that cannot be written (the data disk full) does not keep Burrow from starting', () => {
    const db = openDb(':memory:');
    db.$client.pragma('query_only = ON');
    expect(checkMasterKey(db.$client, box, at)).toBe('unsaved');
    db.$client.pragma('query_only = OFF');
    expect(checkMasterKey(db.$client, box, at)).toBe('written');
  });

  it('a damaged value among the sealed ones does not lock an install out', () => {
    const db = openDb(':memory:');
    db.$client.prepare("INSERT INTO hosts (name, address, username, password_enc, created_at, updated_at) VALUES ('a', 'a', 'u', 'v1.broken', 0, 0)").run();
    db.$client.prepare("INSERT INTO hosts (name, address, username, password_enc, created_at, updated_at) VALUES ('b', 'b', 'u', ?, 0, 0)").run(box.seal('pw', 'hosts.password'));
    expect(checkMasterKey(db.$client, box, at)).toBe('written');
  });
});

describe('human codes', () => {
  it('uses no look-alike characters and normalises input', () => {
    const c = humanCode(4, 4);
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    expect(normalizeCode(` ${c.toLowerCase().replace(/-/g, ' ')} `)).toBe(c.replace(/-/g, ''));
  });
});
