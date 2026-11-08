<script lang="ts">
  import { untrack } from 'svelte';
  import { journalSource, MAX_LOG_TARGETS, targetKey, type JournalUnit } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import LoadFailed from '../components/LoadFailed.svelte';
  import PageTitle from '../components/PageTitle.svelte';
  import { ApiFailure, del, errorMessage, get, post } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go, to, up } from '../lib/router.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';

  // A host's systemd services, to read their journals (journalctl -u) the
  // way container logs are read: one or several merged on the logs page.
  // Kept ones are also watched by the alert rules and read for the reports.

  let { hostId: hostProp }: { hostId: number } = $props();
  const hostId = untrack(() => hostProp);
  if (!data.loaded) inBackground(loadAll());
  const host = $derived(data.hosts.find((h) => h.id === hostId));
  const admin = $derived(session.state?.user?.role === 'admin');

  let units = $state<JournalUnit[] | null>(null);
  let kept = $state<{ id: number; unit: string }[]>([]);
  let error = $state('');
  // No systemd is how the host is, not a failure: said plainly, with its log files a tap away (UIA-14, UIB-10).
  let noSystemd = $state(false);
  async function load() {
    error = '';
    noSystemd = false;
    try {
      const r = await get<{ units: JournalUnit[]; kept: { id: number; unit: string }[] }>(`/api/hosts/${hostId}/journal/units`);
      units = r.units;
      kept = r.kept;
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'no_systemd') noSystemd = true;
      else error = errorMessage(err);
    }
  }
  inBackground(load());

  let query = $state('');
  let picked = $state<string[]>([]);
  // Watched ones that systemd no longer lists (a removed unit, its entries
  // kept) stay here, so they can be unwatched (AUDIT2 J-06).
  const all = $derived([...(units ?? []), ...kept.filter((k) => !(units ?? []).some((u) => u.unit === k.unit)).map((k) => ({ unit: k.unit, load: 'not-found', active: 'inactive', sub: 'not listed', description: '' }))]);
  // Failed ones first: those are what one comes here for.
  const shown = $derived(
    all
      .filter((u) => !query.trim() || `${u.unit} ${u.description}`.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => Number(b.active === 'failed') - Number(a.active === 'failed') || a.unit.localeCompare(b.unit)),
  );
  const toggle = (unit: string) => (picked = picked.includes(unit) ? picked.filter((u) => u !== unit) : [...picked, unit]);
  // All or none of those the search shows (the shared PickList's All/None; these rows carry Keep too).
  function pickAll(on: boolean) {
    const units = shown.map((u) => u.unit);
    picked = on ? [...new Set([...picked, ...units])] : picked.filter((u) => !units.includes(u));
  }
  function show() {
    if (picked.length > MAX_LOG_TARGETS) return toast(t('containers.tooMany', { n: picked.length, max: MAX_LOG_TARGETS }), 'error');
    go(to('/logs', { t: picked.map((u) => targetKey({ hostId, container: '', file: journalSource(u) })).join(',') }));
  }

  let busy = $state(false);
  async function keep(unit: string) {
    busy = true;
    try {
      const k = kept.find((x) => x.unit === unit);
      if (k) {
        await del(`/api/docker/${hostId}/logfiles/${k.id}`);
        kept = kept.filter((x) => x.id !== k.id);
        toast(t('journal.unkept', { unit }));
      } else {
        const f = await post<{ id: number }>(`/api/docker/${hostId}/logfiles`, { container: '', path: journalSource(unit) });
        kept = [...kept, { id: f.id, unit }];
        toast(t('journal.keptNow', { unit }));
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

<div class="page with-fab">
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/hosts')}><Icon name="back" /></button>
    <PageTitle title={t('journal.title')} sub={host?.name ?? ''} tip={t('help.journal')} />
  </header>

  {#if noSystemd}
    <div class="card stack" data-testid="no-systemd">
      <p>{t('journal.noSystemd')}</p>
      <button class="btn" onclick={() => go(to(`/files/${hostId}`, { p: '/var/log' }))} data-testid="no-systemd-logs">{t('journal.openVarLog')}</button>
    </div>
  {:else if error}
    <LoadFailed message={error} onretry={load} />
  {:else if !units}
    <p class="empty">{t('common.loading')}</p>
  {:else}
    <section class="stack" data-content>
      <div class="tools">
        <input type="search" bind:value={query} placeholder={t('journal.search')} aria-label={t('journal.search')} data-testid="journal-search" />
        {#if all.length > 3}
          <button type="button" class="btn small" disabled={!shown.length} onclick={() => pickAll(true)} data-testid="journal-all">{t('pick.all')}</button>
          <button type="button" class="btn small" disabled={!picked.length} onclick={() => pickAll(false)} data-testid="journal-none">{t('pick.none')}</button>
        {/if}
      </div>
      {#if !shown.length}
        <p class="empty">{units.length ? t('journal.noMatch') : t('journal.none')}</p>
      {/if}
      <div class="list" data-testid="journal-units">
        {#each shown as u (u.unit)}
          {@const isKept = kept.some((k) => k.unit === u.unit)}
          <div class="list-item" data-testid="journal-unit">
            <label class="pick">
              <input type="checkbox" checked={picked.includes(u.unit)} onchange={() => toggle(u.unit)} aria-label={t('journal.pick', { unit: u.unit })} />
              <span class="main">
                <!-- The unit's name whole on its line, cut with "..." rather than broken at a hyphen (UIA-09). -->
                <span class="title unit-title"><span class="unit" title={u.unit}>{u.unit}</span>{#if u.active === 'failed'}<span class="badge bad">{t('journal.failed')}</span>{/if}</span>
                <span class="sub whole">{u.description || u.unit} | {u.sub === u.active ? u.active : `${u.active}, ${u.sub}`}</span>
              </span>
            </label>
            {#if admin}
              <button class="btn small" aria-pressed={isKept} disabled={busy} title={t('journal.keepHelp')} onclick={() => keep(u.unit)} data-testid="journal-keep">{isKept ? t('journal.kept') : t('journal.keep')}</button>
            {:else if isKept}
              <span class="badge">{t('journal.kept')}</span>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

{#if picked.length}
  <!-- The chosen ones in one timeline, like several containers' logs. -->
  <button class="fab extended" onclick={show} data-testid="journal-show"><Icon name="layers" size={18} /> {t('journal.show', { n: picked.length })}</button>
{/if}

<style>
  .tools {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .tools input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .tools .btn {
    flex: none;
    width: auto;
  }
  .list-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pick {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
  }
  .main {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  /* Long unit names and descriptions wrap on a phone: the state badge and the description stay whole. */
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 6px;
    overflow-wrap: anywhere;
    white-space: normal;
    overflow: visible;
    font-weight: 600;
  }
  /* Whole, not cut after two lines: shown past them it ran over the next service (report e458b7). */
  .sub {
    overflow-wrap: anywhere;
  }
  .list-item :global(.btn) {
    width: auto;
    flex: none;
  }
  /* The round add button, widened to say what it does. */
  .fab.extended {
    width: auto;
    padding: 0 18px;
    gap: 8px;
    font: 600 0.95rem var(--font);
  }
  .fab.extended :global(svg) {
    width: 18px;
    height: 18px;
  }
  .badge.bad {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .unit-title {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .unit {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
