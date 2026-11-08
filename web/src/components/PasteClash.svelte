<script lang="ts">
  import { t } from '../lib/i18n/index.svelte.js';
  import { pasteClash, type ClashChoice } from '../lib/files.svelte.js';
  import Dialog from './Dialog.svelte';

  // A paste whose names are taken where it goes (report dfda31): keep both (the copy gets a
  // number), skip those, or replace them. Into its own folder only beside it.
  // Open while a paste waits for its answer; closed by the dialog itself too (then cancelled, in onclose).
  let open = $derived(!!pasteClash.answer);
  const pick = (c: ClashChoice | null) => pasteClash.answer?.(c);
  const SHOWN = 6;
  const n = $derived(pasteClash.names.length);
</script>

<Dialog tour="paste-clash" bind:open title={t('files.clash.title')} onclose={() => pick(null)} {actions}>
  <p>{t(pasteClash.same ? 'files.clash.same' : 'files.clash.body', { n })}</p>
  <ul class="names" data-testid="clash-names">
    {#each pasteClash.names.slice(0, SHOWN) as name (name)}<li>{name}</li>{/each}
    {#if n > SHOWN}<li class="dim">{t('files.clash.more', { n: n - SHOWN })}</li>{/if}
  </ul>
</Dialog>

{#snippet actions()}
  {#if pasteClash.same}
    <button type="button" class="btn" onclick={() => pick(null)}>{t('common.cancel')}</button>
  {:else}
    <button type="button" class="btn" onclick={() => pick('skip')} data-testid="clash-skip">{t('files.clash.skip')}</button>
    <button type="button" class="btn danger" onclick={() => pick('replace')} data-testid="clash-replace">{t('files.clash.replace')}</button>
  {/if}
  <button type="button" class="btn primary" onclick={() => pick('rename')} data-testid="clash-rename">{t('files.clash.rename')}</button>
{/snippet}

<style>
  .names {
    margin: 0;
    padding-left: 20px;
    overflow-wrap: anywhere;
  }
</style>
