import { describe, expect, it, vi } from 'vitest';

// Android's Back: the dialog on top closes first (the one opened last, not
// the last in the page, AUDIT2 WEB-14); a dialog with unsaved changes stops
// its own cancel and asks instead. Only with none open does the page go back.
const page = vi.hoisted(() => {
  const open: FakeDialog[] = [];
  class FakeDialog {
    dataset: Record<string, string> = {};
    closed = false;
    constructor(readonly name: string, private readonly keep = false) {}
    dispatchEvent(e: Event) {
      if (this.keep) e.preventDefault();
      return !e.defaultPrevented;
    }
    close() {
      this.closed = true;
      open.splice(open.indexOf(this), 1);
    }
  }
  Object.assign(globalThis, { window: {}, document: { querySelectorAll: (sel: string) => (sel === 'dialog[open]' ? [...open] : []) } });
  return { open, FakeDialog };
});

const { closeTopDialog, markOpened } = await import('./back.js');
type Dialog = InstanceType<typeof page.FakeDialog>;
const show = (d: Dialog, where = page.open.length) => {
  page.open.splice(where, 0, d);
  markOpened(d as unknown as HTMLElement);
  return d;
};

describe("Android's Back", () => {
  it('nothing open: false, so the app goes back in the history', () => {
    expect(closeTopDialog()).toBe(false);
    expect((window as unknown as { __burrowBack: () => boolean }).__burrowBack).toBe(closeTopDialog);
  });

  it('closes the dialog opened last, wherever it is in the page, then the one below', () => {
    const host = show(new page.FakeDialog('host'));
    // Opened later but placed earlier in the page (a confirm portal).
    const confirm = show(new page.FakeDialog('confirm'), 0);
    expect(closeTopDialog()).toBe(true);
    expect([confirm.closed, host.closed]).toEqual([true, false]);
    expect(closeTopDialog()).toBe(true);
    expect(host.closed).toBe(true);
    expect(closeTopDialog()).toBe(false);
  });

  it('a dialog with unsaved changes stops its cancel: it stays open (it asks), and Back is still used up', () => {
    const form = show(new page.FakeDialog('form', true));
    expect(closeTopDialog()).toBe(true);
    expect(form.closed).toBe(false);
    page.open.length = 0;
  });
});
