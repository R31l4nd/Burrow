import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('derives the WebAuthn RP id and treats empty values as unset', () => {
    const c = loadConfig({ BURROW_ORIGIN: 'https://burrow.local.example.com', BURROW_SECRET: '', TRUST_PROXY: '' });
    expect(c).toMatchObject({ origin: 'https://burrow.local.example.com', rpId: 'burrow.local.example.com', secure: true, secret: undefined, trustProxy: undefined, port: 8080 });
  });

  it('allows plain http only on localhost', () => {
    expect(loadConfig({ BURROW_ORIGIN: 'http://localhost:5173' }).secure).toBe(false);
    expect(() => loadConfig({ BURROW_ORIGIN: 'http://burrow.lan' })).toThrow(/https/);
  });

  it('refuses an origin with a path and a missing origin', () => {
    expect(() => loadConfig({ BURROW_ORIGIN: 'https://x.example.com/burrow' })).toThrow(/bare origin/);
    expect(() => loadConfig({})).toThrow(/BURROW_ORIGIN/);
  });

  it('says every setting that is wrong, by name: a pattern that does not compile, a label with spaces', () => {
    let message = '';
    try {
      loadConfig({ BURROW_ORIGIN: 'https://x.example.com', UPDATE_CHECK_EXCLUDE: '^registry\\.(', BURROW_IGNORE_LABEL: 'two words' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^Invalid configuration:/);
    expect(message).toContain('UPDATE_CHECK_EXCLUDE: not a valid regular expression');
    expect(message).toContain('BURROW_IGNORE_LABEL');
  });

  it('compiles the update check exclusion and keeps only well-formed app certificate fingerprints', () => {
    const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
    const c = loadConfig({ BURROW_ORIGIN: 'https://x.example.com', UPDATE_CHECK_EXCLUDE: '^registry\\.example\\.com/', BURROW_ANDROID_CERT_SHA256: ` ${fp} ,not-a-fingerprint,AA:BB` });
    expect(c.updateCheckExclude!.test('registry.example.com/app:1')).toBe(true);
    expect(c.updateCheckExclude!.test('nginx:1.27')).toBe(false);
    expect(c.androidCertSha256).toEqual([fp.toUpperCase()]);
    expect(loadConfig({ BURROW_ORIGIN: 'https://x.example.com' }).updateCheckExclude).toBeNull();
  });
});

describe('the documented settings reach the container', () => {
  it("every variable DEPLOY.md lists that Burrow reads is passed on in compose.yaml (AUDIT2 DOC-09: the ignore label was not)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const doc = readFileSync(join(root, 'docs/DEPLOY.md'), 'utf8');
    const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
    const config = readFileSync(join(root, 'server/src/config.ts'), 'utf8');
    const documented = [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]!);
    const read = documented.filter((v) => new RegExp(`^\\s+${v}:`, 'm').test(config));
    expect(read.length).toBeGreaterThan(5);
    expect(read.filter((v) => !new RegExp(`^\\s+${v}: \\$\\{${v}`, 'm').test(compose))).toEqual([]);
  });
});
