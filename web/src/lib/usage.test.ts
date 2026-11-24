import { afterEach, describe, expect, it, vi } from 'vitest';

// What this browser counts for Settings -> Usage, and when it sends it.
vi.hoisted(() => {
  const listeners: Record<string, () => void> = {};
  Object.assign(globalThis, {
    document: { documentElement: { lang: 'en' }, visibilityState: 'visible', addEventListener: (k: string, fn: () => void) => (listeners[k] = fn) },
    usageListeners: listeners,
  });
});
const { countUse, dropUsage, pageKey, sendUsage, startUsage, usageTurned } = await import('./usage.js');

const sentBodies: Record<string, number>[] = [];
function server(on = true) {
  sentBodies.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)) as Record<string, number>);
      return new Response(JSON.stringify({ on }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}
afterEach(() => {
  dropUsage();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('usage counted in the browser', () => {
  it('nothing before the app starts it (the direct route shows the same dialogs where no Burrow answers)', async () => {
    server();
    countUse('page:hosts');
    await sendUsage();
    expect(sentBodies).toEqual([]);
  });

  it('pages by name only, unknown names left out, sent once with their counts, then nothing left', async () => {
    server();
    startUsage();
    countUse(pageKey('#/hosts/12/stats'));
    countUse(pageKey('#/hosts/3/stats?x=1'));
    countUse('dialog:processes');
    countUse('page:containers/3/nginx');
    countUse('dialog:made-up');
    await sendUsage();
    expect(sentBodies).toEqual([{ 'page:hosts/:id/stats': 2, 'dialog:processes': 1 }]);
    await sendUsage();
    expect(sentBodies).toHaveLength(1);
  });

  it('sent a minute after the first count, and when the page goes out of sight', async () => {
    vi.useFakeTimers();
    server();
    startUsage();
    countUse('page:alerts');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sentBodies).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentBodies).toEqual([{ 'page:alerts': 1 }]);
    countUse('page:apps');
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    (globalThis as unknown as { usageListeners: Record<string, () => void> }).usageListeners.visibilitychange!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentBodies.at(-1)).toEqual({ 'page:apps': 1 });
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'visible';
  });

  it('Burrow says it does not count: this browser stops, until it is turned on here again', async () => {
    server(false);
    startUsage();
    countUse('page:hosts');
    await sendUsage();
    expect(sentBodies).toHaveLength(1);
    countUse('page:alerts');
    await sendUsage();
    expect(sentBodies).toHaveLength(1);
    server(true);
    usageTurned(true);
    countUse('page:alerts');
    await sendUsage();
    expect(sentBodies).toEqual([{ 'page:alerts': 1 }]);
  });

  it('a send that fails loses only those counts; dropped ones are not sent', async () => {
    startUsage();
    usageTurned(true);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    countUse('page:hosts');
    await expect(sendUsage()).resolves.toBeUndefined();
    server();
    countUse('page:apps');
    dropUsage();
    await sendUsage();
    expect(sentBodies).toEqual([]);
  });
});
