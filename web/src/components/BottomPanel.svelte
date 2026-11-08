<script lang="ts">
  import { roving } from '../lib/roving.js';
  import LoadFailed from './LoadFailed.svelte';
  import { scrollCue } from '../lib/scrollcue.js';
  import { untrack } from 'svelte';
  import { sessionLabel, type ContainerInfo } from '@burrow/shared';
  import { session } from '../lib/session.svelte.js';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import LogView from './LogView.svelte';
  import TermSession from './TermSession.svelte';
  import { errorMessage } from '../lib/api.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { DockerWatch } from '../lib/docker.svelte.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { go, to } from '../lib/router.svelte.js';
  import { closeSession, loadSessions, newSession, terms } from '../lib/sessions.svelte.js';
  import { toast } from '../lib/ui.svelte.js';

  // A panel under a page, like the one in VS Code: terminals on the host
  // (started in the page's folder) and the logs of the containers that
  // belong to it, picked by itself (the page says which) or chosen. Under a
  // workspace and on a stack's page, so one tab holds the files, a shell and
  // the logs. What is open, its height and the choice are kept per page on
  // this device.

  let {
    key,
    hostId,
    cwd = null,
    auto,
    autoHelp,
    open = $bindable(false),
    dock = false,
    // Written here, read by the page (room at its bottom).
    // eslint-disable-next-line no-useless-assignment
    space = $bindable(0),
  }: {
    /** Where its layout is kept: `burrow.panel.<key>`. */
    key: string;
    hostId: number;
    cwd?: string | null;
    /** The containers whose logs are shown without a choice. */
    auto: (c: ContainerInfo) => boolean;
    /** What "automatic" means here. */
    autoHelp: string;
    open?: boolean;
    /** Fixed at the bottom of the window (a page that scrolls), not in its parent's flow. */
    dock?: boolean;
    space?: number;
  } = $props();

  interface Layout {
    open: boolean;
    frac: number;
    tab: 'term' | 'logs';
    sessions: string[];
    active: string | null;
    picked: string[] | null;
  }
  const STORE = untrack(() => `burrow.panel.${key}`);
  function read(): Layout {
    const none: Layout = { open: false, frac: 0.4, tab: 'term', sessions: [], active: null, picked: null };
    try {
      const v = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Layout>;
      return {
        open: v.open === true,
        frac: typeof v.frac === 'number' && v.frac >= MIN && v.frac <= MAX ? v.frac : none.frac,
        tab: v.tab === 'logs' ? 'logs' : 'term',
        sessions: Array.isArray(v.sessions) ? v.sessions.filter((s): s is string => typeof s === 'string') : [],
        active: typeof v.active === 'string' ? v.active : null,
        picked: Array.isArray(v.picked) ? v.picked.filter((s): s is string => typeof s === 'string') : null,
      };
    } catch {
      return none;
    }
  }
  const MIN = 0.15;
  const MAX = 0.9;
  const saved = read();
  let frac = $state(saved.frac);
  // Terminals are the admin's: an operator's panel has the logs only.
  const admin = untrack(() => session.state?.user?.role === 'admin');
  let tab = $state(admin ? saved.tab : 'logs');
  let sessions = $state(saved.sessions);
  let active = $state(saved.active);
  let picked = $state(saved.picked);
  if (saved.open) open = true;

  $effect(() => {
    const v: Layout = { open, frac, tab, sessions, active, picked };
    try {
      localStorage.setItem(STORE, JSON.stringify(v));
    } catch {
      // Kept for this page only.
    }
  });

  // ---- terminals

  // Sessions closed elsewhere (or ended) leave the panel once the list is in.
  // Only a list that came: a failed one is no list. Taken as empty, it dropped the panel's
  // sessions and started a new shell (AUDIT2 UI-02); said instead, with Try again.
  let listed = $state(false);
  let listError = $state('');
  function list() {
    listError = '';
    loadSessions().then(
      () => (listed = true),
      (err: unknown) => (listError = errorMessage(err)),
    );
  }
  list();
  $effect(() => {
    if (!listed) return;
    const alive = sessions.filter((id) => terms.list.some((s) => s.id === id));
    if (alive.length !== sessions.length) sessions = alive;
    if (!active || !alive.includes(active)) active = alive[alive.length - 1] ?? null;
  });

  let starting = $state(false);
  async function add(tmux?: 'always' | 'never') {
    if (starting) return;
    starting = true;
    newOpen = false;
    try {
      const s = await newSession(hostId, cwd ?? undefined, tmux);
      sessions = [...sessions, s.id];
      active = s.id;
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      starting = false;
    }
  }
  // Sessions on this host that are not in the panel (from the terminal page,
  // another device): offered before a new one is started (report eca78a:
  // every + and every opening made one more, and asked for a step-up).
  let term = $state<TermSession | null>(null);
  const hasPassword = $derived(!!data.hosts.find((h) => h.id === hostId)?.hasPassword);
  // A host added since the hosts were read (in another tab): read again once, for its stored password.
  let reread = false;
  $effect(() => {
    if (!data.loaded || reread || data.hosts.some((h) => h.id === hostId)) return;
    reread = true;
    void loadAll().catch(() => {});
  });
  const running = $derived(listed ? terms.list.filter((s) => s.hostId === hostId && !sessions.includes(s.id)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)) : []);
  function openRunning(id: string) {
    newOpen = false;
    sessions = [...sessions, id];
    active = id;
  }
  /** +: the running ones to choose from when there are any, else a new one at once. */
  function plus() {
    if (running.length) newOpen = true;
    else void add();
  }
  // Held (or a right click) on +: how, as the terminal page's + offers it (report 776450).
  let newOpen = $state(false);
  let plusHeld = false;
  let plusTimer: ReturnType<typeof setTimeout> | null = null;
  function plusDown() {
    plusHeld = false;
    plusTimer = setTimeout(() => ((plusHeld = true), (newOpen = true)), 550);
  }
  function plusUp() {
    if (plusTimer) clearTimeout(plusTimer);
    plusTimer = null;
  }
  // Opened with no terminal yet: one starts at once (the button asked for
  // it), unless sessions run on this host already: then those are offered.
  // Not after the last one was closed here: then the panel offers one.
  let started = false;
  $effect(() => {
    if (listed && sessions.length) started = true;
    else if (open && tab === 'term' && listed && !started && !running.length) {
      started = true;
      void add();
    }
  });
  const labelOf = (id: string) => {
    const s = terms.list.find((x) => x.id === id);
    return s ? sessionLabel(s, terms.list) : '';
  };
  async function closeTerm(id: string) {
    if (!(await ask({ text: t('term.confirmClose', { name: labelOf(id) }), confirm: t('term.close'), danger: true }))) return;
    try {
      await closeSession(id);
      sessions = sessions.filter((x) => x !== id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ---- logs

  let watch = $state<DockerWatch | null>(null);
  $effect(() => {
    if (!open || tab !== 'logs') return;
    const w = new DockerWatch();
    w.watch([hostId]);
    watch = w;
    return () => {
      w.close();
      watch = null;
    };
  });
  const snapshot = $derived(watch?.hosts[hostId] ?? null);
  const containers = $derived(snapshot?.containers ?? []);
  const autoNames = $derived(containers.filter((c) => auto(c)).map((c) => c.name));
  // Chosen ones that are gone are left out (a log of nothing fails).
  const shownNames = $derived((picked ?? autoNames).filter((n) => containers.some((c) => c.name === n)));
  const sources = $derived(
    shownNames.map((n) => {
      const c = containers.find((x) => x.name === n);
      return { hostId, container: n, label: c?.service ?? n };
    }),
  );
  const sourcesKey = $derived(shownNames.join(','));

  let choosing = $state(false);
  // The auto ones first, then the rest of the host, by name; a host with
  // many gets a filter.
  let filter = $state('');
  const choices = $derived(
    [...containers].filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase())).sort((a, b) => Number(auto(b)) - Number(auto(a)) || a.name.localeCompare(b.name)),
  );
  function toggle(name: string, on: boolean) {
    const now = picked ?? autoNames;
    picked = on ? [...now.filter((n) => n !== name), name] : now.filter((n) => n !== name);
  }
  // All or none of those the filter shows, as the shared PickList does.
  function pickAll(on: boolean) {
    const now = picked ?? autoNames;
    const names = choices.map((c) => c.name);
    picked = on ? [...new Set([...now, ...names])] : now.filter((n) => !names.includes(n));
  }

  function full() {
    if (tab === 'term' && active) go(`/term/${active}`);
    else if (tab === 'logs' && shownNames.length) go(to('/logs', { t: shownNames.map((n) => `${hostId}:${n}`).join(',') }));
  }

  // ---- height: dragged on the grip, or with the arrow keys there

  let el: HTMLElement | undefined = $state();
  let height = $state(0);
  $effect(() => {
    space = open && dock ? height : 0;
  });
  function room(): { top: number; bottom: number } {
    if (!dock && el?.parentElement) {
      const r = el.parentElement.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }
    const b = el?.getBoundingClientRect().bottom ?? window.innerHeight;
    return { top: 0, bottom: b };
  }
  function drag(e: PointerEvent) {
    e.preventDefault();
    const { top, bottom } = room();
    const move = (m: PointerEvent) => {
      frac = Math.min(MAX, Math.max(MIN, (bottom - m.clientY) / Math.max(1, bottom - top)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  function gripKey(e: KeyboardEvent) {
    const step = e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowDown' ? -0.05 : 0;
    if (!step) return;
    e.preventDefault();
    frac = Math.min(MAX, Math.max(MIN, Math.round((frac + step) * 100) / 100));
  }
</script>

{#if open}
  <section class="panel" class:dock data-dock={dock ? '' : undefined} bind:this={el} bind:offsetHeight={height} style:--frac={frac} aria-label={t('panel.toggle')} data-testid="panel">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator is the ARIA window splitter: dragged, or moved with the arrow keys) -->
    <div
      class="grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('panel.resize')}
      aria-valuemin={MIN * 100}
      aria-valuemax={MAX * 100}
      aria-valuenow={Math.round(frac * 100)}
      tabindex="0"
      onpointerdown={drag}
      onkeydown={gripKey}
      data-testid="panel-grip"
    ></div>
    <div class="pbar">
      <div class="seg" role="tablist" use:roving>
        {#if admin}<button role="tab" aria-selected={tab === 'term'} class:on={tab === 'term'} onclick={() => (tab = 'term')} data-testid="panel-tab-term"><Icon name="terminal" size={16} /><span class="tlabel">{t('panel.terminal')}</span></button>{/if}
        <button role="tab" aria-selected={tab === 'logs'} class:on={tab === 'logs'} onclick={() => (tab = 'logs')} data-testid="panel-tab-logs"><Icon name="layers" size={16} /><span class="tlabel">{t('panel.logs')}</span></button>
      </div>
      <div use:scrollCue class="sessions">
        {#if tab === 'term'}
          {#if sessions.length > 1}
            {#each sessions as id, i (id)}
              <button class="chip" class:on={id === active} aria-pressed={id === active} title={labelOf(id)} onclick={() => (active = id)} data-testid="panel-session">{i + 1}</button>
            {/each}
          {/if}
          <button
            class="icon-btn"
            aria-label={t('panel.newTerminal')}
            title={t('term.newHintWay')}
            disabled={starting}
            onpointerdown={plusDown}
            onpointerup={plusUp}
            onpointerleave={plusUp}
            oncontextmenu={(e) => (e.preventDefault(), plusUp(), (newOpen = true))}
            onclick={() => (plusHeld ? (plusHeld = false) : plus())}
            data-testid="panel-term-add"><Icon name="plus" size={16} /></button
          >
          {#if active}<button class="icon-btn" aria-label={t('term.closeNamed', { name: labelOf(active) })} title={t('term.closeNamed', { name: labelOf(active) })} onclick={() => active && void closeTerm(active)} data-testid="panel-term-close"><Icon name="close" size={16} /></button>{/if}
          <!-- As on the terminal page: a browser's password manager cannot fill a terminal (report 35ba91). -->
          {#if active && hasPassword}<button class="icon-btn" aria-label={t('term.pastePassword')} title={t('term.pastePassword')} onpointerdown={(e) => e.preventDefault()} onclick={() => term?.sendPassword()} data-testid="panel-password"><Icon name="key" size={16} /></button>{/if}
        {:else}
          <!-- One button that says what is shown: "Choose" and "Automatic" beside the tabs read as two more tabs, cut on a phone (UIA-11). -->
          <button class="btn small sources" aria-label={`${t('panel.choose')}: ${picked === null ? t('panel.auto') : t('panel.sourcesN', { n: shownNames.length })}`} title={t('panel.choose')} onclick={() => (choosing = true)} data-testid="panel-logs-choose"
            ><Icon name="filter" size={16} /><span class="sources-text" aria-hidden="true">{picked === null ? t('panel.auto') : t('panel.sourcesN', { n: shownNames.length })}</span></button
          >
        {/if}
      </div>
      <button class="icon-btn" aria-label={t('panel.full')} title={t('panel.full')} disabled={tab === 'term' ? !active : !shownNames.length} onclick={full} data-testid="panel-full"><Icon name="external" size={16} /></button>
      <button class="icon-btn" aria-label={t('panel.hide')} title={t('panel.hide')} onclick={() => (open = false)} data-testid="panel-hide"><Icon name="close" size={16} /></button>
    </div>
    <div class="pbody">
      {#if tab === 'term'}
        {#if active}
          {#key active}
            <TermSession id={active} bind:this={term} />
          {/key}
        {:else}
          <div class="empty-p">
            {#if listError}
              <LoadFailed message={listError} onretry={list} />
            {:else if running.length && !starting}
              {@render runningList()}
              <button class="btn small" onclick={() => void add()} data-testid="panel-pick-new"><Icon name="plus" size={16} /> {t('panel.newTerminal')}</button>
            {:else}
              <p class="dim">{starting ? t('common.loading') : t('panel.noTerminal')}</p>
              {#if !starting}<button class="btn small" onclick={() => void add()} data-testid="panel-term-new">{t('panel.newTerminal')}</button>{/if}
            {/if}
          </div>
        {/if}
      {:else if snapshot?.error}
        <p class="alert error small">{snapshot.error}</p>
      {:else if !snapshot}
        <p class="empty-p dim">{t('common.loading')}</p>
      {:else if sources.length}
        {#key sourcesKey}
          <LogView {sources} />
        {/key}
      {:else}
        <div class="empty-p">
          <p class="dim">{t('panel.noLogs')}</p>
          <button class="btn small" onclick={() => (choosing = true)} data-testid="panel-logs-empty-choose">{t('panel.choose')}</button>
        </div>
      {/if}
    </div>
  </section>
{/if}

{#snippet runningList()}
  <div class="stack running" data-testid="panel-running">
    <p class="dim small">{t('panel.running', { host: running[0]?.hostName ?? '' })}</p>
    <div class="list">
      {#each running as s (s.id)}
        <button class="list-item" onclick={() => openRunning(s.id)} data-session={s.id} data-testid="panel-running-open">
          <Icon name="terminal" size={18} />
          <span class="main">
            <span class="title">{sessionLabel(s, terms.list)}</span>
            <span class="sub">{[t('term.active', { when: relativeTime(s.lastActivityAt) }), s.mode === 'tmux' ? 'tmux' : t('term.memory')].join(' | ')}</span>
          </span>
        </button>
      {/each}
    </div>
  </div>
{/snippet}

<Dialog tour="panel-new" menu bind:open={newOpen} title={t('term.newTitle')}>
  <!-- Only while open: the closed dialog stays in the page, its rows twice over. -->
  {#if newOpen && running.length}{@render runningList()}{/if}
  <div class="stack" data-testid="panel-new-ways">
    <button class="btn primary" disabled={starting} onclick={() => void add()}><Icon name="plus" size={16} /> {t('hosts.newSession')}</button>
    <button class="btn small" disabled={starting} onclick={() => void add('always')} data-testid="panel-new-tmux"><Icon name="layers" size={16} /> {t('hosts.withTmux')}</button>
    <button class="btn small" disabled={starting} onclick={() => void add('never')}><Icon name="terminal" size={16} /> {t('hosts.withoutTmux')}</button>
  </div>
</Dialog>

<Dialog tour="panel-logs" bind:open={choosing} title={t('panel.chooseTitle')}>
  <p class="dim small">{autoHelp}</p>
  {#if containers.length > 8}
    <div class="tools">
      <input type="search" bind:value={filter} placeholder={t('panel.filter')} aria-label={t('panel.filter')} data-testid="panel-logs-filter" />
      <button type="button" class="btn small" onclick={() => pickAll(true)} data-testid="panel-logs-all">{t('pick.all')}</button>
      <button type="button" class="btn small" onclick={() => pickAll(false)} data-testid="panel-logs-none">{t('pick.none')}</button>
    </div>
  {/if}
  <div class="choices">
    {#each choices as c (c.name)}
      <label class="check" data-testid="panel-logs-choice">
        <input type="checkbox" checked={shownNames.includes(c.name)} onchange={(e) => toggle(c.name, e.currentTarget.checked)} />
        <span class="cname" title={c.name}>{c.name}</span>
        {#if auto(c)}<span class="badge">{t('panel.auto')}</span>{/if}
      </label>
    {:else}
      <p class="dim">{t('common.loading')}</p>
    {/each}
  </div>
  {#snippet actions()}
    <button class="btn" disabled={picked === null} onclick={() => (picked = null)} data-testid="panel-logs-auto">{t('panel.auto')}</button>
    <button class="btn primary" onclick={() => (choosing = false)}>{t('common.done')}</button>
  {/snippet}
</Dialog>

<style>
  .sources {
    gap: 6px;
  }
  /* A phone: the icon only (its words in its name). */
  @media (max-width: 599px) {
    .sources-text {
      display: none;
    }
  }
  /* Opened: it rises into place. */
  .panel {
    animation: rise-in var(--dur-2) var(--ease);
    flex: 0 0 calc(var(--frac) * 100%);
    min-height: 120px;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border);
    background: var(--bg);
  }
  /* Over the bottom of a page that scrolls: beside the rail, above the phone's tab bar. */
  .panel.dock {
    position: fixed;
    z-index: 15;
    left: var(--rail-w);
    right: 0;
    bottom: calc(var(--nav-h) + env(safe-area-inset-bottom));
    height: calc(var(--frac) * (100dvh - var(--nav-h) - env(safe-area-inset-bottom)));
    box-shadow: var(--shadow);
  }
  /* Little height left (the keyboard up) while typing in it: the panel takes
     the screen, as the terminal page keeps its height; docked again with the
     keyboard gone. Above the fraction it left three rows. Only typing: a
     button focused by a tap made it jump on a low phone screen, the row
     under the finger moved and the tap missed (report ffef5f). */
  @media (max-height: 520px) {
    .panel:has(:global(textarea:focus), :global(input:not([type='checkbox'], [type='radio'], [type='button']):focus)) {
      flex-basis: 100%;
    }
    .panel.dock:has(:global(textarea:focus), :global(input:not([type='checkbox'], [type='radio'], [type='button']):focus)) {
      z-index: 20;
      top: env(safe-area-inset-top);
      bottom: 0;
      height: auto;
    }
  }
  /* The edge to drag: thin to see, tall enough for a finger. */
  .grip {
    flex: none;
    height: 10px;
    margin-top: -5px;
    cursor: ns-resize;
    touch-action: none;
    position: relative;
  }
  .grip::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 3px;
    width: 40px;
    height: 4px;
    margin-left: -20px;
    border-radius: 2px;
    background: var(--border);
  }
  .grip:focus-visible::after {
    background: var(--accent);
  }
  @media (hover: hover) {
    .grip:hover::after {
      background: var(--accent);
    }
  }
  .pbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px 2px;
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }
  .seg {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .seg button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
    font: 600 0.85rem var(--font);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--bg-sunken);
    color: var(--text);
  }
  /* A phone: the tab not shown says its name by its icon only, so the
     terminal's own buttons stay in sight beside the tabs. */
  @media (max-width: 599px) {
    .seg button:not(.on) .tlabel {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
  .sessions {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .sessions .chip {
    flex: none;
    min-width: 30px;
    min-height: 28px;
    cursor: pointer;
  }
  .sessions .chip.on {
    border-color: var(--accent);
    color: var(--text);
  }
  /* A finger's room on a touch screen (AUDIT2 UX-04). */
  @media (pointer: coarse) {
    .seg button,
    .sessions .chip {
      min-height: 36px;
    }
  }
  .sessions :global(.btn) {
    width: auto;
    flex: none;
  }
  .pbody {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* The logs' search and filters off the panel's edges: against the file tree's line they read as part
     of it (report d31c8d). On the Logs page the page's own margin does this. */
  .pbody > :global(.logview) {
    padding-inline: 8px;
  }
  /* Running sessions to open: a readable column, left-aligned rows. */
  .running {
    width: min(100%, 480px);
    text-align: left;
  }
  /* In the middle when it fits; scrolling in the panel when not, at whatever height the panel has
     (report ffef5f: the running sessions below the panel's edge were out of reach). */
  .empty-p {
    margin: auto;
    min-height: 0;
    max-height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px;
    text-align: center;
  }
  .tools {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 8px;
  }
  .tools input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .tools .btn {
    flex: none;
    width: auto;
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 8px;
  }
  .choices .check {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
  }
  /* A container's name on one line, cut with "..." when it must be (its
     whole name in its title): "burrowtest-panel-" over "web-1" read as two. */
  .cname {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
