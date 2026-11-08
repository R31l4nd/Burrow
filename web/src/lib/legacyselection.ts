import { DEFAULT_SELECTION, type LogSelection } from '@burrow/shared';

/** As many rules as a schedule's selection may have (shared/src/logselect.ts). */
export const MAX_RULES = 100;

/**
 * An older schedule's host and container lists as rules: everything else
 * skipped, those taken in with the first rule's window and levels. Names on
 * the hosts named, when both were given: the names alone took those
 * containers on every host (audit WP-18). Null when that needs more rules
 * than a selection may have: the lists then stay as they are, rather than a
 * schedule nothing about can be saved any more (AUDIT2 PAGE-23).
 */
export function selectionFromLists(sel: LogSelection, hostIds: number[] | null, containers: string[] | null): LogSelection | null {
  if (!hostIds && !containers?.length) return sel;
  const base = sel.rules[0] ?? DEFAULT_SELECTION.rules[0]!;
  const only = (target: LogSelection['rules'][number]['target']) => ({ ...base, target, skip: false });
  const taken = containers?.length
    ? (hostIds?.length ? hostIds : [null]).flatMap((hostId) => containers.flatMap((n) => [only({ hostId, project: n, container: null }), only({ hostId, project: null, container: n })]))
    : (hostIds ?? []).map((id) => only({ hostId: id, project: null, container: null }));
  if (taken.length + 1 > MAX_RULES) return null;
  return { rules: [{ ...base, skip: true }, ...taken] };
}
