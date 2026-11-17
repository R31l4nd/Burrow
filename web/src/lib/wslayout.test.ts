import { beforeEach, describe, expect, it, vi } from 'vitest';

// A workspace's sizes (report 780048): kept on the device, read back whole on the next visit.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });

beforeEach(() => {
  store.clear();
  vi.resetModules();
});

describe("a workspace's sizes (report 780048)", () => {
  it('kept and read back on the next visit, every one of them; shares held between 20 and 80 %', async () => {
    const a = await import('./wslayout.svelte.js');
    expect({ ...a.wsLayout }).toEqual({ side: 290, split: 0.5, md: 0.5 });
    Object.assign(a.wsLayout, { side: 350, split: a.share(0.3671), md: a.share(0.95) });
    a.keepWsLayout();
    vi.resetModules();
    const b = await import('./wslayout.svelte.js');
    expect({ ...b.wsLayout }).toEqual({ side: 350, split: 0.367, md: 0.8 });
  });

  it('what cannot be read, or is out of reach, is the size to start with', async () => {
    store.set('burrow.wsLayout', '{"side":12,"split":"x","md":0.1}');
    const a = await import('./wslayout.svelte.js');
    expect({ ...a.wsLayout }).toEqual({ side: 290, split: 0.5, md: 0.2 });
    vi.resetModules();
    store.set('burrow.wsLayout', 'not json');
    expect({ ...(await import('./wslayout.svelte.js')).wsLayout }).toEqual({ side: 290, split: 0.5, md: 0.5 });
  });
});
