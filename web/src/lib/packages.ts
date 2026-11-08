import type { PackageSummary } from '@burrow/shared';
import { t } from './i18n/index.svelte.js';

// How a host's package updates are said: in a report, on the host list and
// on the host's statistics page.

/** "3 updates | 2 security | restart needed": only what applies. */
export const updatesLine = (u: Pick<PackageSummary, 'total' | 'security' | 'reboot'>): string =>
  [u.total || !u.reboot ? t('packages.count', { n: u.total }) : null, u.security ? t('packages.security', { n: u.security }) : null, u.reboot ? t('packages.reboot') : null].filter(Boolean).join(' | ');

/** Whether the host list marks a host: updates waiting or a restart asked for, at a check that read the list. */
export const marks = (u: PackageSummary | undefined): u is PackageSummary => !!u && u.state === 'ok' && (u.total > 0 || u.reboot);
