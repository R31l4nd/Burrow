import { isTermReply } from '@burrow/shared';
// Several terminals side by side on the terminal page (F4): which sessions
// are in the panes, how the space is divided, and the order of the session
// tabs. Kept per device (a phone shows one pane, a wide screen up to four).

export interface SplitLayout {
  /** Session ids, one per pane, in reading order (left to right, top to bottom). */
  panes: string[];
  /** Where the panes divide, as a share of the width and of the height (0.2 - 0.8). */
  x: number;
  y: number;
  /** The session tabs' order (ids); sessions not in it come after, as the server lists them. */
  order: string[];
  /** The pane typed into last: a session opened anew shows there. */
  at: number;
}

/** How many panes fit: four (2 x 2) on a wide screen, two on a medium one, one on a phone. */
export const maxPanes = (width: number, height: number): number => (width >= 1400 && height >= 700 ? 4 : width >= 900 ? 2 : 1);

const clampShare = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(0.8, Math.max(0.2, v)) : 0.5);

/** A layout as stored (anything that was there): only what is valid. */
export function readLayout(raw: unknown): SplitLayout {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 100))] : []);
  const at = typeof o.at === 'number' && Number.isInteger(o.at) ? Math.min(3, Math.max(0, o.at)) : 0;
  return { panes: ids(o.panes).slice(0, 4), x: clampShare(o.x), y: clampShare(o.y), order: ids(o.order), at };
}

/**
 * The panes shown: the stored ones that still exist, as many as fit, with
 * the one asked for (the page's session) always among them - in the pane
 * that was active when it is not there yet.
 */
export function shownPanes(layout: SplitLayout, existing: string[], wanted: string, fit: number, activeIndex = 0): string[] {
  const live = layout.panes.filter((p) => existing.includes(p));
  let panes = live.slice(0, Math.max(1, fit));
  if (!panes.includes(wanted)) {
    const at = Math.min(Math.max(0, activeIndex), Math.max(0, panes.length - 1));
    panes = panes.length ? panes.map((p, i) => (i === at ? wanted : p)) : [wanted];
  }
  return panes;
}

/** One more pane, with the first session not shown yet; null when there is none or no room. */
export function nextForPane(panes: string[], existing: string[], fit: number): string | null {
  if (panes.length >= fit) return null;
  return existing.find((s) => !panes.includes(s)) ?? null;
}

/** A session put in pane `at`; where it was shown already, the two change places. */
export function placeIn(panes: string[], at: number, id: string): string[] {
  const out = [...panes];
  const was = out.indexOf(id);
  if (was === at) return out;
  if (was >= 0) out[was] = out[at]!;
  out[at] = id;
  return out;
}

/** The session list in the tabs' own order. */
export function ordered<T extends { id: string }>(list: T[], order: string[]): T[] {
  const pos = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length + list.findIndex((s) => s.id === id) : i;
  };
  return [...list].sort((a, b) => pos(a.id) - pos(b.id));
}

/** A tab dragged from one place to another: the new order of all ids. */
export function moveTab(ids: string[], from: string, to: string): string[] {
  if (from === to) return ids;
  const out = ids.filter((i) => i !== from);
  const at = out.indexOf(to);
  if (at < 0) return ids;
  // Dropped on a later tab: after it; on an earlier one: before it.
  out.splice(ids.indexOf(from) < ids.indexOf(to) ? at + 1 : at, 0, from);
  return out;
}

/**
 * Typed into all panes: only what was typed. The terminal's own answers (where the cursor is,
 * what it is, focus in or out) and mouse reports went to the other shells as escape junk
 * (audit 2026-11-09).
 */
export function broadcastable(d: string): boolean {
  // eslint-disable-next-line no-control-regex -- escape sequences are what it reads
  return !isTermReply(d) && !/^\x1b\[(?:<[\d;]+[mM]|M[\s\S]{3})/.test(d);
}
