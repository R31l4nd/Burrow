<script lang="ts">
  import Icon from './Icon.svelte';
  import { android } from '../lib/android.js';
  import { burrowAway } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';

  // A page or part that could not load: why, and a way to try again,
  // instead of "Loading..." for ever or an empty list (audit WP-07).

  // `heading`: in place of the whole page, which then has no title of its own.
  // `inline`: a part of a page (a card, a list, a dialog) that could not be read, not the whole page.
  let { message, onretry, heading = false, inline = false }: { message: string; onretry: () => void; heading?: boolean; inline?: boolean } = $props();
  // In the app with Burrow itself away: the phone's direct route reaches the hosts without it
  // (report eedaac: only the app's own error screen had it, not a page that lost Burrow later).
  const direct = $derived(!!android && burrowAway(message));
</script>

<div class="failed" class:inline data-testid="load-failed">
  {#if heading}<h1>{t('common.loadFailed')}</h1>{/if}
  <p class="alert error">{message}</p>
  {#if direct}
    <div class="btnrow">
      <button class="btn" onclick={onretry} data-testid="load-retry"><Icon name="reload" size={16} /> {t('common.retry')}</button>
      <button class="btn" onclick={() => android?.openDirect()} data-testid="load-direct"><Icon name="phone" size={16} /> {t('android.direct')}</button>
    </div>
  {:else}
    <button class="btn" onclick={onretry} data-testid="load-retry"><Icon name="reload" size={16} /> {t('common.retry')}</button>
  {/if}
</div>

<style>
  .failed {
    min-height: 60dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px 16px;
    text-align: center;
  }
  .failed .btn {
    align-self: center;
  }
  .failed.inline {
    min-height: 0;
    padding: 0;
    align-items: stretch;
    text-align: left;
  }
  .failed.inline .alert {
    margin: 0;
  }
  .failed.inline .btn {
    align-self: flex-start;
  }
  h1 {
    font-size: 1.1rem;
    margin: 0;
  }
</style>
