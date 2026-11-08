import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { humanCode, loadMasterSecret, normalizeCode, SecretBox } from '../../src/crypto.js';

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

describe('human codes', () => {
  it('uses no look-alike characters and normalises input', () => {
    const c = humanCode(4, 4);
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    expect(normalizeCode(` ${c.toLowerCase().replace(/-/g, ' ')} `)).toBe(c.replace(/-/g, ''));
  });
});
