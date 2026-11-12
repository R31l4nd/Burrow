<script module lang="ts">
  // A right click on a tab behind: its page opens with its menu (the page is made anew per session).
  let menuOnOpen = false;
  function takeMenuOnOpen() {
    const open = menuOnOpen;
    menuOnOpen = false;
    return open;
  }
</script>

<script lang="ts">
  import { scrollCue } from '../lib/scrollcue.js';
  import { keyBars } from '../lib/keyboard.svelte.js';
  import { ask, askText } from '../lib/confirm.svelte.js';
  import { tick, untrack } from 'svelte';
  import { sessionLabel, type ShellState, type TerminalMode, type TerminalViewer, type UserSummary } from '@burrow/shared';
  import AskAi from '../components/AskAi.svelte';
  import Dialog from '../components/Dialog.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import Icon from '../components/Icon.svelte';
  import SessionList from '../components/SessionList.svelte';
  import SnippetPicker from '../components/SnippetPicker.svelte';
  import TermSession from '../components/TermSession.svelte';
  import { android } from '../lib/android.js';
  import { errorMessage, get } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go, to } from '../lib/router.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { closeSession, connectHost, loadSessions, newSession, prefs, recordSession, renameSession, shareSession, terms } from '../lib/sessions.svelte.js';
  import type { ConnState } from '../lib/terminal.js';
  import { broadcastable, maxPanes, moveTab, nextForPane, ordered, placeIn, readLayout, shownPanes, type SplitLayout } from '../lib/termsplit.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';

  // A session on the server: the WebSocket, the session tabs and menus.
  // The session itself (connection, completion, the terminal) is components/TermSession.svelte.
  // On a wide screen several side by side (F4): up to four panes, each its
  // own session; the one typed into is the active one, and the tabs, the
  // menus and the status line are about it.

  let { id: idProp }: { id: string } = $props();
  const id = untrack(() => idProp);

  // ---- the panes: kept on this device (a phone shows one)
  const SPLIT_KEY = 'burrow.termSplit';
  function storedLayout(): SplitLayout {
    try {
      return readLayout(JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null'));
    } catch {
      return readLayout(null);
    }
  }
  let layout = $state<SplitLayout>(storedLayout());
  function keepLayout() {
    try {
      localStorage.setItem(SPLIT_KEY, JSON.stringify(layout));
    } catch {
      // Not kept on this device; the panes hold for this page.
    }
  }
  // The session asked for: in the pane typed into last, unless shown already.
  if (!layout.panes.includes(id)) layout.panes = placeIn(layout.panes.length ? layout.panes : [id], Math.min(layout.at, Math.max(0, layout.panes.length - 1)), id);
  let active = $state(id);
  // The tab on screen in sight in its strip: with many sessions it was off to the right, none highlighted (UIB-03).
  let tabStrip: HTMLDivElement | undefined = $state();
  $effect(() => {
    void active;
    void tabs.length;
    const strip = tabStrip;
    if (!strip) return;
    requestAnimationFrame(() => {
      const tab = strip.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
      if (!tab) return;
      const a = strip.getBoundingClientRect();
      const r = tab.getBoundingClientRect();
      if (r.left < a.left) strip.scrollLeft -= a.left - r.left + 8;
      else if (r.right > a.right) strip.scrollLeft += r.right - a.right + 8;
    });
  });
  let listed = $state(false);
  const screen = $state({ w: typeof window !== 'undefined' ? innerWidth : 1280, h: typeof window !== 'undefined' ? innerHeight : 800 });
  $effect(() => {
    const on = () => ((screen.w = innerWidth), (screen.h = innerHeight));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  });
  const fit = $derived(maxPanes(screen.w, screen.h));
  const tabs = $derived(ordered(terms.list, layout.order));
  const shown = $derived(shownPanes(layout, listed ? terms.list.map((s) => s.id) : layout.panes, active, fit, layout.panes.indexOf(active)));
  const split = $derived(shown.length > 1);
  // One pane of a split shown alone for a while, the others kept connected
  // behind it (report 42f337; tmux's zoom, VS Code's maximised group).
  let zoomed = $state<string | null>(null);
  $effect(() => {
    if (zoomed && (!split || !shown.includes(zoomed))) zoomed = null;
  });
  function toggleZoom(pid: string) {
    zoomed = zoomed === pid ? null : pid;
    activate(pid);
  }

  // Each pane's session and what it says of itself.
  type PaneState = { mode: TerminalMode | null; shell: ShellState | null; viewers: TerminalViewer[]; connState: ConnState; owner: boolean; limited: boolean };
  let refs = $state<Record<string, TermSession | undefined>>({});
  let paneSt = $state<Record<string, PaneState>>({});
  $effect(() => {
    for (const p of shown) paneSt[p] ??= { mode: null, shell: null, viewers: [], connState: 'connecting', owner: true, limited: false };
  });
  const sess = $derived(refs[active]);
  const mode = $derived(paneSt[active]?.mode ?? null);
  const viewers = $derived(paneSt[active]?.viewers ?? []);
  const connState = $derived(paneSt[active]?.connState ?? 'connecting');
  const owner = $derived(paneSt[active]?.owner ?? true);
  const shell = $derived(paneSt[active]?.shell ?? null);
  const limited = $derived(paneSt[active]?.limited ?? false);
  // On a phone (report aa109d): the bar always compact and the labels only for
  // a warning, the same with the keyboard up or down; the bar grew, the labels
  // came back and the terminal moved each time it went down. "Lost on restart"
  // is no warning there: chosen when opening, said in the session list, and its
  // row took the terminal's room with the keyboard up for the whole session.
  const phone = $derived(keyBars.show);
  const warning = $derived(viewers.length > 1 || !owner || connState === 'reconnecting' || connState === 'connecting');

  /** Typing goes to this pane; the address follows without opening the page again. */
  function activate(pid: string) {
    if (pid === active) return;
    active = pid;
    layout.at = Math.max(0, shown.indexOf(pid));
    keepLayout();
    history.replaceState(history.state, '', `#/term/${pid}`);
  }
  /**
   * One session on screen. The page's own one by the router did nothing: the address had followed
   * another pane without the router, which still thought it was there (audit 2026-11-09).
   */
  function showOnly(sid: string) {
    if (sid !== id) return go(`/term/${sid}`);
    layout.panes = [sid];
    keepLayout();
    activate(sid);
  }
  /** A session from the tabs: in the active pane when split, else the page for it. */
  function pick(sid: string) {
    if (!split) return showOnly(sid);
    layout.panes = placeIn(shown, Math.max(0, shown.indexOf(active)), sid);
    keepLayout();
    activate(sid);
  }
  // One more pane: the first session not shown, else a new one on this host.
  let splitting = $state(false);
  async function addPane() {
    let next = nextForPane(shown, tabs.map((s) => s.id), fit);
    if (!next && shown.length < fit && info) {
      splitting = true;
      try {
        next = (await newSession(info.hostId)).id;
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        splitting = false;
      }
    }
    if (!next) return;
    layout.panes = [...shown, next];
    keepLayout();
    activate(next);
  }
  // Split already: the button is the layout (report 1d2fd4: it opened one
  // more session, which + is for). So many panes, from the open sessions;
  // a new session only when asked for.
  let layoutOpen = $state(false);
  const spare = $derived(tabs.map((s) => s.id).filter((id) => !shown.includes(id)));
  function splitPress() {
    if (split) layoutOpen = true;
    else void addPane();
  }
  function setPanes(n: number) {
    layoutOpen = false;
    if (n <= shown.length) {
      // The one typed into stays.
      const keep = [active, ...shown.filter((p) => p !== active)].slice(0, n);
      layout.panes = shown.filter((p) => keep.includes(p));
    } else layout.panes = [...shown, ...spare.slice(0, n - shown.length)];
    keepLayout();
    activate(layout.panes.includes(active) ? active : layout.panes[0]!);
  }
  async function newPane() {
    layoutOpen = false;
    if (!info) return;
    splitting = true;
    try {
      const id = (await newSession(info.hostId)).id;
      layout.panes = [...shown, id];
      keepLayout();
      activate(id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      splitting = false;
    }
  }
  /** A pane taken out (its session stays open, in the tabs). */
  function closePane(pid: string) {
    const at = shown.indexOf(pid);
    layout.panes = shown.filter((p) => p !== pid);
    if (pid === active) activate(layout.panes[Math.max(0, at - 1)]!);
    keepLayout();
  }
  // The dividers, dragged: a share of the width and of the height.
  let area: HTMLElement | undefined = $state();
  function drag(axis: 'x' | 'y', e: PointerEvent) {
    const el = area;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const move = (m: PointerEvent) => {
      const v = axis === 'x' ? (m.clientX - r.left) / r.width : (m.clientY - r.top) / r.height;
      layout[axis] = Math.min(0.8, Math.max(0.2, v));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      keepLayout();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function nudgeDivider(axis: 'x' | 'y', e: KeyboardEvent) {
    const step = e.key === (axis === 'x' ? 'ArrowLeft' : 'ArrowUp') ? -0.05 : e.key === (axis === 'x' ? 'ArrowRight' : 'ArrowDown') ? 0.05 : 0;
    if (!step) return;
    e.preventDefault();
    layout[axis] = Math.min(0.8, Math.max(0.2, Math.round((layout[axis] + step) * 100) / 100));
    keepLayout();
  }
  // A tab dragged onto another: the tabs' order, kept.
  let dragging: string | null = null;
  function dropTab(on: string) {
    if (!dragging) return;
    layout.order = moveTab(tabs.map((s) => s.id), dragging, on);
    dragging = null;
    keepLayout();
  }
  // Or the focused tab one place left or right with Ctrl+Shift and an arrow, as a workspace's (report 50a6f6).
  function tabKey(e: KeyboardEvent, id: string) {
    const by = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!by || !(e.ctrlKey || e.metaKey) || !e.shiftKey) return false;
    e.preventDefault();
    const ids = tabs.map((s) => s.id);
    const to = ids[ids.indexOf(id) + by];
    if (!to) return true;
    const btn = e.currentTarget as HTMLElement;
    layout.order = moveTab(ids, id, to);
    keepLayout();
    void tick().then(() => btn.focus());
    return true;
  }
  // Typing into every pane at once (N9): only switched on on purpose, a red
  // bar while it is on, off again when the panes are no longer split.
  let broadcast = $state(false);
  $effect(() => {
    if (!split) broadcast = false;
  });
  function typedIn(pid: string, data: string) {
    if (!broadcast || pid !== active || !broadcastable(data)) return;
    for (const p of shown) if (p !== pid) refs[p]?.send(data);
  }

  let switcherOpen = $state(takeMenuOnOpen());
  // A phone's width: the top bar keeps only the tabs and the menu.
  const narrowQuery = typeof window !== 'undefined' ? matchMedia('(max-width: 599px)') : null;
  const narrow = $state({ on: narrowQuery?.matches ?? false });
  $effect(() => {
    if (!narrowQuery) return;
    const on = () => (narrow.on = narrowQuery.matches);
    narrowQuery.addEventListener('change', on);
    return () => narrowQuery.removeEventListener('change', on);
  });
  let snippetsOpen = $state(false);
  let aiOpen = $state(false);
  let aiQuestion = $state('');

  const info = $derived(terms.list.find((s) => s.id === active));
  const host = $derived(data.hosts.find((h) => h.id === info?.hostId));
  const index = $derived(tabs.findIndex((s) => s.id === active));

  if (!data.loaded) inBackground(loadAll());
  // The list of sessions not read: said with Try again; the panes kept as they were laid out (A3-WEB-01).
  let listError = $state('');
  function readList() {
    listError = '';
    loadSessions().then(
      () => (listed = true),
      (err: unknown) => (listError = errorMessage(err)),
    );
  }
  readList();

  function openAi(question = '') {
    aiQuestion = question;
    aiOpen = true;
  }

  function useAiCommand(command: string) {
    aiOpen = false;
    // No Enter: running it is the user's decision.
    sess?.insertCommand(command);
  }

  function switchBy(step: number) {
    const list = tabs;
    if (list.length < 2 || index < 0) return;
    const next = list[(index + step + list.length) % list.length]!;
    pick(next.id);
  }

  // One close at a time: it waits for the host to end its tmux session, and a second
  // Delete meanwhile asked to close the same tab again.
  let closing = false;
  async function closeThis() {
    if (closing) return;
    if (!(await ask({ text: t('term.confirmClose', { name: info ? sessionLabel(info, terms.list) : '' }), confirm: t('term.close'), danger: true }))) return;
    closing = true;
    try {
      const gone = active;
      const rest = shown.filter((p) => p !== gone);
      await closeSession(gone);
      // Split: another pane takes over; else the next session's page.
      if (rest.length) {
        layout.panes = rest;
        keepLayout();
        activate(rest[0]!);
        return;
      }
      const next = tabs[0];
      if (next) showOnly(next.id);
      else go('/hosts');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      closing = false;
    }
  }

  // A long press on the tab in front renames it (a phone has no double click).
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let pressed = false;
  function hold() {
    pressed = false;
    holdTimer = setTimeout(() => {
      pressed = true;
      void rename();
    }, 550);
  }
  function letGo() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    setTimeout(() => (pressed = false), 0);
  }
  // A right click on a tab: that one in front and its menu (rename, share, close), as tabs on a computer
  // do (report 076380). A finger's hold sends a context menu too on Android (report fa1a85): there the
  // hold renames, no menu over it.
  let tabPointer = 'mouse';
  function tabMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    if (tabPointer !== 'mouse') return;
    letGo();
    if (id === active) return void (switcherOpen = true);
    menuOnOpen = !split;
    pick(id);
    if (split) switcherOpen = true;
  }

  async function newHere() {
    if (plusHeld) return void (plusHeld = false);
    const hid = info?.hostId ?? host?.id;
    if (!hid) return go('/hosts');
    try {
      await connectHost(hid, true);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // Held on +: which host, and how (the host's way, with or without tmux,
  // or straight from the phone).
  let newOpen = $state(false);
  let newHost = $state<number | null>(null);
  let newBusy = $state(false);
  let plusHeld = false;
  let plusTimer: ReturnType<typeof setTimeout> | null = null;
  let directIds = $state<number[]>([]);
  function plusDown() {
    plusHeld = false;
    plusTimer = setTimeout(() => {
      plusHeld = true;
      newHost = info?.hostId ?? host?.id ?? data.hosts[0]?.id ?? null;
      newOpen = true;
    }, 550);
  }
  function plusUp() {
    if (plusTimer) clearTimeout(plusTimer);
    plusTimer = null;
  }
  $effect(() => {
    const dev = session.state?.deviceId;
    if (!android || !dev || !newOpen) return;
    void get<{ hostIds: number[] }>(`/api/account/devices/${dev}/hosts`).then(
      (r) => (directIds = r.hostIds),
      () => {},
    );
  });
  async function openNew(tmux?: 'always' | 'never') {
    if (newHost === null) return;
    newBusy = true;
    try {
      await connectHost(newHost, true, undefined, tmux);
      newOpen = false;
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      newBusy = false;
    }
  }

  async function rename() {
    switcherOpen = false;
    const title = await askText({ text: t('term.rename'), confirm: t('term.renameOk'), input: { label: t('term.renameLabel'), value: info?.title ?? '', max: 40 }, empty: true });
    if (title === null) return;
    try {
      await renameSession(active, title);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // Shared to watch, read-only, with Burrow users picked here (F3).
  let shareOpen = $state(false);
  let shareUsers = $state<UserSummary[]>([]);
  let sharePicked = $state<Set<number>>(new Set());
  async function openShare() {
    switcherOpen = false;
    try {
      const me = session.state?.user?.id;
      shareUsers = (await get<UserSummary[]>('/api/users')).filter((u) => u.id !== me && !u.incomplete);
      sharePicked = new Set(info?.sharedWith ?? []);
      shareOpen = true;
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  async function saveShare() {
    try {
      await shareSession(active, [...sharePicked]);
      shareOpen = false;
      toast(sharePicked.size ? t('term.shared', { n: sharePicked.size }) : t('term.unshared'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  async function toggleRecording(on: boolean) {
    switcherOpen = false;
    try {
      await recordSession(active, on);
      toast(on ? t('term.recordOn') : t('term.recordOff'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function reopen() {
    if (!info && !host) return go('/hosts');
    try {
      await connectHost(info?.hostId ?? host!.id, true);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

<div class="term-page" class:phone>
  <header class="term-top">
    <button class="icon-btn" aria-label={t('nav.hosts')} onclick={() => go('/hosts')}><Icon name="back" /></button>
    <div use:scrollCue class="tabs" role="tablist" bind:this={tabStrip}>
      {#each tabs as s (s.id)}
        <!-- Its own name, or the host's: "test-sshd", "test-sshd 2". The one
             in front: renamed by a double click or a long press; a right click
             brings it in front with its menu (report 076380). -->
        <button
          role="tab"
          class="tab"
          class:active={s.id === active}
          class:shown={split && s.id !== active && shown.includes(s.id)}
          aria-selected={s.id === active}
          title={s.id === active ? t('term.tabHint') : s.title ? s.hostName : undefined}
          draggable={!narrow.on}
          ondragstart={(e) => ((dragging = s.id), e.dataTransfer?.setData('text/plain', s.id))}
          ondragover={(e) => dragging && e.preventDefault()}
          ondrop={(e) => (e.preventDefault(), dropTab(s.id))}
          onclick={() => !pressed && pick(s.id)}
          ondblclick={() => s.id === active && void rename()}
          onpointerdown={(e) => ((tabPointer = e.pointerType), e.button === 0 && s.id === active && hold())}
          oncontextmenu={(e) => tabMenu(e, s.id)}
          onpointerup={letGo}
          onpointerleave={letGo}
          onkeydown={(e) => tabKey(e, s.id) || (s.id === active && e.key === 'Delete' && void closeThis())}
          data-testid="term-tab"
        >
          {sessionLabel(s, terms.list)}
          <!-- Close the one in front, in its own tab (asked first). A part of
               the tab, not a button in it: the Delete key does the same, and
               the sessions menu has "Close this session". -->
          {#if s.id === active}<span
              class="tab-x"
              aria-hidden="true"
              title={t('term.closeNamed', { name: sessionLabel(s, terms.list) })}
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => (e.stopPropagation(), void closeThis())}
              data-testid="term-tab-close"><Icon name="close" size={14} /></span
            >{/if}
        </button>
      {/each}
    </div>
    <!-- One more session on this host, at once; held: which host and how. -->
    {#if info || host}
      <button
        class="icon-btn"
        aria-label={t('term.newHere')}
        title={t('term.newHint')}
        onpointerdown={plusDown}
        onpointerup={plusUp}
        onpointerleave={plusUp}
        oncontextmenu={(e) => e.preventDefault()}
        onclick={newHere}
        data-testid="term-new"><Icon name="plus" /></button
      >
    {/if}
    <!-- Room for another pane (a wide screen): one more terminal beside it. -->
    {#if fit > 1 && (info || host)}
      <button class="icon-btn" disabled={splitting || (!split && shown.length >= fit)} aria-label={split ? t('term.layout') : t('term.split')} title={split ? t('term.layout') : t('term.split')} onclick={splitPress} data-testid="term-split"><Icon name="columns" /></button>
    {/if}
    <span class="grow"></span>
    <!-- On a phone these three are in the menu: the tabs need the width. -->
    {#if !narrow.on}
      {#if host?.hasPassword}
        <button
          class="icon-btn"
          aria-label={t('term.pastePassword')}
          title={t('term.pastePassword')}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => {
            sess?.sendPassword();
          }}><Icon name="key" /></button
        >
      {/if}
      <button class="icon-btn" aria-label={t('ai.title')} title={t('ai.title')} onclick={() => openAi()}><Icon name="sparkle" /></button>
      <button class="icon-btn" aria-label={t('term.snippets')} title={t('term.snippets')} onclick={() => (snippetsOpen = true)}><Icon name="bolt" /></button>
    {/if}
    <!-- Its sessions and the tools for this one (search, text box, share, record): named for both (W-FUNC-12). -->
    <button class="icon-btn" aria-label={t('term.menu')} title={t('term.menu')} onclick={() => (switcherOpen = true)}><Icon name="more" /></button>
  </header>

  {#if !phone || warning}<div class="status-row">
    <!-- In the Android app: which route this session takes (the other is "Direct"). -->
    {#if android && !phone}<span class="badge" data-testid="route-burrow">{t('term.viaBurrow')}</span>{/if}
    {#if mode === 'memory' && !phone}
      <span class="badge warn" data-testid="memory-badge">{t('term.memory')}</span>
      <HelpTip text={t('help.memoryMode')} />
    {:else if mode === 'tmux' && !phone}
      <span class="badge">tmux</span>
    {/if}
    {#if limited && !shell?.integration && !phone}
      <span class="badge" data-testid="limited-badge">{t('term.limited')}</span>
      <HelpTip text={t('help.limited')} />
    {/if}
    {#if viewers.length > 1}<span class="badge" data-testid="viewer-count">{t('term.devices', { n: viewers.length })}</span>{/if}
    {#if !owner}<span class="badge">{t('term.otherSize')}</span>{/if}
    {#if connState === 'reconnecting' || connState === 'connecting'}<span class="badge">{t('term.connecting')}</span>{/if}
  </div>{/if}

  {#if listError}
    <div class="alert error small listfail" role="alert">
      <span>{t('term.listFailed', { error: listError })}</span>
      <button class="btn small" onclick={readList}>{t('common.retry')}</button>
    </div>
  {/if}
  {#if broadcast}
    <!-- Every key goes to every pane: said in red, with the way out, all the time it is on. -->
    <div class="broadcast" role="status" data-testid="broadcast-bar">
      <Icon name="alert" size={16} />
      <span>{t('term.broadcastOn', { n: shown.length })}</span>
      <button class="btn small" onclick={() => ((broadcast = false), sess?.focus())} data-testid="broadcast-stop">{t('term.broadcastStop')}</button>
    </div>
  {/if}

  <div class="split-area" bind:this={area}>
    <!-- Split on purpose: the panes together are the main content (e2e checks: data-split). -->
    <div class="panes n{shown.length}" class:zoomed={!!zoomed} style:--x={layout.x} style:--y={layout.y} data-split={split ? '' : undefined} data-testid="term-panes">
      {#each shown as pid (pid)}
        {@const ps = paneSt[pid]}
        {@const ses = terms.list.find((x) => x.id === pid)}
        <section class="pane" class:active={split && pid === active} class:alone={zoomed === pid} aria-label={ses ? sessionLabel(ses, terms.list) : t('term.sessions')} onpointerdowncapture={() => activate(pid)} onfocusin={() => activate(pid)} data-testid="term-pane">
          {#if split}
            <!-- svelte-ignore a11y_no_static_element_interactions (a double click is a shortcut; the button beside it does the same) -->
            <div class="pane-head" ondblclick={() => toggleZoom(pid)}>
              <span class="pane-name">{ses ? sessionLabel(ses, terms.list) : ''}</span>
              <button class="icon-btn small" aria-pressed={zoomed === pid} aria-label={zoomed === pid ? t('term.paneRestore') : t('term.paneZoom')} title={zoomed === pid ? t('term.paneRestore') : t('term.paneZoom')} onclick={(e) => (e.stopPropagation(), toggleZoom(pid))} data-testid="term-pane-zoom"
                ><Icon name={zoomed === pid ? 'minimize' : 'maximize'} size={14} /></button
              >
              <button class="icon-btn small" aria-label={t('term.paneClose')} title={t('term.paneClose')} onclick={(e) => (e.stopPropagation(), closePane(pid))} data-testid="term-pane-close"><Icon name="close" size={14} /></button>
            </div>
          {/if}
          {#if ps}
            {#if ps.connState === 'ended'}
              <div class="ended stack">
                <p>{t('term.ended')}</p>
                <button class="btn primary" onclick={reopen}>{t('term.newSession')}</button>
                <button class="btn" onclick={() => go('/hosts')}>{t('nav.hosts')}</button>
              </div>
            {/if}
            <TermSession
              bind:this={refs[pid]}
              id={pid}
              bind:mode={ps.mode}
              bind:shell={ps.shell}
              bind:viewers={ps.viewers}
              bind:connState={ps.connState}
              bind:owner={ps.owner}
              bind:limited={ps.limited}
              onswipe={split ? null : switchBy}
              onai={openAi}
              ontyped={(d) => typedIn(pid, d)}
            />
          {/if}
        </section>
      {/each}
    </div>
    {#if split && !zoomed}
      <!-- The dividers: dragged, or moved with the arrow keys (none while one pane is alone). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator is the ARIA window splitter: dragged, or moved with the arrow keys) -->
      <div class="divider x" role="separator" aria-orientation="vertical" aria-label={t('term.divider')} aria-valuenow={Math.round(layout.x * 100)} aria-valuemin={20} aria-valuemax={80} tabindex="0" style:left="calc({layout.x * 100}% - 4px)" onpointerdown={(e) => drag('x', e)} onkeydown={(e) => nudgeDivider('x', e)} data-testid="term-divider-x"></div>
      {#if shown.length > 2}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator is the ARIA window splitter: dragged, or moved with the arrow keys) -->
        <div class="divider y" role="separator" aria-orientation="horizontal" aria-label={t('term.dividerRows')} aria-valuenow={Math.round(layout.y * 100)} aria-valuemin={20} aria-valuemax={80} tabindex="0" style:top="calc({layout.y * 100}% - 4px)" onpointerdown={(e) => drag('y', e)} onkeydown={(e) => nudgeDivider('y', e)} data-testid="term-divider-y"></div>
      {/if}
    {/if}
  </div>
</div>

<Dialog tour="term-layout" bind:open={layoutOpen} title={t('term.layout')}>
  <div class="stack" data-testid="term-layout">
    {#each Array.from({ length: fit }, (_, i) => i + 1) as n (n)}
      <button class="btn" aria-pressed={shown.length === n} disabled={n > shown.length + spare.length} onclick={() => setPanes(n)} data-testid="term-layout-n">{t('term.layoutN', { n })}</button>
    {/each}
    {#if shown.length + spare.length < fit}
      <p class="dim small">{t('term.layoutFew')}</p>
      <button class="btn" disabled={splitting} onclick={() => void newPane()} data-testid="term-layout-new">{t('term.layoutNew')}</button>
    {/if}
  </div>
</Dialog>

<Dialog tour="terminal-sessions" bind:open={switcherOpen} title={t('term.menu')}>
  {#if narrow.on}
    <!-- The top bar's buttons, on a phone (there the tabs take its width). -->
    <div class="menu-actions">
      <button class="btn" onclick={() => ((switcherOpen = false), (snippetsOpen = true))}><Icon name="bolt" size={18} /> {t('term.snippets')}</button>
      <button class="btn" onclick={() => ((switcherOpen = false), openAi())}><Icon name="sparkle" size={18} /> {t('ai.title')}</button>
      {#if host?.hasPassword}
        <button
          class="btn"
          onclick={() => {
            switcherOpen = false;
            sess?.sendPassword();
          }}><Icon name="key" size={18} /> {t('term.pastePassword')}</button
        >
      {/if}
    </div>
  {/if}
  <SessionList current={active} currentViewers={viewers} onpick={(sid) => ((switcherOpen = false), pick(sid))} />
  {#if split}
    <label class="check">
      <input type="checkbox" bind:checked={broadcast} onchange={() => (switcherOpen = false)} data-testid="broadcast-toggle" />
      {t('term.broadcast', { n: shown.length })}
      <HelpTip text={t('help.broadcast')} />
    </label>
  {/if}
  <button class="btn" onclick={() => ((switcherOpen = false), sess?.openSearch())} data-testid="term-search-open"><Icon name="search" size={18} /> {t('term.search')}{#if !keyBars.show}<span class="kbd-hint"> (Ctrl+Shift+F)</span>{/if}</button>
  <label class="check">
    <input type="checkbox" checked={prefs.compose} onchange={() => ((switcherOpen = false), sess?.toggleCompose())} data-testid="compose-toggle" />
    {t('term.composeMode')}
    <HelpTip text={t('help.composeMode')} />
  </label>
  <div class="row">
    <button class="btn small" onclick={() => sess?.zoom(-1)} aria-label={t('term.smaller')}>A-</button>
    <button class="btn small" onclick={() => sess?.zoom(1)} aria-label={t('term.larger')}>A+</button>
  </div>
  {#if info}
    <button class="btn" onclick={() => ((switcherOpen = false), go(to(`/files/${info!.hostId}`, { p: shell?.cwd ?? '~' })))} data-testid="files-here"><Icon name="folder" size={18} /> {t('term.filesHere')}</button>
  {/if}
  {#if info}<button class="btn" onclick={rename} data-testid="term-rename"><Icon name="edit" size={18} /> {t('term.rename')}</button>{/if}
  {#if info}
    <button class="btn" onclick={openShare} data-testid="term-share"><Icon name="user" size={18} /> {info.sharedWith.length ? t('term.sharedWith', { n: info.sharedWith.length }) : t('term.share')}</button>
    <label class="check">
      <input type="checkbox" checked={info.recording} onchange={(e) => toggleRecording(e.currentTarget.checked)} data-testid="term-record" />
      {t('term.record')}
      <HelpTip text={t('help.record')} />
    </label>
  {/if}
  <button class="btn danger" onclick={closeThis}><Icon name="close" size={18} /> {t('term.closeThis')}</button>
</Dialog>

<Dialog tour="terminal-share" bind:open={shareOpen} title={t('term.shareTitle')}>
  <p class="dim small">{t('term.shareHint')}</p>
  {#if shareUsers.length}
    <div class="stack" data-testid="share-users">
      {#each shareUsers as u (u.id)}
        <label class="check">
          <input type="checkbox" checked={sharePicked.has(u.id)} onchange={(e) => { const next = new Set(sharePicked); if (e.currentTarget.checked) next.add(u.id); else next.delete(u.id); sharePicked = next; }} data-testid="share-user" />
          {u.username} <span class="dim small">{t(`users.role.${u.role}`)}</span>
        </label>
      {/each}
    </div>
  {:else}
    <p class="small" data-testid="share-none">{t('term.shareNone')}</p>
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => (shareOpen = false)}>{t('common.cancel')}</button>
    <button class="btn primary" disabled={!shareUsers.length} onclick={saveShare} data-testid="share-save">{t('common.save')}</button>
  {/snippet}
</Dialog>

<Dialog tour="terminal-new" menu bind:open={newOpen} title={t('term.newTitle')}>
  <label class="field">
    <span>{t('term.newHost')}</span>
    <select bind:value={newHost} data-testid="new-host">
      {#each data.hosts as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
    </select>
  </label>
  <div class="stack" data-testid="new-ways">
    <button class="btn primary" disabled={newBusy || newHost === null} onclick={() => openNew()} data-testid="new-default"><Icon name="plus" size={16} /> {t('hosts.newSession')}</button>
    <button class="btn small" disabled={newBusy || newHost === null} onclick={() => openNew('always')} data-testid="new-tmux"><Icon name="layers" size={16} /> {t('hosts.withTmux')}</button>
    <button class="btn small" disabled={newBusy || newHost === null} onclick={() => openNew('never')} data-testid="new-memory"><Icon name="terminal" size={16} /> {t('hosts.withoutTmux')}</button>
    {#if android && newHost !== null && directIds.includes(newHost)}
      <button class="btn small" onclick={() => ((newOpen = false), void android?.openDirect(newHost!))} data-testid="new-direct"><Icon name="phone" size={16} /> {t('hosts.directSession')}</button>
    {/if}
  </div>
</Dialog>

<Dialog tour="terminal-ai" size="wide" bind:open={aiOpen} title={t('ai.title')}>
  {#if aiOpen && info}
    <AskAi hostId={info.hostId} cwd={shell?.cwd ?? null} initial={aiQuestion} sessionId={info.id} onuse={useAiCommand} />
  {/if}
</Dialog>

<Dialog tour="terminal-snippets" bind:open={snippetsOpen} title={t('term.snippets')}>
  {#if snippetsOpen}
    <SnippetPicker
      host={host ?? null}
      onuse={(cmd, run) => {
        snippetsOpen = false;
        sess?.typeLine(cmd, run);
      }}
    />
  {/if}
</Dialog>

<style>
  .term-page {
    position: fixed;
    /* Beside the narrow rail on a computer (none on a phone). */
    inset: 0 0 0 var(--rail-w);
    display: flex;
    flex-direction: column;
    background: var(--bg);
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .term-top {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    border-bottom: 1px solid var(--border);
  }
  /* The tabs, then X and + right beside them; the other buttons at the end. */
  .tabs {
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 4px 2px;
  }
  .grow {
    flex: 1;
  }
  .tab {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    white-space: nowrap;
  }
  /* The session in front: dark on light (light on dark), the accent kept
     for actions. */
  .tab.active {
    background: var(--text);
    border-color: var(--text);
    color: var(--bg-raised);
    font-weight: 700;
    padding-right: 2px;
  }
  /* The close mark in the tab in front: a finger's room around a small sign. */
  .tab-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin: -4px 0;
    border-radius: 4px;
    opacity: 0.8;
  }
  @media (hover: hover) {
    .tab-x:hover {
      opacity: 1;
    }
  }
  /* 24 px to look at; on a touch screen it is hit in 36 (AUDIT2 UX-04). */
  @media (pointer: coarse) {
    .tab-x {
      position: relative;
    }
    .tab-x::after {
      content: '';
      position: absolute;
      inset: -6px;
    }
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    min-height: 28px;
    flex-wrap: wrap;
  }
  /* Little height left (the keyboard up): the terminal keeps it. The
     labels go, and the bar with the way back and the tabs gets compact
     (36 px, a finger's least); they come back with the keyboard gone. With
     15 rows a program's own input line (an assistant in a tmux) fell off
     the top. The bar itself stays on a foldable's inner screen (698 x 355):
     without it there was no way back nor to another session while typing
     (report ce0acd), and the terminal keeps its rows anyway (the part with
     the cursor in sight, TermView). Only a phone turned on its side (some
     260 px) leaves too little for it: there nothing of the terminal showed. */
  @media (max-height: 480px) {
    .term-page:not(.phone) .status-row {
      display: none;
    }
    .term-top {
      padding: 0 4px;
    }
    .term-top :global(.icon-btn) {
      width: 36px;
      height: 36px;
    }
    .tabs {
      padding: 2px;
    }
    .tab {
      padding: 2px 8px;
    }
  }
  /* A phone: that compact bar whatever the keyboard does, so nothing changes
     size when it comes or goes (report aa109d). */
  .phone .term-top {
    padding: 0 4px;
  }
  .phone .term-top :global(.icon-btn) {
    width: 36px;
    height: 36px;
  }
  .phone .tabs {
    padding: 2px;
  }
  .phone .tab {
    padding: 2px 8px;
  }
  @media (max-height: 300px) {
    .term-top {
      display: none;
    }
  }
  .status-row:empty {
    display: none;
  }
  /* Each label on one line: "verloren bij herstart" was squeezed over two
     and cut off (report 854cb3). */
  .status-row > :global(.badge) {
    flex: none;
    white-space: nowrap;
  }
  .badge.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .ended {
    padding: 16px;
  }
  .listfail {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 10px;
  }
  .listfail span {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* Try again as wide as its words: on a touch screen a button fills its line, and here it took the
     line from the words, one word a line on a folded-open phone (report a3c513). */
  .listfail .btn {
    flex: none;
    width: auto;
  }
  /* Tabs that are in another pane: marked, not in front. */
  .tab.shown {
    border-color: var(--text-dim);
    color: var(--text);
  }
  .broadcast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--danger);
    color: var(--on-danger);
    font-weight: 700;
    font-size: 0.85rem;
  }
  .broadcast .btn {
    margin-left: auto;
  }
  .split-area {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .panes {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: grid;
    gap: 4px;
  }
  .panes.n1 {
    display: flex;
  }
  .panes.n2 {
    grid-template-columns: calc(var(--x) * 100% - 2px) minmax(0, 1fr);
  }
  .panes.n3,
  .panes.n4 {
    grid-template-columns: calc(var(--x) * 100% - 2px) minmax(0, 1fr);
    grid-template-rows: calc(var(--y) * 100% - 2px) minmax(0, 1fr);
  }
  .panes.n3 > .pane:nth-child(3) {
    grid-column: 1 / span 2;
  }
  /* One pane alone: it takes the whole area; the others stay (connected), out of sight. */
  .panes.zoomed {
    display: flex;
  }
  .panes.zoomed > .pane:not(.alone) {
    display: none;
  }
  .pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    outline: 1px solid var(--border);
  }
  /* Suggestions only where typing goes: the others kept their row (no jump), empty. */
  .panes:not(.n1) > .pane:not(.active) :global(.suggest > *) {
    visibility: hidden;
  }
  /* That row blank: part of its terminal, not a white band under it. */
  .panes:not(.n1) > .pane:not(.active) :global(.suggest) {
    background: var(--bg-sunken);
    border-top-color: transparent;
  }
  /* The pane typed into. */
  .pane.active {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 2px 0 8px;
    font-size: 0.8rem;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
  }
  .pane.active .pane-head {
    color: var(--text);
    font-weight: 700;
  }
  .pane-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Thin to see, wide enough to take hold of. */
  .divider {
    position: absolute;
    z-index: 2;
    touch-action: none;
  }
  .divider.x {
    top: 0;
    bottom: 0;
    width: 8px;
    cursor: col-resize;
  }
  .divider.y {
    left: 0;
    right: 0;
    height: 8px;
    cursor: row-resize;
  }
  .divider:focus-visible {
    background: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  @media (hover: hover) {
    .divider:hover {
      background: color-mix(in srgb, var(--accent) 40%, transparent);
    }
  }
  .menu-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
