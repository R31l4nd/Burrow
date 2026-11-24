import { z } from 'zod';
import { DIALOGS, PAGES, SETTINGS_PARTS, pathOf, pageOf } from './pages.js';

// What Settings -> Usage counts: how often each page and each dialog was
// opened, per day, on this Burrow only (it never leaves it). By name only: a
// page as the tour names it ("hosts/:id/stats"), a dialog by its tour name
// ("processes"), so no host, container, file or token is ever kept. An admin
// sees which parts are used and which are dead weight, and can turn it off.

const SETTINGS = new Set<string>(SETTINGS_PARTS);

/** A page's key: its name, a part of Settings by its own. */
export function usagePage(hash: string): string {
  const page = pageOf(hash, true);
  const part = pathOf(hash).split('/')[1] ?? '';
  return `page:${page === 'settings/:name' && SETTINGS.has(part) ? `settings/${part}` : page}`;
}

/** Every page and dialog there is, by key: the ones never opened are listed too. */
export const USAGE_KEYS: string[] = [
  ...[...PAGES.filter((p) => p !== 'settings/:name' && p !== 'login' && p !== 'setup' && !p.startsWith('invite/')), ...SETTINGS_PARTS.map((x) => `settings/${x}`)].map((p) => `page:${p}`),
  ...DIALOGS.map((d) => `dialog:${d}`),
];

const known = new Set(USAGE_KEYS);

/** A page or dialog Burrow has: anything else is not counted. */
export const usageKeyOk = (key: string): boolean => known.has(key);

/**
 * What a client sends: counts since its last send, at most 200 keys. Keys Burrow does not know
 * (an open tab from before an update, a made-up name) are dropped, the rest kept: one stale key
 * lost the whole batch.
 */
export const usageCounts = z
  .record(z.string().max(100), z.number().int().min(1).max(100_000))
  .refine((r) => Object.keys(r).length <= 200, 'too many usage keys')
  .transform((r) => Object.fromEntries(Object.entries(r).filter(([k]) => usageKeyOk(k))));

/** One page or dialog over the days asked: how often, and the last day it was opened. */
export interface UsageRow {
  key: string;
  n: number;
  last: string | null;
}

export interface UsageSummary {
  on: boolean;
  /** The first day counted (kept: the last 180 days), null when nothing is. */
  since: string | null;
  days: number;
  rows: UsageRow[];
}
