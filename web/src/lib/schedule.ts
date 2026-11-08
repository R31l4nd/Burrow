import type { ScheduleKind } from '@burrow/shared';
import { t } from './i18n/index.svelte.js';

// When something runs by itself (reports, scheduled commands): the words
// for it and the choices its form offers, in one place.

export const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The time zones to choose from: the browser's own list, with this browser's, UTC and the one set. */
export function zonesWith(current: string): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    // An older browser: the few below.
  }
  return [...new Set([...all, browserZone, 'UTC', current])].sort();
}

/** Sunday first, as the server counts (0 ... 6), in the page's language. */
export const dayNames = (lang = document.documentElement.lang || 'en') =>
  [0, 1, 2, 3, 4, 5, 6].map((d) => new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(lang, { weekday: 'long', timeZone: 'UTC' }));

/** "every Monday at 08:00", "every day at 03:00", "cron 0 4 * * *". */
export const whenText = (s: { kind: ScheduleKind; day: number; time: string; cron: string | null }) =>
  s.kind === 'weekly' ? t('reports.weeklyAt', { day: dayNames()[s.day] ?? '', time: s.time }) : s.kind === 'daily' ? t('reports.dailyAt', { time: s.time }) : `cron ${s.cron}`;
