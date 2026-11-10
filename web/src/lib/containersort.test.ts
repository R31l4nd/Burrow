import { describe, expect, it } from 'vitest';
import { readSort, sortGroups, sortRows, type SortKeys } from './containersort';

// Report d36ec8 (2026-11-09): containers sorted by name, CPU or memory, as
// Dozzle and Portainer's lists do; problems first as Apps' "Down first".
type R = SortKeys;
const r = (name: string, cpu: number | null, mem: number | null, trouble = 2): R => ({ name, cpu, mem, trouble });
const keys = (x: R) => x;
const names = (rs: R[]) => rs.map((x) => x.name);

describe('the containers in the order chosen', () => {
  const rows = [r('web', 1.5, 300), r('db', 12, 900), r('cache', null, null, 3), r('api', 12, 100, 0), r('worker', 0.2, 900, 1)];

  it('by name', () => {
    expect(names(sortRows(rows, 'name', keys))).toEqual(['api', 'cache', 'db', 'web', 'worker']);
  });

  it('the busiest first, those not measured (stopped) last, the same load by name', () => {
    expect(names(sortRows(rows, 'cpu', keys))).toEqual(['api', 'db', 'web', 'worker', 'cache']);
  });

  it('the most memory first', () => {
    expect(names(sortRows(rows, 'memory', keys))).toEqual(['db', 'worker', 'web', 'api', 'cache']);
  });

  it('problems first: failed, then needing a look, then running, then stopped on purpose', () => {
    expect(names(sortRows(rows, 'problems', keys))).toEqual(['api', 'worker', 'db', 'web', 'cache']);
  });

  it('leaves the list it was given as it was', () => {
    const before = names(rows);
    sortRows(rows, 'cpu', keys);
    expect(names(rows)).toEqual(before);
  });
});

describe('the stacks in the order chosen', () => {
  type G = { title: string; loose: boolean; rows: R[] };
  const groups: G[] = [
    { title: 'media', loose: false, rows: [r('a', 1, 100), r('b', 1, 100)] },
    { title: 'Containers on pi', loose: true, rows: [r('c', 50, 50)] },
    { title: 'apps', loose: false, rows: [r('d', 5, 1000, 0)] },
  ];
  const by = (s: Parameters<typeof sortGroups>[1]) =>
    sortGroups(groups, s, { rows: (g) => g.rows, keys, title: (g) => g.title, loose: (g) => g.loose }).map((g) => g.title);

  it('by name: the stacks first, then the containers of no stack', () => {
    expect(by('name')).toEqual(['apps', 'media', 'Containers on pi']);
  });

  it('by load: what the stack uses together, the heaviest first', () => {
    expect(by('cpu')).toEqual(['Containers on pi', 'apps', 'media']);
    expect(by('memory')).toEqual(['apps', 'media', 'Containers on pi']);
  });

  it('problems first: the stack with the worst container first', () => {
    expect(by('problems')).toEqual(['apps', 'media', 'Containers on pi']);
  });
});

describe('the order kept on the device', () => {
  it('only one Burrow knows; else by name', () => {
    expect(readSort('memory')).toBe('memory');
    expect(readSort('size')).toBe('name');
    expect(readSort(undefined)).toBe('name');
  });
});
