import { describe, expect, it } from 'vitest';
import { cpuCounters, parseSmart, parseStats, smartCommand, smartOutcome, smartTrouble, statsGap, statsTrouble, sustainedTrouble, DEFAULT_THRESHOLDS } from '../../src/hosts/stats.js';
import { usernameFrom } from '../../src/auth/oidc.js';

const OUT = `@@cpu
cpu  1000 0 1000 8000 0 0 0 0 0 0
cpu  1100 0 1100 8300 0 0 0 0 0 0
@@mem
MemTotal:       16000000 kB
MemAvailable:    4000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
@@load
0.52 0.61 0.70 2/345 6789
8
@@up
123456.78 900000.00
@@df
Filesystem     Type 1B-blocks        Used   Available Capacity Mounted on
/dev/sda2      ext4 100000000000 95000000000 5000000000 95% /
/dev/sdb1      ext4 4000000000000 1000000000000 3000000000000 25% /data
/dev/sdb1      ext4 4000000000000 1000000000000 3000000000000 25% /data/appdata
/dev/sda1      vfat 500000000 10000000 490000000 2% /boot/efi
@@temp
zone:x86_pkg_temp 67000
coretemp:temp1 88000
nvme:temp1 45850
`;

describe('host statistics', () => {
  it('reads CPU, memory, load, uptime, disks and temperatures', () => {
    const s = parseStats(1, OUT, 0);
    expect(s).toMatchObject({ cpu: 40, cores: 8, load: [0.52, 0.61, 0.7], uptimeSeconds: 123457, memTotal: 16000000 * 1024, memUsed: 12000000 * 1024, swapUsed: 500000 * 1024 });
    // A bind mount of the same filesystem counts once.
    expect(s.disks.map((d) => d.mount)).toEqual(['/', '/data', '/boot/efi']);
    expect(s.temps).toEqual([
      { label: 'x86_pkg_temp', celsius: 67 },
      { label: 'coretemp:temp1', celsius: 88 },
      { label: 'nvme:temp1', celsius: 45.9 },
    ]);
    expect(statsTrouble(s, DEFAULT_THRESHOLDS)).toEqual([
      { subject: '@disk /', event: 'disk_full', title: 'disk 95% full' },
      { subject: '@temperature', event: 'hot', title: 'CPU at 88 C' },
    ]);
  });

  it('reads nothing from a host that answered without its numbers (no zeros that look idle)', () => {
    expect(statsGap(OUT)).toBeNull();
    expect(statsGap('')).toBe('/proc/stat');
    expect(statsGap(OUT.replace(/MemTotal.*\n/, ''))).toBe('/proc/meminfo');
    expect(statsGap(OUT.replace('123456.78 900000.00', ''))).toBe('/proc/uptime');
  });

  it('calls SMART fine only when disks answered', () => {
    const sata = JSON.stringify({ model_name: 'WDC', smart_status: { passed: true } });
    expect(smartOutcome(0, `@@dev /dev/sda\n${sata}\n`, '')).toMatchObject({ state: 'ok', message: null });
    expect(smartOutcome(0, `@@dev /dev/sda\n${sata}\n@@dev /dev/sdb\nnot json\n`, '')).toMatchObject({ state: 'ok', message: 'No readable answer from /dev/sdb.' });
    expect(smartOutcome(0, '@@dev /dev/sda\n', '')).toMatchObject({ state: 'error', disks: [] });
    expect(smartOutcome(126, '', 'sh: cannot execute')).toEqual({ state: 'error', message: 'sh: cannot execute', disks: [] });
    expect(smartOutcome(1, '', 'sudo: a password is required')).toMatchObject({ state: 'denied' });
    expect(smartOutcome(0, '', '')).toMatchObject({ state: 'none' });
    expect(smartOutcome(0, '@@nosmart\n', '')).toMatchObject({ state: 'none' });
  });

  it('a short peak is no trouble: the CPU over a whole interval, memory and heat over two samples in a row', () => {
    expect(cpuCounters(OUT)).toEqual({ total: 10500, idle: 8300 });
    const cool = parseStats(1, OUT.replace('coretemp:temp1 88000', 'coretemp:temp1 40000'), 0);
    const hot = parseStats(1, OUT, 0);
    const t = { ...DEFAULT_THRESHOLDS, diskPercent: 99 };
    // Hot once: nothing; hot again: told.
    let r = sustainedTrouble(hot, null, { hot: 0, mem: 0 }, t);
    expect(r.troubles).toEqual([]);
    r = sustainedTrouble(hot, null, r.streak, t);
    expect(r.troubles.map((x) => x.title)).toEqual(['CPU at 88 C']);
    expect(sustainedTrouble(cool, null, r.streak, t).streak.hot).toBe(0);
    // The CPU's average over the interval decides; memory 96% twice.
    expect(sustainedTrouble(cool, { percent: 93.4, minutes: 5 }, { hot: 0, mem: 0 }, t).troubles.map((x) => x.title)).toEqual(['CPU at 93% for 5 minutes']);
    expect(sustainedTrouble(cool, { percent: 60, minutes: 5 }, { hot: 0, mem: 0 }, t).troubles).toEqual([]);
    const full = { ...cool, memUsed: cool.memTotal * 0.96 };
    r = sustainedTrouble(full, null, { hot: 0, mem: 0 }, t);
    expect(r.troubles).toEqual([]);
    expect(sustainedTrouble(full, null, r.streak, t).troubles).toEqual([{ subject: '@memory', event: 'busy', title: 'memory 96% full for 10 minutes' }]);
  });

  it('reads busybox df without types', () => {
    const s = parseStats(1, '@@df\n@@df-plain\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000 500 500 50% /\ntmpfs 100 0 100 0% /tmp\n', 0);
    expect(s.disks).toEqual([{ device: '/dev/root', fs: '', sizeBytes: 1024000, usedBytes: 512000, mount: '/' }]);
  });

  it("a disk SMART cannot read (a USB enclosure) says why, and no 0 C as if it were a temperature (live UI round)", () => {
    const usb = JSON.stringify({ smartctl: { messages: [{ string: '/dev/sda: Unknown USB bridge [0x152d:0x0578 (0x214)]', severity: 'error' }, { string: 'Please specify device type with the -d option.', severity: 'information' }], exit_status: 1 }, temperature: { current: 0 } });
    const [d] = parseSmart(`@@dev /dev/sda\n${usb}\n`);
    expect(d).toMatchObject({ device: '/dev/sda', celsius: null, passed: null, note: 'Unknown USB bridge [0x152d:0x0578 (0x214)]. Please specify device type with the -d option.' });
  });

  it('reads SMART from smartctl JSON and notices trouble', () => {
    const sata = JSON.stringify({ model_name: 'WDC WD40', serial_number: 'S1', smart_status: { passed: true }, temperature: { current: 38 }, power_on_time: { hours: 12000 }, ata_smart_attributes: { table: [{ id: 5, raw: { value: 8 } }, { id: 197, raw: { value: 0 } }] } });
    const nvme = JSON.stringify({ model_name: 'Samsung 980', serial_number: 'N1', smart_status: { passed: true }, nvme_smart_health_information_log: { percentage_used: 91, media_errors: 0, temperature: 51 } });
    const disks = parseSmart(`@@dev /dev/sda\n${sata}\n@@dev /dev/nvme0\n${nvme}\n`);
    expect(disks[0]).toMatchObject({ device: '/dev/sda', model: 'WDC WD40', passed: true, celsius: 38, powerOnHours: 12000, reallocated: 8, pending: 0 });
    expect(disks[1]).toMatchObject({ device: '/dev/nvme0', percentUsed: 91, mediaErrors: 0, celsius: 51 });
    const before = [{ ...disks[0]!, reallocated: 2 }, { ...disks[1]!, percentUsed: 80 }];
    expect(smartTrouble(disks, before, DEFAULT_THRESHOLDS).map((t) => t.title)).toEqual(['8 reallocated sectors (was 2)', 'worn: 91% used']);
    // Nothing new: nothing to say.
    expect(smartTrouble(disks, disks, DEFAULT_THRESHOLDS)).toEqual([]);
    expect(smartTrouble([{ ...disks[0]!, passed: false }], [], DEFAULT_THRESHOLDS)[0]!.title).toBe('SMART says the disk is failing');
    // Backblaze's other three counts and NVMe's critical warning are read too (N4), and their growth is told.
    const more = JSON.stringify({ serial_number: 'S2', smart_status: { passed: true }, ata_smart_attributes: { table: [{ id: 187, raw: { value: 3 } }, { id: 188, raw: { value: 1 } }, { id: 198, raw: { value: 2 } }] } });
    const warn = JSON.stringify({ serial_number: 'N2', smart_status: { passed: true }, nvme_smart_health_information_log: { percentage_used: 5, media_errors: 0, critical_warning: 4 } });
    const [d2, n2] = parseSmart(`@@dev /dev/sdb\n${more}\n@@dev /dev/nvme1\n${warn}\n`);
    expect(d2).toMatchObject({ uncorrectable: 3, timeouts: 1, offlineUncorrectable: 2 });
    expect(n2).toMatchObject({ criticalWarning: 4 });
    expect(smartTrouble([d2!], [{ ...d2!, uncorrectable: 1 }], DEFAULT_THRESHOLDS).map((t) => t.title)).toEqual(['3 uncorrectable errors (was 1)']);
    expect(smartTrouble([d2!], [{ ...d2!, offlineUncorrectable: 0 }], DEFAULT_THRESHOLDS).map((t) => t.title)).toEqual(['2 unreadable sectors (was 0)']);
    expect(smartTrouble([n2!], [{ ...n2!, criticalWarning: 0 }], DEFAULT_THRESHOLDS).map((t) => t.title)).toEqual(['the disk reports a critical warning']);
    expect(smartTrouble([n2!], [n2!], DEFAULT_THRESHOLDS)).toEqual([]);
    // With the stored password one sudo; without, each smartctl through sudo, as the sudoers line in the help allows (AUDIT2 SMART-08).
    expect(smartCommand('pw')).toMatch(/^sudo -S -p '' env SC=smartctl sh -c /);
    expect(smartCommand(null)).toMatch(/^SC='sudo -n smartctl' sh -c /);
    expect(smartCommand(null)).not.toMatch(/sudo -n sh/);
    // Judged failing now and not before: said, also with no growth since the last check (AUDIT2 SMART-01).
    const failing = { ...d2!, pending: 8, verdict: 'failing' as const, reasons: [{ code: 'attr' as const, attr: 'pending' as const, value: 8, was: 3, since: '2026-09-10T00:00:00.000Z' }] };
    expect(smartTrouble([failing], [{ ...failing, verdict: 'watch' }], DEFAULT_THRESHOLDS).map((t) => t.title)).toEqual(['getting worse: 8 pending sectors (was 3)']);
    expect(smartTrouble([failing], [failing], DEFAULT_THRESHOLDS)).toEqual([]);
    // Worn 95% then 100%: worn out is said, though the 90% limit was crossed before.
    expect(smartTrouble([{ ...n2!, criticalWarning: 0, percentUsed: 100 }], [{ ...n2!, criticalWarning: 0, percentUsed: 95 }], DEFAULT_THRESHOLDS).map((t) => t.title)).toEqual(['worn out: 100% used']);
  });
});

describe('single sign-on names', () => {
  it('makes a Burrow user name of a claim', () => {
    expect(usernameFrom('Alice.Smith@example.com')).toBe('alice.smith');
    expect(usernameFrom('Jöhn Doe')).toBe('j-hn-doe');
    expect(usernameFrom('__x')).toBe('x');
  });
});

describe('mounts', () => {
  it('skips what Docker mounts into a container, keeps an overlay root', () => {
    const s = parseStats(
      1,
      '@@df\nFilesystem Type 1B-blocks Used Available Capacity Mounted on\noverlay overlay 100 50 50 50% /\n/dev/sda1 ext4 1000 10 990 1% /etc/hosts\noverlay overlay 100 50 50 50% /var/lib/docker/overlay2/x/merged\n',
      0,
    );
    expect(s.disks.map((d) => d.mount)).toEqual(['/']);
  });
});

describe('host statistics, read right', () => {
  it('reads nothing when load, available memory or df is missing (AUDIT2 MON-08)', () => {
    expect(statsGap(OUT.replace(/MemAvailable.*\n/, ''))).toBe('/proc/meminfo');
    expect(statsGap(OUT.replace('0.52 0.61 0.70 2/345 6789\n', ''))).toBe('/proc/loadavg');
    expect(statsGap(OUT.replace(/@@df\n[\s\S]*?@@temp/, '@@df\n@@df-plain\n@@temp'))).toBe('df');
    // busybox df (no types) is a df that answered.
    expect(statsGap(OUT.replace(/@@df\n[\s\S]*?@@temp/, '@@df\n@@df-plain\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000 500 500 50% /\n@@temp'))).toBeNull();
  });

  it('counts guest time once: it is already in user and nice (AUDIT2 MON-24)', () => {
    const guest = OUT.replace('cpu  1000 0 1000 8000 0 0 0 0 0 0', 'cpu  1000 0 1000 8000 0 0 0 0 500 0').replace('cpu  1100 0 1100 8300 0 0 0 0 0 0', 'cpu  1100 0 1100 8300 0 0 0 0 600 0');
    expect(parseStats(1, guest, 0).cpu).toBe(40);
    expect(cpuCounters(guest)).toEqual({ total: 10500, idle: 8300 });
  });
});

describe('SMART, failed is not empty', () => {
  it('a scan that failed, or disks smartctl could not read, are said (AUDIT2 MON-09)', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const { SMART_SCRIPT } = await import('../../src/hosts/stats.js');
    const bin = mkdtempSync(join(tmpdir(), 'smart-'));
    try {
      writeFileSync(join(bin, 'smartctl'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'smartctl'), 0o755);
      const run = (sc: string) => spawnSync('sh', ['-c', SMART_SCRIPT], { env: { PATH: `${bin}:${process.env.PATH}`, SC: sc }, encoding: 'utf8' });
      const failed = run('false');
      expect(failed.stdout).toContain('@@scanfailed');
      expect(smartOutcome(failed.status, failed.stdout, 'sudo: a password is required')).toMatchObject({ state: 'denied' });
      expect(smartOutcome(failed.status, failed.stdout, 'smartctl: permission denied')).toMatchObject({ state: 'error', message: 'smartctl: permission denied' });
      // Nothing found: no disk named "".
      expect(run('true').stdout).not.toContain('@@dev');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
    const good = JSON.stringify({ model_name: 'WDC', smart_status: { passed: true } });
    const open = JSON.stringify({ smartctl: { exit_status: 2, messages: [{ string: '/dev/sdb: Device open failed', severity: 'error' }] } });
    expect(smartOutcome(0, `@@dev /dev/sda\n${good}\n@@dev /dev/sdb\n${open}\n`, '')).toMatchObject({ state: 'ok', message: 'No readable answer from /dev/sdb (Device open failed).' });
    expect(smartOutcome(0, `@@dev /dev/sdb\n${open}\n`, '')).toMatchObject({ state: 'error', message: 'No readable answer from /dev/sdb (Device open failed).' });
  });
});
