import { describe, expect, it } from 'vitest';
import { activityCommand, ActivityUnreadable, containerOf, counterRows, DiskMap, diskSamples, mountOf, parseActivity, parseDiskstats, parseFds, parseInventory, parseMountinfo, parsePower, wholeDisks, type DiskCounterRow } from '../../src/hosts/diskio.js';
import { parseStats, statsSections } from '../../src/hosts/stats.js';

// Report d4a9c0: per disk its reads, writes and busy time, whether a hard
// disk spins, and which processes read and write. The samples below are
// real: /proc/diskstats, /sys/block, /proc/<pid>/io, mountinfo and
// `ls -l /proc/<pid>/fd` from a Debian host with an NVMe SSD and two hard
// disks (sda a 10 TB data disk on /mnt/data), with Docker; paths and ids
// shortened, nothing else changed.

const DISKSTATS_1 = `1835418.25 11263343.26
 259       0 nvme0n1 459031465 16491772 62321459550 184323392 149754797 192082949 9206673652 866154119 0 100337436 1059400401 1361299 0 1827827472 850071 12715033 8072817
 259       1 nvme0n1p1 1768 6288 27998 1443 2 0 2 0 0 148 1513 9 0 5930040 69 0 0
 259       2 nvme0n1p2 432954429 8358634 62047771304 172483424 142580738 150736841 8804620442 796943701 0 118903212 970277127 1361290 0 1821897432 850001 0 0
 259       3 nvme0n1p3 26073965 8126850 273619680 11838219 7174047 41346108 402053208 69210417 0 7361296 81048637 0 0 0 0 0 0
   8       0 sda 49662440 667018 13649733122 225718137 5698904 2292470 6392289712 234755396 0 62619760 466125861 0 0 0 0 45399 5652327
   8       1 sda1 49662345 667018 13649730330 225717946 5698904 2292470 6392289712 234755396 0 76032740 460473343 0 0 0 0 0 0
   8      16 sdb 480029 61159 4335134 5941440 39761 138275 6670064 282310 0 3104496 6223750 0 0 0 0 0 0
   8      17 sdb1 479974 61159 4333990 5940793 39761 138275 6670064 282310 0 3128808 6223103 0 0 0 0 0 0`;

const DISKSTATS_2 = `1835419.29 11263347.39
 259       0 nvme0n1 459031466 16491772 62321459558 184323397 149754797 192082949 9206673652 866154119 0 100337440 1059400406 1361299 0 1827827472 850071 12715033 8072817
 259       1 nvme0n1p1 1768 6288 27998 1443 2 0 2 0 0 148 1513 9 0 5930040 69 0 0
 259       2 nvme0n1p2 432954430 8358634 62047771312 172483428 142580738 150736841 8804620442 796943701 0 118903216 970277132 1361290 0 1821897432 850001 0 0
 259       3 nvme0n1p3 26073965 8126850 273619680 11838219 7174047 41346108 402053208 69210417 0 7361296 81048637 0 0 0 0 0 0
   8       0 sda 49662440 667018 13649733122 225718137 5698904 2292470 6392289712 234755396 0 62619760 466125861 0 0 0 0 45399 5652327
   8       1 sda1 49662345 667018 13649730330 225717946 5698904 2292470 6392289712 234755396 0 76032740 460473343 0 0 0 0 0 0
   8      16 sdb 480029 61159 4335134 5941440 39761 138275 6670064 282310 0 3104496 6223750 0 0 0 0 0 0
   8      17 sdb1 479974 61159 4333990 5940793 39761 138275 6670064 282310 0 3128808 6223103 0 0 0 0 0 0`;

const BLK = `/sys/block/nvme0n1/queue/rotational:0
/sys/block/sda/queue/rotational:1
/sys/block/sdb/queue/rotational:1
/sys/block/nvme0n1/size:2000409264
/sys/block/sda/size:19532873728
/sys/block/sdb/size:976773168
/sys/block/nvme0n1/device/model:INTEL SSDPEKNW010T8
/sys/block/sda/device/model:ST10000DM006-3GD
/sys/block/sdb/device/model:HM500JI
/sys/block/nvme0n1/device/power/runtime_status:unsupported
/sys/block/sda/device/power/runtime_status:active
/sys/block/sdb/device/power/runtime_status:active
/sys/block/nvme0n1/hidden:0
/sys/block/sda/hidden:0
/sys/block/sdb/hidden:0`;
const PARTS = '@@parts /sys/block/nvme0n1/nvme0n1p1/partition /sys/block/nvme0n1/nvme0n1p2/partition /sys/block/nvme0n1/nvme0n1p3/partition /sys/block/sda/sda1/partition /sys/block/sdb/sdb1/partition';
// No device mapper or RAID: the shell left its glob as it was.
const SLAVES = '@@slaves /sys/block/*/slaves/*';

const STATS = `@@cpu
cpu  1000 0 1000 8000 0 0 0 0 0 0
cpu  1100 0 1100 8300 0 0 0 0 0 0
@@mem
MemTotal:       16000000 kB
MemAvailable:    4000000 kB
@@load
0.52 0.61 0.70 2/345 6789
8
@@up
123456.78 900000.00
@@df
Filesystem     Type 1B-blocks        Used   Available Capacity Mounted on
/dev/nvme0n1p2 ext4 100000000000 50000000000 50000000000 50% /
@@temp
@@io1
${DISKSTATS_1}
@@io2
${DISKSTATS_2}
@@blk
${BLK}
${PARTS}
${SLAVES}
`;

describe('disk I/O in the stats', () => {
  it('reads each whole disk, its kind, model and size, and its rates over the second (iostat: kB/s, r/s, %util)', () => {
    const s = parseStats(1, STATS, 0);
    expect(s.ioError).toBeNull();
    expect(s.io!.map((d) => [d.name, d.kind, d.model, d.sizeBytes])).toEqual([
      ['nvme0n1', 'nvme', 'INTEL SSDPEKNW010T8', 2000409264 * 512],
      ['sda', 'hdd', 'ST10000DM006-3GD', 19532873728 * 512],
      ['sdb', 'hdd', 'HM500JI', 976773168 * 512],
    ]);
    // 8 sectors read in 1.04 s; 4 ms of the 1040 busy.
    expect(s.io![0]).toMatchObject({ readBps: 3938, writeBps: 0, readIops: 1, writeIops: 0, util: 0.4, power: null, powerFrom: null });
    // A hard disk that did nothing, read without root: not known whether it spins (never woken to ask).
    expect(s.io![1]).toMatchObject({ readBps: 0, util: 0, power: 'unknown', powerFrom: null });
  });

  it("a hard disk's power state without root: spun down by the kernel, or active when it did I/O just now", () => {
    const suspended = STATS.replace('/sys/block/sda/device/power/runtime_status:active', '/sys/block/sda/device/power/runtime_status:suspended');
    expect(parseStats(1, suspended, 0).io![1]).toMatchObject({ name: 'sda', power: 'standby', powerFrom: 'kernel' });
    const busy = STATS.replace(DISKSTATS_2, DISKSTATS_2.replace(' sda 49662440 667018 13649733122 225718137 5698904 2292470 6392289712', ' sda 49662440 667018 13649733122 225718137 5698944 2292470 6392299712'));
    expect(parseStats(1, busy, 0).io![1]).toMatchObject({ name: 'sda', power: 'active', powerFrom: 'io', writeIops: 38.5 });
  });

  it('failed is not "no disks": a host whose counters could not be read says which', () => {
    expect(parseStats(1, STATS.replace(/@@io1[\s\S]*?@@blk/, '@@io1\n@@io2\n1.0 2.0\n@@blk'), 0)).toMatchObject({ io: [], ioError: '/proc/diskstats' });
    expect(parseStats(1, STATS.replace(BLK, ''), 0)).toMatchObject({ io: [], ioError: '/sys/block' });
  });

  it('counts only whole disks: no loop devices, RAM or compressed swap, device mapper, RAID, empty card readers, SD boot areas or hidden NVMe paths', () => {
    const blk = ['loop0', 'zram0', 'dm-0', 'md127', 'sr0', 'mmcblk0', 'mmcblk0boot0', 'mmcblk0rpmb', 'nvme0n1', 'nvme0c0n1', 'sdc', 'vda'].flatMap((n) => [`/sys/block/${n}/queue/rotational:1`, `/sys/block/${n}/size:${n === 'sdc' ? 0 : 1000}`]);
    expect(wholeDisks(parseInventory(blk, '', ''))).toEqual(['mmcblk0', 'nvme0n1', 'vda']);
  });

  it('keeps each disk\'s counters with a sample; the history is the rate over each interval, none over a reboot or a gap', () => {
    const { sec, markers } = statsSections(STATS);
    expect(counterRows(sec, markers, 1000).map((r) => r.disk)).toEqual(['nvme0n1', 'sda', 'sdb']);
    expect(counterRows(sec, markers, 1000)[0]).toMatchObject({ uptime: 1835419.29, rdSectors: 62321459558, wrIos: 149754797, ioMs: 100337440 });
    const row = (min: number, uptime: number, wrSectors: number, wrIos: number, ioMs: number): DiskCounterRow => ({ at: min * 60_000, disk: 'sda', uptime, rdIos: 0, rdSectors: 0, wrIos, wrSectors, ioMs });
    const samples = diskSamples([
      row(0, 1000, 0, 0, 0),
      // Five minutes: 300 s, 600 sectors written in 60 writes, 3 s busy.
      row(5, 1300, 600, 60, 3000),
      // A reboot: the uptime went back. No point.
      row(10, 200, 10, 1, 10),
      row(15, 500, 310, 31, 310),
      // Burrow was down for an hour: no average drawn over it.
      row(75, 4100, 1000, 100, 1000),
    ]);
    expect(samples).toEqual([
      { at: new Date(5 * 60_000).toISOString(), readBps: 0, writeBps: 1024, readIops: 0, writeIops: 0.2, util: 1 },
      { at: new Date(15 * 60_000).toISOString(), readBps: 0, writeBps: 512, readIops: 0, writeIops: 0.1, util: 0.1 },
    ]);
  });
});

// The on-demand sample, as root: two processes in containers and one on
// the host, the counters before and after, their mount tables and files.
const PROCS_A = `1680318/io:read_bytes: 188416
1680318/io:write_bytes: 790253568
88424/io:read_bytes: 602112
88424/io:write_bytes: 415277056
107173/io:write_bytes: 1077248
2210/io:read_bytes: 1048576
3301/io:read_bytes: 4096`;
// 3301 did nothing since; 4410 is new (its counter went from 0).
const PROCS_B = `1680318/io:read_bytes: 192512
1680318/io:write_bytes: 811438080
88424/io:read_bytes: 602112
88424/io:write_bytes: 415285248
107173/io:write_bytes: 1081344
2210/io:read_bytes: 9437184
3301/io:read_bytes: 4096
4410/io:write_bytes: 65536`;

const SELF_MOUNTS = `29 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro
47 29 0:42 / /tmp rw,nosuid,nodev shared:71 - tmpfs tmpfs rw,nr_inodes=1048576,inode64
50 29 259:1 / /boot/efi rw,relatime shared:88 - vfat /dev/nvme0n1p1 rw,fmask=0077,dmask=0077
53 29 8:1 / /mnt/data rw,relatime shared:91 - ext4 /dev/sda1 rw
1227 29 0:155 / /var/lib/docker/overlay2/d66ab06a/merged rw,relatime shared:531 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/RVIYUUPU:/var/lib/docker/overlay2/l/SXKNHY6X,upperdir=/var/lib/docker/overlay2/d66ab06a/diff,workdir=/var/lib/docker/overlay2/d66ab06a/work,nouserxattr`;

const ID_CHROME = '9e53043da1d398bf17a16a45b112ec7f024fe758af77a007787a9926c8855788';
const ID_PG = '659524e463978ace7816515f0fbb592d0be7d4838b963ed8f091287eef97b45a';

const ACTIVITY = `@@sudo
@@begin 0
@@procs 1941 1941
@@io1
${DISKSTATS_1.replace('1835418.25', '1835417.25')}
@@io2
${DISKSTATS_2}
@@a
${PROCS_A}
@@b
${PROCS_B}
@@blk
${BLK}
${PARTS}
${SLAVES}
@@selfns mnt:[4026531841]
@@selfmounts
${SELF_MOUNTS}
@@pid 1680318
@@comm chrome-headless
@@cg 0::/system.slice/docker-${ID_CHROME}.scope
@@ns mnt:[4026537803]
@@mounts
5370 5146 0:757 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/QYPEY4LM:/var/lib/docker/overlay2/l/5WHO2LJE,upperdir=/var/lib/docker/overlay2/d66ab06a/diff,workdir=/var/lib/docker/overlay2/d66ab06a/work,nouserxattr
5372 5370 0:787 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
5373 5370 0:788 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755,inode64
5380 5370 259:2 /var/lib/docker/containers/9e53043d/hostname /etc/hostname rw,relatime - ext4 /dev/nvme0n1p2 rw,errors=remount-ro
@@fd
lr-x------ 1 debian debian 64 Oct 16 00:17 0 -> /dev/null
lr-x------ 1 debian debian 64 Oct 16 00:17 10 -> /dev/urandom
lr-x------ 1 debian debian 64 Oct 16 00:17 13 -> /ms-playwright/chromium_headless_shell-1243/v8_context_snapshot.bin
lr-x------ 1 debian debian 64 Oct 16 00:17 21 -> /proc/2679/statm
lrwx------ 1 debian debian 64 Oct 16 00:17 30 -> /tmp/.org.chromium.Chromium.YfGL5r (deleted)
@@pid 88424
@@comm postgres
@@cg 0::/system.slice/docker-${ID_PG}.scope
@@ns mnt:[4026534910]
@@mounts
2569 2434 0:344 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/GOGCQW4J,upperdir=/var/lib/docker/overlay2/76858bc9/diff,workdir=/var/lib/docker/overlay2/76858bc9/work
2578 2569 259:2 /var/lib/docker/containers/659524e4/hostname /etc/hostname rw,relatime - ext4 /dev/nvme0n1p2 rw,errors=remount-ro
2581 2569 8:1 /appdata/postgres /var/lib/postgresql/data rw,relatime - ext4 /dev/sda1 rw
@@fd
lrwx------ 1 debian debian 64 Oct 16 00:17 0 -> /dev/null
lrwx------ 1 debian debian 64 Oct 16 00:17 6 -> /var/lib/postgresql/data/pg_wal/000000010000000500000013
lr-x------ 1 debian debian 64 Oct 16 00:17 7 -> /var/lib/postgresql/data/base/16384/2601
@@pid 2210
@@comm rsync
@@cg
@@ns mnt:[4026531841]
@@fd
lr-x------ 1 root root 64 Oct 16 00:17 3 -> /mnt/data/media/film.mkv
l-wx------ 1 root root 64 Oct 16 00:17 4 -> /mnt/data/media/.film.mkv.Xa81
@@pid 107173
@@comm nginx
@@cg 0::/system.slice/docker-6ec93b75856616526a98d351ac7cc0b2fc752312586f5bf177406eccc6f6b7bd.scope
@@ns
@@fdunread
@@fd
@@pid 4410
@@gone
@@power sda hdparm
 drive state is:  standby
@@power sdb smartctl
Power mode is:    ACTIVE or IDLE
@@end
`;

describe('who reads and writes (on demand)', () => {
  const names = new Map([[ID_CHROME, 'e2e-chrome']]);

  it('reads every process that did I/O, busiest first, with its container, rates and the disks of its files', () => {
    const a = parseActivity(ACTIVITY, names);
    expect(a).toMatchObject({ asRoot: true, seconds: 2.04, processes: { total: 1941, readable: 1941 } });
    expect(a.top.map((p) => [p.pid, p.name, p.container, p.readBps, p.writeBps])).toEqual([
      // 21 MB written in 2.04 s.
      [1680318, 'chrome-headless', 'e2e-chrome', 2008, 10384565],
      [2210, 'rsync', null, 4112063, 0],
      [4410, '', null, 0, 32125],
      // Not a container Burrow knows (ignored, or Docker not read): its short id.
      [88424, 'postgres', '659524e46397', 0, 4016],
      [107173, 'nginx', '6ec93b758566', 0, 2008],
    ]);
    const [chrome, rsync, gone, pg, nginx] = a.top as [(typeof a.top)[number], (typeof a.top)[number], (typeof a.top)[number], (typeof a.top)[number], (typeof a.top)[number]];
    // A container's own files: through its overlay's upper layer to the host's disk; /dev and /proc are no files.
    expect(chrome.files).toEqual([
      { path: '/tmp/.org.chromium.Chromium.YfGL5r', write: true, disks: ['nvme0n1'] },
      { path: '/ms-playwright/chromium_headless_shell-1243/v8_context_snapshot.bin', write: false, disks: ['nvme0n1'] },
    ]);
    // A volume bound from the hard disk: on sda, by the mount's device number (8:1, its partition).
    expect(pg.files[0]).toEqual({ path: '/var/lib/postgresql/data/pg_wal/000000010000000500000013', write: true, disks: ['sda'] });
    expect(pg.disks).toEqual(['sda']);
    // On the host itself: its mount table is the reader's own.
    expect(rsync.files).toEqual([
      { path: '/mnt/data/media/.film.mkv.Xa81', write: true, disks: ['sda'] },
      { path: '/mnt/data/media/film.mkv', write: false, disks: ['sda'] },
    ]);
    // Ended before it was looked at, or not allowed: said, not "no files".
    expect(gone).toMatchObject({ files: [], filesUnread: true });
    expect(nginx).toMatchObject({ files: [], filesUnread: true });
    expect(chrome.filesUnread).toBe(false);
  });

  it("each container's bytes per disk from its cgroup's io.stat, over the same seconds, busiest first (decision 6)", () => {
    const cg = (id: string, scope = true) => (scope ? `/sys/fs/cgroup/system.slice/docker-${id}.scope/io.stat` : `/sys/fs/cgroup/docker/${id}/io.stat`);
    const c1 = [`${cg(ID_PG)}:8:0 rbytes=1000 wbytes=500000 rios=1 wios=20 dbytes=0 dios=0`, `${cg(ID_PG)}:259:0 rbytes=0 wbytes=4096 rios=0 wios=1 dbytes=0 dios=0`, `${cg(ID_CHROME, false)}:259:0 rbytes=0 wbytes=100 rios=0 wios=1 dbytes=0 dios=0`].join('\n');
    const c2 = [`${cg(ID_PG)}:8:0 rbytes=1000 wbytes=4580000 rios=1 wios=900 dbytes=0 dios=0`, `${cg(ID_PG)}:259:0 rbytes=0 wbytes=8192 rios=0 wios=2 dbytes=0 dios=0`, `${cg(ID_CHROME, false)}:259:0 rbytes=2040 wbytes=20400100 rios=1 wios=99 dbytes=0 dios=0`].join('\n');
    const a = parseActivity(ACTIVITY.replace('@@blk\n', `@@c1\n${c1}\n@@c2\n${c2}\n@@blk\n`), new Map([[ID_CHROME, 'e2e-chrome']]));
    // 20.4 MB and 4.08 MB in 2.04 s.
    expect(a.containers).toEqual([
      { container: 'e2e-chrome', readBps: 1000, writeBps: 10000000, disks: [{ disk: 'nvme0n1', readBps: 1000, writeBps: 10000000 }] },
      { container: '659524e46397', readBps: 0, writeBps: 2002008, disks: [{ disk: 'sda', readBps: 0, writeBps: 2000000 }, { disk: 'nvme0n1', readBps: 0, writeBps: 2008 }] },
    ]);
    // Without cgroup v2 io accounting: none, not "no container wrote".
    expect(parseActivity(ACTIVITY).containers).toBeUndefined();
  });

  it("as root, each hard disk's power state as the drive says it (hdparm -C, smartctl -n standby): neither wakes it", () => {
    const a = parseActivity(ACTIVITY);
    expect(a.disks.map((d) => [d.name, d.power, d.powerFrom])).toEqual([
      ['nvme0n1', null, null],
      ['sda', 'standby', 'hdparm'],
      ['sdb', 'active', 'smartctl'],
    ]);
    expect(parsePower('hdparm', '\n/dev/sda:\n drive state is:  active/idle\n')).toBe('active');
    expect(parsePower('hdparm', ' drive state is:  unknown')).toBe('unknown');
    expect(parsePower('hdparm', 'SG_IO: bad/missing sense data')).toBe('unknown');
    expect(parsePower('smartctl', 'Device is in STANDBY mode, exit(2)')).toBe('standby');
    expect(parsePower('smartctl', 'Device is in SLEEP mode, exit(2)')).toBe('standby');
    expect(parsePower('smartctl', '')).toBe('unknown');
  });

  it('not root: said so; a sample cut short or without the counters is an error, never "nobody writes"', () => {
    const user = parseActivity(ACTIVITY.replace('@@begin 0', '@@begin 1000').replace('@@procs 1941 1941', '@@procs 1941 1333'));
    expect(user).toMatchObject({ asRoot: false, processes: { total: 1941, readable: 1333 } });
    expect(() => parseActivity(ACTIVITY.replace('@@end\n', ''))).toThrow(ActivityUnreadable);
    expect(() => parseActivity(ACTIVITY.replace(/@@a\n[\s\S]*?@@blk/, '@@blk'))).toThrow(ActivityUnreadable);
    expect(() => parseActivity('')).toThrow(ActivityUnreadable);
    expect(() => parseActivity(ACTIVITY.replace(/@@io1[\s\S]*?@@a\n/, '@@io1\n@@io2\n@@a\n'))).toThrow('/proc/diskstats');
    // Read whole, and nobody did any I/O: that is an empty list.
    expect(parseActivity(ACTIVITY.replace(PROCS_B, PROCS_A)).top).toEqual([]);
  });

  it('LVM, LUKS and RAID: a file on a device-mapper volume is on the disks under it; btrfs and ZFS by their mount source', () => {
    const inv = parseInventory(
      ['sdc', 'sdd'].flatMap((n) => [`/sys/block/${n}/queue/rotational:1`, `/sys/block/${n}/size:1000`]).concat(['/sys/block/dm-0/queue/rotational:1', '/sys/block/dm-0/size:900', '/sys/block/dm-0/dm/name:vg0-data', '/sys/block/md0/size:900', '/sys/block/md0/queue/rotational:1']),
      '@@parts /sys/block/sdc/sdc1/partition /sys/block/sdd/sdd1/partition',
      '@@slaves /sys/block/dm-0/slaves/md0 /sys/block/md0/slaves/sdc1 /sys/block/md0/slaves/sdd1',
    );
    const snap = parseDiskstats([' 253 0 dm-0 1 0 0 0 0 0 0 0 0 0 0 0 0 0', '   9 0 md0 1 0 0 0 0 0 0 0 0 0 0 0 0 0']);
    const mounts = parseMountinfo(['60 29 253:0 / /srv rw,relatime - ext4 /dev/mapper/vg0-data rw', '61 29 0:52 / /pool rw,relatime - btrfs /dev/mapper/vg0-data rw,space_cache=v2', '62 29 0:60 / /tank rw - zfs tank/data rw']);
    const map = new DiskMap(inv, snap, mounts);
    expect(map.ofPath('/srv/x', mounts)).toEqual(['sdc', 'sdd']);
    expect(map.ofPath('/pool/x', mounts)).toEqual(['sdc', 'sdd']);
    // ZFS: its disks are not in a mount table (zpool status would tell): not told, not guessed.
    expect(map.ofPath('/tank/x', mounts)).toEqual([]);
  });

  it('mount tables, open files and containers as the kernel writes them', () => {
    const m = parseMountinfo(['53 29 8:1 / /mnt/my\\040disk rw,relatime shared:91 - ext4 /dev/sda1 rw', '29 1 259:2 / / rw - ext4 /dev/nvme0n1p2 rw']);
    expect(m[0]).toMatchObject({ dev: '8:1', point: '/mnt/my disk', fs: 'ext4', source: '/dev/sda1' });
    expect(mountOf('/mnt/my disk/a', m)?.dev).toBe('8:1');
    expect(mountOf('/mnt/my diskette', m)?.dev).toBe('259:2');
    expect(parseFds(['l-wx------ 1 a a 64 Oct 16 00:17 4 -> /var/log/x.log', 'lr-x------ 1 a a 64 Oct 16 00:17 5 -> /var/log/x.log', 'lrwx------ 1 a a 64 Oct 16 00:17 6 -> /dev/sda', 'lrwx------ 1 a a 64 Oct 16 00:17 7 -> /memfd:wayland (deleted)'])).toEqual([{ path: '/var/log/x.log', write: true }]);
    expect(containerOf(`0::/system.slice/docker-${ID_PG}.scope`, new Map())).toBe('659524e46397');
    expect(containerOf(`12:memory:/docker/${ID_PG}`, new Map([[ID_PG, 'db']]))).toBe('db');
    expect(containerOf(`0::/machine.slice/libpod-${ID_PG}.scope/container`, new Map())).toBe('659524e46397');
    expect(containerOf('0::/lxc.payload.web01', new Map())).toBe('web01');
    expect(containerOf('0::/user.slice/user-1000.slice/session-3.scope', new Map())).toBeNull();
  });

  it('runs as root through the stored password, else sudo -n; as the user when sudo said no', () => {
    expect(activityCommand('pw')).toContain("sudo -S -p '' sh -c");
    expect(activityCommand(null)).toContain('sudo -n sh -c');
    expect(activityCommand(null, true)).toMatch(/^sh -c /);
    expect(activityCommand(null, true)).not.toMatch(/sudo -/);
    // The password goes on sudo's input, never in the command line any process list shows.
    expect(activityCommand('hunter2-stored-password')).not.toContain('hunter2');
  });
});
