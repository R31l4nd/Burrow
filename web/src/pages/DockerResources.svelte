<script lang="ts">
  import { untrack } from 'svelte';
  import { unused, type DockerResources, type PruneResult } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import PageTitle from '../components/PageTitle.svelte';
  import Icon from '../components/Icon.svelte';
  import { errorMessage, get, post } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { formatBytes } from '../lib/files.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { up } from '../lib/router.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';

  // A host's Docker images, volumes and networks, what uses each, and a
  // clean-up that shows what it would remove first (docs/PRIOR-ART.md).

  let { hostId: hostProp }: { hostId: number } = $props();
  const hostId = untrack(() => hostProp);
  if (!data.loaded) inBackground(loadAll());
  const host = $derived(data.hosts.find((h) => h.id === hostId));

  let res = $state<DockerResources | null>(null);
  let error = $state('');
  let view = $state<'images' | 'volumes' | 'networks'>('images');
  async function load() {
    try {
      res = await get<DockerResources>(`/api/docker/${hostId}/resources`);
      error = '';
    } catch (err) {
      error = errorMessage(err);
    }
  }
  inBackground(load());

  const free = $derived(res ? unused(res) : null);
  const freeBytes = $derived(free ? free.images.reduce((a, i) => a + i.sizeBytes, 0) : 0);

  // The clean-up: unused images and networks ticked; volumes not (their data goes with them).
  let pruneOpen = $state(false);
  // Anyone signed in looks; cleaning up is the admin's.
  const admin = $derived(session.state?.user?.role === 'admin');
  let pick = $state<{ images: string[]; volumes: string[]; networks: string[] }>({ images: [], volumes: [], networks: [] });
  let busy = $state(false);
  function openPrune() {
    if (!free) return;
    pick = { images: free.images.map((i) => i.id), volumes: [], networks: free.networks.map((n) => n.id) };
    pruneOpen = true;
  }
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  async function prune() {
    busy = true;
    try {
      const r = await post<PruneResult>(`/api/docker/${hostId}/prune`, pick);
      const n = r.removed.images.length + r.removed.volumes.length + r.removed.networks.length;
      toast(t('res.pruned', { n, size: formatBytes(r.freedBytes) }), r.skipped.length ? 'error' : 'info');
      for (const s of r.skipped) toast(`${s.id.replace(/^sha256:/, '').slice(0, 12)}: ${s.why}`, 'error');
      pruneOpen = false;
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
  const total = $derived(pick.images.length + pick.volumes.length + pick.networks.length);
  const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12);
</script>

<div class="page">
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/hosts')}><Icon name="back" /></button>
    <PageTitle title={t('res.title')} sub={host?.name ?? ''} tip={t('help.resources')} />
  </header>

  {#if error}<p class="alert error small">{error}</p>{/if}
  {#if res?.usageUnknown}<p class="alert warn small">{t('res.usageUnknown')}</p>{/if}
  {#if res && free}
    <section class="stack" data-content>
      <div class="bar">
        <!-- A dropdown: three counts side by side did not fit a phone (report 8f41d4). -->
        <select class="view" bind:value={view} aria-label={t('res.show')} data-testid="res-view">
          <option value="images">{t('res.images', { n: res.images.length })}</option>
          <option value="volumes">{t('res.volumes', { n: res.volumes.length })}</option>
          <option value="networks">{t('res.networks', { n: res.networks.length })}</option>
        </select>
        {#if admin}<button class="btn small" disabled={!free.images.length && !free.volumes.length && !free.networks.length} onclick={openPrune} data-testid="res-prune"><Icon name="trash" size={16} /> {t('res.prune')}</button>{/if}
      </div>
      <p class="dim small" data-testid="res-summary">{t('res.unusedSummary', { images: free.images.length, size: formatBytes(freeBytes), volumes: free.volumes.length, networks: free.networks.length })}</p>

      <div class="list" data-testid="res-list">
        {#if view === 'images'}
          {#each res.images as i (i.id)}
            <div class="list-item" data-testid="res-row">
              <span class="main">
                <span class="title">{i.tags.join(', ') || t('res.dangling', { id: shortId(i.id) })}</span>
                <span class="sub">{formatBytes(i.sizeBytes)} | {i.usedBy.length ? t('res.usedBy', { names: i.usedBy.join(', ') }) : t('res.unused')}</span>
              </span>
            </div>
          {/each}
        {:else if view === 'volumes'}
          {#each res.volumes as v (v.name)}
            <div class="list-item" data-testid="res-row">
              <span class="main">
                <span class="title">{v.name}</span>
                <span class="sub">{v.project ? `${v.project} | ` : ''}{v.usedBy.length ? t('res.usedBy', { names: v.usedBy.join(', ') }) : t('res.unused')}</span>
              </span>
            </div>
          {/each}
        {:else}
          {#each res.networks as n (n.id)}
            <div class="list-item" data-testid="res-row">
              <span class="main">
                <span class="title">{n.name}</span>
                <span class="sub">{n.driver}{n.builtin ? ` | ${t('res.builtin')}` : ''} | {n.usedBy.length ? t('res.usedBy', { names: n.usedBy.join(', ') }) : t('res.unused')}</span>
              </span>
            </div>
          {/each}
        {/if}
      </div>
    </section>
  {:else if !error}
    <p class="empty">{t('common.loading')}</p>
  {/if}
</div>

{#snippet head(kind: 'images' | 'volumes' | 'networks', title: string, ids: string[])}
  <div class="khead" data-kind={kind}>
    <h3>{title}</h3>
    <button class="btn small" disabled={pick[kind].length === ids.length} onclick={() => (pick[kind] = [...ids])} data-testid="prune-all">{t('res.all')}</button>
    <button class="btn small" disabled={!pick[kind].length} onclick={() => (pick[kind] = [])} data-testid="prune-none">{t('res.none')}</button>
  </div>
{/snippet}

<Dialog tour="resources-prune" bind:open={pruneOpen} title={t('res.pruneTitle')}>
  {#if free}
    <div class="stack">
      <p class="small">{t('res.pruneWhat')}</p>
      <!-- Each kind with all or none at a press: a long list was ticked one by one (report 8f41d4). -->
      {#if free.images.length}{@render head('images', t('res.images', { n: free.images.length }), free.images.map((i) => i.id))}{/if}
      {#each free.images as i (i.id)}
        <label class="check"><input type="checkbox" checked={pick.images.includes(i.id)} onchange={() => (pick.images = toggle(pick.images, i.id))} data-testid="prune-image" /> {i.tags.join(', ') || t('res.dangling', { id: shortId(i.id) })} <span class="dim small">{formatBytes(i.sizeBytes)}</span></label>
      {/each}
      {#if free.networks.length}{@render head('networks', t('res.networks', { n: free.networks.length }), free.networks.map((n) => n.id))}{/if}
      {#each free.networks as n (n.id)}
        <label class="check"><input type="checkbox" checked={pick.networks.includes(n.id)} onchange={() => (pick.networks = toggle(pick.networks, n.id))} data-testid="prune-network" /> {t('res.network', { name: n.name })}</label>
      {/each}
      {#if free.volumes.length}
        {@render head('volumes', t('res.volumes', { n: free.volumes.length }), free.volumes.map((v) => v.name))}
        <p class="alert warn small">{t('res.volumesWarn')}</p>
        {#each free.volumes as v (v.name)}
          <label class="check"><input type="checkbox" checked={pick.volumes.includes(v.name)} onchange={() => (pick.volumes = toggle(pick.volumes, v.name))} data-testid="prune-volume" /> {t('res.volume', { name: v.name })}</label>
        {/each}
      {/if}
    </div>
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => (pruneOpen = false)}>{t('common.cancel')}</button>
    <button class="btn danger" disabled={busy || !total} onclick={prune} data-testid="prune-go">{t('res.pruneGo', { n: total })}</button>
  {/snippet}
</Dialog>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .bar :global(.btn) {
    width: auto;
  }
  .view {
    width: auto;
    flex: 1;
    min-width: 0;
  }
  .khead {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .khead h3 {
    flex: 1;
    margin: 0;
    font-size: 0.95rem;
  }
  .khead .btn {
    width: auto;
  }
</style>
