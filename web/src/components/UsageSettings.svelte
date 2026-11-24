<script lang="ts">
  import { untrack } from 'svelte';
  import type { UsageRow, UsageSummary } from '@burrow/shared';
  import LoadFailed from './LoadFailed.svelte';
  import { del, errorMessage, get, put } from '../lib/api.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { dateOnly, t } from '../lib/i18n/index.svelte.js';
  import { dropUsage, sendUsage, usageTurned } from '../lib/usage.js';

  // Settings -> Usage: which pages and dialogs were opened how often, and which never, on this
  // Burrow only (server/src/usage.ts). For deciding what is used and what is dead weight.

  let days = $state(30);
  let summary = $state<UsageSummary | null>(null);
  let failed = $state('');
  // Turning counting on or off that did not save: said beside it, the list kept.
  let saveFailed = $state('');
  let busy = $state(false);
  // Only the newest read is shown: a slower answer for another period came after it (audit 2026-11-23).
  let asked = 0;

  async function load(send = true) {
    const mine = ++asked;
    failed = '';
    try {
      // What this browser counted since its last send, in the numbers shown.
      if (send) await sendUsage();
      const s = await get<UsageSummary>(`/api/usage?days=${days}`);
      if (mine === asked) summary = s;
    } catch (err) {
      if (mine !== asked) return;
      summary = null;
      failed = errorMessage(err) || t('common.loadFailed');
    }
  }
  $effect(() => {
    void days;
    untrack(() => void load());
  });

  const used = $derived(summary?.rows.filter((r) => r.n > 0) ?? []);
  const unused = $derived(summary?.rows.filter((r) => r.n === 0) ?? []);
  const most = $derived(Math.max(1, ...used.map((r) => r.n)));
  const name = (r: UsageRow) => r.key.replace(/^(page|dialog):/, '');
  // A day as the server keeps it (YYYY-MM-DD): that day here, not the evening before west of UTC.
  const day = (d: string) => dateOnly(`${d}T12:00:00`);

  async function turn(box: HTMLInputElement) {
    const on = box.checked;
    busy = true;
    saveFailed = '';
    try {
      await put('/api/usage/settings', { on });
      usageTurned(on);
      await load();
    } catch (err) {
      // As it was: the change did not happen.
      box.checked = !on;
      saveFailed = errorMessage(err) || t('common.loadFailed');
    } finally {
      busy = false;
    }
  }

  async function clear() {
    if (!(await ask({ text: t('usage.clearConfirm'), confirm: t('usage.clear'), danger: true }))) return;
    busy = true;
    try {
      // What this browser counted, in before the clearing; what the confirmation (a step-up, the page
      // counted again) added while it was asked, dropped after it: cleared stays cleared.
      await sendUsage();
      await del('/api/usage');
      dropUsage();
      await load(false);
    } catch (err) {
      if (errorMessage(err)) failed = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="card stack" data-testid="usage">
  <p class="dim small">{t('usage.what')}</p>
  {#if failed}
    <LoadFailed inline message={failed} onretry={() => load()} />
  {:else if !summary}
    <p class="dim small" data-testid="usage-loading">{t('common.loading')}</p>
  {:else}
    <label class="check"><input type="checkbox" checked={summary.on} disabled={busy} onchange={(e) => void turn(e.currentTarget)} data-testid="usage-on" /> {t('usage.on')}</label>
    {#if saveFailed}<p class="alert error small" role="alert" data-testid="usage-save-failed">{t('usage.notSaved', { error: saveFailed })}</p>{/if}
    <label class="field">
      <span>{t('usage.period')}</span>
      <select value={String(days)} onchange={(e) => (days = Number(e.currentTarget.value))} data-testid="usage-days">
        {#each [7, 30, 90, 180] as n (n)}<option value={String(n)}>{t('usage.days', { n })}</option>{/each}
      </select>
    </label>
    <p class="small" data-testid="usage-since">{summary.since ? t('usage.since', { date: day(summary.since) }) : t('usage.nothing')}</p>
    {#if used.length}
      <h3>{t('usage.used')}</h3>
      <ul class="rows" data-testid="usage-used">
        {#each used as r (r.key)}
          <li data-testid="usage-row">
            <span class="name"><span class="mono">{name(r)}</span> <span class="dim small">{r.key.startsWith('page:') ? t('usage.page') : t('usage.dialog')}</span></span>
            <span class="n">{r.n}</span>
            <span class="bar" aria-hidden="true"><span style:width="{(r.n / most) * 100}%"></span></span>
            <span class="dim small last">{r.last ? day(r.last) : ''}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <h3>{t('usage.unused', { n: unused.length })}</h3>
    <p class="dim small">{t('usage.unusedHelp')}</p>
    {#if unused.length}
      <ul class="unused" data-testid="usage-unused">
        {#each unused as r (r.key)}<li class="mono small">{name(r)}</li>{/each}
      </ul>
    {/if}
    <button class="btn danger" disabled={busy || !summary.since} onclick={clear} data-testid="usage-clear">{t('usage.clear')}</button>
  {/if}
</div>

<style>
  h3 {
    margin: 8px 0 0;
  }
  .rows,
  .unused {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* Name, count, a bar to the most used, the last day: one line each, the numbers in a column. */
  .rows li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(40px, 120px) auto;
    align-items: center;
    gap: 4px 10px;
    padding: 4px 0;
  }
  .rows li + li {
    border-top: 1px solid var(--border);
  }
  .name {
    overflow-wrap: anywhere;
  }
  .n {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-hover);
  }
  .bar > span {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--accent);
  }
  .last {
    min-width: 6em;
    text-align: right;
  }
  /* A phone: the bar and the day under the name. */
  @media (max-width: 520px) {
    .rows li {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .bar {
      grid-column: 1;
    }
  }
  .unused {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
</style>
