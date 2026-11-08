// The button (or link) last pressed: a menu opens beside the one that opened it (decision 28).
// Read at the moment a dialog opens; a keyboard press counts as much as a pointer.
let last: HTMLElement | null = null;
let at = 0;

function remember(e: Event) {
  const t = e.target instanceof Element ? e.target.closest<HTMLElement>('button, a, [role=button], [role=menuitem]') : null;
  if (t && !t.closest('dialog')) {
    last = t;
    at = Date.now();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && remember(e), true);
}

/** The one pressed a moment ago; not one from long before (a menu opened by a shortcut, or after a wait). */
export const lastPressed = (): HTMLElement | null => (Date.now() - at < 2000 ? last : null);
