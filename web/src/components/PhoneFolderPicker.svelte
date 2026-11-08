<script lang="ts">
  import { android, type PhoneListing, type PhoneRoot } from '../lib/android.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { phoneCrumbs, phoneFailure, sortEntries } from '../lib/phonefiles.js';
  import { toast } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import Skeleton from './Skeleton.svelte';

  // A host's file copied to the phone (the Android app): a folder of the
  // phone chosen among the ones the person granted (or one added now), then
  // the app downloads it there itself, with its progress in the notification.

  let { open = $bindable(false), file }: { open?: boolean; file: { url: string; name: string } | null } = $props();

  let roots = $state<PhoneRoot[] | null>(null);
  let listing = $state<PhoneListing | null>(null);
  let error = $state('');
  let busy = $state(false);
  let seq = 0;

  async function show(path: string) {
    if (!android) return;
    const mine = ++seq;
    error = '';
    try {
      if (path === '/') {
        listing = null;
        const r = await android.phoneRoots();
        if (mine === seq) roots = r;
      } else {
        const l = await android.phoneList(path);
        if (mine === seq) listing = l;
      }
    } catch (err) {
      if (mine === seq) error = phoneFailure(err).message;
    }
  }
  $effect(() => {
    if (open) void show('/');
  });

  async function add() {
    busy = true;
    try {
      const r = await android!.phoneAddRoot('');
      if (!('cancelled' in r)) await show(`/${r.id}`);
    } catch (err) {
      toast(phoneFailure(err).message, 'error');
    } finally {
      busy = false;
    }
  }

  async function copyHere() {
    if (!file || !listing) return;
    busy = true;
    try {
      await android!.phoneSaveFrom({ url: file.url, name: file.name, dir: listing.path });
      toast(t('phone.copyingToPhone', { name: file.name, folder: listing.names.at(-1) ?? listing.root.name }));
      open = false;
    } catch (err) {
      toast(phoneFailure(err).message, 'error');
    } finally {
      busy = false;
    }
  }

  const dirs = $derived(listing ? sortEntries(listing.entries, false).filter((e) => e.type === 'dir') : []);
</script>

<Dialog tour="phone-pick-folder" bind:open title={t('phone.copyToPhone')}>
  {#if error}<p class="alert error">{error}</p>{/if}
  {#if !listing}
    <p class="dim small">{t('phone.pickHelp', { name: file?.name ?? '' })}</p>
    {#if roots === null && !error}
      <Skeleton rows={2} />
    {:else}
      <div class="list" data-testid="phone-pick-roots">
        {#each (roots ?? []).filter((r) => !r.lost) as r (r.id)}
          <button class="list-item" onclick={() => show(`/${r.id}`)} data-testid="phone-pick-root"><Icon name="folder" /><span class="main"><span class="title">{r.name}</span></span></button>
        {/each}
        <button class="list-item" disabled={busy} onclick={add} data-testid="phone-pick-add"><Icon name="plus" /><span class="main"><span class="title">{t('phone.addOther')}</span></span></button>
      </div>
    {/if}
  {:else}
    <p class="mono small" data-testid="phone-pick-where">{phoneCrumbs(listing).map((c) => c.name).join(' / ')}</p>
    <div class="list folders">
      <button class="list-item" onclick={() => show(listing!.parent ?? '/')} data-testid="phone-pick-up"><Icon name="back" /><span class="main"><span class="title">..</span></span></button>
      {#each dirs as d (d.path)}
        <button class="list-item" onclick={() => show(d.path)} data-testid="phone-pick-dir"><Icon name="folder" /><span class="main"><span class="title">{d.name}</span></span></button>
      {/each}
    </div>
    {#if !listing.canCreate}<p class="dim small">{t('phone.cannotWrite')}</p>{/if}
  {/if}
  {#snippet actions()}
    <button class="btn primary" disabled={busy || !listing?.canCreate} onclick={copyHere} data-testid="phone-pick-here">{t('phone.copyHere')}</button>
  {/snippet}
</Dialog>

<style>
  .folders {
    max-height: 45vh;
    overflow: auto;
  }
</style>
