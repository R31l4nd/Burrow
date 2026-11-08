<script lang="ts">
  import { scrollCue } from '../lib/scrollcue.js';
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { keepFresh } from '../lib/keepfresh.js';
  import { lastSeen, remember } from '../lib/lastseen.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import HelpTip from '../components/HelpTip.svelte';
  import WorkspaceList from '../components/WorkspaceList.svelte';
  import { android, androidInfo } from '../lib/android.js';
  import { untrack } from 'svelte';
  import type { Bookmark, DirListing, FileAccessRule, FileEntry } from '@burrow/shared';
  import { phoneFavorites } from '../lib/phonefavorites.svelte.js';
  import Dialog from '../components/Dialog.svelte';
  import FileSheet from '../components/FileSheet.svelte';
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import Viewer from '../components/Viewer.svelte';
  import { ApiFailure, del, errorMessage, get, post } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { clearClipboard, clipboard, formatBytes, openKind, pasteInto, rawUrl, setClipboard } from '../lib/files.svelte.js';
  import { dragsFiles, droppedFiles, uploadInto } from '../lib/uploadinto.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { go, route, to } from '../lib/router.svelte.js';
  import { connectHost } from '../lib/sessions.svelte.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';
  import { footBar } from '../lib/footbar.js';

  // One folder on one host. The route carries both (#/files/<host>?p=<path>),
  // so back and forward in the browser walk the folders.

  // The selection or clipboard bar's height while it is shown (0 when not).
  let barH = $state(0);
  let { hostId: hostProp }: { hostId: number | null } = $props();
  const hostId = untrack(() => hostProp);
  const wanted = untrack(() => route.query.p ?? '~');

  const PREFS_KEY = 'burrow.files';
  function readPrefs(): { hidden: boolean; sort: 'name' | 'size' | 'mtime'; grid: boolean } {
    try {
      return { hidden: false, sort: 'name', grid: false, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as object) };
    } catch {
      return { hidden: false, sort: 'name', grid: false };
    }
  }
  const prefs = $state(readPrefs());
  $effect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Not remembered; fine.
    }
  });

  let listing = $state<DirListing | null>(null);
  let error = $state('');
  let loading = $state(false);
  let selected = $state<Set<string>>(new Set());
  let sheetItem = $state<FileEntry | null>(null);
  let sheetOpen = $state(false);
  let viewerIndex = $state<number | null>(null);
  let bookmarks = $state<Bookmark[]>([]);
  // The start page: every host's favourite folders.
  let allBookmarks = $state<Bookmark[]>([]);
  $effect(() => {
    if (hostId === null) void get<Bookmark[]>('/api/files/bookmarks').then((b) => (allBookmarks = b)).catch(() => {});
  });
  let searchOpen = $state(false);
  let searchName = $state('');
  let searchResults = $state<string[] | null>(null);
  let newOpen = $state<'file' | 'dir' | null>(null);
  let newName = $state('');
  let fileInput: HTMLInputElement | undefined = $state();

  const host = $derived(data.hosts.find((h) => h.id === hostId));
  // In the Android app: the phone itself, beside the hosts (its folders the person grants, PhoneFiles).
  let phoneFiles = $state(false);
  if (android && hostId === null) void androidInfo().then((i) => (phoneFiles = !!i?.phoneFiles));
  if (!data.loaded) inBackground(loadAll());

  // An upload started elsewhere (the share page) finished into this folder.
  $effect(() => {
    const onUploaded = (e: Event) => {
      const d = (e as CustomEvent<{ hostId: number; dir: string }>).detail;
      if (d.hostId === hostId && d.dir === listing?.path) void load();
    };
    window.addEventListener('burrow:uploaded', onUploaded);
    return () => window.removeEventListener('burrow:uploaded', onUploaded);
  });

  // An operator's folders (W-FUNC-05, decision 14): the hosts they may open here, each at its folders;
  // null for an admin (everything). Read once.
  let mine = $state<FileAccessRule[] | null | undefined>(undefined);
  const myFolders = (id: number) => (mine?.find((r) => r.hostId === id)?.allow ?? []).filter((f) => !mine!.find((r) => r.hostId === id)!.deny.includes(f));
  const myAccess = get<{ rules: FileAccessRule[] | null }>('/api/files/access').then(
    (r) => (mine = r.rules),
    () => (mine = null),
  );
  // Refused here: the folders this person may open, to go to (it was a sentence to read and nothing to tap).
  let refusedOpen = $state<string[]>([]);

  async function load(path = listing?.path ?? wanted) {
    if (hostId === null) return;
    loading = true;
    error = '';
    refusedOpen = [];
    try {
      const l = await get<DirListing>(`/api/files/${hostId}/list?path=${encodeURIComponent(path)}`);
      // Kept by what was asked and by where it is ("~" and /home/you alike).
      remember(`files:${hostId}:${path}`, l);
      listing = remember(`files:${hostId}:${l.path}`, l);
      selected = new Set();
      rememberRecent(listing.path);
    } catch (err) {
      error = errorMessage(err);
      if (err instanceof ApiFailure && err.code === 'no_file_access') {
        await myAccess;
        refusedOpen = myFolders(hostId);
        // The host opened at its home, which this operator may not read: their first folder instead.
        if (path === '~' && refusedOpen.length) return load(refusedOpen[0]);
      }
    } finally {
      loading = false;
    }
  }
  // Pulled down on a phone: this folder read again.
  $effect(() => pullToRefresh(() => load()));
  // And by itself, when the page is seen again and every few seconds while it is (report 905455, as a
  // workspace's tree): quietly, the selection kept, a failed read leaving the list as it was.
  async function freshen() {
    if (hostId === null || !listing || loading) return;
    const at = listing.path;
    const l = await get<DirListing>(`/api/files/${hostId}/list?path=${encodeURIComponent(at)}`).catch(() => null);
    if (!l || listing?.path !== at || loading) return;
    const sig = (d: DirListing) => d.entries.map((e) => `${e.name}|${e.type}|${e.size}|${e.mtime}|${e.mode}`).join('\n');
    if (sig(l) === sig(listing)) return;
    listing = remember(`files:${hostId}:${l.path}`, l);
    const still = new Set(l.entries.map((e) => e.path));
    selected = new Set([...selected].filter((p) => still.has(p)));
  }
  $effect(() => keepFresh(() => void freshen()));

  if (hostId !== null) {
    listing = lastSeen<DirListing>(`files:${hostId}:${wanted}`);
    void load(wanted);
    get<Bookmark[]>(`/api/files/${hostId}/bookmarks`)
      .then((b) => (bookmarks = b))
      .catch(() => {});
  }

  // ---- recent folders, per device

  const RECENT_KEY = 'burrow.files.recent';
  function recents(): string[] {
    try {
      return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>)[String(hostId)] ?? [];
    } catch {
      return [];
    }
  }
  let recent = $state<string[]>(recents());
  function rememberRecent(path: string) {
    try {
      const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>;
      const list = [path, ...(all[String(hostId)] ?? []).filter((p) => p !== path)].slice(0, 8);
      all[String(hostId)] = list;
      localStorage.setItem(RECENT_KEY, JSON.stringify(all));
      recent = list;
    } catch {
      // Not remembered.
    }
  }

  // ---- what is shown

  const entries = $derived.by(() => {
    const list = (listing?.entries ?? []).filter((e) => prefs.hidden || !e.name.startsWith('.'));
    const dirFirst = (e: FileEntry) => (e.type === 'dir' || e.targetType === 'dir' ? 0 : 1);
    return [...list].sort((a, b) => {
      const d = dirFirst(a) - dirFirst(b);
      if (d) return d;
      if (prefs.sort === 'size') return b.size - a.size;
      if (prefs.sort === 'mtime') return b.mtime.localeCompare(a.mtime);
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  });
  const images = $derived(entries.filter((e) => e.type !== 'dir' && openKind(e.name) === 'image'));
  const crumbs = $derived.by(() => {
    const p = listing?.path ?? '/';
    const parts = p.split('/').filter(Boolean);
    return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))];
  });
  const isDir = (e: FileEntry) => e.type === 'dir' || (e.type === 'link' && e.targetType === 'dir');

  function nav(path: string) {
    go(to(`/files/${hostId}`, { p: path }));
  }

  function open(e: FileEntry) {
    if (selected.size) return toggle(e);
    if (isDir(e)) return nav(e.path);
    const kind = openKind(e.name);
    if (kind === 'text') return go(to(`/edit/${hostId}`, { p: e.path }));
    if (kind === 'image') {
      viewerIndex = images.findIndex((x) => x.path === e.path);
      return;
    }
    if (kind === 'video' || kind === 'audio') {
      viewerIndex = -1;
      mediaItem = e;
      return;
    }
    if (kind === 'pdf') {
      // The WebView has no PDF viewer; the phone's own app shows it.
      if (android) return void android.openWith({ url: new URL(rawUrl(hostId!, e.path, true), location.href).toString(), name: e.name, hostId: hostId!, path: e.path, editable: false });
      return void window.open(rawUrl(hostId!, e.path), '_blank', 'noopener');
    }
    openMenu(e);
  }
  let mediaItem = $state<FileEntry | null>(null);

  function openMenu(e: FileEntry) {
    sheetItem = e;
    sheetOpen = true;
  }

  function toggle(e: FileEntry) {
    const next = new Set(selected);
    if (next.has(e.path)) next.delete(e.path);
    else next.add(e.path);
    selected = next;
  }

  // Long press selects (the way file managers on phones work); the three dots open the menu.
  // On a phone the hold only chooses: Android's own context menu after it opened the menu as well,
  // and Select there took the file out again (report fa1a85). A right click opens the menu.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pressed = false;
  let byTouch = false;
  function press(e: FileEntry) {
    pressed = false;
    timer = setTimeout(() => {
      pressed = true;
      navigator.vibrate?.(10);
      toggle(e);
    }, 450);
  }
  function release() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // ---- actions

  async function run(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function copySelection(move: boolean) {
    setClipboard(hostId!, host?.name ?? '', [...selected], move);
    selected = new Set();
    toast(t(move ? 'files.cutDone' : 'files.copyDone', { n: clipboard.paths.length }));
  }

  async function paste() {
    if (!listing || clipboard.hostId === null) return;
    const dir = listing.path;
    await run(() => pasteInto(hostId!, host?.name ?? '', dir, () => void load()));
  }

  async function deleteSelection() {
    const paths = [...selected];
    if (!(await ask({ text: t('files.confirmDelete', { n: paths.length }), confirm: t('common.delete'), danger: true }))) return;
    await run(async () => {
      await post(`/api/files/${hostId}/delete`, { paths });
      await load();
    });
  }

  async function createNew(e: SubmitEvent) {
    e.preventDefault();
    if (!listing || !newOpen) return;
    const kind = newOpen;
    const path = `${listing.path === '/' ? '' : listing.path}/${newName.trim()}`;
    await run(async () => {
      await post(`/api/files/${hostId}/create`, { path, kind });
      newOpen = null;
      newName = '';
      if (kind === 'file') go(to(`/edit/${hostId}`, { p: path }));
      else await load();
    });
  }

  function pickUpload() {
    fileInput?.click();
  }
  async function uploadPicked() {
    const files = [...(fileInput?.files ?? [])];
    if (fileInput) fileInput.value = '';
    if (!files.length) return;
    if (!listing) return void toast(t('common.loading'), 'error');
    await uploadInto(hostId!, listing.path, files, () => void load()).catch((err: unknown) => toast(errorMessage(err), 'error'));
  }

  // Files dropped from the computer: on a folder's row into that folder, elsewhere into this one (report 6d86aa, as a workspace's tree).
  let dropDir = $state<string | null>(null);
  const dropTarget = (ev: DragEvent) => (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-dir]')?.dataset.dir ?? listing?.path ?? null;
  function onDragOver(ev: DragEvent) {
    if (!admin || !listing || !hostId || !dragsFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    dropDir = dropTarget(ev);
  }
  function onDragLeave(ev: DragEvent) {
    if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node | null)) dropDir = null;
  }
  function onDrop(ev: DragEvent) {
    if (!admin || !listing || !hostId || !dragsFiles(ev)) return;
    ev.preventDefault();
    const dir = dropTarget(ev);
    dropDir = null;
    const files = droppedFiles(ev);
    if (dir && files.length) void uploadInto(hostId, dir, files, () => void load()).catch((err: unknown) => toast(errorMessage(err), 'error'));
  }

  let searchSeq = 0;
  async function doSearch(e: SubmitEvent) {
    e.preventDefault();
    if (!listing) return;
    searchResults = null;
    // The newest search only: an older one finishing later showed its names
    // under the new words (audit WP-14).
    const mine = ++searchSeq;
    await run(async () => {
      const found = await get<string[]>(`/api/files/${hostId}/search?dir=${encodeURIComponent(listing!.path)}&name=${encodeURIComponent(searchName)}`);
      if (mine === searchSeq) searchResults = found;
    });
  }

  async function toggleBookmark() {
    if (!listing) return;
    const existing = bookmarks.find((b) => b.path === listing!.path);
    await run(async () => {
      if (existing) await del(`/api/files/bookmarks/${existing.id}`);
      else await post(`/api/files/${hostId}/bookmarks`, { path: listing!.path, name: listing!.path.split('/').pop() || '/' });
      bookmarks = await get<Bookmark[]>(`/api/files/${hostId}/bookmarks`);
    });
  }

  async function terminalHere() {
    if (!listing) return;
    await run(() => connectHost(hostId!, true, listing!.path));
  }

  const icon = (e: FileEntry) =>
    isDir(e) ? 'folder' : e.type === 'link' ? 'link' : ({ image: 'image', video: 'film', audio: 'music', pdf: 'file', archive: 'archive', text: 'file', other: 'file' } as const)[openKind(e.name)];
  const admin = $derived(session.state?.user?.role === 'admin');
</script>

{#if hostId === null}
  <div class="page">
    <header class="topbar"><h1>{t('files.title')}</h1></header>
    {#if allBookmarks.length || (phoneFiles && phoneFavorites.list.length)}
      <h2 class="group">{t('files.favorites')} <HelpTip text={t('help.fileFavorites')} /></h2>
      <div class="list" data-testid="favorites">
        {#each allBookmarks as b (b.id)}
          <button class="list-item" onclick={() => go(to(`/files/${b.hostId}`, { p: b.path }))}>
            <Icon name="star" />
            <span class="main"><span class="title">{b.name}</span><span class="sub">{data.hosts.find((h) => h.id === b.hostId)?.name ?? ''}:{b.path}</span></span>
          </button>
        {/each}
        <!-- The phone's own (report 9980fa): kept on the phone, shown in the app only. -->
        {#if phoneFiles}
          {#each phoneFavorites.list as f (f.path)}
            <button class="list-item" onclick={() => go(to('/files/phone', { p: f.path }))} data-testid="phone-favorite">
              <Icon name="star" />
              <span class="main"><span class="title">{f.name}</span><span class="sub">{t('phone.thisPhone')}: {f.root}</span></span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
    <WorkspaceList />
    {#if phoneFiles}
      <h2 class="group">{t('phone.thisPhone')}</h2>
      <div class="list">
        <button class="list-item" onclick={() => go(to('/files/phone', { p: '/' }))} data-testid="phone-files">
          <Icon name="phone" />
          <span class="main"><span class="title">{t('phone.thisPhone')}</span><span class="sub">{t('phone.startSub')}</span></span>
        </button>
      </div>
    {/if}
    <h2 class="group">{t('files.hosts')}</h2>
    <p class="dim small">{t('files.pickHost')}</p>
    <div class="list">
      <!-- An operator: only hosts with folders granted, opened at the first of them (decision 14, W-FUNC-05). -->
      {#each data.hosts.filter((h) => mine === null || myFolders(h.id).length) as h (h.id)}
        {@const folders = mine ? myFolders(h.id) : []}
        <button class="list-item" onclick={() => go(to(`/files/${h.id}`, { p: folders[0] ?? '~' }))} data-testid="files-host">
          <Icon name="folder" />
          <span class="main"><span class="title">{h.name}</span><span class="sub">{folders.length ? folders.join(', ') : h.address}</span></span>
        </button>
      {/each}
      {#if mine && !data.hosts.some((h) => myFolders(h.id).length)}<p class="empty">{t('files.noneGranted')}</p>{/if}
    </div>
  </div>
{:else}
  <!-- Room at the end for the bar over the list, as high as it is (AUDIT2 PAGE-26: it covered the last rows). -->
  <div class="page files" role="region" aria-label={t('files.title')} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} style:padding-bottom={barH && clipboard.hostId !== null && !selected.size ? `calc(var(--nav-h) + 24px + env(safe-area-inset-bottom) + ${barH}px)` : undefined}>
    {#if selected.size}
    <!-- Files chosen: the title bar says how many and what to do with them, as Files (Android) and
         Gmail do; words beside the icons on a computer. A bar of two rows over the list at the
         bottom was large and ugly (reports 1d6881, 7ff350, b06954); before that, on one row, its
         count was squeezed away (fc208f). -->
    <div class="topbar selbar" role="toolbar" aria-label={t('files.selection')} data-testid="file-selection">
      <button class="icon-btn" aria-label={t('files.selectNone')} title={t('files.selectNone')} onclick={() => (selected = new Set())} data-testid="select-none"><Icon name="close" /></button>
      <h1 class="count" data-testid="file-selected">{t('files.selected', { n: selected.size })}</h1>
      {#if selected.size < entries.length}
        <button class="icon-btn labeled" aria-label={t('files.selectAll')} title={t('files.selectAll')} onclick={() => (selected = new Set(entries.map((e) => e.path)))} data-testid="select-all"><Icon name="checkAll" /><span class="wide-only" aria-hidden="true">{t('files.selectAll')}</span></button>
      {:else}
        <!-- All chosen: the same place chooses none (report d6a5e3: the button went, nothing in its place). -->
        <button class="icon-btn labeled" aria-label={t('files.selectNone')} title={t('files.selectNone')} onclick={() => (selected = new Set())} data-testid="select-all-none"><Icon name="checkNone" /><span class="wide-only" aria-hidden="true">{t('files.none')}</span></button>
      {/if}
      <button class="icon-btn labeled" aria-label={t('common.copy')} title={t('common.copy')} onclick={() => copySelection(false)}><Icon name="copy" /><span class="wide-only" aria-hidden="true">{t('common.copy')}</span></button>
      <button class="icon-btn labeled" aria-label={t('files.cut')} title={t('files.cut')} onclick={() => copySelection(true)}><Icon name="cut" /><span class="wide-only" aria-hidden="true">{t('files.cut')}</span></button>
      <button class="icon-btn labeled danger" aria-label={t('common.delete')} title={t('common.delete')} onclick={deleteSelection}><Icon name="trash" /><span class="wide-only" aria-hidden="true">{t('common.delete')}</span></button>
    </div>
    {:else}
    <header class="topbar">
      <button class="icon-btn" aria-label={t('files.title')} onclick={() => go('/files')}><Icon name="back" /></button>
      <h1>{host?.name ?? ''}</h1>
      <button class="icon-btn labeled" aria-label={t('files.search')} title={t('files.search')} onclick={() => (searchOpen = true)}><Icon name="search" /><span class="wide-only" aria-hidden="true">{t('files.search')}</span></button>
      <!-- Operators read; uploading and the folder's menu are the admin's. -->
      {#if admin}
        <button class="icon-btn labeled" aria-label={t('files.upload')} title={t('files.upload')} disabled={!listing} onclick={pickUpload}><Icon name="upload" /><span class="wide-only" aria-hidden="true">{t('files.upload')}</span></button>
        <button class="icon-btn" aria-label={t('files.more')} title={t('files.more')} onclick={() => ((sheetItem = null), (sheetOpen = true))}><Icon name="more" /></button>
      {/if}
    </header>
    {/if}
    <input bind:this={fileInput} type="file" multiple hidden onchange={uploadPicked} data-testid="upload-input" />

    <!-- The star beside the path, not at the end of it: a long path scrolls, and the star went out
         of sight with it on a phone (report b7caab). -->
    <div class="pathrow">
      <nav use:scrollCue class="crumbs" aria-label={t('files.path')}>
        {#each crumbs as c, i (c.path)}
          {#if i > 1}<span class="sep">/</span>{/if}
          <!-- The folder shown: pressed, it is read again (as a file manager's own path does). -->
          <button class="crumb" aria-current={i === crumbs.length - 1 ? 'page' : undefined} onclick={() => (i === crumbs.length - 1 ? void load() : nav(c.path))}>{c.name}</button>
        {/each}
        {#if loading}<span class="dim small" aria-live="polite">...</span>{/if}
      </nav>
      {#if admin}
        <button class="icon-btn star" class:on={bookmarks.some((b) => b.path === listing?.path)} aria-pressed={bookmarks.some((b) => b.path === listing?.path)} aria-label={t('files.bookmark')} title={t('files.bookmark')} onclick={toggleBookmark}
          ><Icon name="star" size={18} /></button
        >
      {/if}
    </div>

    {#if bookmarks.length || recent.length > 1}
      <div use:scrollCue class="quick">
        {#each bookmarks as b (b.id)}<button class="chip-link" onclick={() => nav(b.path)}><Icon name="star" size={12} /> {b.name}</button>{/each}
        {#each recent.filter((r) => r !== listing?.path && !bookmarks.some((b) => b.path === r)).slice(0, 4) as r (r)}
          <button class="chip-link dim" onclick={() => nav(r)}>{r}</button>
        {/each}
      </div>
    {/if}

    {#if error}
      <p class="alert error">{error}</p>
      {#if refusedOpen.length}
        <div class="list">
          {#each refusedOpen as f (f)}
            <button class="list-item" onclick={() => nav(f)} data-testid="files-allowed-folder"><Icon name="folder" /><span class="main"><span class="title mono">{f}</span></span></button>
          {/each}
        </div>
      {/if}
    {:else if !listing}
      <Skeleton rows={6} />
    {:else if entries.length === 0}
      <p class="empty" class:dropping={dropDir !== null}>{t('files.emptyFolder')}</p>
    {:else}
      <div class="list" class:grid={prefs.grid} class:dropping={dropDir !== null && dropDir === listing.path} data-testid="file-list">
        {#if !prefs.grid}
          <div class="fhead from-tablet" aria-hidden="true"><span></span><span>{t('files.colName')}</span><span class="r">{t('files.colSize')}</span><span>{t('files.colModified')}</span><span>{t('files.colRights')}</span><span>{t('files.colOwner')}</span></div>
        {/if}
        {#if listing.parent && !prefs.grid}
          <button class="list-item" onclick={() => nav(listing!.parent!)}><Icon name="folder" /><span class="main"><span class="title">..</span></span></button>
        {/if}
        {#each entries as e (e.path)}
          <div class="list-item file" class:sel={selected.has(e.path)} class:droptarget={isDir(e) && dropDir === e.path} data-dir={isDir(e) ? e.path : undefined} data-testid="file-row">
            <button
              class="main tap"
              data-testid="file-open"
              onclick={() => {
                if (pressed) return void (pressed = false);
                open(e);
              }}
              onpointerdown={(ev) => ((byTouch = ev.pointerType === 'touch'), press(e))}
              onpointerup={release}
              onpointerleave={release}
              oncontextmenu={(ev) => {
                ev.preventDefault();
                if (byTouch) return;
                release();
                openMenu(e);
              }}
            >
              {#if prefs.grid && openKind(e.name) === 'image' && !isDir(e)}
                <img class="thumb" src={rawUrl(hostId, e.path)} alt="" loading="lazy" />
              {:else}
                <span class="ico" class:dir={isDir(e)}><Icon name={icon(e)} /></span>
              {/if}
              <span class="text">
                <span class="title">{e.name}{#if e.type === 'link'}<span class="dim"> -> {e.target ?? '?'}</span>{/if}</span>
                {#if !prefs.grid}
                  <span class="sub until-tablet">{isDir(e) ? '' : `${formatBytes(e.size)} | `}{relativeTime(e.mtime)}</span>
                {/if}
              </span>
              <!-- A wide screen: what the line below the name says on a phone, in columns, with the rights and the owner. -->
              {#if !prefs.grid}
                <span class="cell num from-tablet">{isDir(e) ? '' : formatBytes(e.size)}</span>
                <span class="cell from-tablet">{relativeTime(e.mtime)}</span>
                <span class="cell mono from-tablet">{e.mode.toString(8).padStart(4, '0')}</span>
                <span class="cell from-tablet">{e.owner}:{e.group}</span>
              {/if}
            </button>
            <!-- A tile too: the hold chooses on a phone, so its menu is here (report fa1a85). -->
            <button class="icon-btn" aria-label={t('files.menuFor', { name: e.name })} onclick={() => openMenu(e)} data-testid="file-menu"><Icon name="more" size={20} /></button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if clipboard.hostId !== null && !selected.size}
    <div class="actionbar" role="toolbar" aria-label={t('files.clipboard')} bind:offsetHeight={barH} use:footBar>
      <span class="count">{t(clipboard.move ? 'files.toMove' : 'files.toCopy', { n: clipboard.paths.length, host: clipboard.hostName })}</span>
      <button class="btn small primary" onclick={paste} data-testid="paste">{t('files.pasteHere')}</button>
      <button class="icon-btn" aria-label={t('common.cancel')} onclick={clearClipboard}><Icon name="close" size={18} /></button>
    </div>
  {/if}

  <FileSheet
    bind:open={sheetOpen}
    item={sheetItem}
    {hostId}
    dir={listing?.path ?? null}
    {prefs}
    onchanged={() => void load()}
    onnew={(k) => ((newOpen = k), (newName = ''))}
    onupload={pickUpload}
    onterminal={terminalHere}
    onselect={(e) => (selected = new Set([...selected, e.path]))}
  />

  <Dialog tour="files-new" open={newOpen !== null} title={newOpen === 'dir' ? t('files.newFolder') : t('files.newFile')} onclose={() => (newOpen = null)}>
    <form id="new-form" class="stack" onsubmit={createNew}>
      <label class="field">
        <span>{t('files.name')}</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={newName} required autofocus autocapitalize="none" spellcheck="false" />
      </label>
    </form>
    <!-- Cancel and Save, as every form dialog (UIA-20: Save alone). -->
    {#snippet actions()}
      <button type="button" class="btn" onclick={() => (newOpen = null)}>{t('common.cancel')}</button>
      <button class="btn primary" form="new-form">{t('common.save')}</button>
    {/snippet}
  </Dialog>

  <Dialog tour="files-search" bind:open={searchOpen} title={t('files.search')}>
    <form id="search-form" class="stack" onsubmit={doSearch}>
      <label class="field">
        <span>{t('files.searchIn', { dir: listing?.path ?? '' })}</span>
        <input bind:value={searchName} required autocapitalize="none" spellcheck="false" />
      </label>
    </form>
    {#if searchResults}
      {#if searchResults.length === 0}<p class="dim">{t('files.noResults')}</p>{/if}
      <div class="list">
        {#each searchResults as r (r)}
          <button
            class="list-item"
            onclick={() => {
              searchOpen = false;
              nav(r.slice(0, r.lastIndexOf('/')) || '/');
            }}><span class="main"><span class="title">{r.split('/').pop()}</span><span class="sub mono">{r}</span></span></button
          >
        {/each}
      </div>
    {/if}
      {#snippet actions()}
      <button type="button" class="btn" onclick={() => (searchOpen = false)}>{t('common.close')}</button>
      <!-- The folder still loading: nothing to search in yet (a press did nothing). -->
      <button class="btn primary" form="search-form" disabled={!listing}>{t('files.search')}</button>
    {/snippet}
  </Dialog>

  <Viewer
    {hostId}
    items={mediaItem ? [mediaItem] : images}
    index={viewerIndex}
    onclose={() => {
      viewerIndex = null;
      mediaItem = null;
    }}
  />
{/if}

<style>
  .pathrow {
    display: flex;
    align-items: center;
    gap: 4px;
    /* Centred with the rest of the page on a wide screen (it kept to the left, decision 26). */
    margin: 0 auto 8px;
  }
  .crumbs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
  }
  .crumb {
    background: none;
    border: 0;
    color: var(--text-dim);
    font: inherit;
    padding: 6px 4px;
    cursor: pointer;
  }
  .crumb[aria-current='page'] {
    color: var(--text);
    font-weight: 700;
  }
  .sep {
    color: var(--text-dim);
  }
  .star {
    flex: none;
    color: var(--text-dim);
  }
  .star.on {
    color: var(--warn);
  }
  .quick {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    margin-bottom: 10px;
  }
  .chip-link {
    flex: none;
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
    font: 0.8rem var(--font);
    cursor: pointer;
  }
  .file {
    padding: 0 4px 0 0;
    gap: 0;
  }
  .file.sel {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .tap {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 8px 10px 14px;
    min-height: 52px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .ico {
    color: var(--text-dim);
    display: inline-flex;
  }
  /* A tablet up (720 px) too: the phone's rows stretched over 760 px left the buttons far from the names (A3-WEB-15).
     The time it was changed keeps room for its words (UIB-15). */
  @media (min-width: 720px) {
    .list:not(.grid) .tap {
      display: grid;
      grid-template-columns: 24px minmax(0, 2.4fr) 90px minmax(14ch, 1fr) 60px minmax(0, 1fr);
      column-gap: 14px;
      min-height: 42px;
      padding-top: 6px;
      padding-bottom: 6px;
    }
    .fhead {
      display: grid !important;
      /* The rows' grid, with the room their menu button takes at the right. */
      grid-template-columns: 24px minmax(0, 2.4fr) 90px minmax(14ch, 1fr) 60px minmax(0, 1fr);
      column-gap: 14px;
      padding: 8px 48px 8px 14px;
      font-size: 0.78rem;
      font-weight: 500;
      color: var(--text-dim);
    }
    .fhead .r {
      text-align: right;
    }
    .cell {
      font-size: 0.85rem;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cell.num {
      text-align: right;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
    }
    .cell.mono {
      font-family: var(--mono);
    }
  }
  .ico.dir {
    color: var(--accent);
  }
  .list.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 8px;
    padding: 8px;
  }
  .list.grid > * + * {
    border-top: 0;
  }
  .list.grid .file {
    padding: 0;
    position: relative;
  }
  .list.grid .file > .icon-btn {
    position: absolute;
    top: 0;
    right: 0;
    width: 32px;
    height: 32px;
  }
  .list.grid .tap {
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 4px;
  }
  .list.grid .title {
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 96px;
  }
  .thumb {
    width: 80px;
    height: 80px;
    object-fit: cover;
    border-radius: 6px;
    background: var(--bg-sunken);
  }
  .actionbar {
    position: fixed;
    left: calc(8px + var(--rail-w));
    right: 8px;
    bottom: calc(var(--nav-h) + 8px + env(safe-area-inset-bottom));
    z-index: 9;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 8px 14px;
    border-radius: var(--radius);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .actionbar .btn {
    width: auto;
  }
  /* The title bar while files are chosen: the count where the host's name was, given way to by
     nothing (it ends in dots before a button goes). Delete in the danger colour. */
  .selbar h1.count {
    font-size: 1.05rem;
  }
  /* On a phone five buttons and the count share 343 px: the count whole (it ended in dots). */
  @media (max-width: 899px) {
    .selbar :global(.icon-btn) {
      width: 40px;
    }
  }
  /* A narrow phone with everything chosen: six buttons (All gives way to None), the count whole. */
  @media (max-width: 379px) {
    .selbar :global(.icon-btn) {
      width: 34px;
    }
  }
  .selbar .danger {
    color: var(--danger);
  }
  .count {
    flex: 1;
    font-size: 0.85rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Files dragged from the computer: where they would land (report 6d86aa). */
  .dropping {
    outline: 2px dashed var(--accent);
    outline-offset: 2px;
  }
  .droptarget {
    background: color-mix(in srgb, var(--accent) 14%, var(--bg-raised));
    box-shadow: inset 3px 0 0 var(--accent);
  }
</style>
