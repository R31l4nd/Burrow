<script lang="ts">
  import { t } from '../lib/i18n/index.svelte.js';

  // While a page's list or numbers are on their way: their shape, calmly
  // shimmering, instead of the word "Loading..." in an empty page (the
  // word is still there for a screen reader). `tiles`: a row of number
  // tiles above, as on a host's statistics.
  let { rows = 4, tiles = 0 }: { rows?: number; tiles?: number } = $props();
</script>

<div class="skel" role="status" data-content data-testid="skeleton">
  <span class="sr-only">{t('common.loading')}</span>
  {#if tiles}
    <div class="tiles" aria-hidden="true">
      {#each Array.from({ length: tiles }, (_, i) => i) as i (i)}<div class="tile skeleton"></div>{/each}
    </div>
  {/if}
  <div class="list" aria-hidden="true">
    {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
      <div class="row">
        <span class="dot skeleton"></span>
        <span class="lines">
          <span class="line skeleton" style:width="{40 + ((i * 23) % 35)}%"></span>
          <span class="line short skeleton" style:width="{25 + ((i * 17) % 25)}%"></span>
        </span>
      </div>
    {/each}
  </div>
</div>

<style>
  .skel {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
  }
  .tile {
    height: 84px;
    border-radius: var(--radius);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    min-height: 56px;
  }
  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .lines {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .line {
    display: block;
    height: 12px;
  }
  .line.short {
    height: 10px;
  }
</style>
