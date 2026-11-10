<script lang="ts">
  import { untrack } from 'svelte';
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import type { ContainerInfo, ContainerStats, DownStack, StatsHistory } from '@burrow/shared';
  import { MAX_LOG_TARGETS } from '@burrow/shared';
  import CheckProgress from '../components/CheckProgress.svelte';
  import ChangelogDialog from '../components/ChangelogDialog.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import LoadFailed from '../components/LoadFailed.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import SectionTabs from '../components/SectionTabs.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import { data, dataLoad, ensureLoaded } from '../lib/data.svelte.js';
  import { DockerWatch, formatBytesShort, since } from '../lib/docker.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { healthLabel } from '../lib/containers.js';
  import { go, to } from '../lib/router.svelte.js';
  import { errorMessage, get } from '../lib/api.js';
  import { activity } from '../lib/activity.svelte.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';
  import { checkOf, checkUpdates, loadUpdates, updateCount, updates } from '../lib/updates.svelte.js';
  import BulkDialog from '../components/BulkDialog.svelte';
  import type { BulkAction, BulkRow } from '../lib/bulk.js';
  import { notesLabel } from '../lib/notescount.js';
  import { footBar } from '../lib/footbar.js';
  import { CONTAINER_SORTS, readSort, sortGroups, sortRows, type ContainerSort, type SortKeys } from '../lib/containersort.js';

  // All containers of all Docker hosts, grouped by compose stack across
  // hosts, with state, health, restarts and live CPU/memory. Pick several
  // (or a whole stack) for one merged log timeline.

  interface Row {
    hostId: number;
    hostName: string;
    c: ContainerInfo;
    stats: ContainerStats | undefined;
    history: StatsHistory | undefined;
  }

  // The hosts not read: said on the page with Try again, not an empty page under the search (A3-WEB-01).
  ensureLoaded();
  const watch = new DockerWatch();
  $effect(() => () => watch.close());
  // Pulled down on a phone: every host read now.
  $effect(() => pullToRefresh(() => watch.refresh()));

  const dockerHosts = $derived(data.hosts.filter((h) => h.facts?.hasDocker));
  // Stacks brought down from Burrow: no containers, still here to bring up again (as Dockge lists them).
  let down = $state<DownStack[]>([]);
  // Not read: said with Try again; the stacks brought down vanished without a word, no way left to bring them up (audit 2026-11-09).
  let downError = $state('');
  const readDown = () => get<DownStack[]>('/api/docker/stacks/down').then((d) => ((down = d), (downError = '')), (err: unknown) => (downError = errorMessage(err)));
  $effect(() => void readDown());
  const downShown = $derived(
    down.filter((d) => (hostFilter === 'all' || d.hostId === hostFilter) && (stateFilter === 'all' || stateFilter === 'stopped') && (!query.trim() || `${d.project} ${d.hostName}`.toLowerCase().includes(query.trim().toLowerCase()))),
  );
  // One filter, a host or a state: two dropdowns did not fit a phone's line.
  let filter = $state<string>('all');
  const hostFilter = $derived(filter.startsWith('host:') ? Number(filter.slice(5)) : 'all');
  const stateFilter = $derived(filter.startsWith('state:') ? filter.slice(6) : 'all');
  let query = $state('');
  // The order (report d36ec8): by name, the busiest or largest first, or problems
  // first; kept on this device. A menu, not a second dropdown (no room on a phone).
  const SORT_KEY = 'burrow.containers.sort';
  let sortBy = $state<ContainerSort>(storedSort());
  function storedSort(): ContainerSort {
    try {
      return readSort(localStorage.getItem(SORT_KEY));
    } catch {
      return 'name';
    }
  }
  let sortMenu = $state(false);
  function setSort(s: ContainerSort) {
    sortBy = s;
    resort++;
    sortMenu = false;
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      // Not kept: this order until the page is left.
    }
  }
  const TROUBLE = { bad: 0, warn: 1, ok: 2, off: 3 } as const;
  const sortKeys = (r: Row): SortKeys => {
    const up = r.c.state === 'running' && r.stats;
    return { name: r.c.name, cpu: up ? up.cpu : null, mem: up && up.memKnown !== false ? up.memBytes : null, trouble: TROUBLE[tone(r.c)] };
  };
  // The logs page reads at most this many at once.
  const MAX_LOGS = MAX_LOG_TARGETS;
  let selecting = $state(false);
  let picked = $state<Set<string>>(new Set());
  let now = $state(Date.now());
  // Checking: started here, or still going on the server (started before
  // this page was opened again, from another device, or by the window).
  let checkingHere = $state(false);
  const checking = $derived(checkingHere || activity.check !== null);
  inBackground(loadUpdates());

  // The update button's menu: check now, or show what has an update.
  let updMenu = $state(false);
  function showUpdates() {
    updMenu = false;
    filter = 'state:update';
  }
  async function checkNow() {
    updMenu = false;
    checkingHere = true;
    try {
      await checkUpdates(dockerHosts.map((h) => h.id));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      checkingHere = false;
    }
  }
  // A check that ends while this page is open: its results.
  let wasChecking = false;
  $effect(() => {
    if (wasChecking && !checking) inBackground(loadUpdates());
    wasChecking = checking;
  });
  const hasUpdate = (r: Row) => checkOf(r.hostId, r.c.image)?.status === 'update';

  $effect(() => {
    watch.watch(dockerHosts.map((h) => h.id));
  });
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 5000);
    return () => clearInterval(timer);
  });

  // The picked containers, also those the filters hide now, for the actions below the list.
  let bulk = $state<BulkAction | null>(null);
  // A phone's width: the actions in a menu of their own (in the bar they wrapped).
  const narrowQuery = typeof window !== 'undefined' ? matchMedia('(max-width: 599px)') : null;
  const narrow = $state({ on: narrowQuery?.matches ?? false });
  $effect(() => {
    if (!narrowQuery) return;
    const on = () => (narrow.on = narrowQuery.matches);
    narrowQuery.addEventListener('change', on);
    return () => narrowQuery.removeEventListener('change', on);
  });
  let bulkMenu = $state(false);
  const doBulk = (a: BulkAction) => ((bulkMenu = false), (bulk = a));
  const pickedRows = $derived.by((): BulkRow[] => {
    const out: BulkRow[] = [];
    for (const h of Object.values(watch.hosts))
      for (const c of h.containers) {
        if (!picked.has(`${h.hostId}:${c.name}`)) continue;
        out.push({ hostId: h.hostId, hostName: h.hostName, name: c.name, running: c.state === 'running', self: !!c.self, project: c.project, service: c.service, image: c.image, hasUpdate: checkOf(h.hostId, c.image)?.status === 'update' });
      }
    return out;
  });

  // What is new in several images at once (reports 26c0fa, bd2d76): every
  // update that says where its notes are, or those of the picked rows.
  let notesFor = $state<{ hostId: number; image: string }[] | null>(null);
  const withNotes = (list: { hostId: number; image: string }[]) => {
    const seen = new Set<string>();
    return list.filter((x) => checkOf(x.hostId, x.image)?.status === 'update' && checkOf(x.hostId, x.image)?.source && !seen.has(`${x.hostId} ${x.image}`) && !!seen.add(`${x.hostId} ${x.image}`)).map((x) => ({ hostId: x.hostId, image: x.image }));
  };
  const allNotes = $derived(withNotes(updates.overview?.checks ?? []));
  const pickedNotes = $derived(withNotes(pickedRows));
  // Of how many updates, when some have no notes (report 2fe705).
  const updatesIn = (list: { hostId: number; image: string }[]) => new Set(list.filter((x) => checkOf(x.hostId, x.image)?.status === 'update').map((x) => `${x.hostId} ${x.image}`)).size;
  const allLabel = $derived(notesLabel(allNotes.length, updatesIn(updates.overview?.checks ?? [])));
  const pickedLabel = $derived(notesLabel(pickedNotes.length, updatesIn(pickedRows)));
  const readNotes = (list: { hostId: number; image: string }[]) => ((updMenu = false), (bulkMenu = false), (notesFor = list));

  const rows = $derived.by(() => {
    const out: Row[] = [];
    for (const h of Object.values(watch.hosts)) {
      if (hostFilter !== 'all' && h.hostId !== hostFilter) continue;
      for (const c of h.containers) out.push({ hostId: h.hostId, hostName: h.hostName, c, stats: h.stats[c.id], history: h.history[c.id] });
    }
    const q = query.trim().toLowerCase();
    return out.filter(
      (r) =>
        (!q || `${r.c.name} ${r.c.image} ${r.c.project ?? ''} ${r.hostName}`.toLowerCase().includes(q)) &&
        (stateFilter === 'all' ||
          (stateFilter === 'running' ? r.c.state === 'running' : stateFilter === 'stopped' ? tone(r.c) === 'off' : stateFilter === 'update' ? hasUpdate(r) : tone(r.c) === 'bad' || tone(r.c) === 'warn')),
    );
  });

  /** Stacks (compose projects) across hosts first, then loose containers per host. */
  function groupsOf(rs: Row[]) {
    const m = new Map<string, { key: string; title: string; stack: string | null; rows: Row[] }>();
    for (const r of rs) {
      const k = r.c.project ? `s:${r.c.project}` : `h:${r.hostName}`;
      if (!m.has(k)) m.set(k, { key: k, title: r.c.project ?? t('containers.loose', { host: r.hostName }), stack: r.c.project, rows: [] });
      m.get(k)!.rows.push(r);
    }
    return [...m.values()];
  }
  // The order held while the numbers move (audit 2026-11-09): sorted by CPU or memory, the rows
  // moved under a finger with every update. Sorted again when an order is chosen, a container
  // comes or goes, and every 30 s.
  let resort = $state(0);
  $effect(() => {
    const id = setInterval(() => resort++, 30_000);
    return () => clearInterval(id);
  });
  const rowSet = $derived(rows.map((r) => `${r.hostId}:${r.c.name}`).sort().join('\n'));
  const held = $derived.by(() => {
    void resort;
    void rowSet;
    const by = sortBy;
    return untrack(() => {
      const gs = groupsOf(rows).map((g) => ({ ...g, rows: sortRows(g.rows, by, sortKeys) }));
      const ordered = sortGroups(gs, by, { rows: (g) => g.rows, keys: sortKeys, title: (g) => g.title, loose: (g) => !g.stack });
      return { groups: new Map(ordered.map((g, i) => [g.key, i])), rows: new Map(ordered.flatMap((g) => g.rows).map((r, i) => [`${r.hostId}:${r.c.name}`, i])) };
    });
  });
  const groups = $derived.by(() => {
    const at = (m: Map<string, number>, k: string) => m.get(k) ?? Number.MAX_SAFE_INTEGER;
    return groupsOf(rows)
      .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => at(held.rows, `${a.hostId}:${a.c.name}`) - at(held.rows, `${b.hostId}:${b.c.name}`)) }))
      .sort((a, b) => at(held.groups, a.key) - at(held.groups, b.key));
  });

  // Stacks folded away, kept on this device: sixty containers of one stack
  // made a very long page on a phone (report df6153). Searching or showing
  // only some states opens them all, so what is looked for is never folded.
  const FOLD_KEY = 'burrow.containers.folded';
  let folded = $state<Set<string>>(readFolded());
  function readFolded(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }
  function toggleFold(key: string) {
    const n = new Set(folded);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    keepFolded(n);
  }
  // All at once (report 44c246): folds every stack, or opens them all when all are folded.
  const allFolded = $derived(groups.length > 0 && groups.every((g) => folded.has(g.key)));
  const foldAll = () => keepFolded(allFolded ? new Set() : new Set(groups.map((g) => g.key)));
  function keepFolded(n: Set<string>) {
    folded = n;
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...n]));
    } catch {
      // Not kept: folded until the page is left.
    }
  }
  const looking = $derived(query.trim() !== '' || stateFilter !== 'all');
  const isFolded = (key: string) => !looking && folded.has(key);
  const troubled = (rs: Row[]) => rs.filter((r) => tone(r.c) === 'bad' || tone(r.c) === 'warn').length;

  const errors = $derived(Object.values(watch.hosts).filter((h) => h.error));
  const waiting = $derived(dockerHosts.length > 0 && Object.keys(watch.hosts).length === 0);
  // Hosts not read yet while others are: named, and the counts said to be so far (UIB-04: one host in, the page read as complete).
  const pending = $derived(waiting ? [] : dockerHosts.filter((h) => !watch.hosts[h.id] && (hostFilter === 'all' || hostFilter === h.id)));

  const restartsText = (n: number) => (n === 1 ? t('containers.restartsOne') : t('containers.restarts', { n }));
  const key = (r: Row) => `${r.hostId}:${r.c.name}`;
  const hostsOf = (rs: Row[]) => [...new Set(rs.map((r) => r.hostName))].sort((a, b) => a.localeCompare(b));

  function tone(c: ContainerInfo): 'ok' | 'warn' | 'bad' | 'off' {
    if (c.state === 'running') return c.health === 'unhealthy' ? 'bad' : c.health === 'starting' ? 'warn' : 'ok';
    if (c.state === 'restarting' || c.state === 'paused') return 'warn';
    if (c.state === 'exited' && c.exitCode === 0) return 'off';
    return c.state === 'created' ? 'off' : 'bad';
  }

  function stateText(c: ContainerInfo): string {
    if (c.state === 'running') return t('containers.up', { for: since(c.startedAt, now) });
    // Its end not known: the code alone, not "exited (137)  ago" (A3-WEB-25).
    if (c.state === 'exited') return (c.finishedAt ? t('containers.exited', { code: c.exitCode, ago: since(c.finishedAt, now) }) : t('containers.exitedCode', { code: c.exitCode })) + (c.oomKilled ? ' | OOM' : '');
    return t(`containers.state.${c.state}`);
  }

  function logs(rs: Row[]) {
    // More than one view merges: said here, not refused by the server there (AUDIT2 PAGE-05).
    if (rs.length > MAX_LOG_TARGETS) return toast(t('containers.tooMany', { n: rs.length, max: MAX_LOG_TARGETS }), 'error');
    go(to('/logs', { t: rs.map(key).join(',') }));
  }

  function open(r: Row) {
    if (selecting) {
      const n = new Set(picked);
      if (n.has(key(r))) n.delete(key(r));
      else n.add(key(r));
      picked = n;
      return;
    }
    go(`/containers/${r.hostId}/${encodeURIComponent(r.c.name)}`);
  }
  const admin = $derived(session.state?.user?.role === 'admin');
</script>

<div class="page" class:with-bar={selecting && picked.size > 0}>
  <header class="topbar">
    <h1>{t('containers.title')} <HelpTip text={t('help.containers')} /></h1>
    <!-- The image check: an icon here (when it last ran in its label), a line below only when there is news. -->
    {#if dockerHosts.length && admin}
      {@const checked = updates.overview?.lastCheckAt ? t('updates.checked', { ago: since(updates.overview.lastCheckAt, now) }) : t('updates.neverChecked')}
      <button class="icon-btn labeled" class:spin={checking} aria-haspopup="dialog" aria-label="{t('updates.menuTitle')} ({checked}){updateCount() ? `, ${t('updates.count', { n: updateCount() })}` : ''}" title="{t('updates.menuTitle')} ({checked})" onclick={() => (updMenu = true)} data-testid="updates-menu"
        ><Icon name="updates" /><span class="wide-only" aria-hidden="true">{t('updates.menuTitle')}</span>{#if updateCount()}<span class="upd-badge" title={t('updates.count', { n: updateCount() })} data-testid="updates-count">{updateCount()}</span>{/if}</button
      >
    {/if}
    <button class="btn small" aria-pressed={selecting} onclick={() => ((selecting = !selecting), (picked = new Set()))}>{selecting ? t('common.cancel') : t('containers.select')}</button>
  </header>
  <SectionTabs current="containers" />

  <div class="filters">
    <div class="search grow">
      <Icon name="search" />
      <input type="search" bind:value={query} placeholder={t('common.search')} aria-label={t('containers.search')} autocapitalize="none" spellcheck="false" data-testid="containers-search" />
    </div>
    <select bind:value={filter} aria-label={t('containers.filter')} data-testid="containers-filter">
      <option value="all">{t('containers.filterAll')}</option>
      <optgroup label={t('containers.stateFilter')}>
        <option value="state:running">{t('containers.stateRunning')}</option>
        <option value="state:attention">{t('containers.stateAttention')}</option>
        <option value="state:stopped">{t('containers.stateStopped')}</option>
        <option value="state:update">{t('containers.stateUpdate')}</option>
      </optgroup>
      {#if dockerHosts.length > 1}
        <optgroup label={t('containers.host')}>
          {#each dockerHosts as h (h.id)}<option value="host:{h.id}">{h.name}</option>{/each}
        </optgroup>
      {/if}
    </select>
    <!-- Not while picking: the pick-all box takes its place (on a 343 px phone the filter's word was cut off). -->
    {#if !selecting}
      <button class="icon-btn" aria-haspopup="dialog" aria-label={t('containers.sortLabel', { by: t(`containers.sort.${sortBy}`) })} title={t('containers.sortLabel', { by: t(`containers.sort.${sortBy}`) })} onclick={() => (sortMenu = true)} data-testid="containers-sort"
        ><Icon name="sort-az" /></button
      >
    {/if}
    {#if !looking && groups.length > 1}
      <button class="icon-btn" aria-pressed={allFolded} aria-label={allFolded ? t('containers.unfoldAll') : t('containers.foldAll')} title={allFolded ? t('containers.unfoldAll') : t('containers.foldAll')} onclick={foldAll} data-testid="stacks-fold-all"
        ><Icon name={allFolded ? 'chevron' : 'chevron-down'} /></button
      >
    {/if}
    {#if selecting}
      <!-- Everything the filters show, chosen in one tap (again: none of them). -->
      {@const all = rows.length > 0 && rows.every((r) => picked.has(key(r)))}
      <button class="icon-btn" aria-pressed={all} aria-label={t('containers.pickShown', { n: rows.length })} title={t('containers.pickShown', { n: rows.length })} onclick={() => (picked = all ? new Set([...picked].filter((k) => !rows.some((r) => key(r) === k))) : new Set([...picked, ...rows.map(key)]))} data-testid="pick-shown"><Icon name="check" /></button>
    {/if}
  </div>

  {#if !data.loaded && dataLoad.error}
    <LoadFailed message={dataLoad.error} onretry={ensureLoaded} />
  {:else if data.loaded && !dockerHosts.length}
    <p class="empty">{t('containers.noDocker')}</p>
  {:else if waiting}
    <Skeleton rows={6} />
  {/if}
  <!-- Updates found: a count on the check's icon and a pill on each stack; a line only while checking. -->
  {#if dockerHosts.length && checking}
    <div class="updline small" data-testid="updates-line"><CheckProgress /></div>
  {/if}
  <!-- Shown at once from the last visit; says so until the fresh snapshot is in. -->
  {#if Object.keys(watch.hosts).some((id) => !watch.fresh[Number(id)])}
    <p class="dim small stale" data-testid="containers-stale">{t('containers.refreshingLine')}</p>
  {/if}
  {#each pending as h (h.id)}<p class="dim small stale" data-content data-testid="host-pending">{t('containers.reading', { host: h.name })}</p>{/each}
  {#each errors as h (h.hostId)}<p class="alert error small">{h.hostName}: {h.error}</p>{/each}
  <!-- A host that stopped answering (hung, TCP still up): what shows is its last word, not now (OPS-W-04). -->
  {#each Object.entries(watch.silent) as [id, secs] (id)}<p class="alert warn small">{t('containers.silent', { host: watch.hosts[Number(id)]?.hostName ?? id, n: secs })}</p>{/each}

  <!-- On a very wide screen the stacks in two columns (one alone keeps a table's width). -->
  <div class:cols={groups.length > 1}>
  {#each groups as g (g.title)}
    <!-- Each stack in one column, a big one too, as the others (report 2018c4: across both, it broke the columns). -->
    <section class="group" data-testid="stack" data-content>
      <div class="ghead toolbar">
        {#if !looking}
          <button
            class="icon-btn fold"
            aria-expanded={!isFolded(g.key)}
            aria-label={t(isFolded(g.key) ? 'containers.unfold' : 'containers.fold', { name: g.title })}
            title={t(isFolded(g.key) ? 'containers.unfold' : 'containers.fold', { name: g.title })}
            onclick={() => toggleFold(g.key)}
            data-testid="stack-fold"><Icon name={isFolded(g.key) ? 'chevron' : 'chevron-down'} size={18} /></button
          >
        {/if}
        <div class="gmain">
          {#if g.stack}
            <!-- By host name: the order of whichever answered first changed between visits (UIB-22). -->
            {@const hs = [...new Set(g.rows.map((r) => r.hostId))].sort((a, b) => (g.rows.find((r) => r.hostId === a)?.hostName ?? '').localeCompare(g.rows.find((r) => r.hostId === b)?.hostName ?? ''))}
            <!-- A stack is managed per host: one link, or one per host it runs on. -->
            <h2>
              {#if hs.length === 1}
                <a href={`#/stacks/${hs[0]}/${encodeURIComponent(g.stack)}`} class="stacklink" data-testid="stack-link" onclick={(e) => (e.preventDefault(), go(`/stacks/${hs[0]}/${encodeURIComponent(g.stack!)}`))}>{g.title}<Icon name="chevron" size={16} /></a>
              {:else}
                {g.title}
              {/if}
              {#if g.rows.some(hasUpdate)}<span class="flag upd">{t('updates.available')}</span>{/if}
            </h2>
            {#if hs.length > 1}
              <span class="hostlinks small">
                {#each hs as hid (hid)}
                  <a href={`#/stacks/${hid}/${encodeURIComponent(g.stack)}`} class="stacklink" data-testid="stack-link" onclick={(e) => (e.preventDefault(), go(`/stacks/${hid}/${encodeURIComponent(g.stack!)}`))}
                    >{t('containers.stackOn', { host: g.rows.find((r) => r.hostId === hid)?.hostName ?? '' })}<Icon name="chevron" size={14} /></a
                  >
                {/each}
              </span>
            {/if}
          {:else}
            <h2>{g.title}</h2>
          {/if}
          <span class="dim small">
            {t('containers.running', { n: g.rows.filter((r) => r.c.state === 'running').length, total: g.rows.length })}{#if pending.length}<span data-testid="stack-partial">{` ${t('containers.soFar')}`}</span>{/if}
            {#if g.stack}| {hostsOf(g.rows).join(' | ')}{/if}
            <!-- Folded: what needs a look is still said. -->
            {#if isFolded(g.key) && troubled(g.rows)}<span class="badt" data-testid="stack-troubled">| {t('containers.troubled', { n: troubled(g.rows) })}</span>{/if}
          </span>
        </div>
        {#if selecting}
          <!-- This stack only, all or none (report 335a38). -->
          {@const allG = g.rows.every((r) => picked.has(key(r)))}
          <button class="btn small" aria-pressed={allG} aria-label={t(allG ? 'containers.pickStackNone' : 'containers.pickStackAll', { name: g.title, n: g.rows.length })} onclick={() => (picked = allG ? new Set([...picked].filter((k) => !g.rows.some((r) => key(r) === k))) : new Set([...picked, ...g.rows.map(key)]))} data-testid="pick-stack">{allG ? t('containers.pickNone') : t('containers.pickAll')}</button>
        {:else}
          <button class="btn small" onclick={() => logs(g.rows)} data-testid="stack-logs">{t('containers.logs')}</button>
        {/if}
      </div>
      <div class="list ctable" class:selecting class:hidden={isFolded(g.key)}>
        <!-- Column names, on a wide screen where the rows are a table. -->
        <div class="chead" aria-hidden="true">
          {#if selecting}<span></span>{/if}<span></span><span>{t('containers.colName')}</span><span>{t('containers.colState')}</span><span class="r">{t('containers.colCpu')}</span><span class="r">{t('containers.colMem')}</span><span>{t('containers.colTrend')}</span><span>{t('containers.colTrendMem')}</span><span></span>
        </div>
        {#each g.rows as r (key(r))}
          <!-- Picking: the row itself is the toggle (aria-pressed); the box is
               only a picture of that, not a second control inside it. -->
          <button class="list-item crow" class:picked={picked.has(key(r))} aria-pressed={selecting ? picked.has(key(r)) : undefined} onclick={() => open(r)} data-testid="container-row">
            {#if selecting}<span class="pickbox" class:on={picked.has(key(r))} aria-hidden="true">{#if picked.has(key(r))}<Icon name="check" size={14} />{/if}</span>{/if}
            <span class="dot {tone(r.c)}" aria-hidden="true"></span>
            <!-- With a badge (its host): wraps rather than cutting the badge off. -->
            <span class="title c-name" class:wrap={g.stack && hostsOf(g.rows).length > 1} title={r.c.name}><span class="nowrap">{r.c.name}</span> {#if g.stack && hostsOf(g.rows).length > 1}<span class="host">{r.hostName}</span>{/if}</span>
            <span class="sub c-state" class:warnt={tone(r.c) === 'warn'} class:badt={tone(r.c) === 'bad'}>
              {[stateText(r.c), r.c.health ? healthLabel(r.c.health) : null, r.c.restarts ? restartsText(r.c.restarts) : null].filter(Boolean).join(' | ')}
            </span>
            {#if r.stats}
              <span class="num c-cpu">{r.stats.cpu.toFixed(1)}%</span>
              <span class="num c-mem" title={r.stats.memKnown === false ? t('containers.memUnknown') : undefined}>{r.stats.memKnown === false ? '-' : formatBytesShort(r.stats.memBytes)}</span>
              <span class="c-spark"><Sparkline values={r.history?.cpu ?? []} at={r.history?.at} label={t('containers.cpuOf', { name: r.c.name })} format={(v) => `${v.toFixed(1)}%`} /></span>
              <!-- Memory beside CPU, the kept hour first (report 428102). -->
              <span class="c-spark" data-testid="mem-spark"><Sparkline values={r.history?.mem ?? []} at={r.history?.at} label={t('containers.memOf', { name: r.c.name })} format={formatBytesShort} /></span>
            {/if}
            <span class="c-upd">{#if hasUpdate(r)}<span class="flag upd" data-testid="row-update">{t('updates.available')}</span>{/if}</span>
          </button>
        {/each}
      </div>
    </section>
  {/each}
  </div>
  {#if downError}<LoadFailed inline message={downError} onretry={readDown} />{/if}
  {#if downShown.length}
    <section class="group" data-testid="stacks-down">
      <div class="ghead toolbar">
        <div class="gmain">
          <h2>{t('containers.downTitle')}</h2>
          <span class="dim small">{t('containers.downWhat')}</span>
        </div>
      </div>
      <div class="list">
        {#each downShown as d (`${d.hostId}/${d.project}`)}
          <a class="list-item" href={`#/stacks/${d.hostId}/${encodeURIComponent(d.project)}`} onclick={(e) => (e.preventDefault(), go(`/stacks/${d.hostId}/${encodeURIComponent(d.project)}`))} data-testid="stack-down">
            <span class="dot"></span>
            <span class="grow"><strong>{d.project}</strong> <span class="dim small">{t('containers.downSince', { host: d.hostName, ago: since(d.downAt, now) })}</span></span>
            <Icon name="chevron" size={16} />
          </a>
        {/each}
      </div>
    </section>
  {/if}
</div>

{#if selecting && picked.size}
  <!-- What to do with the picked ones: their logs together, or (an admin) an action on each. -->
  <div class="bulkbar" role="toolbar" aria-label={t('bulk.actions')} data-testid="bulk-bar" use:footBar>
    <button class="btn primary" disabled={picked.size > MAX_LOGS} onclick={() => go(to('/logs', { t: [...picked].join(',') }))} data-testid="picked-logs"
      ><Icon name="file" size={16} />{picked.size > MAX_LOGS ? t('containers.tooMany', { n: picked.size, max: MAX_LOGS }) : t('containers.logsOf', { n: picked.size })}</button
    >
    {#if admin}
      {#if narrow.on}
        <button class="btn" onclick={() => (bulkMenu = true)} data-testid="bulk-more"><Icon name="more" size={16} />{t('bulk.more')}</button>
      {:else}
        {@render bulkActions()}
      {/if}
    {/if}
  </div>
{/if}
{#snippet bulkActions()}
  <button class="btn" onclick={() => doBulk('restart')} data-testid="bulk-restart"><Icon name="reload" size={16} />{t('bulk.do.restart')}</button>
  <button class="btn" onclick={() => doBulk('stop')} data-testid="bulk-stop"><Icon name="stop" size={16} />{t('bulk.do.stop')}</button>
  <button class="btn" onclick={() => doBulk('start')} data-testid="bulk-start"><Icon name="play" size={16} />{t('bulk.do.start')}</button>
  {#if pickedRows.some((r) => r.hasUpdate)}<button class="btn" onclick={() => doBulk('update')} data-testid="bulk-update"><Icon name="download" size={16} />{t('bulk.do.update')}</button>{/if}
  {#if pickedNotes.length}<button class="btn" onclick={() => readNotes(pickedNotes)} data-testid="bulk-whats-new"><Icon name="info" size={16} />{t(pickedLabel.key, { n: pickedLabel.n, total: pickedLabel.total })}</button>{/if}
{/snippet}
{#if narrow.on}
  <Dialog tour="bulk-menu" menu bind:open={bulkMenu} title={t('bulk.actions')}>
    <div class="stack">{@render bulkActions()}</div>
  </Dialog>
{/if}
<!-- Done: the hosts read again at once, so the list (and the next action) sees what changed. -->
<BulkDialog action={bulk} rows={pickedRows} onclose={() => (bulk = null)} ondone={() => inBackground(watch.refresh())} refresh={() => watch.refresh()} />

<Dialog tour="updates-menu" menu bind:open={updMenu} title={t('updates.menuTitle')}>
  <div class="stack" data-testid="updates-menu-items">
    <p class="dim small">{updates.overview?.lastCheckAt ? t('updates.lastChecked', { ago: since(updates.overview.lastCheckAt, now) }) : t('updates.neverChecked')}</p>
    <button class="btn" disabled={checking} onclick={checkNow} data-testid="check-updates"><Icon name="reload" size={18} /> {t('updates.checkImages')}</button>
    <button class="btn" disabled={!updateCount()} onclick={showUpdates} data-testid="show-updates"><Icon name="updates" size={18} /> {t('updates.showUpdates', { n: updateCount() })}</button>
    {#if allNotes.length}<button class="btn" onclick={() => readNotes(allNotes)} data-testid="updates-whats-new"><Icon name="info" size={18} /> {t(allLabel.key, { n: allLabel.n, total: allLabel.total })}</button>{/if}
  </div>
</Dialog>
<ChangelogDialog items={notesFor} onclose={() => (notesFor = null)} />

<Dialog tour="containers-sort" menu bind:open={sortMenu} title={t('containers.sortTitle')}>
  <div class="stack" data-testid="containers-sort-items">
    {#each CONTAINER_SORTS as s (s)}
      <button class="btn sortby" aria-pressed={sortBy === s} onclick={() => setSort(s)} data-testid="containers-sort-by">{t(`containers.sort.${s}`)}</button>
    {/each}
  </div>
</Dialog>

<style>
  /* The order in use, among the others in its menu. */
  .sortby[aria-pressed='true'] {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    font-weight: 600;
  }
  .hidden {
    display: none;
  }
  .filters {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  /* The search keeps room for its word beside the filter and the buttons
     (select mode on a 343 px phone cut "Zoeken" off); the filter gives way. */
  .filters .grow {
    flex: 1;
    min-width: 8.5em;
  }
  .filters select {
    width: auto;
    min-width: 0;
    max-width: 45%;
    flex: 0 1 auto;
  }
  .group {
    margin-bottom: 16px;
  }
  .pickbox {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 2px solid var(--border);
    border-radius: 4px;
  }
  .pickbox.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .gmain {
    flex: 1;
    min-width: 0;
  }
  .fold {
    width: 32px;
    height: 32px;
    margin-left: -6px;
  }
  .ghead h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
  .stale {
    margin: 0 0 8px;
  }
  .updline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin-bottom: 12px;
  }
  .spin :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin :global(svg) {
      animation: none;
    }
  }
  .icon-btn {
    position: relative;
  }
  .upd-badge {
    position: absolute;
    top: 0;
    right: 0;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-text);
    font: 700 0.65rem/16px var(--font);
  }
  .hostlinks {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
  }
  .hostlinks .stacklink {
    color: var(--accent);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .stacklink {
    color: inherit;
    text-decoration: none;
    margin-right: 8px;
  }
  .stacklink :global(svg) {
    vertical-align: -3px;
    color: var(--text-dim);
  }
  .flag {
    vertical-align: 2px;
  }
  /* A phone: two lines (name and update; state below) with the numbers at
     the right. A wide screen: a table, one column per kind of value. */
  .crow {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    grid-template-areas: 'dot name upd cpu' 'dot state state mem';
    column-gap: 10px;
    row-gap: 1px;
    align-items: center;
  }
  .ctable.selecting .crow {
    grid-template-columns: auto auto minmax(0, 1fr) auto auto;
    grid-template-areas: 'pick dot name upd cpu' 'pick dot state state mem';
  }
  .crow .pickbox {
    grid-area: pick;
  }
  .crow .dot {
    grid-area: dot;
  }
  .c-name {
    grid-area: name;
  }
  /* A name breaks between its parts, never inside one ("burrowtest-" / "worker" at most, not "burrowtest-wor" / "ker"). */
  .c-name.wrap {
    overflow-wrap: normal;
    word-break: normal;
  }
  .c-state {
    grid-area: state;
  }
  .c-cpu {
    grid-area: cpu;
    text-align: right;
  }
  .c-mem {
    grid-area: mem;
    text-align: right;
  }
  .c-spark {
    display: none;
  }
  .c-upd {
    grid-area: upd;
  }
  .chead {
    display: none;
  }
  .warnt {
    color: var(--warn);
  }
  .badt {
    color: var(--danger);
  }
  /* A tablet up (720 px) too: the phone's rows stretched over 760 px left the buttons far from the names (A3-WEB-15). */
  @media (min-width: 720px) {
    /* One table: the rows share its columns (subgrid), so the state is as wide as its longest words
       (up to 40 characters) and the update column only as wide as a flag in it; the name takes the
       rest. Each row its own grid of shares, "draait 14 dagen | gezond" broke over two lines beside
       an empty update column (report 6fa349). The name never under 16 characters (UIB-07). */
    /* The first and last columns "auto": a row's own padding is part of them in a subgrid (a fixed
       10 px for the dot left it against the name). */
    .ctable:not(.hidden) {
      --cols: minmax(16ch, 1fr) fit-content(40ch) 58px 64px 76px 76px auto;
      display: grid;
      grid-template-columns: auto var(--cols);
      column-gap: 14px;
    }
    .ctable.selecting:not(.hidden) {
      grid-template-columns: auto auto var(--cols);
    }
    .crow,
    .chead {
      grid-column: 1 / -1;
      grid-template-columns: subgrid;
      grid-template-areas: none;
      /* The table's gap (a phone's row has its own). */
      column-gap: normal;
      min-height: 44px;
      padding-top: 6px;
      padding-bottom: 6px;
    }
    .ctable.selecting .crow,
    .ctable.selecting .chead {
      grid-template-columns: subgrid;
      grid-template-areas: none;
    }
    .crow > *,
    .crow .pickbox,
    .crow .dot {
      grid-area: auto;
    }
    .c-spark {
      display: block;
    }
    .c-upd {
      text-align: right;
      /* The last column also on a stopped container's row, which has no numbers before it. */
      grid-column: -2 / -1;
    }
    .chead {
      display: grid;
      align-items: center;
      padding: 8px 14px;
      min-height: 0;
      font-size: 0.78rem;
      font-weight: 500;
      color: var(--text-dim);
    }
    .chead .r {
      text-align: right;
    }
  }
  /* A tablet: the same columns, closer together. */
  @media (min-width: 720px) and (max-width: 899px) {
    .ctable:not(.hidden) {
      --cols: minmax(12ch, 1fr) fit-content(20ch) 52px 64px 76px 76px auto;
      column-gap: 10px;
    }
  }
  .crow.picked {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.warn {
    background: var(--warn-dot);
  }
  .dot.bad {
    background: var(--danger);
  }
  .dot.off {
    background: var(--text-dim);
  }
  .host {
    white-space: nowrap;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0 6px;
    margin-left: 4px;
  }
  .num {
    font: 0.8rem var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
    white-space: nowrap;
  }
  /* The last rows above the bar, not under it. */
  .page.with-bar {
    padding-bottom: calc(var(--nav-h) + 150px + env(safe-area-inset-bottom));
  }
  .bulkbar {
    position: fixed;
    left: var(--rail-w);
    right: 0;
    bottom: calc(var(--nav-h) + env(safe-area-inset-bottom));
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    padding: 10px 16px;
    background: var(--bg-raised);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .bulkbar .btn {
    width: auto;
    flex: 1 1 auto;
    max-width: 220px;
  }
</style>
