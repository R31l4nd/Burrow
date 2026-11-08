<script lang="ts">
  import { toasts } from '../lib/ui.svelte.js';
  import { framed, toastSpot } from '../lib/toastplace.js';

  // Toasts live in the browser's top layer (a manual popover), like modal
  // dialogs do. A z-index cannot put anything above an open <dialog>; a
  // popover shown after it can. Re-shown on every new toast so it lands
  // above whatever dialog opened in between.
  let el: HTMLDivElement | undefined = $state();

  function raise() {
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (toasts.items.length > 0) el.showPopover();
    } catch {
      // Older browsers without the Popover API: the fixed position remains.
    }
    place();
  }

  // Above what sits at the foot of the screen under them: a selection bar's
  // Copy, Cut and Delete, an empty list's Add (UIA-04), an open dialog's
  // footer with its Send (UIB-09). Measured while toasts show.
  const FOOT = 'dialog[open] > footer, [data-foot-bar], .actionbar, .bulkbar';
  /** A form's fields and its messages: never under the toasts either, however wide (2.18.0). */
  const FIELDS = 'input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select, .alert';
  // Measured once, then the spot worked out from those boxes (lib/toastplace.ts): moving the
  // toasts and measuring the page again for each spot tried laid the page out over and over.
  function place() {
    if (!el) return;
    el.style.bottom = el.style.top = '';
    if (!toasts.items.length) return;
    const own = el.getBoundingClientRect();
    let lift = 0;
    for (const b of document.querySelectorAll<HTMLElement>(FOOT)) {
      if (!b.checkVisibility()) continue;
      const r = b.getBoundingClientRect();
      // Beside the toasts' column, or high up the screen (a centred dialog's footer above them): not in the way.
      if (r.right <= own.left || r.left >= own.right || r.bottom < own.top - 8) continue;
      lift = Math.max(lift, window.innerHeight - r.top + 8);
    }
    const sheet = [...document.querySelectorAll('dialog[open]')].pop()?.getBoundingClientRect();
    const bar = [...document.querySelectorAll('dialog[open] > header, .topbar')].filter((b) => (b as HTMLElement).checkVisibility()).pop();
    const spot = toastSpot({ own, screen: window.innerHeight, lift, sheetTop: sheet?.top ?? null, high: (bar?.getBoundingClientRect().bottom ?? 0) + 8, boxes: inColumn(own) });
    if (!spot) return;
    el.style.bottom = spot.bottom === null ? 'auto' : `${spot.bottom}px`;
    el.style.top = spot.top === null ? '' : `${spot.top}px`;
  }
  /** The buttons and fields in the toasts' column, where a tap meant for one would land on them: each one's top and middle height. */
  function inColumn(own: DOMRect): { top: number; y: number }[] {
    const scope: Element | Document = [...document.querySelectorAll('dialog[open]')].pop() ?? document;
    const out: { top: number; y: number }[] = [];
    for (const b of scope.querySelectorAll<HTMLElement>(`button, a.btn, [role=button], ${FIELDS}`)) {
      if (el!.contains(b)) continue;
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      // Only those in the column are looked at further.
      if (x <= own.left || x >= own.right) continue;
      // A list's whole row stays there to tap beside the toast; its buttons are what must not be hidden.
      // Not so in a dialog: its menu's buttons are as wide as the sheet (Rename under "Folder ... made.").
      if (r.width >= window.innerWidth * 0.6 && scope === document && !b.matches(FIELDS)) continue;
      if (!b.checkVisibility()) continue;
      out.push({ top: r.top, y: r.top + r.height / 2 });
    }
    return out;
  }
  // Placed again when something may have moved: scrolled or resized (in the next frame, once
  // however many events come), and while the page changes (a bar that appears with a selection, a
  // dialog rising in), a few times a second until it has been still for a second. A page that
  // stays as it is is not measured again and again.
  const SETTLE_MS = 1000;
  let movedAt = 0;
  const moved = () => (movedAt = Date.now());
  const soon = framed(place);
  const onMove = () => (moved(), soon());
  $effect(() => {
    void toasts.items.length;
    raise();
    if (!toasts.items.length) return;
    moved();
    const timer = setInterval(() => Date.now() - movedAt < SETTLE_MS && place(), 250);
    // Not the toasts' own changes (placing them sets their style).
    const watch = new MutationObserver((records) => records.some((r) => !el?.contains(r.target)) && moved());
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener('scroll', onMove, { capture: true, passive: true });
    window.addEventListener('resize', onMove);
    window.addEventListener('transitionend', onMove, true);
    window.addEventListener('animationend', onMove, true);
    return () => {
      clearInterval(timer);
      watch.disconnect();
      window.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
      window.removeEventListener('transitionend', onMove, true);
      window.removeEventListener('animationend', onMove, true);
    };
  });

  // A dialog opened after the toast: bring the toasts back on top.
  $effect(() => {
    window.addEventListener('burrow:toplayer', raise);
    return () => window.removeEventListener('burrow:toplayer', raise);
  });
</script>

<div class="toasts" popover="manual" bind:this={el} aria-live="polite" data-testid="toasts">
  {#each toasts.items as item (item.id)}
    <div class="toast" class:error={item.kind === 'error'} role={item.kind === 'error' ? 'alert' : 'status'} data-bug-ui={item.apart ? '' : undefined} data-testid={item.testid}>{item.text}</div>
  {/each}
</div>
