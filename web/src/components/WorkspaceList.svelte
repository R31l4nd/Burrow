<script lang="ts">
  import LoadFailed from './LoadFailed.svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import type { Workspace } from '@burrow/shared';
  import { del, errorMessage, get } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import Icon from './Icon.svelte';

  // Saved workspaces (folders opened as a project), most recent first.
  let { heading = true }: { heading?: boolean } = $props();
  let list = $state<Workspace[]>([]);
  // Removing is the admin's (the server refuses an operator).
  const admin = $derived(session.state?.user?.role === 'admin');

  // Not read is said, not left out as if there were none (AUDIT2 UI-29).
  let loadError = $state('');
  const load = () =>
    get<Workspace[]>('/api/workspaces').then(
      (w) => ((list = w), (loadError = '')),
      (err: unknown) => (loadError = errorMessage(err)),
    );
  void load();

  async function remove(w: Workspace) {
    if (!(await ask({ text: t('ws.removeConfirm', { name: w.name }), confirm: t('common.remove') }))) return;
    try {
      await del(`/api/workspaces/${w.id}`);
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

{#if loadError}
  {#if heading}<h2 class="group">{t('ws.title')}</h2>{/if}
  <LoadFailed message={loadError} onretry={load} />
{:else if list.length}
  {#if heading}<h2 class="group">{t('ws.title')}</h2>{/if}
  <div class="list" data-testid="workspaces">
    {#each list as w (w.id)}
      <div class="list-item">
        <button class="open" onclick={() => go(`/ws/${w.id}`)}>
          <Icon name="code" />
          <span class="main"><span class="title">{w.name}</span><span class="sub">{w.hostName}:{w.root}</span></span>
        </button>
        {#if admin}<button class="icon-btn" aria-label={t('ws.remove', { name: w.name })} onclick={() => remove(w)} data-testid="ws-remove"><Icon name="trash" /></button>{/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 0;
    cursor: pointer;
  }
</style>
