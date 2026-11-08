import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { attempt, copyText, dropToast, finishStepUp, inBackground, requestStepUp, stepUp, stepUpBecause, toast, toastWhile, toasts, undoCheck } = await import('./ui.svelte.js');
const { ApiFailure } = await import('./api.js');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  toasts.items = [];
});

describe('toasts', () => {
  it('the same words again are one toast, shown anew; nothing to say is no toast; errors stay longer', () => {
    vi.useFakeTimers();
    toast('Saved.');
    toast('');
    toast('Saved.');
    toast('Saved.', 'error');
    expect(toasts.items.map((t) => [t.text, t.kind])).toEqual([
      ['Saved.', 'info'],
      ['Saved.', 'error'],
    ]);
    vi.advanceTimersByTime(3000);
    expect(toasts.items.map((t) => t.kind)).toEqual(['error']);
    vi.advanceTimersByTime(3000);
    expect(toasts.items).toEqual([]);
  });

  it('a toast for as long as something takes: no timer, gone when done, kept out of a report picture when asked', () => {
    vi.useFakeTimers();
    toast('Saved.');
    const done = toastWhile('Taking a picture...', { apart: true, testid: 'bug-capturing' });
    vi.advanceTimersByTime(60_000);
    expect(toasts.items.map((t) => [t.text, t.apart, t.testid])).toEqual([['Taking a picture...', true, 'bug-capturing']]);
    done();
    expect(toasts.items).toEqual([]);
  });

  it('a toast no longer true goes before its time, the others stay (report 04436d)', () => {
    toast('Go to the screen with the problem.');
    toast('Saved.');
    dropToast('Go to the screen with the problem.');
    expect(toasts.items.map((t) => t.text)).toEqual(['Saved.']);
  });

  it('a load in the background that fails is said once in words; an action says its failure and gives false (audit WP-08)', async () => {
    inBackground(Promise.reject(new ApiFailure(500, 'internal', 'Disk full.')));
    await vi.waitFor(() => expect(toasts.items.map((t) => t.text)).toEqual(['Disk full.']));
    expect(await attempt(async () => {})).toBe(true);
    expect(await attempt(async () => { throw new ApiFailure(409, 'conflict', 'Changed meanwhile.'); })).toBe(false);
    expect(toasts.items.at(-1)).toMatchObject({ text: 'Changed meanwhile.', kind: 'error' });
  });
});

describe('the step-up', () => {
  it('two requests at once share one dialog: one yes lets both go on', async () => {
    const a = requestStepUp();
    const b = requestStepUp();
    expect(a).toBe(b);
    expect(stepUp.open).toBe(true);
    finishStepUp(true);
    expect(await a).toBe(true);
    expect(stepUp.open).toBe(false);
    // The next one is a dialog of its own.
    const c = requestStepUp();
    expect(c).not.toBe(a);
    finishStepUp(false);
    expect(await c).toBe(false);
  });

  it('says why while the work that may need it runs, and no longer after, failed or not', async () => {
    let seen: string | null = null;
    expect(await stepUpBecause('The app has a new key.', async () => ((seen = stepUp.why), 7))).toBe(7);
    expect(seen).toBe('The app has a new key.');
    expect(stepUp.why).toBeNull();
    await expect(stepUpBecause('x', async () => { throw new Error('no'); })).rejects.toThrow('no');
    expect(stepUp.why).toBeNull();
  });
});

describe('small helpers', () => {
  it('a checkbox not saved goes back as it was', () => {
    const box = { checked: true } as HTMLInputElement;
    undoCheck(box, true);
    expect(box.checked).toBe(false);
  });

  it('copy: true when the clipboard took it, false when refused', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void writes.push(t) } });
    expect(await copyText('ssh-ed25519 AAAA')).toBe(true);
    expect(writes).toEqual(['ssh-ed25519 AAAA']);
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('not allowed'); } } });
    expect(await copyText('x')).toBe(false);
  });
});
