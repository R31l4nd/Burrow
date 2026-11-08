/**
 * A bar fixed at the foot of a page (the clipboard's "Paste here", the bulk actions): how far its
 * top is from the window's bottom, as --foot-bar-top on the root, so the busy list and its pill
 * float above it (on a computer the list lay over the clipboard bar's words, 2026-11-06). Kept
 * current as the bar or the window changes size; gone with the bar.
 */
export function footBar(node: HTMLElement) {
  const root = document.documentElement.style;
  const update = () => root.setProperty('--foot-bar-top', `${Math.max(0, Math.round(window.innerHeight - node.getBoundingClientRect().top))}px`);
  update();
  const ro = new ResizeObserver(update);
  ro.observe(node);
  window.addEventListener('resize', update);
  return {
    destroy() {
      ro.disconnect();
      window.removeEventListener('resize', update);
      root.removeProperty('--foot-bar-top');
    },
  };
}
