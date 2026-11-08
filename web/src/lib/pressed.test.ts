import { describe, expect, it, vi } from 'vitest';

// The button last pressed, beside which a menu opens on a computer (decision 28).
const on = vi.hoisted(() => {
  const handlers: Record<string, (e: unknown) => void> = {};
  class Element {
    constructor(public tag: string, public inDialog = false) {}
    closest(sel: string) {
      if (sel === 'dialog') return this.inDialog ? this : null;
      return this.tag === 'button' || this.tag === 'a' ? this : null;
    }
  }
  Object.assign(globalThis, { Element, document: { addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn) } });
  return { handlers, Element };
});
const { lastPressed } = await import('./pressed.js');

describe('the button last pressed', () => {
  it('a press or Enter on a button counts, a moment long; one inside a dialog or a plain element does not', () => {
    vi.useFakeTimers();
    expect(lastPressed()).toBeNull();
    const button = new on.Element('button');
    on.handlers.pointerdown!({ target: button });
    expect(lastPressed()).toBe(button);
    // Inside a dialog (a menu's own items) or not a button at all: the one before stays.
    on.handlers.pointerdown!({ target: new on.Element('button', true) });
    on.handlers.pointerdown!({ target: new on.Element('div') });
    expect(lastPressed()).toBe(button);
    const link = new on.Element('a');
    on.handlers.keydown!({ key: 'x', target: link });
    expect(lastPressed()).toBe(button);
    on.handlers.keydown!({ key: 'Enter', target: link });
    expect(lastPressed()).toBe(link);
    // Long after: no longer the one that opened what opens now.
    vi.advanceTimersByTime(2500);
    expect(lastPressed()).toBeNull();
    vi.useRealTimers();
  });
});
