/**
 * A row that scrolls sideways without a scrollbar (chips, keys, tabs) says
 * there is more: data-more="end", "start" or "both" while some of it is out
 * of sight, which app.css fades at that edge. Kept current as it scrolls and
 * as it or its content changes size.
 */
export function scrollCue(node: HTMLElement) {
  // Sideways only: CSS makes a row that scrolls sideways scroll up and down too, and a few pixels
  // that reach below it (a close mark's finger room) let a swipe move its tabs up, cut off at the
  // top (report e020bc).
  node.style.overflowY = 'hidden';
  const update = () => {
    const more = node.scrollWidth - node.clientWidth > 1;
    const atStart = node.scrollLeft <= 1;
    const atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
    const v = !more ? null : atStart ? 'end' : atEnd ? 'start' : 'both';
    if (v) node.dataset.more = v;
    else delete node.dataset.more;
  };
  // The chosen one (a tab on screen) in sight: when the row opens, narrows (a phone turned, a
  // window made smaller) or another is chosen; not while the person scrolls it (UIB-03).
  const keep = () => {
    const c = node.querySelector<HTMLElement>(':scope > [aria-selected=true], :scope > [aria-current=page], :scope > * > [aria-selected=true]');
    if (!c || node.scrollWidth - node.clientWidth <= 1) return;
    const a = node.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    if (r.left < a.left) node.scrollLeft -= a.left - r.left + 8;
    else if (r.right > a.right) node.scrollLeft += r.right - a.right + 8;
  };
  // The row's own size, and its items' (a font that loads late makes them wider, not the row).
  const ro = new ResizeObserver(() => {
    update();
    keep();
  });
  ro.observe(node);
  for (const c of node.children) ro.observe(c);
  void document.fonts?.ready.then(() => (update(), keep()));
  const mo = new MutationObserver((records) => {
    for (const c of node.children) ro.observe(c);
    update();
    if (records.some((r) => r.type === 'attributes' || r.type === 'childList')) keep();
  });
  mo.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current'] });
  node.addEventListener('scroll', update, { passive: true });
  update();
  requestAnimationFrame(keep);
  return {
    destroy() {
      ro.disconnect();
      mo.disconnect();
      node.removeEventListener('scroll', update);
    },
  };
}
