import { describe, expect, it } from 'vitest';
import { maxPanes, moveTab, nextForPane, ordered, placeIn, readLayout, shownPanes } from './termsplit.js';

describe('split terminals', () => {
  it('four panes on a wide screen, two on a medium one, one on a phone', () => {
    expect(maxPanes(1920, 1080)).toBe(4);
    expect(maxPanes(1400, 650)).toBe(2);
    expect(maxPanes(1280, 720)).toBe(2);
    expect(maxPanes(412, 915)).toBe(1);
  });

  it('a stored layout read back: only valid ids, at most four, shares within bounds', () => {
    expect(readLayout({ panes: ['a', 'b', 'a', 3, '', 'c', 'd', 'e'], x: 2, y: 'x', order: ['b'], at: 9 })).toEqual({ panes: ['a', 'b', 'c', 'd'], x: 0.8, y: 0.5, order: ['b'], at: 3 });
    expect(readLayout(null)).toEqual({ panes: [], x: 0.5, y: 0.5, order: [], at: 0 });
  });

  it('the panes shown: the ones still there, as many as fit, the asked one always in (in the active pane)', () => {
    const layout = readLayout({ panes: ['a', 'gone', 'b', 'c'] });
    expect(shownPanes(layout, ['a', 'b', 'c'], 'a', 4)).toEqual(['a', 'b', 'c']);
    expect(shownPanes(layout, ['a', 'b', 'c'], 'b', 1)).toEqual(['b']);
    expect(shownPanes(layout, ['a', 'b', 'c', 'x'], 'x', 2, 1)).toEqual(['a', 'x']);
    expect(shownPanes(readLayout({}), ['a'], 'a', 4)).toEqual(['a']);
  });

  it('a new pane takes the first session not shown; a session put in a pane swaps with where it was', () => {
    expect(nextForPane(['a'], ['a', 'b', 'c'], 4)).toBe('b');
    expect(nextForPane(['a', 'b'], ['a', 'b'], 4)).toBeNull();
    expect(nextForPane(['a', 'b'], ['a', 'b', 'c'], 2)).toBeNull();
    expect(placeIn(['a', 'b'], 0, 'c')).toEqual(['c', 'b']);
    expect(placeIn(['a', 'b'], 0, 'b')).toEqual(['b', 'a']);
  });

  it('tabs in their own order, and one dragged onto another', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(ordered(list, ['c', 'a']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(moveTab(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(moveTab(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveTab(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });
});
