<script lang="ts">
  import { t } from '../lib/i18n/index.svelte.js';
  import Icon from './Icon.svelte';

  // A small "?" next to a setting that explains it in a sentence or two.
  // Tap to open, tap again or anywhere else to close.
  let { text }: { text: string } = $props();

  let open = $state(false);
  let root: HTMLSpanElement | undefined = $state();
  let btn: HTMLButtonElement | undefined = $state();
  let pop: HTMLSpanElement | undefined = $state();
  let pos = $state<{ left: number; top: number } | null>(null);

  const MARGIN = 8;

  // Fixed position computed from the button and clamped to the viewport: a
  // tip next to a field at the right edge of a phone screen would otherwise
  // hang off the screen. Opens above the button when there is no room below.
  function place() {
    if (!btn || !pop) return;
    const b = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.min(Math.max(b.left + b.width / 2 - w / 2, MARGIN), vw - w - MARGIN);
    const below = b.bottom + 6;
    const top = below + h + MARGIN <= vh ? below : Math.max(MARGIN, b.top - 6 - h);
    pos = { left, top };
  }

  $effect(() => {
    if (!open || !pop) return;
    // In the top layer, over everything: inside a bar (the terminal's) a fixed tip
    // stayed in that bar's stacking and fell under the rail beside it (report 6779f4).
    try {
      pop.showPopover();
    } catch {
      // A browser without popovers: fixed and high, as before.
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  });

  $effect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (open = false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
    };
  });
</script>

<span class="helptip" bind:this={root}>
  <button
    bind:this={btn}
    type="button"
    class="q"
    aria-label={t('common.help')}
    aria-expanded={open}
    onclick={(e) => {
      // Inside a <label>, a click would otherwise also focus the field.
      e.preventDefault();
      e.stopPropagation();
      pos = null;
      open = !open;
    }}><Icon name="help" size={16} /></button
  >
  {#if open}
    <span
      class="pop"
      role="note"
      popover="manual"
      bind:this={pop}
      style:left={pos ? `${pos.left}px` : '0'}
      style:top={pos ? `${pos.top}px` : '0'}
      style:visibility={pos ? 'visible' : 'hidden'}>{text}</span
    >
  {/if}
</span>

<style>
  .helptip {
    position: relative;
    display: inline-flex;
    vertical-align: middle;
  }
  /* Small to look at, not to hit: on a touch screen its area reaches past its edge (AUDIT2 UX-04). */
  @media (pointer: coarse) {
    .q {
      position: relative;
    }
    .q::after {
      content: '';
      position: absolute;
      inset: -4px;
    }
  }
  .q {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: -6px 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }
  .q[aria-expanded='true'] {
    color: var(--accent);
  }
  /* Not on a touch screen: a tapped "?" kept its hover, accent-green on the dark title bar (UIA-13). */
  @media (hover: hover) {
    .q:hover {
      color: var(--accent);
    }
  }
  .pop {
    position: fixed;
    z-index: 1000;
    /* A popover's own placement (centred, inset 0) gives way to ours. */
    inset: auto;
    margin: 0;
    overflow: visible;
    width: min(300px, calc(100vw - 16px));
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
    box-shadow: var(--shadow);
    font-size: 0.85rem;
    font-weight: 400;
    line-height: 1.4;
    text-transform: none;
    letter-spacing: normal;
    white-space: normal;
  }
</style>
