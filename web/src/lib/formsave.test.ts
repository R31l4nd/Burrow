import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const toasts: string[] = [];
vi.mock('./ui.svelte.js', () => ({ toast: (m: string) => toasts.push(m) }));
const { FormSave } = await import('./formsave.svelte.js');

const held = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

describe('a dialog form saved', () => {
  it('twice while the first is on its way: saved once (AUDIT2 PAGE-11)', async () => {
    const s = new FormSave();
    const h = held();
    const save = vi.fn(() => h.p);
    const first = s.run(save);
    expect(s.busy).toBe(true);
    expect(await s.run(save)).toBeNull();
    h.release();
    expect(await first).toBe('saved');
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.busy).toBe(false);
  });

  it('then closed and another form opened before it is done: not that one\'s to close (AUDIT2 PAGE-12)', async () => {
    const s = new FormSave();
    s.opened();
    const h = held();
    const first = s.run(() => h.p);
    s.opened();
    h.release();
    expect(await first).toBe('elsewhere');
  });

  it('refused: said, and the form can save again', async () => {
    const s = new FormSave();
    expect(await s.run(() => Promise.reject(new Error('name taken')))).toBeNull();
    expect(toasts).toContain('name taken');
    expect(s.busy).toBe(false);
    expect(await s.run(() => Promise.resolve())).toBe('saved');
  });
});
