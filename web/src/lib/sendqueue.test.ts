import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendQueue } from './sendqueue.js';

describe('what a terminal sends, in order (AUDIT2 TERM-05)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('two quick sends, each an Enter a moment after its text: never mixed', () => {
    const out: string[] = [];
    const q = sendQueue((d) => out.push(d));
    q.now('ls');
    q.after('\r', 100);
    vi.advanceTimersByTime(30);
    q.now('pwd');
    q.after('\r', 100);
    // A key typed meanwhile waits its turn too.
    q.now('x');
    vi.advanceTimersByTime(1000);
    expect(out.join('')).toBe('ls\rpwd\rx');
  });

  it('nothing waiting: at once', () => {
    const out: string[] = [];
    const q = sendQueue((d) => out.push(d));
    q.now('a');
    expect(out).toEqual(['a']);
  });

  it('the view going: what waited goes out at once, in order, and only once', () => {
    const out: string[] = [];
    const q = sendQueue((d) => out.push(d));
    q.now('ls');
    q.after('\r', 100);
    q.now('x');
    q.flush();
    vi.advanceTimersByTime(1000);
    expect(out).toEqual(['ls', '\r', 'x']);
  });
});
