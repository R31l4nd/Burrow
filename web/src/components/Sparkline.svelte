<script lang="ts">
  // A small line of recent values (CPU or memory), newest on the right.
  // `mark`: a point picked on it (an index into values), shown by a line
  // from top to bottom and a dot. `format`: its values said on hover (and to
  // a screen reader): now and the highest (report 4af4ec: a line without numbers).
  import { t } from '../lib/i18n/index.svelte.js';
  let {
    values,
    max = null,
    width = 72,
    height = 22,
    label,
    mark = null,
    format = null,
    at = null,
  }: {
    values: number[];
    max?: number | null;
    width?: number;
    height?: number;
    label: string;
    mark?: number | null;
    format?: ((v: number) => string) | null;
    /** When each value was (ms): placed by time, so kept samples five minutes apart and live ones seconds apart read right. */
    at?: number[] | null;
  } = $props();
  // Always with its numbers: a chart said only by its name told a screen reader nothing (AUDIT2 UX-03).
  const fmt = $derived(format ?? ((v: number) => v.toFixed(1)));
  const said = $derived(values.length < 2 ? `${label}: ${t('spark.collecting')}` : `${label}: ${t('spark.values', { now: fmt(values[values.length - 1]!), max: fmt(Math.max(...values)) })}`);

  const top = $derived(Math.max(max ?? 0, ...values, 1e-9));
  const step = $derived(values.length > 1 ? width / (values.length - 1) : 0);
  const timed = $derived(!!at && at.length === values.length && values.length > 1 && at[at.length - 1]! > at[0]!);
  const x = (i: number) => (timed ? ((at![i]! - at![0]!) / (at![at!.length - 1]! - at![0]!)) * width : i * step);
  const y = (v: number) => height - 1 - (v / top) * (height - 2);
  const points = $derived(values.length < 2 ? '' : values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
</script>

<svg class="spark" viewBox="0 0 {width} {height}" width={width} height={height} role="img" aria-label={said}>
  <title>{said}</title>
  {#if points}<polyline {points} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />{:else}
    <!-- Not enough samples yet: a dashed base line, not an empty space. -->
    <line class="empty" x1="0" x2={width} y1={height - 1} y2={height - 1} stroke-width="1" stroke-dasharray="3 3" />
  {/if}
  {#if points && mark !== null && values[mark] !== undefined}
    <line class="mark" x1={x(mark)} x2={x(mark)} y1="0" y2={height} stroke-width="1" />
    <circle class="mark-dot" cx={x(mark)} cy={y(values[mark]!)} r="3" />
  {/if}
</svg>

<style>
  .spark {
    display: block;
    color: var(--accent);
    flex: none;
  }
  .mark,
  .empty {
    stroke: var(--text-dim);
  }
  .mark-dot {
    fill: var(--accent);
  }
</style>
