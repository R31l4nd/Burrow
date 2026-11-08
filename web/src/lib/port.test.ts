import { describe, expect, it } from 'vitest';
import { PortBridge, type Port } from './port.js';

// The Android app's bridge: requests answered by id (in any order), errors
// as rejections, events to whoever listens; what is not JSON is ignored.
function port() {
  const sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
  const p: Port & { sent: typeof sent; reply: (m: unknown) => void; raw: (s: string) => void } = {
    onmessage: null,
    postMessage: (m) => void sent.push(JSON.parse(m)),
    sent,
    reply: (m) => p.onmessage?.({ data: JSON.stringify(m) }),
    raw: (s) => p.onmessage?.({ data: s }),
  };
  return p;
}

describe('the bridge to the Android app', () => {
  it('each request gets its own answer, whichever comes first', async () => {
    const p = port();
    const b = new PortBridge(p);
    const info = b.call<{ version: string }>('info');
    const list = b.call<string[]>('phoneList', { path: '/x' });
    expect(p.sent).toEqual([
      { id: 1, method: 'info', params: {} },
      { id: 2, method: 'phoneList', params: { path: '/x' } },
    ]);
    p.reply({ id: 2, result: ['a'] });
    p.reply({ id: 1, result: { version: '2.0.0' } });
    expect(await list).toEqual(['a']);
    expect(await info).toEqual({ version: '2.0.0' });
  });

  it("the app's error is a rejection with its code; an answer to nothing asked, or not JSON, is ignored", async () => {
    const p = port();
    const b = new PortBridge(p);
    const r = b.call('phoneList');
    p.raw('not json');
    p.reply({ id: 99, result: 1 });
    p.reply({ id: 1, error: 'no_access' });
    await expect(r).rejects.toThrow('no_access');
    // Answered once: a second answer to the same id goes nowhere.
    expect(() => p.reply({ id: 1, result: 'again' })).not.toThrow();
  });

  it('events reach their listeners until they stop listening', () => {
    const p = port();
    const b = new PortBridge(p);
    const got: unknown[] = [];
    const stop = b.on('pushEndpoint', (d) => got.push(d));
    b.on('pushEndpoint', (d) => got.push(['second', d]));
    p.reply({ event: 'pushEndpoint', data: { url: 'u' } });
    p.reply({ event: 'downloads', data: [] });
    stop();
    p.reply({ event: 'pushEndpoint', data: null });
    expect(got).toEqual([{ url: 'u' }, ['second', { url: 'u' }], ['second', null]]);
  });
});
