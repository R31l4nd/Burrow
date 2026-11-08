import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSshConfig } from '../../src/hosts/importer.js';

describe('parseSshConfig', () => {
  it('turns concrete aliases into hosts and applies wildcard defaults', () => {
    const text = `
# comment
Host server2 nas
  HostName 192.168.1.20
  Port 2222

Host pi
  HostName pi.lan
  User pi
  IdentityFile ~/.ssh/id_pi

Host *.lan !bad
  Port 2200

Host *
  User alice
  IdentityFile ~/.ssh/id_ed25519
`;
    const r = parseSshConfig(text);
    expect(r.map((h) => h.alias)).toEqual(['server2', 'nas', 'pi']);
    expect(r[0]).toMatchObject({ address: '192.168.1.20', port: 2222, username: 'alice', identityFile: '~/.ssh/id_ed25519' });
    expect(r[1]).toMatchObject({ address: '192.168.1.20', port: 2222 });
    // First value wins, as in OpenSSH.
    expect(r[2]).toMatchObject({ address: 'pi.lan', username: 'pi', identityFile: '~/.ssh/id_pi', port: null });
  });

  it('uses the alias as address when HostName is missing and ignores case', () => {
    expect(parseSshConfig('host router\n  USER admin\n')[0]).toMatchObject({ alias: 'router', address: 'router', username: 'admin' });
  });

  it('never runs Match exec from pasted text', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'burrow-')), 'pwned');
    const text = `Match exec "touch ${marker}"\n  User evil\n\nHost a\n  HostName a.lan\n`;
    const r = parseSshConfig(text);
    expect(existsSync(marker)).toBe(false);
    expect(r[0]?.username).toBeNull();
  });
});
