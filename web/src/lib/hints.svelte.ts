import type { SystemHints } from '@burrow/shared';
import { get } from './api.js';
import { onAccountChange } from './session.svelte.js';

// What an admin should know about how Burrow runs (GET /api/system/hints):
// a proxy TRUST_PROXY does not name (decision 12), a full data disk, and the
// problem reports still open (W-FUNC-11). Shown on Settings, a dot or a
// count on its menu item.

export const hints = $state<{ h: SystemHints | null }>({ h: null });

export async function loadHints(): Promise<void> {
  hints.h = await get<SystemHints>('/api/system/hints');
}

/** Something about how Burrow runs that an admin should fix. */
export const hintsToFix = (): boolean => !!hints.h && (hints.h.trustProxy !== null || hints.h.diskFull);

// Another account: the last one's hints (open reports) not shown, read again for an admin (audit 2026-11-23).
onAccountChange(() => (hints.h = null));
