<script lang="ts">
  import { pull, PULL_TRIGGER } from '../lib/pull.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import Icon from './Icon.svelte';

  // The circle that comes down with the finger: "let go to refresh" once far
  // enough, spinning while the page reads again.
</script>

{#if pull.distance > 8 || pull.busy}
  <div class="pull" style:transform={`translate(-50%, ${pull.busy ? 16 : pull.distance / 2}px)`} role="status" aria-live="polite" data-testid="pull">
    <span class="ball" class:spin={pull.busy} style:transform={pull.busy ? undefined : `rotate(${pull.distance * 3}deg)`}><Icon name="reload" size={18} /></span>
    <span class="small">{pull.busy ? t('pull.refreshing') : pull.distance >= PULL_TRIGGER ? t('pull.release') : t('pull.pull')}</span>
  </div>
{/if}

<style>
  .pull {
    position: fixed;
    top: 8px;
    left: 50%;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    color: var(--text);
  }
  .ball {
    display: inline-flex;
    color: var(--accent);
  }
  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
</style>
