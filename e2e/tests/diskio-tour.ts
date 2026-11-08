import { expect, type Page } from './fixtures.js';
import type { DiskActivity, DiskHistory, DiskIo, HostStats } from '@burrow/shared';
import type { MessageKey } from '../../web/src/lib/i18n/en.js';

// The tour's screens of a disk's activity (report d4a9c0), with numbers
// that stay the same from pass to pass: a host with an NVMe SSD and two
// hard disks, one spun down and one busy; who reads and writes as root,
// as the SSH user only (sudo refused), and a measurement that failed.

type Tr = (key: MessageKey, params?: Record<string, string | number>) => string;

const STATS = /\/api\/hosts\/\d+\/stats$/;
const HISTORY = /\/api\/hosts\/\d+\/stats\/disks\?/;
const ACTIVITY = /\/api\/hosts\/\d+\/disks\/activity$/;

const disk = (d: Partial<DiskIo> & Pick<DiskIo, 'name' | 'kind'>): DiskIo => ({ model: null, sizeBytes: 0, readBps: 0, writeBps: 0, readIops: 0, writeIops: 0, util: 0, power: null, powerFrom: null, ...d });
const DISKS: DiskIo[] = [
  disk({ name: 'nvme0n1', kind: 'nvme', model: 'Samsung SSD 980 PRO 2TB', sizeBytes: 2_000_398_934_016, readBps: 52_224, writeBps: 1_258_291, readIops: 4.2, writeIops: 61, util: 3.1 }),
  disk({ name: 'sda', kind: 'hdd', model: 'ST10000DM006-3GD', sizeBytes: 10_000_831_348_736, power: 'standby', powerFrom: 'hdparm' }),
  disk({ name: 'sdb', kind: 'hdd', model: 'WDC WD40EFRX-68N32N0', sizeBytes: 4_000_787_030_016, readBps: 2_202_009, writeBps: 6_501_171, readIops: 18, writeIops: 47.5, util: 41.7, power: 'active', powerFrom: 'hdparm' }),
];

function stats(hostId: number, io: DiskIo[]): HostStats {
  return {
    hostId,
    at: new Date().toISOString(),
    cpu: 12.5,
    cores: 8,
    load: [0.8, 0.7, 0.6],
    memTotal: 33_554_432_000,
    memUsed: 13_421_772_800,
    swapTotal: 0,
    swapUsed: 0,
    uptimeSeconds: 1_716_000,
    disks: [{ mount: '/', fs: 'ext4', device: '/dev/nvme0n1p2', sizeBytes: 972_799_049_728, usedBytes: 571_230_486_528 }],
    temps: [],
    io,
    ioError: null,
  };
}

const history: DiskHistory[] = ['nvme0n1', 'sda', 'sdb'].map((name, n) => ({
  disk: name,
  samples: Array.from({ length: 12 }, (_, i) => ({ at: new Date(Date.now() - (12 - i) * 300_000).toISOString(), readBps: 100_000 * ((i + n) % 4), writeBps: 400_000 * ((i * 3 + n) % 5), readIops: (i + n) % 4, writeIops: 2 * ((i * 3 + n) % 5), util: 3 * ((i * 3 + n) % 5) })),
}));

const file = (path: string, write: boolean, disks: string[]) => ({ path, write, disks });
const ROOT: Omit<DiskActivity, 'hostId' | 'at'> = {
  seconds: 2.02,
  asRoot: true,
  rootRefused: null,
  // A few ended between the counting and the reading.
  processes: { total: 486, readable: 483 },
  disks: DISKS,
  top: [
    {
      pid: 2210,
      name: 'qbittorrent-nox',
      container: 'qbittorrent',
      readBps: 0,
      writeBps: 6_291_456,
      files: [file('/downloads/incomplete/Some.Linux.Distribution.2026.10.x86_64.Everything.DVD.iso', true, ['sdb']), file('/config/qBittorrent/logs/qbittorrent.log', true, ['nvme0n1'])],
      disks: ['nvme0n1', 'sdb'],
      moreFiles: 3,
      filesUnread: false,
    },
    { pid: 3301, name: 'smbd', container: null, readBps: 2_097_152, writeBps: 0, files: [file('/srv/media/Films/A very long film title that goes on and on (2026)/film.mkv', false, ['sdb'])], disks: ['sdb'], moreFiles: 0, filesUnread: false },
    { pid: 512, name: 'jbd2/sdb1-8', container: null, readBps: 0, writeBps: 40_960, files: [], disks: [], moreFiles: 0, filesUnread: false },
    {
      pid: 88424,
      name: 'postgres',
      container: 'immich-database-with-a-rather-long-name',
      readBps: 0,
      writeBps: 122_880,
      files: [file('/var/lib/postgresql/data/pg_wal/000000010000000500000013', true, ['nvme0n1'])],
      disks: ['nvme0n1'],
      moreFiles: 0,
      filesUnread: false,
    },
    { pid: 41022, name: '', container: null, readBps: 0, writeBps: 8_192, files: [], disks: [], moreFiles: 0, filesUnread: true },
  ],
  // Each container's bytes per disk from its cgroup (decision 6).
  containers: [
    { container: 'qbittorrent', readBps: 0, writeBps: 8_388_608, disks: [{ disk: 'sdb', readBps: 0, writeBps: 8_257_536 }, { disk: 'nvme0n1', readBps: 0, writeBps: 131_072 }] },
    { container: 'immich-database-with-a-rather-long-name', readBps: 0, writeBps: 163_840, disks: [{ disk: 'nvme0n1', readBps: 0, writeBps: 163_840 }] },
  ],
};
// Without root: the user's own processes, sda written to by none of them.
const USER: Omit<DiskActivity, 'hostId' | 'at'> = {
  ...ROOT,
  asRoot: false,
  rootRefused: 'sudo: a password is required',
  processes: { total: 486, readable: 212 },
  disks: DISKS.map((d) => (d.name === 'sda' ? { ...d, writeBps: 49_152, writeIops: 3, util: 2.5, power: 'active', powerFrom: 'io' } : d.name === 'sdb' ? { ...d, power: 'unknown', powerFrom: null } : d)),
  top: [ROOT.top[3]!],
};

async function mock(p: Page, hostId: number, activity: ((p: Page) => Promise<unknown>) | null) {
  await p.route(STATS, (r) => r.fulfill({ json: stats(hostId, DISKS) }));
  await p.route(HISTORY, (r) => r.fulfill({ json: history }));
  if (activity) await activity(p);
  await p.reload();
  await expect(p.getByTestId('io-disk')).toHaveCount(3, { timeout: 20_000 });
}

const openDisk = (name: string) => async (p: Page) => {
  await p.getByTestId('io-disk').filter({ hasText: name }).click();
  await expect(p.locator('dialog[open][data-tour=disk-activity]')).toBeVisible();
};

/** The screens, for workspace-tour.spec.ts. */
export function diskScreens(hostId: number) {
  const url = `/#/hosts/${hostId}/stats`;
  const answer = (body: Omit<DiskActivity, 'hostId' | 'at'>) => (p: Page) => p.route(ACTIVITY, (r) => r.fulfill({ json: { ...body, hostId, at: new Date().toISOString() } }));
  return [
    // The disk list: a busy hard disk, one spun down, an NVMe SSD.
    { name: 'host-stats-disks', url, noDialog: true, ready: (p: Page) => mock(p, hostId, null), open: (p: Page, T: Tr) => expect(p.getByTestId('io-power')).toHaveText([T('stats.io.power.standby'), T('stats.io.power.active')]) },
    {
      name: 'disk-activity',
      url,
      ready: (p: Page) => mock(p, hostId, answer(ROOT)),
      open: async (p: Page, T: Tr) => {
        await openDisk('sdb')(p);
        const d = p.locator('dialog[open]');
        // jbd2 (the journal) has no files open: not told which disk, among the others.
        await expect(d.getByTestId('disk-here').getByTestId('disk-proc')).toHaveCount(2);
        await expect(d.getByTestId('disk-elsewhere').getByTestId('disk-proc')).toHaveCount(3);
        await expect(d.getByTestId('disk-here')).toContainText('qbittorrent');
        await expect(d.getByTestId('disk-power')).toContainText(T('stats.io.from.hdparm'));
        await expect(d.getByTestId('disk-charts')).toBeVisible();
        await expect(d.getByTestId('disk-partial')).toContainText(T('disk.partial', { seen: 483, total: 486 }));
      },
    },
    {
      name: 'disk-activity-user',
      url,
      ready: (p: Page) => mock(p, hostId, answer(USER)),
      open: async (p: Page, T: Tr) => {
        await openDisk('sda')(p);
        const d = p.locator('dialog[open]');
        await expect(d.getByTestId('disk-as-user')).toContainText(T('disk.sudoSaid', { why: 'sudo: a password is required' }));
        await expect(d.getByTestId('disk-nobody')).toBeVisible();
        await expect(d.getByTestId('disk-unexplained')).toBeVisible();
      },
    },
    {
      name: 'disk-activity-failed',
      url,
      ready: (p: Page) => mock(p, hostId, (q) => q.route(ACTIVITY, (r) => r.fulfill({ status: 502, json: { error: 'host_unreachable', message: 'connect ECONNREFUSED 192.168.1.20:22' } }))),
      open: async (p: Page, T: Tr) => {
        await openDisk('sda')(p);
        // The network's words said in Burrow's (W-FUNC-06).
        await expect(p.locator('dialog[open]').getByTestId('load-failed')).toContainText(T('disk.failed', { error: T('error.host_unreachable', { detail: T('error.net.refused', { host: '192.168.1.20', port: '22' }) }) }));
      },
    },
  ];
}

/** After each screen: the stand-ins gone. */
export async function unrouteDisk(p: Page): Promise<void> {
  await p.unroute(STATS);
  await p.unroute(HISTORY);
  await p.unroute(ACTIVITY);
}
