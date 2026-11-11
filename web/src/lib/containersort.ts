// The order of the Containers page (report d36ec8): by name, the busiest or
// largest first (as Dozzle's and Portainer's lists sort), or problems first
// (as Apps' "Down first"). Kept on the device, like the folded stacks.

export const CONTAINER_SORTS = ['name', 'cpu', 'memory', 'problems'] as const;
export type ContainerSort = (typeof CONTAINER_SORTS)[number];

/** What a row is sorted by. `cpu`/`mem` null: not measured (stopped, or the host does not say). `trouble`: 0 failed, 1 needs a look, 2 running, 3 stopped on purpose. */
export interface SortKeys {
  name: string;
  cpu: number | null;
  mem: number | null;
  trouble: number;
}

export function readSort(v: unknown): ContainerSort {
  return (CONTAINER_SORTS as readonly unknown[]).includes(v) ? (v as ContainerSort) : 'name';
}

const byName = (a: SortKeys, b: SortKeys) => a.name.localeCompare(b.name);
// The larger first (`back`: the smaller); not measured after every measured one either way.
const larger = (a: number | null, b: number | null, back = false) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : back ? a - b : b - a);

function compare(by: ContainerSort, a: SortKeys, b: SortKeys, back: boolean): number {
  const dir = back ? -1 : 1;
  if (by === 'cpu') return larger(a.cpu, b.cpu, back) || byName(a, b);
  if (by === 'memory') return larger(a.mem, b.mem, back) || byName(a, b);
  if (by === 'problems') return dir * (a.trouble - b.trouble) || byName(a, b);
  return dir * byName(a, b);
}

/** The rows in the order chosen, `back` the other way round (report faf150: a column's name pressed again); the list given is left as it was. */
export function sortRows<T>(rows: readonly T[], by: ContainerSort, keys: (r: T) => SortKeys, back = false): T[] {
  return [...rows].sort((a, b) => compare(by, keys(a), keys(b), back));
}

interface GroupParts<G, T> {
  rows: (g: G) => readonly T[];
  keys: (r: T) => SortKeys;
  title: (g: G) => string;
  /** The containers of no stack: after the stacks when sorted by name. */
  loose: (g: G) => boolean;
}

/** The stacks in the order chosen: by what they use together, or by their worst container; else stacks by name, then the loose ones. */
export function sortGroups<G, T>(groups: readonly G[], by: ContainerSort, p: GroupParts<G, T>, back = false): G[] {
  const dir = back ? -1 : 1;
  // The containers of no stack after the stacks either way.
  const named = (a: G, b: G) => Number(p.loose(a)) - Number(p.loose(b)) || p.title(a).localeCompare(p.title(b));
  const total = (g: G, k: 'cpu' | 'mem') => {
    const vs = p.rows(g).map((r) => p.keys(r)[k]).filter((v): v is number => v !== null);
    return vs.length ? vs.reduce((s, v) => s + v, 0) : null;
  };
  const worst = (g: G) => Math.min(...p.rows(g).map((r) => p.keys(r).trouble));
  return [...groups].sort((a, b) => {
    if (by === 'cpu') return larger(total(a, 'cpu'), total(b, 'cpu'), back) || named(a, b);
    if (by === 'memory') return larger(total(a, 'mem'), total(b, 'mem'), back) || named(a, b);
    if (by === 'problems') return dir * (worst(a) - worst(b)) || named(a, b);
    return Number(p.loose(a)) - Number(p.loose(b)) || dir * p.title(a).localeCompare(p.title(b));
  });
}
