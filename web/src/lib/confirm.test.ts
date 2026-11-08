import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { answered, ask, askText, asking } = await import('./confirm.svelte.js');
const { healthLabel } = await import('./containers.js');
const { parseTargetList } = await import('./logtargets.js');

const shown = async () => {
  await vi.waitFor(() => expect(asking.q).not.toBeNull());
  return asking.q!.text;
};

// The app's own "are you sure?": one question at a time, each answered once.
describe("the app's questions", () => {
  it('a second question waits until the first is answered; yes and no are each their own', async () => {
    const first = ask({ text: 'Delete host?', confirm: 'Delete', danger: true });
    const second = ask({ text: 'Close session?', confirm: 'Close' });
    expect(await shown()).toBe('Delete host?');
    answered('');
    expect(await first).toBe(true);
    expect(await shown()).toBe('Close session?');
    answered(null);
    expect(await second).toBe(false);
    expect(asking.q).toBeNull();
  });

  it('a line of text: what was typed, or null when cancelled', async () => {
    const named = askText({ text: 'Name', confirm: 'Save', input: { label: 'Name', value: 'old' } });
    expect(await shown()).toBe('Name');
    expect(asking.q!.input).toEqual({ label: 'Name', value: 'old' });
    answered('new name');
    expect(await named).toBe('new name');
    const cancelled = askText({ text: 'Name', confirm: 'Save', input: { label: 'Name', value: '' } });
    await shown();
    answered(null);
    expect(await cancelled).toBeNull();
    // An answer with no question open goes nowhere.
    expect(() => answered('stray')).not.toThrow();
  });
});

describe('small words', () => {
  it("Docker's health states in words, anything else as Docker says it", () => {
    expect(['healthy', 'unhealthy', 'starting', 'none'].map(healthLabel)).toEqual(['healthy', 'unhealthy', 'health starting', 'none']);
  });

  it('log targets from an address: only the well-formed ones', () => {
    expect(parseTargetList('1:web,2::%2Fvar%2Flog%2Fsyslog,nonsense,,3:db').length).toBe(3);
    expect(parseTargetList('')).toEqual([]);
  });
});
