import { describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { authorizedKeysCommand, factsComplete, FACTS_COMMAND, hostKeyOrder, parseFacts } from '../../src/ssh/connect.js';
import { fingerprintOf, keyTypeOf } from '../../src/ssh/knownhosts.js';
import { generateEd25519 } from '../../src/keys/vault.js';

const { utils } = ssh2;

describe('host keys', () => {
  it('reads the type and an OpenSSH-compatible fingerprint', () => {
    const { pair } = generateEd25519('test');
    const parsed = utils.parseKey(pair.public);
    if (parsed instanceof Error) throw parsed;
    const blob = parsed.getPublicSSH();
    expect(keyTypeOf(blob)).toBe('ssh-ed25519');
    expect(fingerprintOf(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(keyTypeOf(Buffer.from([0, 0]))).toBe('unknown');
  });

  it('offers trusted key types first', () => {
    expect(hostKeyOrder(['ssh-rsa']).slice(0, 3)).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
    expect(hostKeyOrder(['ssh-rsa'])).toContain('ssh-ed25519');
    expect(hostKeyOrder(['sk-unknown'])[0]).toBe('ssh-ed25519');
  });
});

describe('authorizedKeysCommand', () => {
  it('quotes a normal key line', () => {
    const cmd = authorizedKeysCommand('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH burrow-main');
    expect(cmd).toContain(`grep -qxF 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH burrow-main'`);
  });

  it('refuses anything that could break out of the quotes', () => {
    expect(() => authorizedKeysCommand(`ssh-ed25519 AAAA x'; rm -rf ~; echo '`)).toThrow();
    expect(() => authorizedKeysCommand('ssh-ed25519 AAAA\nssh-rsa BBBB')).toThrow();
  });
});

describe('parseFacts', () => {
  it('parses the facts script output', () => {
    const f = parseFacts('kernel=Linux 6.12\nos=Debian GNU/Linux 13 (trixie)\nshell=/bin/bash\ntmux=1\ndocker=0\n', 0);
    expect(f).toMatchObject({ kernel: 'Linux 6.12', os: 'Debian GNU/Linux 13 (trixie)', shell: '/bin/bash', hasTmux: true, hasDocker: false });
    expect(parseFacts('os=\n', 0).os).toBeNull();
  });
});

describe('facts that are whole', () => {
  it('only an answer with every line, from a command that succeeded, replaces what is known (AUDIT2 MON-10)', async () => {
    const { spawnSync } = await import('node:child_process');
    const ours = spawnSync('sh', ['-c', FACTS_COMMAND], { encoding: 'utf8' });
    expect(factsComplete(ours.status, ours.stdout)).toBe(true);
    // A forced command, or a shell that printed a banner and ran nothing.
    expect(factsComplete(0, 'This account is for backups only.\n')).toBe(false);
    expect(factsComplete(1, ours.stdout)).toBe(false);
    expect(factsComplete(0, ours.stdout.replace(/^docker=.*$/m, ''))).toBe(false);
  });
});

describe('generateEd25519', () => {
  it('never returns one of the malformed keys ssh2 sometimes produces', async () => {
    const { generateEd25519 } = await import('../../src/keys/vault.js');
    // ~0.5% of raw ssh2 keys are broken; 600 draws make at least one very likely.
    for (let i = 0; i < 600; i++) {
      const { pair, parsed } = generateEd25519('t');
      expect(parsed.getPublicSSH().length).toBe(51);
      expect(utils.parseKey(pair.private)).not.toBeInstanceOf(Error);
    }
  });
});

describe('the MAC address in the facts', () => {
  it('keeps a real one, lower case; drops none or zeros', () => {
    expect(parseFacts('mac=0A:1B:2C:3D:4E:5F\n', 0).mac).toBe('0a:1b:2c:3d:4e:5f');
    // A Proxmox VE node says so (F5); a host from before, without the line, is not one.
    expect(parseFacts('pve=1\n', 0).proxmox).toBe(true);
    expect(parseFacts('pve=0\n', 0).proxmox).toBe(false);
    expect(parseFacts('kernel=Linux\n', 0).proxmox).toBe(false);
    expect(parseFacts('mac=\n', 0).mac).toBeNull();
    expect(parseFacts('mac=00:00:00:00:00:00\n', 0).mac).toBeNull();
  });
});
