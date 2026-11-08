<script lang="ts">
  import type { DirListing } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import { android, nativeSource, type NativeFile } from '../lib/android.js';
  import { errorMessage, get } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { formatBytes, upload } from '../lib/files.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go, to } from '../lib/router.svelte.js';
  import { toast } from '../lib/ui.svelte.js';

  // Files shared into Burrow from another Android app ("Share" > Burrow):
  // pick a host and a folder, then they go through the normal upload queue,
  // read from the app in pieces.

  const LAST_KEY = 'burrow.shareTarget';

  let files = $state<NativeFile[]>([]);
  let hostId = $state<number | null>(null);
  let loading = $state(false);

  function remembered(): { hostId: number; path: string } | null {
    try {
      return JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as { hostId: number; path: string } | null;
    } catch {
      return null;
    }
  }

  // Where the files go: the host and the folder read from it, together. A
  // slower answer for the host chosen before could pair one host with the
  // other's folder (audit WP-01); only the newest request counts.
  let dest = $state<{ hostId: number; listing: DirListing } | null>(null);
  let seq = 0;
  async function open(path: string) {
    if (hostId === null) return;
    const host = hostId;
    const mine = ++seq;
    if (dest?.hostId !== host) dest = null;
    loading = true;
    try {
      const l = await get<DirListing>(to(`/api/files/${host}/list`, { path }));
      if (mine === seq) dest = { hostId: host, listing: l };
    } catch (err) {
      if (mine !== seq) return;
      toast(errorMessage(err), 'error');
      if (path !== '~') return void (await open('~'));
      dest = null;
    } finally {
      if (mine === seq) loading = false;
    }
  }
  const listing = $derived(dest?.listing ?? null);

  async function init() {
    if (!android) return;
    files = await android.sharedFiles();
    if (!data.loaded) await loadAll();
    const last = remembered();
    hostId = last && data.hosts.some((h) => h.id === last.hostId) ? last.hostId : (data.hosts[0]?.id ?? null);
    await open(last?.hostId === hostId ? last.path : '~');
  }
  init().catch((err: unknown) => toast(errorMessage(err), 'error'));

  const dirs = $derived(listing ? listing.entries.filter((e) => e.type === 'dir' || (e.type === 'link' && e.targetType === 'dir')) : []);

  function send() {
    if (!dest || loading) return;
    const { hostId, listing } = dest;
    const dir = listing.path;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ hostId, path: dir }));
    } catch {
      // Remembered for this time only.
    }
    // Each file the app holds is let go once it arrived: one that failed kept the others
    // held too, and offered them again later (AUDIT2 PAGE-27). A failed one stays held.
    const held = files;
    upload(hostId, dir, held.map(nativeSource), (i) => void android?.release(held[i]!.token));
    files = [];
    go(to(`/files/${hostId}`, { p: dir }));
  }
</script>

<div class="page narrow">
  <header class="topbar">
    <h1>{t('share.title')}</h1>
  </header>

  {#if !android}
    <p class="empty">{t('share.onlyApp')}</p>
  {:else if files.length === 0}
    <p class="empty">{t('share.nothing')}</p>
  {:else}
    <div class="stack">
      <div class="list">
        {#each files as f (f.token)}
          <div class="list-item">
            <Icon name="file" />
            <div class="main">
              <div class="title">{f.name}</div>
              <div class="sub">{formatBytes(f.size)}</div>
            </div>
          </div>
        {/each}
      </div>

      <label class="field">
        <span>{t('share.host')}</span>
        <select bind:value={hostId} onchange={() => open('~')}>
          {#each data.hosts as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
        </select>
      </label>

      {#if listing}
        <p class="mono small">{listing.path}</p>
        <div class="list folders">
          {#if listing.parent}
            <button class="list-item" disabled={loading} onclick={() => open(listing!.parent!)}><Icon name="back" /> ..</button>
          {/if}
          {#each dirs as d (d.path)}
            <button class="list-item" disabled={loading} onclick={() => open(d.path)}><Icon name="folder" /> {d.name}</button>
          {/each}
        </div>
      {/if}

      <button class="btn primary block" disabled={!listing || loading} onclick={send}>
        <Icon name="upload" /> {t('share.upload', { n: files.length, dir: listing?.path ?? '' })}
      </button>
    </div>
  {/if}
</div>

<style>
  .folders {
    max-height: 45vh;
    overflow: auto;
    margin-bottom: 1rem;
  }
</style>
