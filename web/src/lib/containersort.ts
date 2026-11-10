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
// The larger first; not measured after every measured one.
const larger = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a);

function compare(by: ContainerSort, a: SortKeys, b: SortKeys): number {
  if (by === 'cpu') return larger(a.cpu, b.cpu) || byName(a, b);
  if (by === 'memory') return larger(a.mem, b.mem) || byName(a, b);
  if (by === 'problems') return a.trouble - b.trouble || byName(a, b);
  return byName(a, b);
}

/** The rows in the order chosen; the list given is left as it was. */
export function sortRows<T>(rows: readonly T[], by: ContainerSort, keys: (r: T) => SortKeys): T[] {
  return [...rows].sort((a, b) => compare(by, keys(a), keys(b)));
}

interface GroupParts<G, T> {
  rows: (g: G) => readonly T[];
  keys: (r: T) => SortKeys;
  title: (g: G) => string;
  /** The containers of no stack: after the stacks when sorted by name. */
  loose: (g: G) => boolean;
}

/** The stacks in the order chosen: by what they use together, or by their worst container; else stacks by name, then the loose ones. */
export function sortGroups<G, T>(groups: readonly G[], by: ContainerSort, p: GroupParts<G, T>): G[] {
  const named = (a: G, b: G) => Number(p.loose(a)) - Number(p.loose(b)) || p.title(a).localeCompare(p.title(b));
  const total = (g: G, k: 'cpu' | 'mem') => {
    const vs = p.rows(g).map((r) => p.keys(r)[k]).filter((v): v is number => v !== null);
    return vs.length ? vs.reduce((s, v) => s + v, 0) : null;
  };
  const worst = (g: G) => Math.min(...p.rows(g).map((r) => p.keys(r).trouble));
  return [...groups].sort((a, b) => {
    if (by === 'cpu') return larger(total(a, 'cpu'), total(b, 'cpu')) || named(a, b);
    if (by === 'memory') return larger(total(a, 'mem'), total(b, 'mem')) || named(a, b);
    if (by === 'problems') return worst(a) - worst(b) || named(a, b);
    return named(a, b);
  });
}
