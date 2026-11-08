import type { Host } from '@burrow/shared';

// The hosts used last, above the list: worth it only when the list is long.
// With a few hosts "Recent" repeated the same rows right above them (the
// live UI round: four hosts, three of them twice).

/** Below this many hosts the whole list is in sight; no recent ones then. */
export const RECENT_FROM = 8;

export function recentHosts(hosts: Host[], max = 5): Host[] {
  if (hosts.length < RECENT_FROM) return [];
  return hosts
    .filter((h) => h.lastUsedAt && !h.favorite)
    .sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!))
    .slice(0, max);
}
