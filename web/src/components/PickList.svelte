<script lang="ts" module>
  export interface PickItem<I> {
    id: I;
    title: string;
    sub?: string;
    testid?: string;
  }
</script>

<script lang="ts" generics="Id extends string | number">
  import { untrack } from 'svelte';
  import { t } from '../lib/i18n/index.svelte.js';

  // Ticking a few out of many (hosts, apps): the ticked ones first, then the
  // first few of the rest and "Show all"; a search box and All/None once the
  // list is long. The same everywhere a long list is picked from.

  let {
    items,
    chosen,
    onchange,
    label,
  }: {
    items: PickItem<Id>[];
    chosen: Id[];
    onchange: (next: Id[]) => void;
    /** For screen readers: what is picked. */
    label: string;
  } = $props();

  const LONG = 8;
  /** Unticked ones shown before "Show all". */
  const FEW = 5;
  let query = $state('');
  let all = $state(false);
  const long = $derived(items.length > LONG);
  const on = $derived(new Set(chosen));
  const q = $derived(query.trim().toLowerCase());
  const matching = $derived(q ? items.filter((i) => `${i.title} ${i.sub ?? ''}`.toLowerCase().includes(q)) : items);
  // The ticked ones stay where they are while you tick: the order is fixed
  // when the list opens or the search changes, not on every tick.
  let firstOn = $state<Set<Id>>(new Set());
  $effect(() => {
    void q;
    firstOn = new Set(untrack(() => chosen));
  });
  const ordered = $derived([...matching.filter((i) => firstOn.has(i.id)), ...matching.filter((i) => !firstOn.has(i.id))]);
  const shown = $derived(!long || all || q ? ordered : ordered.slice(0, firstOn.size + FEW));
  const hidden = $derived(ordered.length - shown.length);

  function toggle(id: Id, yes: boolean) {
    onchange(yes ? [...chosen.filter((x) => x !== id), id] : chosen.filter((x) => x !== id));
  }
  function setAll(yes: boolean) {
    const ids = matching.map((i) => i.id);
    onchange(yes ? [...new Set([...chosen, ...ids])] : chosen.filter((x) => !ids.includes(x)));
  }
</script>

<div class="picklist" role="group" aria-label={label} data-testid="picklist">
  {#if long}
    <div class="tools">
      <input type="search" bind:value={query} placeholder={t('pick.search')} aria-label={t('pick.search')} autocapitalize="none" spellcheck="false" data-testid="pick-search" />
      <button type="button" class="btn small" onclick={() => setAll(true)} data-testid="pick-all">{t('pick.all')}</button>
      <button type="button" class="btn small" onclick={() => setAll(false)} data-testid="pick-none">{t('pick.none')}</button>
    </div>
    <!-- Only what is on the list: an id chosen once and gone from it since is no choice to see (report 80f9de). -->
    <p class="dim small">{t('pick.count', { n: items.filter((x) => on.has(x.id)).length, total: items.length })}</p>
  {/if}
  <div class="list">
    {#each shown as i (i.id)}
      <label class="list-item check">
        <input type="checkbox" checked={on.has(i.id)} onchange={(e) => toggle(i.id, e.currentTarget.checked)} data-testid={i.testid ?? 'pick-item'} />
        <span class="main"><span class="title">{i.title}</span>{#if i.sub}<span class="sub">{i.sub}</span>{/if}</span>
      </label>
    {/each}
    {#if !shown.length}<p class="empty small">{t('pick.nothing')}</p>{/if}
  </div>
  {#if hidden > 0}
    <button type="button" class="btn small more" onclick={() => (all = true)} data-testid="pick-more">{t('pick.more', { n: hidden })}</button>
  {/if}
</div>

<style>
  .picklist {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tools {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .tools input {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* The buttons their own width; the search box takes the rest. */
  .tools .btn {
    flex: none;
    width: auto;
  }
  p {
    margin: 0;
  }
  .more {
    align-self: flex-start;
  }
</style>
