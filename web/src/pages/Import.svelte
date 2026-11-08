<script lang="ts">
  import type { Host, ImportCandidate } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import { errorMessage, post } from '../lib/api.js';
  import { data, dataLoad, ensureLoaded, groupPath, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { goFrom, here, up } from '../lib/router.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import LoadFailed from '../components/LoadFailed.svelte';

  const EXAMPLE = ['Host server2', '  HostName 192.168.1.20', '  User alice', '  IdentityFile ~/.ssh/id_ed25519'].join('\n');

  let text = $state('');
  let candidates = $state<(ImportCandidate & { selected: boolean; keyId: number | null })[] | null>(null);
  let groupId = $state<number | null>(null);
  let busy = $state(false);

  // The groups and keys to put the hosts in: not read is said (A3-WEB-01).
  ensureLoaded();

  const selectedCount = $derived(candidates?.filter((c) => c.selected).length ?? 0);
  // All or none at once, as the shared PickList does (these rows carry a key choice too).
  const pickAll = (on: boolean) => candidates?.forEach((c) => (c.selected = on));

  async function preview(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    try {
      const list = await post<ImportCandidate[]>('/api/import/ssh-config/preview', { text });
      candidates = list.map((c) => ({ ...c, selected: c.duplicateOf === null, keyId: c.matchedKeyId }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  async function apply() {
    if (!candidates) return;
    busy = true;
    const from = here();
    try {
      const created = await post<Host[]>('/api/import/ssh-config/apply', {
        groupId,
        entries: candidates
          .filter((c) => c.selected)
          .map((c) => ({ alias: c.alias, address: c.address, port: c.port, username: c.username, keyId: c.keyId })),
      });
      toast(t('import.done', { count: created.length }));
      await loadAll();
      goFrom(from, '/hosts');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

<div class="page narrow">
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/hosts')}><Icon name="back" /></button>
    <h1>{t('import.title')}</h1>
  </header>

  {#if !data.loaded && dataLoad.error}
    <LoadFailed message={dataLoad.error} onretry={ensureLoaded} />
  {:else if !candidates}
    <form class="stack" onsubmit={preview}>
      <p class="dim small">{t('import.help')}</p>
      <textarea bind:value={text} name="config" aria-label={t('import.config')} rows="14" spellcheck="false" autocapitalize="none" placeholder={EXAMPLE}></textarea>
      <button class="btn primary block" disabled={busy || !text.trim()}>{t('import.preview')}</button>
    </form>
  {:else if candidates.length === 0}
    <p class="empty">{t('import.none')}</p>
    <button class="btn block" onclick={() => (candidates = null)}>{t('common.back')}</button>
  {:else}
    {#if candidates.length > 3}
      <div class="tools">
        <span class="dim small">{t('pick.count', { n: selectedCount, total: candidates.length })}</span>
        <button type="button" class="btn small" onclick={() => pickAll(true)} data-testid="import-all">{t('pick.all')}</button>
        <button type="button" class="btn small" onclick={() => pickAll(false)} data-testid="import-none">{t('pick.none')}</button>
      </div>
    {/if}
    <div class="list">
      {#each candidates as c (c.alias)}
        <label class="list-item">
          <input type="checkbox" bind:checked={c.selected} />
          <span class="main">
            <span class="title">{c.alias}</span>
            <span class="sub">{c.username ? `${c.username}@` : ''}{c.address}{c.port ? `:${c.port}` : ''}{c.duplicateOf ? ` | ${t('import.duplicate')}` : ''}</span>
            {#if c.identityFile}<span class="sub mono">{c.identityFile}</span>{/if}
          </span>
          <select bind:value={c.keyId} aria-label={t('host.key')} style:width="auto" style:max-width="40%">
            <option value={null}>{t('common.none')}</option>
            {#each data.keys as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
          </select>
        </label>
      {/each}
    </div>
    <label class="field" style:margin-top="12px">
      <span>{t('import.into')}</span>
      <select bind:value={groupId}>
        <option value={null}>{t('common.none')}</option>
        {#each data.groups as g (g.id)}<option value={g.id}>{groupPath(g.id)}</option>{/each}
      </select>
    </label>
    <div class="stack" style:margin-top="12px">
      <button class="btn primary" disabled={busy || selectedCount === 0} onclick={apply}>{t('import.apply', { count: selectedCount })}</button>
      <button class="btn" onclick={() => (candidates = null)}>{t('common.back')}</button>
    </div>
  {/if}
</div>

<style>
  .tools {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
  }
  .tools .btn {
    flex: none;
    width: auto;
  }
  .tools > span {
    flex: 1;
  }
</style>
