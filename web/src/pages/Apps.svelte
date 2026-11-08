<script lang="ts">
  import { frameCsp } from '../lib/framecsp.js';
  import LoadFailed from '../components/LoadFailed.svelte';
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { scrollCue } from '../lib/scrollcue.js';
  import { ask } from '../lib/confirm.svelte.js';
  import type { AppInput, AppTab, DiscoveryResult } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import SectionTabs from '../components/SectionTabs.svelte';
  import Icon from '../components/Icon.svelte';
  import { uptimeLabel } from '../lib/uptime.js';
  import { android } from '../lib/android.js';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { footBar } from '../lib/footbar.js';

  // Web apps next to the shell (Radarr, Sonarr, ...). Opening one: in the
  // Android app a native tab with its own cookies; in a browser a frame when
  // the app allows it, else a new browser tab.

  let apps = $state<AppTab[]>([]);
  let loaded = $state(false);
  let manage = $state(false);
  let editing = $state<AppTab | null>(null);
  let formOpen = $state(false);
  let form = $state({ name: '', url: '', group: '', pinned: true, monitor: true, newTab: false });
  // The form as opened: changed, closing it asks first (AUDIT2 PAGE-09).
  let formBase = '';
  let found = $state<DiscoveryResult | null>(null);
  let discoverOpen = $state(false);
  let discoverHost = $state(0);
  let busy = $state(false);

  const admin = $derived(session.state?.user?.role === 'admin');


  async function load() {
    apps = await get<AppTab[]>('/api/apps');
    loaded = true;
  }
  // Pulled down on a phone: read again.
  $effect(() => pullToRefresh(() => load()));

  let loadError = $state('');
  const firstLoad = () => {
    loadError = '';
    load().catch((err: unknown) => (loadError = errorMessage(err)));
  };
  firstLoad();

  // Found by a word of the name, the address or the group; in the order of
  // one's choice (kept on this device): the order set in Manage, by name,
  // or the ones that are down first.
  type Sort = 'own' | 'name' | 'down' | 'adjust';
  const VIEW_KEY = 'burrow.appsView';
  let query = $state('');
  let sortBy = $state<Sort>(
    (() => {
      try {
        const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as { sort?: string };
        return v.sort === 'name' || v.sort === 'down' ? v.sort : 'own';
      } catch {
        return 'own';
      }
    })(),
  );
  $effect(() => {
    // "Change the order": to Manage, and back to one's own order.
    if (sortBy === 'adjust') {
      sortBy = 'own';
      manage = true;
      return;
    }
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: sortBy }));
    } catch {
      // Not kept on this device; the choice holds for this page.
    }
  });
  const matches = (a: AppTab) => {
    const q = query.trim().toLowerCase();
    return !q || [a.name, a.url, hostOf(a.url), a.group ?? ''].some((x) => x.toLowerCase().includes(q));
  };
  const rank = (a: AppTab) => (a.up === false ? 0 : a.up === null ? 1 : 2);
  const ordered = (list: AppTab[]) =>
    sortBy === 'name' ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : sortBy === 'down' ? [...list].sort((a, b) => rank(a) - rank(b)) : list;
  const visible = $derived(apps.filter(matches));

  const groups = $derived.by(() => {
    const m = new Map<string, AppTab[]>();
    for (const a of ordered(visible.filter((x) => x.pinned))) {
      const g = a.group ?? '';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(a);
    }
    // By name: the groups by name too. Otherwise in the order of their first
    // app: in one's own order the groups move with their apps (they stayed
    // alphabetical, so dragging across groups changed nothing).
    const entries = [...m.entries()];
    return sortBy === 'name' ? entries.sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))) : entries;
  });
  const others = $derived(ordered(visible.filter((a) => !a.pinned)));

  function openApp(a: AppTab) {
    if (android) return void android.openApp({ id: a.id, name: a.name, url: a.url }).catch((err: unknown) => toast(errorMessage(err), 'error'));
    if (a.embeddable === 'yes' && !a.newTab) {
      // A reload first when apps changed since the page loaded: AppFrame.
      go(`/apps/${a.id}`);
      return;
    }
    window.open(a.url, '_blank', 'noopener');
  }

  async function run(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
      frameCsp.stale = true;
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  function edit(a: AppTab | null) {
    editing = a;
    form = { name: a?.name ?? '', url: a?.url ?? 'https://', group: a?.group ?? '', pinned: a?.pinned ?? true, monitor: a?.monitor ?? true, newTab: a?.newTab ?? false };
    formBase = JSON.stringify(form);
    formOpen = true;
  }

  const save = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      const body: AppInput = { name: form.name, url: form.url, group: form.group || null, pinned: form.pinned, hostId: editing?.hostId ?? null, container: editing?.container ?? null, monitor: form.monitor, newTab: form.newTab };
      const a = editing ? await put<AppTab>(`/api/apps/${editing.id}`, body) : await post<AppTab>('/api/apps', body);
      formOpen = false;
      if (a.embeddable === 'unknown') toast(t('apps.unreachable'));
    });
  };

  // Several at once while managing (an addition to report e34ebd's round): picked, then one change
  // for all of them, or removed together.
  let chosen = $state<Set<number>>(new Set());
  const pickApp = (id: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    chosen = next;
  };
  $effect(() => {
    if (!manage && chosen.size) chosen = new Set();
  });
  // All or none in one button that keeps its place (report b2340c: an "All" that left the bar made the others jump).
  const allChosen = $derived(visible.length > 0 && visible.every((a) => chosen.has(a.id)));
  let bulkOpen = $state(false);
  type Tri = '' | 'yes' | 'no';
  let bulk = $state<{ setGroup: boolean; group: string; pinned: Tri; newTab: Tri; monitor: Tri }>({ setGroup: false, group: '', pinned: '', newTab: '', monitor: '' });
  const pickedApps = $derived(apps.filter((a) => chosen.has(a.id)));
  function openBulk() {
    bulk = { setGroup: false, group: '', pinned: '', newTab: '', monitor: '' };
    bulkOpen = true;
  }
  const tri = (v: Tri, was: boolean) => (v === '' ? was : v === 'yes');
  const saveBulk = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      for (const a of pickedApps) {
        const body: AppInput = {
          name: a.name,
          url: a.url,
          group: bulk.setGroup ? bulk.group.trim() || null : a.group,
          pinned: tri(bulk.pinned, a.pinned),
          hostId: a.hostId,
          container: a.container,
          monitor: tri(bulk.monitor, a.monitor),
          newTab: tri(bulk.newTab, a.newTab),
        };
        await put<AppTab>(`/api/apps/${a.id}`, body);
      }
      toast(t('apps.bulkSaved', { n: pickedApps.length }));
      bulkOpen = false;
      chosen = new Set();
    });
  };
  const removeChosen = () =>
    run(async () => {
      const list = pickedApps;
      if (!(await ask({ text: t('apps.bulkDeleteConfirm', { n: list.length }), confirm: t('common.delete'), danger: true }))) return;
      for (const a of list) await del(`/api/apps/${a.id}`);
      chosen = new Set();
    });

  const remove = (a: AppTab) =>
    run(async () => {
      if ((await ask({ text: t('common.confirmDelete', { name: a.name }), confirm: t('common.delete'), danger: true }))) await del(`/api/apps/${a.id}`);
    });

  // The open form shows the new answer too; what is typed in it stays (AUDIT2 UX-09).
  const recheck = (a: AppTab) =>
    run(async () => {
      const fresh = await post<AppTab>(`/api/apps/${a.id}/check`);
      if (editing?.id === fresh.id) editing = fresh;
    });

  const saveOrder = (ids: number[]) => run(async () => void (await post('/api/apps/order', { ids })));
  // The arrow keys on a row's grip move it one place (the keyboard's drag).
  const move = (a: AppTab, dir: -1 | 1) => {
    const ids = apps.map((x) => x.id);
    const i = ids.indexOf(a.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    return saveOrder(ids);
  };
  const sortAz = async () => {
    if (!(await ask({ text: t('apps.sortAzConfirm'), confirm: t('apps.sortAz') }))) return;
    await saveOrder([...apps].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map((x) => x.id));
  };

  // Dragged by its grip (finger or mouse): the row follows, the order is
  // saved when it is let go.
  let dragging = $state<{ id: number; startY: number; dy: number; at: number } | null>(null);
  let rowEls = $state<Record<number, HTMLElement>>({});
  function dragStart(e: PointerEvent, a: AppTab) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = { id: a.id, startY: e.clientY, dy: 0, at: apps.findIndex((x) => x.id === a.id) };
  }
  function dragMove(e: PointerEvent) {
    if (!dragging) return;
    dragging.dy = e.clientY - dragging.startY;
    // Where the dragged row's middle is now: the row it is over.
    const me = rowEls[dragging.id]!.getBoundingClientRect();
    const mid = me.top + me.height / 2 + 0;
    const over = apps.findIndex((x) => {
      const r = rowEls[x.id]?.getBoundingClientRect();
      return r && x.id !== dragging!.id && mid > r.top && mid < r.bottom;
    });
    if (over >= 0) dragging.at = over;
  }
  function dragEnd() {
    if (!dragging) return;
    const { id, at } = dragging;
    dragging = null;
    const ids = apps.map((x) => x.id).filter((x) => x !== id);
    ids.splice(at, 0, id);
    if (ids.join() !== apps.map((x) => x.id).join()) void saveOrder(ids);
  }

  // Failed: said in the dialog, with another try (it said "Looking..." for ever).
  let discoverError = $state('');
  async function discover() {
    found = null;
    discoverError = '';
    discoverOpen = true;
    try {
      found = await get<DiscoveryResult>('/api/apps/discover');
    } catch (err) {
      discoverError = errorMessage(err);
    }
  }

  const addFound = (f: DiscoveryResult['apps'][number]) =>
    run(async () => {
      await post<AppTab>('/api/apps', { name: f.name, url: f.url, group: f.group, pinned: true, hostId: f.hostId, container: f.container, monitor: true, newTab: false } satisfies AppInput);
      f.added = true;
    });

  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  // An app without its own icon: its first letter on a colour of its own
  // (the same name, the same colour), each dark enough for white letters.
  const SHADES = ['#2e6b4e', '#2f5fb3', '#7a4fa8', '#9a5b13', '#0f6f7d', '#a23b3b', '#4a5a8a'];
  const shade = (name: string) => SHADES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SHADES.length];
  const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';
  // A certificate that runs out within 14 days (or did): days left, else null.
  const certDays = (a: AppTab): number | null => {
    if (!a.certExpiresAt) return null;
    const days = Math.floor((Date.parse(a.certExpiresAt) - Date.now()) / 86_400_000);
    return days < 14 ? days : null;
  };
  const certText = (days: number) => (days < 0 ? t('apps.certExpired') : t('apps.certDays', { n: days }));
  // In the app: the apps open as tabs now, at the top and marked (report
  // 050019: which were open showed only after opening one). Asked again
  // when the page shows again (back from the tabs).
  let openIds = $state<number[]>([]);
  const openNow = $derived(openIds.map((id) => apps.find((a) => a.id === id)).filter((a): a is AppTab => !!a));
  $effect(() => {
    if (!android) return;
    const ask = () => void android!.openApps().then((ids) => (openIds = ids), () => {});
    ask();
    const onShow = () => document.visibilityState === 'visible' && ask();
    document.addEventListener('visibilitychange', onShow);
    const off = android.on('resumed', ask);
    return () => {
      document.removeEventListener('visibilitychange', onShow);
      off?.();
    };
  });

  // The longest word of any name fits a tile: one smaller size for all of
  // them on narrow tiles, never a word broken between its letters (report 050019).
  const longestWord = $derived(Math.max(8, ...visible.flatMap((a) => a.name.split(/\s+/).map((w) => w.length))));
  /** Why this app opens in a tab of its own, or null when it opens here. */
  const tabWhy = (a: AppTab) => (a.newTab ? t('apps.tabChosen') : a.embeddable === 'no' ? t('apps.tabRefused') : a.embeddable === 'unknown' ? t('apps.tabUnknown') : null);
  const embedLabel = (a: AppTab) => (a.embeddable === 'yes' ? t('apps.embedYes') : a.embeddable === 'no' ? t('apps.embedNo') : t('apps.embedUnknown'));
</script>

{#snippet tile(a: AppTab)}
  <div class="tile-wrap">
    <button class="tile" class:open={openIds.includes(a.id)} onclick={() => openApp(a)} data-testid="app-tile">
      <!-- In a tab of its own (in a browser; the Android app gives each app its own tab anyway): said, and why (report c2fde7). -->
      {#if !android && tabWhy(a)}<span class="ext" role="img" aria-label={tabWhy(a)} title={tabWhy(a)} data-testid="app-new-tab"><Icon name="external" size={14} /></span>{/if}
      {#if a.hasIcon}<img src={`/api/apps/${a.id}/icon`} alt="" />{:else}<span class="ph initial" style:background={shade(a.name)} aria-hidden="true">{initial(a.name)}</span>{/if}
      <span class="name">{a.name}{#if openIds.includes(a.id)}<span class="sr-only"> ({t('apps.isOpen')})</span>{/if}</span>
      <!-- Up or down (watched every minute), and how often up the last day. -->
      {#if a.up !== null}
        <span class="state small" class:down={!a.up} data-testid="app-state" title={a.up ? t('apps.upFor', { pct: uptimeLabel(a.uptime) }) : t('apps.downSince', { since: relativeTime(a.downSince) })}>
          <span class="sdot" aria-hidden="true"></span>{a.up ? uptimeLabel(a.uptime) : t('apps.down')}
        </span>
      {/if}
      <!-- Its certificate runs out soon: renew it before the browser refuses the app. -->
      {#if certDays(a) !== null}
        <span class="cert small" class:gone={certDays(a)! < 3} data-testid="app-cert">{certText(certDays(a)!)}</span>
      {/if}
    </button>
  </div>
{/snippet}

<div class="page" class:with-bar={manage && chosen.size > 0}>
  <header class="topbar">
    <h1>{t('apps.title')} <HelpTip text={t('help.apps')} /></h1>
    {#if admin}
      <!-- A-Z: in the bar, beside Done (a third row pushed the list down on a phone). -->
      <!-- Add and Find in containers too: rows of buttons under the search pushed the list down on a phone. -->
      {#if manage && apps.length > 1}<button class="icon-btn" disabled={busy} onclick={sortAz} aria-label={t('apps.sortAz')} title={t('apps.sortAz')} data-testid="apps-sort-az"><Icon name="sort-az" /></button>{/if}
      {#if manage}
        <button class="icon-btn" disabled={busy} onclick={discover} aria-label={t('apps.discover')} title={t('apps.discover')}><Icon name="box" /></button>
        <button class="icon-btn" disabled={busy} onclick={() => edit(null)} aria-label={t('apps.add')} title={t('apps.add')}><Icon name="plus" /></button>
      {/if}
      <button class="btn small" aria-pressed={manage} onclick={() => (manage = !manage)}>{manage ? t('common.done') : t('apps.manage')}</button>
    {/if}
  </header>
  <SectionTabs current="apps" />

  {#if apps.length > 1}
    <div class="filters">
      <div class="search grow">
        <Icon name="search" />
        <input type="search" bind:value={query} placeholder={t('common.search')} aria-label={t('apps.search')} autocapitalize="none" spellcheck="false" data-testid="apps-search" />
      </div>
      {#if !manage}
        <select bind:value={sortBy} aria-label={t('apps.sort')} data-testid="apps-sort">
          <option value="own">{t('apps.sortOwn')}</option>
          <option value="name">{t('apps.sortName')}</option>
          <option value="down">{t('apps.sortDown')}</option>
          <!-- One's own order is set in Manage: the way there, in the same list (no room for a button on a phone). -->
          {#if admin}<option value="adjust">{t('apps.adjustOrder')}</option>{/if}
        </select>
      {:else}
        <button class="btn small pickall" aria-pressed={allChosen} onclick={() => (chosen = allChosen ? new Set() : new Set(visible.map((x) => x.id)))} data-testid="apps-pick-all">{allChosen ? t('containers.pickNone') : t('containers.pickAll')}</button>
      {/if}
    </div>
    {#if query.trim() && !visible.length}<p class="empty" data-testid="apps-none-found">{t('apps.noneFound', { q: query.trim() })}</p>{/if}
  {/if}

  {#if manage}
    <!-- Managing: a list, each app one row with its order and its buttons
         (the tiles had no room for them). -->
    <div class="list" data-testid="apps-manage">
      {#each visible as a (a.id)}
        <div class="list-item" class:dragged={dragging?.id === a.id} style:transform={dragging?.id === a.id ? `translateY(${dragging.dy}px)` : undefined} bind:this={rowEls[a.id]} data-testid="app-row">
          <input type="checkbox" class="pickbox" checked={chosen.has(a.id)} aria-label={t('apps.pick', { name: a.name })} onchange={(e) => pickApp(a.id, e.currentTarget.checked)} data-testid="app-pick" />
          <button
            class="icon-btn grip"
            aria-label={t('apps.dragHint', { name: a.name })}
            title={t('apps.dragHint', { name: a.name })}
            disabled={busy || !!query.trim()}
            onpointerdown={(e) => dragStart(e, a)}
            onpointermove={dragMove}
            onpointerup={dragEnd}
            onpointercancel={() => (dragging = null)}
            onkeydown={(e) => (e.key === 'ArrowUp' ? (e.preventDefault(), void move(a, -1)) : e.key === 'ArrowDown' ? (e.preventDefault(), void move(a, 1)) : undefined)}
            data-testid="app-grip"><Icon name="grip" size={18} /></button
          >
          {#if a.hasIcon}<img class="micon" src={`/api/apps/${a.id}/icon`} alt="" />{:else}<span class="micon initial small-initial" style:background={shade(a.name)} aria-hidden="true">{initial(a.name)}</span>{/if}
          <!-- The row itself edits: one button fewer, room for the name. -->
          <button class="main edit" aria-label="{t('common.edit')} {a.name}" disabled={busy} onclick={() => edit(a)} data-testid="app-edit">
            <span class="title">{a.name}</span>
            <span class="sub">{hostOf(a.url)} | {embedLabel(a)}{a.group ? ` | ${a.group}` : ''}{a.pinned ? '' : ` | ${t('apps.hiddenShort')}`}{certDays(a) !== null ? ` | ${certText(certDays(a)!)}` : ''}</span>
          </button>

          <button class="icon-btn" aria-label={t('common.delete')} title={t('common.delete')} disabled={busy} onclick={() => remove(a)}><Icon name="trash" size={18} /></button>
        </div>
      {/each}
    </div>
    {#if chosen.size}
      <div class="bulkbar" role="toolbar" aria-label={t('bulk.actions')} data-testid="apps-bulk-bar" use:footBar>
        <span class="count small">{t('apps.chosen', { n: chosen.size })}</span>
        <button class="btn small primary" disabled={busy} onclick={openBulk} data-testid="apps-bulk-edit">{t('apps.bulkEdit')}</button>
        <button class="btn small danger" disabled={busy} onclick={removeChosen} data-testid="apps-bulk-delete">{t('common.delete')}</button>
      </div>
    {/if}
  {:else}

  {#if !loaded && loadError}
    <LoadFailed message={loadError} onretry={firstLoad} />
  {/if}
  {#if loaded && apps.length === 0}
    <p class="empty">{admin ? t('apps.emptyAdmin') : t('apps.empty')}</p>
    <!-- No apps yet: the two ways to get some, without Manage first. -->
    {#if admin}
      <div class="first">
        <button class="btn small" disabled={busy} onclick={() => edit(null)}><Icon name="plus" size={16} /> {t('apps.add')}</button>
        <button class="btn small" disabled={busy} onclick={discover}><Icon name="box" size={16} /> {t('apps.discover')}</button>
      </div>
    {/if}
  {/if}

  {#if openNow.length && !query.trim()}
    <div class="opennow" data-testid="apps-open-now">
      <span class="dim small">{t('apps.openNow')}</span>
      <!-- One row, sideways when there are more than fit (report f1b358: they took rows of their own). -->
      <div use:scrollCue class="opened">
        {#each openNow as a (a.id)}<button class="btn small" onclick={() => openApp(a)} data-testid="app-open">{a.name}</button>{/each}
      </div>
    </div>
  {/if}

  {#each groups as [g, list] (g)}
    {#if g}<h2>{g}</h2>{/if}
    <div class="grid" style:--chars={longestWord}>
      {#each list as a (a.id)}{@render tile(a)}{/each}
    </div>
  {/each}

  {#if others.length}
    <details open={!!query.trim() || undefined}>
      <summary>{t('apps.others', { n: others.length })}</summary>
      <div class="grid" style:--chars={longestWord}>
        {#each others as a (a.id)}{@render tile(a)}{/each}
      </div>
    </details>
  {/if}
  {/if}
</div>

<Dialog tour="app-form" bind:open={formOpen} title={editing ? editing.name : t('apps.add')} dirty={() => JSON.stringify(form) !== formBase}>
  <form id="app-form" class="stack" onsubmit={save}>
    <label class="field">
      <span>{t('apps.name')}</span>
      <input bind:value={form.name} required maxlength="60" />
    </label>
    <label class="field">
      <span>{t('apps.url')}</span>
      <input bind:value={form.url} type="url" required autocapitalize="none" spellcheck="false" />
    </label>
    <label class="field">
      <span>{t('apps.group')} <span class="dim">({t('common.optional')})</span></span>
      <input bind:value={form.group} maxlength="40" />
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={form.pinned} />
      {t('apps.pinned')}
    </label>
    <div class="row">
      <label class="check">
        <input type="checkbox" bind:checked={form.newTab} data-testid="app-new-tab-always" />
        {t('apps.newTabAlways')}
      </label>
      <HelpTip text={t('help.appFrame')} />
    </div>
    <div class="row">
      <label class="check">
        <input type="checkbox" bind:checked={form.monitor} data-testid="app-monitor" />
        {t('apps.monitor')}
      </label>
      <HelpTip text={t('help.appMonitor')} />
    </div>
  </form>
  {#if editing}
    <!-- Framed here or in a tab of its own, and its icon: looked at again. -->
    <p class="dim small">{embedLabel(editing)}</p>
    <button class="btn small" disabled={busy} onclick={() => editing && recheck(editing)} data-testid="app-recheck"><Icon name="reload" size={16} /> {t('apps.recheck')}</button>
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => (formOpen = false)}>{t('common.cancel')}</button>
    <button class="btn primary" form="app-form" disabled={busy}>{t('common.save')}</button>
  {/snippet}
</Dialog>

<Dialog tour="apps-bulk" bind:open={bulkOpen} title={t('apps.bulkTitle', { n: pickedApps.length })}>
  <form id="apps-bulk-form" class="stack" onsubmit={saveBulk} data-testid="apps-bulk">
    <p class="dim small">{t('apps.bulkHelp')}</p>
    <label class="check"><input type="checkbox" bind:checked={bulk.setGroup} data-testid="apps-bulk-set-group" /> {t('apps.bulkSetGroup')}</label>
    {#if bulk.setGroup}
      <label class="field">
        <span>{t('apps.group')} <span class="dim">({t('apps.bulkGroupEmpty')})</span></span>
        <input bind:value={bulk.group} maxlength="40" data-testid="apps-bulk-group" />
      </label>
    {/if}
    {#each [['pinned', t('apps.pinned')], ['newTab', t('apps.newTabAlways')], ['monitor', t('apps.monitor')]] as const as [key, label] (key)}
      <label class="field">
        <span>{label}</span>
        <select bind:value={bulk[key]} data-testid={`apps-bulk-${key}`}>
          <option value="">{t('apps.bulkKeep')}</option>
          <option value="yes">{t('apps.bulkYes')}</option>
          <option value="no">{t('apps.bulkNo')}</option>
        </select>
      </label>
    {/each}
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (bulkOpen = false)}>{t('common.cancel')}</button>
    <button class="btn primary" form="apps-bulk-form" disabled={busy} data-testid="apps-bulk-save">{t('common.save')}</button>
  {/snippet}
</Dialog>

<Dialog tour="apps-discover" bind:open={discoverOpen} title={t('apps.discover')}>
  {#if discoverError}
    <LoadFailed message={discoverError} onretry={discover} />
  {:else if !found}
    <p class="dim">{t('apps.discovering')}</p>
  {:else}
    {#if found.apps.length === 0}<p class="dim">{t('apps.nothingFound')}</p>{/if}
    <!-- Several Docker hosts: one at a time, or all. -->
    {#if new Set(found.apps.map((f) => f.hostId)).size > 1}
      <label class="field">
        <span>{t('apps.discoverOn')}</span>
        <select bind:value={discoverHost} data-testid="discover-host">
          <option value={0}>{t('alerts.allHosts')}</option>
          {#each [...new Map(found.apps.map((f) => [f.hostId, f.hostName]))] as [id, name] (id)}<option value={id}>{name}</option>{/each}
        </select>
      </label>
    {/if}
    <div class="list">
      <!-- Two containers (or hosts) can carry the same address. -->
      {#each found.apps.filter((f) => !discoverHost || f.hostId === discoverHost) as f (`${f.hostId}:${f.container}:${f.url}`)}
        <div class="list-item">
          <div class="main">
            <div class="title">{f.name}</div>
            <div class="sub">{f.url} | {f.hostName} | {f.source}</div>
          </div>
          {#if f.added}
            <span class="badge">{t('apps.added')}</span>
          {:else}
            <button class="btn small" disabled={busy} onclick={() => addFound(f)}>{t('common.add')}</button>
          {/if}
        </div>
      {/each}
    </div>
    {#each found.errors as e (e.hostId)}<p class="alert error small">{e.hostName}: {e.message}</p>{/each}
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => (discoverOpen = false)}>{t('common.close')}</button>
  {/snippet}
</Dialog>

<style>
  /* Picked while managing: what to do with them, at the bottom (as on Containers). */
  .bulkbar {
    position: fixed;
    left: var(--rail-w);
    right: 0;
    bottom: calc(var(--nav-h) + env(safe-area-inset-bottom));
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 16px;
    background: var(--bg-raised);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .bulkbar .btn {
    width: auto;
    white-space: nowrap;
  }
  .bulkbar .count {
    font-weight: 600;
  }
  /* The last rows above the bar, not under it. */
  .page.with-bar {
    padding-bottom: calc(var(--nav-h) + 120px + env(safe-area-inset-bottom));
  }
  .pickall {
    width: auto;
    flex: none;
    min-width: 5.5em;
  }
  /* A phone: two by two under the count, not four in a ragged wrap. */
  @media (max-width: 599px) {
    .bulkbar {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
    .bulkbar .count {
      grid-column: 1 / -1;
      text-align: center;
    }
  }
  .pickbox {
    flex: none;
    width: 20px;
    height: 20px;
  }
  [data-testid='apps-manage'] {
    padding-bottom: 72px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    /* Every tile as high as the highest: one name over two lines made its
       row taller than the others (report 00ec50). */
    grid-auto-rows: 1fr;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .tile-wrap {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-dim);
  }
  .state.down {
    color: var(--danger);
    font-weight: 700;
  }
  .sdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
  }
  .state.down .sdot {
    background: var(--danger);
  }
  /* Open as a tab in the app: an accent edge. */
  .tile.open {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .opennow {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .opennow > span {
    flex: none;
  }
  .opened {
    display: flex;
    gap: 6px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .opened :global(.btn) {
    width: auto;
    flex: none;
  }
  /* Opens in a tab of its own: a small mark in the corner (its reason in its title). */
  .ext {
    position: absolute;
    top: 6px;
    right: 6px;
    display: inline-flex;
    color: var(--text-dim);
  }
  .tile {
    position: relative;
    flex: 1;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    padding: 0.75rem 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .tile img,
  .ph {
    width: 40px;
    height: 40px;
    object-fit: contain;
    display: grid;
    place-items: center;
    color: var(--text-dim);
  }
  /* Under the centred empty text, centred too. */
  /* One above the other, as wide as each other: side by side they wrapped
     unevenly on a narrow phone (Dutch labels). */
  .first {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 280px;
    margin: 0 auto;
  }
  .cert {
    color: var(--warn);
    font-weight: 600;
  }
  .cert.gone {
    color: var(--danger);
  }
  .filters {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .filters .grow {
    flex: 1;
    min-width: 0;
  }
  /* Its whole choice shown ("Eigen volgorde" was cut off); the search takes the rest. */
  .filters select {
    flex: none;
    width: auto;
  }
  .name {
    /* The longest word on one line: about 0.58 em a letter. */
    font-size: clamp(0.62rem, calc(100cqi / (var(--chars, 10) * 0.6)), 0.85rem);
    text-align: center;
    overflow-wrap: break-word;
    /* The state below it at the same height in every tile. */
    flex: 1;
  }
  .initial {
    border-radius: 8px;
    color: #fff;
    font-weight: 600;
    font-size: 1.05rem;
  }
  /* A computer: wider tiles, read from the left like the rest of the pages. */
  /* A tablet up (720 px) too: the phone's rows stretched over 760 px left the buttons far from the names (A3-WEB-15). */
  @media (min-width: 720px) {
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
    }
    .tile {
      align-items: flex-start;
      padding: 14px;
      gap: 8px;
    }
    .tile img,
    .ph {
      width: 36px;
      height: 36px;
    }
    .name {
      text-align: left;
      font-weight: 600;
      font-size: 0.92rem;
    }
  }
  .micon {
    width: 24px;
    height: 24px;
    object-fit: contain;
    flex: none;
  }
  .small-initial {
    display: grid;
    place-items: center;
    border-radius: 6px;
    font-size: 0.78rem;
  }
  /* A row's buttons close together: four of them beside the name. */
  [data-testid='apps-manage'] .icon-btn {
    width: 36px;
    height: 36px;
  }
  .main.edit {
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 0;
    cursor: pointer;
  }
  .grip {
    cursor: grab;
    touch-action: none;
    color: var(--text-dim);
  }
  .dragged {
    position: relative;
    z-index: 2;
    background: var(--bg-raised);
    box-shadow: var(--shadow);
  }
</style>
