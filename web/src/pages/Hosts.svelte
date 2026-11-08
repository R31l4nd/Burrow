<script lang="ts">
  import LoadFailed from '../components/LoadFailed.svelte';
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import WorkspaceList from '../components/WorkspaceList.svelte';
  import Fuse from 'fuse.js';
  import type { Group, Host, SharedSession } from '@burrow/shared';
  import HostRow from '../components/HostRow.svelte';
  import HostSheet from '../components/HostSheet.svelte';
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import { ApiFailure, errorMessage, get } from '../lib/api.js';
  import { data, groupPath, loadAll, loadStatus } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { recentHosts } from '../lib/recenthosts.js';
  import { connectHost } from '../lib/sessions.svelte.js';
  import { toast } from '../lib/ui.svelte.js';

  let query = $state('');
  let selected = $state<Host | null>(null);
  let sheetOpen = $state(false);
  let firstConnect = $state(false);

  const COLLAPSE_KEY = 'burrow.collapsedGroups';
  let collapsed = $state<Set<number>>(readCollapsed());
  function readCollapsed(): Set<number> {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as number[]);
    } catch {
      return new Set();
    }
  }
  function toggle(id: number) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
    } catch {
      // Not remembered; harmless.
    }
  }

  let loadError = $state('');
  function load() {
    loadError = '';
    loadAll().catch((err: unknown) => (loadError = errorMessage(err)));
  }
  load();
  // Pulled down on a phone: hosts and their state read again.
  $effect(() => pullToRefresh(() => Promise.all([loadAll(), loadStatus()])));
  $effect(() => {
    const timer = setInterval(() => void loadStatus().catch(() => {}), 30_000);
    return () => clearInterval(timer);
  });

  const fuse = $derived(
    new Fuse(
      data.hosts.map((h) => ({ h, group: groupPath(h.groupId) })),
      {
        keys: [
          { name: 'h.name', weight: 3 },
          { name: 'h.address', weight: 2 },
          { name: 'h.tags', weight: 2 },
          { name: 'group', weight: 1 },
          { name: 'h.username', weight: 1 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
        includeScore: true,
      },
    ),
  );
  // What was typed, found as written: only those (in the fuzzy order). With
  // none, a typo: the close fuzzy matches only. Among 600 hosts "host-421"
  // matched 387 of them fuzzily.
  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const found = fuse.search(q);
    const said = ({ h, group }: { h: Host; group: string }) => [h.name, h.address, h.username ?? '', group, ...h.tags].some((x) => x.toLowerCase().includes(q));
    const exact = found.filter((r) => said(r.item));
    if (exact.length) return exact.map((r) => r.item.h);
    const best = found[0]?.score ?? 0;
    return found
      .filter((r) => (r.score ?? 1) <= best + 0.1)
      .slice(0, 20)
      .map((r) => r.item.h);
  });

  const favorites = $derived(data.hosts.filter((h) => h.favorite));
  const recent = $derived(recentHosts(data.hosts));
  const children = (parentId: number | null): Group[] => data.groups.filter((g) => g.parentId === parentId);
  const hostsIn = (groupId: number | null): Host[] => data.hosts.filter((h) => h.groupId === groupId);
  const countIn = (groupId: number): number =>
    hostsIn(groupId).length + children(groupId).reduce((n, g) => n + countIn(g.id), 0);

  function openHost(h: Host) {
    selected = h;
    sheetOpen = true;
  }

  async function connect(h: Host) {
    // No shell for operators: a tap shows how the host is doing.
    if (!admin) return go(`/hosts/${h.id}/stats`);
    try {
      await connectHost(h.id);
    } catch (err) {
      // A host never connected to, or whose key changed: its menu with the fingerprint at once,
      // trusted and connected in one step; no raw code in a toast (W-FUNC-02, decision 13).
      if (err instanceof ApiFailure && (err.code === 'unknown_host_key' || err.code === 'host_key_mismatch')) {
        firstConnect = true;
        return openHost(h);
      }
      // Another problem (credentials, unreachable) is explained in the host menu, where it can be fixed.
      toast(errorMessage(err), 'error');
      openHost(h);
    }
  }

  function onSearchKey(e: KeyboardEvent) {
    // Enter connects to the best match: search-then-connect without touching the list.
    // preventDefault: otherwise the same key press activates the button that
    // gets focus in the opened sheet (its close button) and shuts it again.
    if (e.key === 'Enter' && results[0]) {
      e.preventDefault();
      void connect(results[0]);
    }
  }
  const admin = $derived(session.state?.user?.role === 'admin');
  // Sessions someone shared with this person, to watch (F3).
  let shared = $state<SharedSession[]>([]);
  get<SharedSession[]>('/api/terminal/shared').then(
    (l) => (shared = l),
    () => {},
  );
</script>

<div class="page">
  <header class="topbar">
    <h1>{t('hosts.title')}</h1>
    {#if admin}
      <!-- On a wide screen with their words beside them. The add button is in the bar on a phone too:
           the round one floating over the list sat on a row's menu (UIA-06, decision 25). -->
      <button class="icon-btn labeled" title={t('snippets.adhoc')} aria-label={t('snippets.adhoc')} onclick={() => go('/settings/snippets?run=1')} data-testid="hosts-adhoc"><Icon name="terminal" /><span class="wide-only" aria-hidden="true">{t('snippets.adhoc')}</span></button>
      <button class="icon-btn labeled" title={t('nav.import')} aria-label={t('nav.import')} onclick={() => go('/import')}><Icon name="import" /><span class="wide-only" aria-hidden="true">{t('nav.import')}</span></button>
      <button class="icon-btn labeled" title={t('hosts.addGroup')} aria-label={t('hosts.addGroup')} onclick={() => go('/groups/new')}><Icon name="folder" /><span class="wide-only" aria-hidden="true">{t('hosts.addGroup')}</span></button>
      <button class="btn primary add-top" aria-label={t('hosts.add')} title={t('hosts.add')} onclick={() => go('/hosts/new')} data-testid="hosts-add-top"><Icon name="plus" size={18} /><span class="wide-only" aria-hidden="true">{t('hosts.add')}</span></button>
    {/if}
  </header>

  {#if shared.length}
    <section class="card stack shared" aria-label={t('watch.sharedWithYou')} data-testid="shared-sessions">
      <strong class="small">{t('watch.sharedWithYou')}</strong>
      {#each shared as s (s.id)}
        <div class="row">
          <span class="main">{s.title ?? s.hostName} <span class="dim small">{t('watch.from', { owner: s.owner, host: s.hostName })}</span></span>
          <button class="btn small" onclick={() => go(`/watch/${s.id}`)} data-testid="shared-watch">{t('watch.open')}</button>
        </div>
      {/each}
    </section>
  {/if}

  <div class="search">
    <Icon name="search" />
    <input type="search" bind:value={query} placeholder={t('hosts.search')} aria-label={t('hosts.search')} onkeydown={onSearchKey} autocapitalize="none" spellcheck="false" />
  </div>

  {#if !data.loaded && loadError}
    <LoadFailed message={loadError} onretry={load} />
  {:else if !data.loaded}
    <Skeleton rows={5} />
  {:else if query.trim()}
    {#if results.length}
      <div class="list" style:margin-top="12px">
        {#each results as h (h.id)}<HostRow host={h} onconnect={connect} onmenu={openHost} />{/each}
      </div>
    {:else}
      <p class="empty">{t('hosts.noMatch', { q: query })}</p>
    {/if}
  {:else if data.hosts.length === 0 && data.groups.length === 0}
    <div class="empty stack">
      <p>{t('hosts.empty')}</p>
      <p class="small">{t('hosts.emptyHelp')}</p>
      {#if admin}
        <!-- Centred under the words, not at the left edge (UIB-10). -->
        <div class="stack empty-actions">
          <button class="btn primary" onclick={() => go('/hosts/new')}>{t('hosts.add')}</button>
          <button class="btn" onclick={() => go('/import')}>{t('nav.import')}</button>
        </div>
      {/if}
    </div>
  {:else}
    <!-- On a very wide screen in two columns; each part (a heading with its list, a group) kept whole. -->
    <div class="cols">
    {#if favorites.length}
      <div><h2 class="group">{t('hosts.favorites')}</h2>
      <div class="list">{#each favorites as h (h.id)}<HostRow host={h} onconnect={connect} onmenu={openHost} />{/each}</div></div>
    {/if}
    <div><WorkspaceList /></div>
    {#if recent.length}
      <div><h2 class="group">{t('hosts.recent')}</h2>
      <div class="list">{#each recent as h (h.id)}<HostRow host={h} onconnect={connect} onmenu={openHost} />{/each}</div></div>
    {/if}

    {#snippet groupTree(parentId: number | null)}
      {#each children(parentId) as g (g.id)}
        <div class="group">
          <div class="group-head">
            <button class="group-toggle" aria-expanded={!collapsed.has(g.id)} onclick={() => toggle(g.id)}>
              <span class="chev" class:open={!collapsed.has(g.id)}><Icon name="chevron" size={18} /></span>
              <span class="group-name">{g.name}</span>
              <span class="dim small">{countIn(g.id)}</span>
            </button>
            {#if admin}<button class="icon-btn" aria-label={t('group.edit')} onclick={() => go(`/groups/${g.id}/edit`)}><Icon name="more" size={20} /></button>{/if}
          </div>
          {#if !collapsed.has(g.id)}
            {#if hostsIn(g.id).length}
              <div class="list">{#each hostsIn(g.id) as h (h.id)}<HostRow host={h} onconnect={connect} onmenu={openHost} />{/each}</div>
            {/if}
            {@render groupTree(g.id)}
          {/if}
        </div>
      {/each}
    {/snippet}

    {@render groupTree(null)}

    {#if hostsIn(null).length}
      <div><h2 class="group">{data.groups.length ? t('hosts.ungrouped') : t('hosts.title')}</h2>
      <div class="list">{#each hostsIn(null) as h (h.id)}<HostRow host={h} onconnect={connect} onmenu={openHost} />{/each}</div></div>
    {/if}
    </div>
  {/if}
</div>


<HostSheet host={selected ? (data.hosts.find((h) => h.id === selected!.id) ?? selected) : null} bind:open={sheetOpen} bind:firstConnect />

<style>
  .group {
    margin-top: 10px;
  }
  /* A group as a part of the page: the same room above it as a part with a heading, kept at the top
     of a column where a margin is cut (report dc0352). */
  .cols > .group {
    margin-top: 0;
    padding-top: 1.25rem;
  }
  /* One step in per level: a subgroup sits inside its group's block, so the
     steps add up by themselves (depth * 12px on each grew quadratically and
     ate a phone's width at a few levels, AUDIT2 PAGE-31). */
  .group .group {
    margin-left: 12px;
  }
  .group-head {
    display: flex;
    align-items: center;
  }
  .group-toggle {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    background: none;
    border: 0;
    color: var(--text);
    font: inherit;
    cursor: pointer;
    text-align: left;
    padding: 0 4px;
  }
  .group-name {
    font-weight: 700;
  }
  .chev {
    display: inline-flex;
    transition: transform var(--dur-2) var(--ease);
    color: var(--text-dim);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .shared {
    margin-bottom: 12px;
  }
  .shared .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .shared .main {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* A phone: a square of the bar's icon size, its plus only. */
  .add-top {
    gap: 6px;
  }
  @media (max-width: 899px) {
    .add-top {
      width: 44px;
      min-height: 40px;
      padding: 0;
      justify-content: center;
    }
  }
  .empty-actions {
    align-items: center;
  }
  .empty-actions > :global(.btn) {
    align-self: center;
  }
</style>
