<script lang="ts">
  import LoadFailed from './LoadFailed.svelte';
  import { untrack } from 'svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import { errorMessage, get, post } from '../lib/api.js';
  import type { HistoryItem } from '../lib/complete/engine.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';

  // A host's remembered commands (the suggestions in the terminal): search
  // them, and forget one that should not come back (a typo, an autocorrect).

  let { open = $bindable(false), hostId, hostName }: { open?: boolean; hostId: number; hostName: string } = $props();

  let items = $state<HistoryItem[] | null>(null);
  let query = $state('');
  const shown = $derived((items ?? []).filter((h) => !query.trim() || h.command.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 200));

  // Not read: said with Try again, not "Loading..." for ever (AUDIT2 UI-29).
  let loadError = $state('');
  function load() {
    items = null;
    loadError = '';
    get<HistoryItem[]>(`/api/hosts/${hostId}/history?limit=5000`).then(
      (x) => (items = x),
      (err: unknown) => (loadError = errorMessage(err)),
    );
  }
  $effect(() => {
    if (!open) return;
    query = '';
    untrack(load);
  });

  async function forget(command: string) {
    try {
      await post(`/api/hosts/${hostId}/history/forget`, { command });
      items = (items ?? []).filter((h) => h.command !== command);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

<Dialog tour="history" bind:open title={t('history.title', { name: hostName })}>
  <input type="search" bind:value={query} placeholder={t('history.search')} aria-label={t('history.search')} autocapitalize="none" spellcheck="false" data-testid="history-search" />
  {#if loadError}
    <LoadFailed message={loadError} onretry={load} />
  {:else if items === null}
    <p class="dim small">{t('common.loading')}</p>
  {:else if !items.length}
    <p class="empty">{t('history.none')}</p>
  {:else}
    <p class="dim small">{t('history.count', { n: items.length })}</p>
    <div class="list" data-testid="history-list">
      {#each shown as h (h.command)}
        <div class="list-item">
          <span class="main"><span class="title mono">{h.command}</span></span>
          <button class="icon-btn" aria-label={t('history.forget', { command: h.command })} title={t('history.forget', { command: h.command })} onclick={() => forget(h.command)} data-testid="history-forget"
            ><Icon name="trash" size={18} /></button
          >
        </div>
      {/each}
    </div>
  {/if}
</Dialog>
