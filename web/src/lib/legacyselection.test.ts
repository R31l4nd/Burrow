import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION } from '@burrow/shared';
import { MAX_RULES, selectionFromLists } from './legacyselection.js';

describe("an older schedule's lists as rules", () => {
  it('names on the hosts named: each as a stack and as a container there, the rest skipped', () => {
    const r = selectionFromLists(DEFAULT_SELECTION, [3], ['web'])!;
    expect(r.rules.map((x) => [x.target, x.skip])).toEqual([
      [null, true],
      [{ hostId: 3, project: 'web', container: null }, false],
      [{ hostId: 3, project: null, container: 'web' }, false],
    ]);
  });
  it('more names than rules may hold: kept as lists, not a selection that cannot be saved (AUDIT2 PAGE-23)', () => {
    const names = Array.from({ length: 50 }, (_, i) => `c${i}`);
    expect(selectionFromLists(DEFAULT_SELECTION, [1], names)).toBeNull();
    // 49 names: 98 rules and the default, within the limit.
    expect(selectionFromLists(DEFAULT_SELECTION, [1], names.slice(0, 49))!.rules.length).toBeLessThanOrEqual(MAX_RULES);
  });
  it('no lists: the selection as it is', () => {
    expect(selectionFromLists(DEFAULT_SELECTION, null, null)).toBe(DEFAULT_SELECTION);
  });
});
