<script lang="ts">
  // One line of a history (a host's CPU, a container's memory, a disk's writes) with its name, its
  // highest and newest value, and, where it is pointed at or touched, that moment's time and value next
  // to the pointer (report af0eec: the value stood only at the far left, away from the cursor; report
  // 4af4ec: none on a phone). Charts of one history share the moment through `picked`.
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { nearestIndex, placeOf } from '../lib/chartpick.js';
  import Sparkline from './Sparkline.svelte';

  let {
    label,
    values,
    at,
    max = null,
    format = (v: number) => v.toFixed(1),
    width = 600,
    height = 60,
    picked = $bindable(null),
    testid = 'history-chart',
  }: {
    label: string;
    values: number[];
    /** When each value was (ms since the epoch). */
    at: number[];
    max?: number | null;
    format?: (v: number) => string;
    width?: number;
    height?: number;
    picked?: number | null;
    testid?: string;
  } = $props();

  let plot = $state<HTMLElement | null>(null);
  // Drawn at the width it has on the screen, at its own height: drawn small and scaled up, a wide
  // screen made each chart hundreds of pixels high (report dfc610).
  let plotWidth = $state(0);
  // As before up to its own width (a phone's charts as they were), never higher than its height.
  const drawnHeight = $derived(plotWidth > 0 ? Math.min(height, Math.max(24, Math.round((plotWidth * height) / width))) : height);
  function pick(e: PointerEvent) {
    const r = plot?.getBoundingClientRect();
    if (!r || r.width <= 0 || values.length < 2) return;
    picked = nearestIndex(at, (e.clientX - r.left) / r.width);
  }
  const shown = $derived(picked !== null && values[picked] !== undefined ? picked : null);
  const left = $derived(shown === null ? 0 : placeOf(at, shown) * 100);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (pointing only adds a moment's value; the line above says max and now for everyone) -->
<div class="chart" onpointerdown={pick} onpointermove={(e) => (e.pointerType === 'mouse' || e.buttons) && pick(e)} onpointerleave={(e) => e.pointerType === 'mouse' && (picked = null)} data-testid={testid}>
  <span class="small" data-testid="chart-value">{label} <span class="dim">| {t('stats.maxNow', { max: format(Math.max(...values)), now: format(values[values.length - 1]!) })}</span></span>
  <div class="plot" bind:this={plot} bind:clientWidth={plotWidth}>
    <Sparkline {values} {max} {at} width={plotWidth > 0 ? Math.round(plotWidth) : width} height={drawnHeight} {label} format={format} mark={shown} />
    {#if shown !== null}
      <!-- Beside the line at that moment, turned to the left past the middle so it stays inside. -->
      <span class="tip" class:flip={left > 55} style:left="{left}%" data-testid="chart-tip"><span class="dim">{dateTime(new Date(at[shown]!).toISOString())}</span> <b>{format(values[shown]!)}</b></span>
    {/if}
  </div>
</div>

<style>
  /* The graphs follow the card's width; their drawn size must not widen it. */
  .chart {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    /* A finger along a chart picks a moment; up and down still scrolls. */
    touch-action: pan-y;
    cursor: crosshair;
  }
  .plot {
    position: relative;
  }
  .plot :global(svg) {
    width: 100%;
    max-width: 100%;
    height: auto;
  }
  .tip {
    position: absolute;
    top: 0;
    transform: translateX(8px);
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
    box-shadow: var(--shadow);
    font-size: 0.8rem;
    white-space: nowrap;
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .tip.flip {
    transform: translateX(calc(-100% - 8px));
  }
</style>
