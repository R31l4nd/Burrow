<script lang="ts" module>
  // Where the line under the chosen tab was: each tab is its own page, so
  // the next page's line starts there and slides over.
  let last: { left: number; width: number } | null = null;
</script>

<script lang="ts">
  import { roving } from '../lib/roving.js';
  import { scrollCue } from '../lib/scrollcue.js';
  import { alertState } from '../lib/alerts.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';

  // Containers, Apps, Alerts and Reports share one place in the bottom bar:
  // a row of tabs under the page's bar, the new alerts counted beside theirs.
  let { current }: { current: 'containers' | 'apps' | 'alerts' | 'reports' } = $props();

  let row: HTMLDivElement | undefined = $state();
  let line = $state<{ left: number; width: number } | null>(last);
  $effect(() => {
    void current;
    if (!row) return;
    const place = () => {
      const on = row?.querySelector<HTMLElement>('button.on');
      if (!on) return;
      line = last = { left: on.offsetLeft, width: on.offsetWidth };
    };
    // A frame later: from where the last page left it, so it slides.
    const raf = requestAnimationFrame(place);
    const ro = new ResizeObserver(place);
    ro.observe(row);
    return () => (cancelAnimationFrame(raf), ro.disconnect());
  });
</script>

<div use:scrollCue use:roving bind:this={row} class="tabs full-bleed" role="tablist" aria-label={t('nav.containers')}>
  {#each [{ id: 'containers', label: t('containers.title') }, { id: 'apps', label: t('apps.title') }, { id: 'alerts', label: t('alerts.title') }, { id: 'reports', label: t('reports.title') }] as const as tab (tab.id)}
    <!-- Its name stays the tab's word (the nav button already says how many alerts are new). -->
    <button role="tab" aria-selected={current === tab.id} aria-label={tab.label} class:on={current === tab.id} onclick={() => go(`/${tab.id}`)}>
      {tab.label}{#if tab.id === 'alerts' && alertState.unread}<span class="count" aria-hidden="true">{alertState.unread}</span>{/if}
    </button>
  {/each}
  {#if line}<span class="line" aria-hidden="true" style:transform="translateX({line.left}px)" style:width="{line.width}px"></span>{/if}
</div>

<style>
  .tabs {
    display: flex;
    gap: 2px;
    margin: -8px -16px 14px;
    padding: 0 12px;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs button {
    flex: none;
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-dim);
    font: 500 0.92rem var(--font);
    white-space: nowrap;
    cursor: pointer;
  }
  .tabs button.on {
    color: var(--text);
    font-weight: 600;
  }
  .tabs {
    position: relative;
  }
  /* The chosen tab's line: one, sliding to the tab chosen. */
  .line {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    background: var(--accent);
    border-radius: 2px 2px 0 0;
    transition:
      transform var(--dur-3) var(--ease),
      width var(--dur-3) var(--ease);
  }
  .count {
    margin-left: 6px;
    font: 600 0.8rem var(--mono);
    color: var(--danger);
  }
  /* A tablet: across the screen, the tabs over the page's centred column. */
  @media (max-width: 899px) {
    .tabs {
      padding: 0 calc(max(0px, (100% - 760px) / 2) + 12px);
    }
  }
  @media (min-width: 900px) {
    .tabs {
      margin: -20px -28px 18px;
      padding: 0 20px;
    }
  }
</style>
