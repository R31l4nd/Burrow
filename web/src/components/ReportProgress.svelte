<script lang="ts">
  import type { ReportProgress } from '@burrow/shared';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';

  // A report being made: what it is doing, how far, and when it should be
  // ready (from how long the last one took); then a way to it.
  let { p, onopen = () => {} }: { p: ReportProgress; onopen?: () => void } = $props();

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(Math.max(0, now - Date.parse(p.startedAt)));
  const left = $derived(p.expectedMs !== null ? Math.max(0, p.expectedMs - elapsed) : null);
  const secs = (ms: number) => Math.max(1, Math.round(ms / 1000));
</script>

<div class="rp" data-testid="report-progress">
  <div class="row">
    <strong class="label">{p.name}</strong>
    {#if p.phase === 'done' && p.reportId !== null}
      <button class="btn small" onclick={() => (onopen(), go(`/reports/${p.reportId}`))} data-testid="report-progress-open">{t('reports.open')}</button>
    {/if}
  </div>
  {#if p.phase === 'failed'}
    <span class="err small">{t('reports.failed', { error: p.error ?? '' })}</span>
  {:else if p.phase === 'done'}
    <span class="dim small">{t('reports.ready')}</span>
  {:else}
    <span class="dim small">
      {t(`reports.phase.${p.phase}`, { done: p.done, total: p.total })}
      | {left !== null ? t('reports.eta', { s: secs(left) }) : t('reports.etaFirst', { s: secs(elapsed) })}
    </span>
    {#if p.total > 0 && p.phase !== 'sending'}
      <progress max={p.total} value={p.done} aria-label={p.name}></progress>
    {:else}
      <progress aria-label={p.name}></progress>
    {/if}
  {/if}
</div>

<style>
  .rp {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  progress {
    width: 100%;
    accent-color: var(--accent);
  }
  .err {
    color: var(--danger);
  }
</style>
