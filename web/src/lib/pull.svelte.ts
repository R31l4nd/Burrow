// Pull to refresh, as phones do elsewhere: at the top of a page, a finger
// pulled down past a point and let go reads the page again. Touch only (a
// computer has its reload); the page says what it reloads.

import { errorMessage } from './api.js';
import { toast } from './ui.svelte.js';

export const pull = $state<{ distance: number; busy: boolean }>({ distance: 0, busy: false });

const TRIGGER = 70;

/** Wires pull-to-refresh to the window while a page is shown; returns the way to stop. */
export function pullToRefresh(refresh: () => Promise<unknown>): () => void {
  let startY: number | null = null;
  const start = (e: TouchEvent) => {
    // Only from the very top, one finger, and not inside a dialog or a scroller of its own.
    const target = e.target instanceof Element ? e.target : null;
    startY = e.touches.length === 1 && window.scrollY <= 0 && !target?.closest('dialog, [data-no-pull], .xterm, .cm-editor') ? e.touches[0]!.clientY : null;
  };
  const move = (e: TouchEvent) => {
    if (startY === null || pull.busy) return;
    const d = e.touches[0]!.clientY - startY;
    pull.distance = d > 0 ? Math.min(d * 0.6, TRIGGER * 1.5) : 0;
  };
  const end = async () => {
    if (startY === null) return;
    startY = null;
    const go = pull.distance >= TRIGGER;
    pull.distance = 0;
    if (!go || pull.busy) return;
    pull.busy = true;
    try {
      await refresh();
    } catch (err) {
      // Said, not an unhandled rejection with the old data left as if fresh (AUDIT2 WEB-15).
      const m = errorMessage(err);
      if (m) toast(m, 'error');
    } finally {
      pull.busy = false;
    }
  };
  // A pull broken off (a call, the system gesture): nothing left half pulled.
  const cancel = () => {
    startY = null;
    pull.distance = 0;
  };
  window.addEventListener('touchstart', start, { passive: true });
  window.addEventListener('touchmove', move, { passive: true });
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', cancel);
  return () => {
    window.removeEventListener('touchstart', start);
    window.removeEventListener('touchmove', move);
    window.removeEventListener('touchend', end);
    window.removeEventListener('touchcancel', cancel);
    pull.distance = 0;
  };
}

export const PULL_TRIGGER = TRIGGER;
