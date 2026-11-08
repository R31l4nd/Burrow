import { describe, expect, it, vi } from 'vitest';
import type { DiskIo } from '@burrow/shared';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { diskTitle, iops, perSecond, powerNote } = await import('./diskio.js');

// How a disk's numbers are said on the statistics page and in its dialog.
const disk = (d: Partial<DiskIo>) => ({ name: 'sda', kind: 'hdd', powerFrom: null, ...d }) as DiskIo;

describe("a disk's numbers", () => {
  it('bytes a second, whole bytes and the unit that fits', () => {
    expect(perSecond(0)).toBe('0 B/s');
    expect(perSecond(511.6)).toBe('512 B/s');
    expect(perSecond(340 * 1024)).toBe('340 KB/s');
    expect(perSecond(12 * 1024 * 1024)).toMatch(/^12(\.0)? MB\/s$/);
  });

  it('operations a second: one decimal below ten, none when it is whole, whole above', () => {
    expect(iops(0)).toBe('0');
    expect(iops(2.34)).toBe('2.3');
    expect(iops(4)).toBe('4');
    expect(iops(9.96)).toBe('10');
    expect(iops(123.6)).toBe('124');
  });

  it("the dialog's title says the kind short; the power note says how it is known, or why not", () => {
    expect(diskTitle(disk({ name: 'nvme0n1', kind: 'nvme' }))).toBe('nvme0n1 (NVMe SSD)');
    expect(diskTitle(disk({}))).toBe('sda (HDD)');
    expect(powerNote(disk({ powerFrom: 'hdparm' }))).toMatch(/hdparm -C/);
    expect(powerNote(disk({ powerFrom: null }))).toMatch(/never wakes a disk/);
  });
});
