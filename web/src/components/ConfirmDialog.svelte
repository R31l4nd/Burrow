<script lang="ts">
  import { answered, asking, OTHER } from '../lib/confirm.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import Dialog from './Dialog.svelte';

  // The one place where the app asks before it acts (lib/confirm.svelte.ts).

  let value = $state('');
  let open = $state(false);
  $effect(() => {
    open = asking.q !== null;
    value = asking.q?.input?.value ?? '';
  });

  function go(e?: SubmitEvent) {
    e?.preventDefault();
    if (asking.q?.input && !asking.q.empty && !value.trim()) return;
    answered(asking.q?.input ? value.trim() : '');
  }
</script>

<Dialog tour="confirm" bind:open title={asking.q?.confirm ?? ''} onclose={() => asking.q && answered(null)}>
  {#if asking.q}
    <form id="confirm-form" class="stack" onsubmit={go}>
      <p class="text" data-testid="confirm-text">{asking.q.text}</p>
      {#if asking.q.items?.length}
        <ul class="items" data-testid="confirm-items">
          {#each asking.q.items as it (it.title)}
            <li><b class="mono">{it.title}</b>{#each it.lines as l, i (i)}<p>{l}</p>{/each}</li>
          {/each}
        </ul>
      {/if}
      {#if asking.q.input}
        <label class="field">
          <span>{asking.q.input.label}</span>
          <!-- svelte-ignore a11y_autofocus (the one thing to do here) -->
          <input bind:value required={!asking.q.empty} maxlength={asking.q.input.max} autofocus data-testid="confirm-input" />
        </label>
      {/if}
    </form>
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => answered(null)} data-testid="confirm-cancel">{t('common.cancel')}</button>
    {#if asking.q?.other}<button class="btn" onclick={() => answered(OTHER)} data-testid="confirm-other">{asking.q.other}</button>{/if}
    <button class={asking.q?.danger ? 'btn danger' : 'btn primary'} form="confirm-form" data-testid="confirm-ok">{asking.q?.confirm ?? ''}</button>
  {/snippet}
</Dialog>

<style>
  .text {
    margin: 0;
    white-space: pre-line;
  }
  /* Each image apart: its name, then what its notes say. */
  .items {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .items li {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    overflow-wrap: anywhere;
  }
  .items p {
    margin: 4px 0 0;
  }
</style>
