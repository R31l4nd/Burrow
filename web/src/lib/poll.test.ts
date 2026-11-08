import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollEvery } from './poll.js';

// A page's numbers read every so often (a host's statistics): a slow read is not joined by a second,
// and an older answer never replaces a newer one (audit 2026-11-05).
describe('pollEvery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads now and every so often, but skips a tick while a read is still on its way', async () => {
    const answers: ((v: number) => void)[] = [];
    const read = vi.fn(() => new Promise<number>((r) => answers.push(r)));
    const got: number[] = [];
    const stop = pollEvery(read, 10_000, (v) => got.push(v), () => {});
    expect(read).toHaveBeenCalledTimes(1);
    // Slow: two ticks pass, no second read joins it.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(read).toHaveBeenCalledTimes(1);
    answers[0]!(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a failure is said; an answer after the stop (the page left, or read anew) is not put in place', async () => {
    let fail!: (e: Error) => void;
    const read = vi.fn(() => new Promise<number>((_, no) => (fail = no)));
    const got: number[] = [];
    const errors: unknown[] = [];
    const stop = pollEvery(read, 10_000, (v) => got.push(v), (e) => errors.push(e));
    fail(new Error('away'));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(got).toEqual([]);
  });
});
