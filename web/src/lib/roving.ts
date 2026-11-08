// Tabs and radio buttons as the widget says they are: arrows move between
// them (and choose, as a tab list does), Home and End go to the ends, and
// Tab reaches the group once, at the chosen one. They were plain buttons
// with a tab role, each its own Tab stop (AUDIT2 UX-02).

/** The item an arrow key moves to: wrapping round, Home and End to the ends; null for any other key. */
export function nextIndex(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (at + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** Svelte action on the group: role "tab" (aria-selected) or "radio" (aria-checked). */
export function roving(node: HTMLElement, role: 'tab' | 'radio' = 'tab') {
  const items = () => [...node.querySelectorAll<HTMLElement>(`[role="${role}"]`)].filter((el) => !el.hasAttribute('disabled'));
  const chosen = (el: HTMLElement) => el.getAttribute(role === 'tab' ? 'aria-selected' : 'aria-checked') === 'true';
  const stops = () => {
    const all = items();
    const on = all.find(chosen) ?? all[0];
    for (const el of all) el.tabIndex = el === on ? 0 : -1;
  };
  const key = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const next = nextIndex(e.key, at, all.length);
    if (next === null) return;
    e.preventDefault();
    all[next]!.focus();
    all[next]!.click();
  };
  stops();
  const watch = new MutationObserver(stops);
  watch.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'aria-checked', 'disabled'] });
  node.addEventListener('keydown', key);
  return {
    destroy() {
      watch.disconnect();
      node.removeEventListener('keydown', key);
    },
  };
}
