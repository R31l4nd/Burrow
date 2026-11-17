<script lang="ts">
  // The edge between two parts side by side, dragged to share the room
  // differently (report 780048, VS Code's sash): the mouse or a finger, the
  // arrow keys when it has the focus, a double click back to the start.
  // The parent places it (left) and turns the pointer's x into a size.
  let {
    label,
    value,
    left,
    onmove,
    onstep,
    onreset,
    ondone,
    testid,
  }: {
    label: string;
    /** For a screen reader: how far along, 0 to 100. */
    value: number;
    /** Its place in the parent (position: relative), e.g. "290px" or "50%". */
    left: string;
    /** Dragged: the pointer's x on the screen. */
    onmove: (clientX: number) => void;
    /** An arrow key: one step left (-1) or right (1). */
    onstep: (by: -1 | 1) => void;
    onreset: () => void;
    /** Let go (or a step taken): keep the size. */
    ondone: () => void;
    testid: string;
  } = $props();

  let dragging = $state(false);

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (m: PointerEvent) => onmove(m.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      dragging = false;
      ondone();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function key(e: KeyboardEvent) {
    const by = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!by) return;
    e.preventDefault();
    onstep(by);
    ondone();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator is the ARIA window splitter: dragged, or moved with the arrow keys) -->
<div
  class="sash"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={Math.round(value)}
  aria-valuemin={0}
  aria-valuemax={100}
  tabindex="0"
  style:left="calc({left} - 4px)"
  onpointerdown={down}
  ondblclick={() => (onreset(), ondone())}
  onkeydown={key}
  data-testid={testid}
></div>

<style>
  .sash {
    position: absolute;
    z-index: 5;
    top: 0;
    bottom: 0;
    width: 8px;
    cursor: col-resize;
    touch-action: none;
  }
  .sash:focus-visible,
  .sash.dragging {
    background: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  @media (hover: hover) {
    .sash:hover {
      background: color-mix(in srgb, var(--accent) 40%, transparent);
    }
  }
  /* While dragged, the page under it does not select text or take the pointer. */
  :global(body:has(.sash.dragging)) {
    cursor: col-resize;
    user-select: none;
  }
</style>
