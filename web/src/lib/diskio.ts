import type { DiskIo } from '@burrow/shared';
import { formatBytes } from './files.svelte.js';
import { t } from './i18n/index.svelte.js';

// How a disk's numbers are said (the stats page's disk list and DiskDialog).

/** Bytes a second: "0 B/s", "340 KB/s", "12 MB/s". */
export const perSecond = (bps: number): string => `${formatBytes(Math.round(bps))}/s`;

/** Operations a second: one decimal below ten. */
export const iops = (n: number): string => (n < 10 ? n.toFixed(1).replace(/\.0$/, '') : String(Math.round(n)));

/** "sda (HDD)": short enough for a phone's dialog title; the model goes beside the numbers. */
export function diskTitle(d: DiskIo): string {
  return `${d.name} (${t(`stats.io.kind.${d.kind}`)})`;
}

/** How a hard disk's power state is known, or why not. */
export function powerNote(d: DiskIo): string {
  return d.powerFrom ? t(`stats.io.from.${d.powerFrom}`) : t('stats.io.from.none');
}
