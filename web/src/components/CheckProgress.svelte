<script lang="ts">
  import { activity } from '../lib/activity.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';

  // How far an image update check is: tags asked at their registry, of all.
  const c = $derived(activity.check);
  const label = $derived(c && c.total ? t('activity.check', { done: c.done, total: c.total }) : t('activity.checkReading'));
</script>

{#if c}
  <div class="cp" data-testid="check-progress">
    <span class="dim small">{label}</span>
    {#if c.total}
      <progress max={c.total} value={c.done} aria-label={label}></progress>
    {:else}
      <progress aria-label={label}></progress>
    {/if}
  </div>
{/if}

<style>
  .cp {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
  }
  progress {
    width: 100%;
    accent-color: var(--accent);
  }
</style>
