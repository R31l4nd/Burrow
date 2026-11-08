// The picture viewer's place in its list, by the shown picture's path: the list can be read again
// while it is open (Files reads its folder every ten seconds), and a picture added or removed before
// it changed what an index pointed at, or left it pointing past the end (audit 2026-11-05).

/** Where the picture shown is in the list now (-1: no longer in it). */
export const shownAt = (items: readonly { path: string }[], path: string | null): number => (path === null ? -1 : items.findIndex((x) => x.path === path));

/** The picture d steps from the one shown, round at the ends; when that one is gone, the first. */
export function stepFrom<T extends { path: string }>(items: readonly T[], path: string | null, d: number): T | undefined {
  if (!items.length) return undefined;
  const at = shownAt(items, path);
  return items[at < 0 ? 0 : (at + d + items.length) % items.length];
}
