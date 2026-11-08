<script lang="ts">
  import type { AuditEntry } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import { errorMessage, get } from '../lib/api.js';
  import { dateLocale, dateOnly, hasKey, t } from '../lib/i18n/index.svelte.js';
  import { up } from '../lib/router.svelte.js';
  import LoadFailed from '../components/LoadFailed.svelte';

  let entries = $state<AuditEntry[]>([]);
  let done = $state(false);
  let busy = $state(false);
  // Not read: said on the page (an empty list said "nothing happened", A3-WEB-01).
  let error = $state('');

  async function more() {
    busy = true;
    error = '';
    try {
      const last = entries.at(-1);
      const page = await get<AuditEntry[]>(`/api/audit?limit=100${last ? `&before=${last.id}` : ''}`);
      entries = [...entries, ...page];
      done = page.length < 100;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
  void more();

  // The date as everywhere ("28 Sep 2026"), the time to the second.
  const fmt = (iso: string) => `${dateOnly(iso)}, ${new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}`;
  const alarming = (a: string) => /failed|blocked|rejected|mismatch/.test(a);
  // In words (UIA-07, UIB-11: "auth.login" in both languages); an action without words yet shows its key.
  const label = (a: string) => (hasKey(`audit.action.${a}`) ? t(`audit.action.${a}` as never) : a);
  // Only the parts there are: a system entry ended in "| - |".
  const meta = (e: AuditEntry) => [fmt(e.at), e.username ?? t('audit.system'), e.ip].filter(Boolean).join(' | ');
  let query = $state('');
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => [label(e.action), e.action, e.target ?? '', e.username ?? '', e.ip ?? ''].some((x) => x.toLowerCase().includes(q))) : entries;
  });
</script>

<div class="page">
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/settings/security')}><Icon name="back" /></button>
    <h1>{t('settings.audit')}</h1>
  </header>
  {#if error && !entries.length}
    <LoadFailed message={error} onretry={more} />
  {:else}
  <div class="search">
    <Icon name="search" />
    <input type="search" bind:value={query} placeholder={t('audit.filter')} aria-label={t('audit.filter')} autocapitalize="none" spellcheck="false" data-testid="audit-filter" />
  </div>
  <div class="list audit">
    {#each shown as e (e.id)}
      <div class="list-item" data-testid="audit-entry">
        <div class="main">
          <div class="title" class:danger={alarming(e.action)} title={e.action}>{label(e.action)}{#if e.target}<span class="target mono small">{e.target}</span>{/if}</div>
          <div class="sub">{meta(e)}</div>
        </div>
      </div>
    {/each}
  </div>
  {#if query.trim() && !shown.length}<p class="empty">{t('audit.noMatch', { q: query.trim() })}</p>{/if}
  {#if error}<p class="alert error small" style:margin-top="12px">{error}</p>{/if}
  {#if !done}
    <button class="btn block" style:margin-top="12px" disabled={busy} onclick={more}>{error ? t('common.retry') : t('audit.more')}</button>
  {/if}
  {/if}
</div>

<style>
  .danger {
    color: var(--danger);
  }
  .target {
    margin-left: 8px;
    color: var(--text-dim);
  }
  .search {
    margin-bottom: 12px;
  }
  /* A wide screen: one line per entry, time and who beside what happened. */
  @media (min-width: 900px) {
    .audit .main {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: baseline;
      gap: 16px;
    }
    .audit .sub {
      grid-row: 1;
      grid-column: 2;
      white-space: nowrap;
    }
  }
</style>
