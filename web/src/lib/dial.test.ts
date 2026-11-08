import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dialLimit } from './dial.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('a socket still dialling after 4 s is closed, so its owner dials again; one that opened is left alone', () => {
  const hung = { readyState: 0, close: vi.fn() };
  const fine = { readyState: 0, close: vi.fn() };
  dialLimit(hung as unknown as WebSocket);
  dialLimit(fine as unknown as WebSocket);
  fine.readyState = 1;
  vi.advanceTimersByTime(3900);
  expect(hung.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(200);
  expect(hung.close).toHaveBeenCalledOnce();
  expect(fine.close).not.toHaveBeenCalled();
});
