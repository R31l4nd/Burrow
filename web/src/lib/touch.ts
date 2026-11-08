// Touch handlers that may stop the page from moving. Svelte 5 adds
// ontouchstart and ontouchmove as passive listeners, so preventDefault()
// in them does nothing: a finger's scroll in a terminal under a tmux of its
// own also pulled the page down for the browser's reload. Added here
// without passive, they can.

export interface TouchHandlers {
  start?: (e: TouchEvent) => void;
  move?: (e: TouchEvent) => void;
  end?: (e: TouchEvent) => void;
  cancel?: (e: TouchEvent) => void;
}

/** use:touch={{ start, move, end, cancel }} */
export function touch(node: HTMLElement, handlers: TouchHandlers) {
  let current = handlers;
  const on = {
    touchstart: (e: TouchEvent) => current.start?.(e),
    touchmove: (e: TouchEvent) => current.move?.(e),
    touchend: (e: TouchEvent) => current.end?.(e),
    touchcancel: (e: TouchEvent) => current.cancel?.(e),
  };
  for (const [type, fn] of Object.entries(on)) node.addEventListener(type, fn as EventListener, { passive: false });
  return {
    update(next: TouchHandlers) {
      current = next;
    },
    destroy() {
      for (const [type, fn] of Object.entries(on)) node.removeEventListener(type, fn as EventListener);
    },
  };
}
