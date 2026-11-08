import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepFresh } from './keepfresh.js';

// A list of files read again by itself: when the page is seen again, and every so often while it is
// seen (report 905455: a workspace's tree showed files made in its terminal only after a reload).
describe('keepFresh', () => {
  let state: 'visible' | 'hidden' = 'visible';
  const listeners: Record<string, (() => void)[]> = {};
  beforeEach(() => {
    vi.useFakeTimers();
    state = 'visible';
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.stubGlobal('document', {
      get visibilityState() {
        return state;
      },
      addEventListener: (k: string, f: () => void) => (listeners[k] ??= []).push(f),
      removeEventListener: (k: string, f: () => void) => (listeners[k] = (listeners[k] ?? []).filter((x) => x !== f)),
    });
    vi.stubGlobal('window', { addEventListener: (k: string, f: () => void) => (listeners[k] ??= []).push(f), removeEventListener: (k: string, f: () => void) => (listeners[k] = (listeners[k] ?? []).filter((x) => x !== f)) });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('every so often while seen, not while hidden; again when seen; stopped for good', () => {
    const read = vi.fn();
    const stop = keepFresh(read, 10_000);
    vi.advanceTimersByTime(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    state = 'hidden';
    vi.advanceTimersByTime(30_000);
    expect(read).toHaveBeenCalledTimes(1);
    state = 'visible';
    listeners.visibilitychange?.forEach((f) => f());
    expect(read).toHaveBeenCalledTimes(2);
    // Focus right after: not read twice in a row.
    listeners.focus?.forEach((f) => f());
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(60_000);
    listeners.visibilitychange?.forEach((f) => f());
    expect(read).toHaveBeenCalledTimes(2);
  });
});
