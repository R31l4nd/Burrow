import { describe, expect, it } from 'vitest';
import { parseApkList, parseAptList, parseDnfList, parseDnfSecurity, parsePackageCheck, parsePacmanList, packageSummary } from './packages.js';

const AT = '2026-11-01T12:00:00.000Z';

describe('package updates', () => {
  it('reads apt list --upgradable, a -security suite as a security update', () => {
    const out = [
      'Listing...',
      'bash/trixie-security 5.2.37-2+b10+deb13u1 amd64 [upgradable from: 5.2.37-2+b10]',
      'gzip/trixie-updates 1.13-1+deb13u2 amd64 [upgradable from: 1.13-1+deb13u1]',
      'openssl/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]',
    ].join('\n');
    expect(parseAptList(out)).toEqual([
      { name: 'bash', from: '5.2.37-2+b10', to: '5.2.37-2+b10+deb13u1', security: true },
      { name: 'gzip', from: '1.13-1+deb13u1', to: '1.13-1+deb13u2', security: false },
      { name: 'openssl', from: '3.0.13-0ubuntu3.4', to: '3.0.13-0ubuntu3.5', security: true },
    ]);
  });

  it('reads dnf check-update and its security advisories (dnf 4 and 5)', () => {
    const list = ['Last metadata expiration check: 1:02:03 ago on Sat 01 Nov 2026.', '', 'openssl.x86_64     1:3.1.4-3.fc40     updates', 'vim-minimal.x86_64 2:9.1.2-1.fc40 updates', 'Obsoleting Packages', 'grub2-tools.x86_64 1:2.06-1.fc40 updates'].join('\n');
    expect(parseDnfList(list).map((u) => u.name)).toEqual(['openssl', 'vim-minimal']);
    const dnf4 = 'FEDORA-2026-1a2b3c Important/Sec. openssl-1:3.1.4-3.fc40.x86_64';
    const dnf5 = 'FEDORA-2026-4d5e6f security Moderate vim-minimal-2:9.1.2-1.fc40.x86_64 2026-10-30 10:00:00';
    expect([...parseDnfSecurity(`${dnf4}\n${dnf5}`)]).toEqual(['openssl', 'vim-minimal']);
  });

  it('reads apk list -u and pacman -Qu, an ignored package left out', () => {
    expect(parseApkList('busybox-1.36.1-r20 x86_64 {busybox} (GPL-2.0-only) [upgradable from: busybox-1.36.1-r19]')).toEqual([{ name: 'busybox', from: '1.36.1-r19', to: '1.36.1-r20', security: false }]);
    expect(parsePacmanList('linux 6.11.1.arch1-1 -> 6.11.2.arch1-1\nfirefox 131.0-1 -> 131.0.2-1 [ignored]')).toEqual([{ name: 'linux', from: '6.11.1.arch1-1', to: '6.11.2.arch1-1', security: false }]);
  });

  it('reads the whole check: security first, the lists age, a restart asked for', () => {
    const out = ['@@pkg apt', '@@age 1761998400', 'Listing...', 'gzip/trixie-updates 1.13-2 amd64 [upgradable from: 1.13-1]', 'tar/trixie-security 1.35-4 amd64 [upgradable from: 1.35-3]', '@@burrow-exit 0', '@@reboot yes'].join('\n');
    const r = parsePackageCheck(3, AT, out);
    expect(r).toMatchObject({ state: 'ok', manager: 'apt', listAt: '2025-11-01T12:00:00.000Z', security: 1, reboot: true, message: null });
    expect(r.updates.map((u) => u.name)).toEqual(['tar', 'gzip']);
    expect(packageSummary(r)).toEqual({ hostId: 3, checkedAt: AT, state: 'ok', total: 2, security: 1, reboot: true, listAt: '2025-11-01T12:00:00.000Z' });
  });

  it('marks dnf security updates from the advisories; exit 100 means updates are there', () => {
    const out = ['@@pkg dnf', 'openssl.x86_64 1:3.1.4-3.fc40 updates', 'zstd.x86_64 1.5.6-1.fc40 updates', '@@burrow-exit 100', '@@security', 'FEDORA-2026-1 Important/Sec. openssl-1:3.1.4-3.fc40.x86_64', '@@burrow-exit 0', '@@reboot no'].join('\n');
    const r = parsePackageCheck(1, AT, out);
    expect(r.state).toBe('ok');
    expect(r.updates).toEqual([
      { name: 'openssl', from: null, to: '1:3.1.4-3.fc40', security: true },
      { name: 'zstd', from: null, to: '1.5.6-1.fc40', security: false },
    ]);
    expect(r.reboot).toBe(false);
  });

  it('a failed or cut-short read is an error, never "nothing to update"', () => {
    const failed = parsePackageCheck(1, AT, '@@pkg apt\n@@burrow-exit 100\n', 'WARNING: apt does not have a stable CLI interface.\nE: Could not open lock file');
    expect(failed).toMatchObject({ state: 'error', manager: 'apt', message: 'E: Could not open lock file', updates: [] });
    expect(parsePackageCheck(1, AT, '@@pkg dnf\nopenssl.x86_64 1:3.1.4-3.fc40 updates\n')).toMatchObject({ state: 'error', message: 'The check was cut short.' });
    expect(parsePackageCheck(1, AT, '@@pkg dnf\n@@burrow-exit 1\n', 'Cache-only enabled but no cache for fedora')).toMatchObject({ state: 'error', message: 'Cache-only enabled but no cache for fedora' });
    expect(parsePackageCheck(1, AT, '')).toMatchObject({ state: 'error', manager: null });
  });

  it('pacman -Qu exits 1 when nothing is to update: none, not a failure', () => {
    expect(parsePackageCheck(1, AT, '@@pkg pacman\n@@burrow-exit 1\n@@reboot no\n')).toMatchObject({ state: 'ok', updates: [] });
    expect(parsePackageCheck(1, AT, '@@pkg pacman\n@@burrow-exit 1\n', 'error: failed to init transaction')).toMatchObject({ state: 'error', message: 'error: failed to init transaction' });
  });

  it('a host without a known package manager says so', () => {
    expect(parsePackageCheck(1, AT, '@@pkg none\n@@reboot no\n')).toMatchObject({ state: 'none', manager: null, updates: [] });
  });
});
