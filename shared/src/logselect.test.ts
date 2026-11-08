import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION, keepLevel, logSelection, ruleFor, windowArgs, type LogSelection } from './logselect.js';

const sel: LogSelection = logSelection.parse({
  rules: [
    { target: null, window: { kind: 'since_last' }, levels: ['error', 'warn'] },
    { target: { hostId: 2 }, window: { kind: 'hours', n: 6 }, levels: ['error'] },
    { target: { project: 'media' }, window: { kind: 'lines', n: 200 }, levels: ['fatal', 'error', 'warn', 'info'] },
    { target: { project: 'media', container: 'media-db-1' }, window: { kind: 'since_start' }, levels: ['error'], skip: true },
  ],
});

describe('log selection', () => {
  it('the most specific rule wins: container, then stack, then host, then the default', () => {
    expect(ruleFor(sel, 1, null, 'web').window.kind).toBe('since_last');
    expect(ruleFor(sel, 2, null, 'web').window).toEqual({ kind: 'hours', n: 6 });
    expect(ruleFor(sel, 2, 'media', 'media-web-1').window).toEqual({ kind: 'lines', n: 200 });
    expect(ruleFor(sel, 2, 'media', 'media-db-1').skip).toBe(true);
    expect(ruleFor(DEFAULT_SELECTION, 5, 'x', 'y').levels).toEqual(['fatal', 'error', 'warn']);
  });

  it('turns a window into docker logs --since / --tail', () => {
    const times = { now: 10_000_000, lastRun: 9_000_000, started: 5_000_000, fallbackMs: 7 * 86_400_000 };
    expect(windowArgs({ kind: 'lines', n: 300 }, times)).toEqual({ since: null, tail: 300 });
    expect(windowArgs({ kind: 'hours', n: 1 }, times)).toEqual({ since: 10_000_000 - 3_600_000, tail: null });
    expect(windowArgs({ kind: 'since_start', n: 1 }, times)).toEqual({ since: 5_000_000, tail: null });
    expect(windowArgs({ kind: 'since_last', n: 1 }, times)).toEqual({ since: 9_000_000, tail: null });
    expect(windowArgs({ kind: 'since_last', n: 1 }, { ...times, lastRun: null })).toEqual({ since: 10_000_000 - 7 * 86_400_000, tail: null });
  });

  it('keeps the chosen levels; a line without one counts as "none"', () => {
    expect(keepLevel(['error'], 'error')).toBe(true);
    expect(keepLevel(['error'], 'info')).toBe(false);
    expect(keepLevel(['none'], null)).toBe(true);
  });
});

describe('the same name on several hosts', () => {
  it('a rule for a stack on one host wins over the same stack on any host, and leaves other hosts alone', () => {
    const w = { kind: 'lines' as const, n: 10 };
    const sel = logSelection.parse({
      rules: [
        { target: null, window: w, levels: ['error'], skip: false },
        { target: { hostId: null, project: 'web', container: null }, window: { kind: 'lines', n: 50 }, levels: ['error'], skip: false },
        { target: { hostId: 2, project: 'web', container: null }, window: { kind: 'lines', n: 99 }, levels: ['error'], skip: true },
      ],
    });
    expect(ruleFor(sel, 2, 'web', 'web-1').skip).toBe(true);
    expect(ruleFor(sel, 1, 'web', 'web-1').window.n).toBe(50);
    expect(ruleFor(sel, 1, 'db', 'db-1').window.n).toBe(10);
  });
});
