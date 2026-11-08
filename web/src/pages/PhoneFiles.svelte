<script lang="ts">
  import { untrack } from 'svelte';
  import type { FileEntry } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import LogView from '../components/LogView.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import Viewer from '../components/Viewer.svelte';
  import { android, androidInfo, type AllFilesStatus, type PhoneArchive, type PhoneEntry, type PhoneListing, type PhoneRoot } from '../lib/android.js';
  import { switchAllFiles } from '../lib/allfiles.js';
  import { isPhoneFavorite, phoneFavorites, togglePhoneFavorite } from '../lib/phonefavorites.svelte.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { errorMessage } from '../lib/api.js';
  import { formatBytes, openKind } from '../lib/files.svelte.js';
  import { dateTime, relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { innerUp, isApk, isArchive, phoneCrumbs, phoneDir, phoneFailure, phonePath, readHeld, sortEntries, textual } from '../lib/phonefiles.js';
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { go, route, to, up } from '../lib/router.svelte.js';
  import { scrollCue } from '../lib/scrollcue.js';
  import { toast } from '../lib/ui.svelte.js';

  // The phone's own files, in the Android app (report a9552e): the folders
  // the person granted in Android's folder picker, their files shown with
  // Burrow's own views (the editor, the picture viewer, a log), another app
  // for the rest, and a copy to a host. #/files/phone?p=/<folder id>/<names>;
  // "/" lists the folders. Everything comes from the app's bridge and stays
  // on this page: nothing goes to Burrow unless a file is copied to a host.

  const path = untrack(() => phonePath(route.query.p));
  const asLog = untrack(() => route.query.view === 'log' && path.split('/').length > 2);
  // Inside an archive (report 99d993, "as Material Files"): #/files/phone?p=<the archive>&in=<its folder>.
  const inner = untrack(() => (path.split('/').length > 2 ? route.query.in : undefined));
  const name = path.split('/').pop() ?? '';

  let roots = $state<PhoneRoot[] | null>(null);
  let listing = $state<PhoneListing | null>(null);
  let logText = $state<string | null>(null);
  let error = $state('');
  let loading = $state(false);
  // Hidden files shown or not: the same choice as a host's folders (Files.svelte's "burrow.files").
  const PREFS_KEY = 'burrow.files';
  function readHidden(): boolean {
    try {
      return (JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { hidden?: boolean }).hidden === true;
    } catch {
      return false;
    }
  }
  let hidden = $state(readHidden());
  function setHidden(on: boolean) {
    hidden = on;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as object), hidden: on }));
    } catch {
      // Not remembered; fine.
    }
  }
  let selected = $state<Set<string>>(new Set());
  let sheetItem = $state<PhoneEntry | null>(null);
  let menuOpen = $state(false);
  let viewerIndex = $state<number | null>(null);
  let busy = $state(false);

  // "All files" (report 862305): offered when this app and Android have it; on, its volumes are among the roots.
  let allFiles = $state<AllFilesStatus | null>(null);
  // Delete, rename and a new folder (report 6eaf00): apps from 2.18.0.
  let change = $state(false);
  // Archives as folders, unpacked; open with, share (report 99d993): apps from 2.19.0.
  let archives = $state(false);
  void androidInfo().then((i) => {
    change = i?.phoneChange === true;
    archives = i?.phoneArchives === true;
  });
  let archive = $state<PhoneArchive | null>(null);

  async function load() {
    if (!android) return;
    loading = true;
    error = '';
    try {
      if (path === '/') {
        roots = await android.phoneRoots();
        allFiles = (await androidInfo())?.phoneAllFiles ? await android.phoneAllFiles().catch(() => null) : null;
      }
      else if (asLog) logText = (await android.phoneText(path)).content;
      else if (inner !== undefined) archive = await android.phoneArchive(path, inner);
      else {
        listing = await android.phoneList(path);
        selected = new Set();
      }
    } catch (err) {
      error = phoneFailure(err).message;
    } finally {
      loading = false;
    }
  }
  void load();
  $effect(() => pullToRefresh(() => load()));

  const nav = (p: string) => go(to('/files/phone', { p }));
  const navIn = (dir: string) => go(to('/files/phone', { p: path, in: dir }));
  const back = () =>
    up(
      inner
        ? to('/files/phone', { p: path, in: innerUp(inner) })
        : asLog || inner !== undefined
          ? to('/files/phone', { p: phoneDir(path) })
          : listing?.parent
            ? to('/files/phone', { p: listing.parent })
            : path === '/'
              ? '/files'
              : to('/files/phone', { p: '/' }),
    );

  // ---- the folders granted

  async function addFolder(start: 'documents' | 'downloads' | '') {
    busy = true;
    try {
      const r = await android!.phoneAddRoot(start);
      if ('cancelled' in r) return;
      toast(t('phone.added', { name: r.name }));
      await load();
    } catch (err) {
      toast(phoneFailure(err).message, 'error');
    } finally {
      busy = false;
    }
  }

  async function allFilesTo(on: boolean) {
    busy = true;
    try {
      if (await switchAllFiles(on)) await load();
    } finally {
      busy = false;
    }
  }

  async function removeFolder(r: { id: string; name: string }) {
    if (!(await ask({ text: t('phone.confirmRemove', { name: r.name }), confirm: t('phone.remove'), danger: true }))) return;
    try {
      await android!.phoneRemoveRoot(r.id);
      toast(t('phone.removed', { name: r.name }));
      if (path === '/') await load();
      else nav('/');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ---- a folder's files

  const entries = $derived(sortEntries(listing?.entries ?? [], hidden));
  const images = $derived(entries.filter((e) => e.type === 'file' && openKind(e.name) === 'image'));
  /** What the viewer takes: a host's entry, with what a phone's file does not have left empty. */
  const asEntry = (e: PhoneEntry): FileEntry => ({ name: e.name, path: e.path, type: e.type, size: e.size, mtime: e.mtime ?? '', mode: 0, owner: '', group: '' });
  const crumbs = $derived(listing ? phoneCrumbs(listing) : []);
  const atTop = $derived(!!listing && listing.names.length === 0);

  async function picture(e: FileEntry): Promise<string> {
    try {
      const [held] = await android!.phoneHold([e.path], 'view');
      return URL.createObjectURL(await readHeld(android!, held!));
    } catch (err) {
      throw phoneFailure(err);
    }
  }

  /** Another app shows it; `chooser`: always Android's list of apps (Open with). */
  function phoneOpen(e: PhoneEntry, chooser = false) {
    menuOpen = false;
    android!.phoneOpen(e.path, chooser && archives).catch((err: unknown) => toast(phoneFailure(err).message, 'error'));
  }

  function share(paths: string[]) {
    menuOpen = false;
    android!.phoneShare(paths).catch((err: unknown) => toast(phoneFailure(err).message, 'error'));
  }

  function open(e: PhoneEntry) {
    if (selected.size) return toggle(e);
    if (e.type === 'dir') return nav(e.path);
    // As Material Files: an app goes to Android's installer, an archive opens as a folder.
    if (isApk(e.name)) return phoneOpen(e);
    if (archives && isArchive(e.name)) return go(to('/files/phone', { p: e.path, in: '' }));
    const kind = openKind(e.name);
    // A name Burrow does not know is text only when the phone does not say it is something else.
    if (kind === 'text') return textual(e.mime) ? go(to('/edit/phone', { p: e.path })) : phoneOpen(e);
    if (kind === 'image') return void (viewerIndex = images.findIndex((x) => x.path === e.path));
    // A PDF, a film, music, an archive: the phone's own apps show them.
    if (kind !== 'other') return phoneOpen(e);
    openMenu(e);
  }

  function openMenu(e: PhoneEntry | null) {
    sheetItem = e;
    menuOpen = true;
  }

  function toggle(e: PhoneEntry) {
    const next = new Set(selected);
    if (next.has(e.path)) next.delete(e.path);
    else next.add(e.path);
    selected = next;
  }

  // Long press selects, as on a host's folder; the three dots open the menu.
  // On a phone the hold only chooses: Android's own context menu after it opened the menu as well,
  // and Select there took the file out again (report fa1a85). A right click opens the menu.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pressed = false;
  let byTouch = false;
  function press(e: PhoneEntry) {
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

  /** Held by the app and handed to the share page: a host and a folder there, then the normal upload. */
  async function copyToHost(paths: string[]) {
    busy = true;
    try {
      await android!.phoneHold(paths, 'upload');
      menuOpen = false;
      selected = new Set();
      go('/share');
    } catch (err) {
      toast(phoneFailure(err).message, 'error');
    } finally {
      busy = false;
    }
  }

  // ---- delete, rename, a new folder (report 6eaf00). The delete is asked
  // by the app itself, in its own dialog: the page does not ask again.

  async function remove(paths: string[]) {
    menuOpen = false;
    busy = true;
    try {
      const r = await android!.phoneDelete(paths);
      if ('cancelled' in r) return;
      toast(t('phone.deleted'));
      selected = new Set();
      await load();
    } catch (err) {
      toast(phoneFailure(err).message, 'error');
      // One of several may have gone before the one that failed.
      await load();
    } finally {
      busy = false;
    }
  }

  let naming = $state<{ kind: 'rename' | 'mkdir'; entry: PhoneEntry | null } | null>(null);
  let newName = $state('');
  let nameError = $state('');
  function startNaming(kind: 'rename' | 'mkdir', entry: PhoneEntry | null) {
    menuOpen = false;
    newName = entry?.name ?? '';
    nameError = '';
    naming = { kind, entry };
  }

  async function saveName(ev: SubmitEvent) {
    ev.preventDefault();
    if (!naming || !listing) return;
    const n = newName.trim();
    busy = true;
    nameError = '';
    try {
      if (naming.kind === 'rename') {
        await android!.phoneRename(naming.entry!.path, n);
        toast(t('phone.renamed', { name: n }));
      } else {
        await android!.phoneMkdir(listing.path, n);
        toast(t('phone.folderMade', { name: n }));
      }
      naming = null;
      await load();
    } catch (err) {
      nameError = phoneFailure(err).message;
    } finally {
      busy = false;
    }
  }

  // ---- archives: their files shown by another app, unpacked beside them

  type ArchiveEntry = PhoneArchive['entries'][number];
  function openInArchive(e: ArchiveEntry, chooser = false) {
    entryItem = null;
    if (e.type === 'dir') return navIn(e.path);
    android!.phoneArchiveOpen(path, e.path, chooser).catch((err: unknown) => toast(phoneFailure(err).message, 'error'));
  }
  let entryItem = $state<ArchiveEntry | null>(null);
  const archiveEntries = $derived((archive?.entries ?? []).filter((e) => hidden || !e.name.startsWith('.')));

  let unpacking = $state<{ name: string; done: number; total: number } | null>(null);
  async function unpack(archivePath: string, archiveName: string) {
    menuOpen = false;
    const id = Math.random().toString(36).slice(2);
    unpacking = { name: archiveName, done: 0, total: 0 };
    const off = android!.on('phoneProgress', (d) => {
      const p = d as { id: string; done: number; total: number };
      if (p.id === id && unpacking) unpacking = { ...unpacking, done: p.done, total: p.total };
    });
    try {
      const r = await android!.phoneUnpack(archivePath, id);
      const folder = r.path.split('/').pop() ?? '';
      toast(t('phone.unpacked', { name: folder, n: r.files }));
      // From inside the archive: to where it went; else that folder's list, the new one in it.
      if (inner !== undefined) nav(phoneDir(archivePath));
      else await load();
    } catch (err) {
      toast(phoneFailure(err).message, 'error');
    } finally {
      off();
      unpacking = null;
    }
  }

  let properties = $state<PhoneEntry | null>(null);
  /** Where a file is, as the path shows it: the folder's names after "This phone". */
  const whereIs = (e: PhoneEntry) => [t('phone.thisPhone'), ...(listing ? [listing.root.name, ...listing.names] : [])].join(' / ') + ` / ${e.name}`;

  const deletable = $derived(change && selected.size > 0 && [...selected].every((p) => entries.find((e) => e.path === p)?.deletable));

  const icon = (e: PhoneEntry) => (e.type === 'dir' ? 'folder' : ({ image: 'image', video: 'film', audio: 'music', pdf: 'file', archive: 'archive', text: 'file', other: 'file' } as const)[openKind(e.name)]);
</script>

{#if asLog}
  <div class="detail">
    <header class="topbar">
      <button class="icon-btn" aria-label={t('common.back')} onclick={back}><Icon name="back" /></button>
      <h1 class="name">{name}</h1>
    </header>
    {#if error}
      <p class="alert error">{error}</p>
    {:else if logText === null}
      <Skeleton rows={6} />
    {:else}
      <LogView sources={[{ hostId: 0, container: '', file: name, label: name }]} text={logText} />
    {/if}
  </div>
{:else}
  <div class="page">
    {#if selected.size}
    <!-- Files chosen: the title bar says how many and what to do, as for a host's files (report 1d6881). -->
    <div class="topbar selbar" role="toolbar" aria-label={t('files.selection')} data-testid="phone-selection">
      <button class="icon-btn" aria-label={t('files.selectNone')} title={t('files.selectNone')} onclick={() => (selected = new Set())} data-testid="phone-select-none"><Icon name="close" /></button>
      <h1 class="count">{t('files.selected', { n: selected.size })}</h1>
      {#if selected.size < entries.filter((e) => e.type === 'file').length}
        <button class="icon-btn labeled" aria-label={t('files.selectAll')} title={t('files.selectAll')} onclick={() => (selected = new Set(entries.filter((e) => e.type === 'file').map((e) => e.path)))} data-testid="phone-select-all"><Icon name="checkAll" /><span class="wide-only" aria-hidden="true">{t('files.selectAll')}</span></button>
      {:else}
        <!-- All chosen: the same place chooses none (report d6a5e3: the button went, nothing in its place). -->
        <button class="icon-btn labeled" aria-label={t('files.selectNone')} title={t('files.selectNone')} onclick={() => (selected = new Set())} data-testid="phone-select-all-none"><Icon name="checkNone" /><span class="wide-only" aria-hidden="true">{t('files.none')}</span></button>
      {/if}
      <button class="icon-btn labeled" aria-label={t('phone.copyToHost')} title={t('phone.copyToHost')} disabled={busy || [...selected].some((p) => entries.find((e) => e.path === p)?.type === 'dir')} onclick={() => copyToHost([...selected])} data-testid="phone-copy-selection"><Icon name="upload" /><span class="wide-only" aria-hidden="true">{t('phone.copyToHost')}</span></button>
      {#if archives}
        <button class="icon-btn labeled" aria-label={t('phone.share')} title={t('phone.share')} disabled={busy || [...selected].some((p) => entries.find((e) => e.path === p)?.type === 'dir')} onclick={() => share([...selected])} data-testid="phone-share-selection"><Icon name="share" /><span class="wide-only" aria-hidden="true">{t('phone.share')}</span></button>
      {/if}
      {#if deletable}
        <button class="icon-btn labeled danger" aria-label={t('common.delete')} title={t('common.delete')} disabled={busy} onclick={() => remove([...selected])} data-testid="phone-delete-selection"><Icon name="trash" /><span class="wide-only" aria-hidden="true">{t('common.delete')}</span></button>
      {/if}
    </div>
    {:else}
    <header class="topbar">
      <button class="icon-btn" aria-label={t('common.back')} onclick={back}><Icon name="back" /></button>
      <h1>{inner !== undefined ? name : listing ? listing.root.name : t('phone.thisPhone')}</h1>
      {#if inner !== undefined}
        <button class="icon-btn labeled" disabled={busy || unpacking !== null || !archive} aria-label={t('phone.unpack')} title={t('phone.unpack')} onclick={() => unpack(path, name)} data-testid="phone-unpack-here"><Icon name="archive" /><span class="wide-only" aria-hidden="true">{t('phone.unpack')}</span></button>
      {:else if listing}
        <button class="icon-btn" aria-label={t('files.more')} title={t('files.more')} onclick={() => openMenu(null)} data-testid="phone-folder-menu"><Icon name="more" /></button>
      {/if}
    </header>
    {/if}
    {#if unpacking}
      <!-- Unpacking: how far, the app's notification says it too. -->
      <div class="unpacking" role="status" data-testid="phone-unpack-progress">
        <span>{t('phone.unpacking', { name: unpacking.name })}{unpacking.total ? ` ${Math.min(100, Math.round((100 * unpacking.done) / unpacking.total))}%` : ''}</span>
        <progress aria-label={t('phone.unpacking', { name: unpacking.name })} max={unpacking.total || 1} value={unpacking.total ? unpacking.done : undefined}></progress>
      </div>
    {/if}

    {#if !android}
      <p class="empty">{t('phone.onlyApp')}</p>
    {:else if path === '/'}
      <!-- With "All files" on, not "only these folders" (report 862305). -->
      <p class="dim small">{roots?.some((r) => r.all) ? t('phone.introAll') : t('phone.intro')}</p>
      {#if error}<p class="alert error">{error}</p>{/if}
      {#if phoneFavorites.list.length}
        <h2 class="group">{t('files.favorites')}</h2>
        <div class="list">
          {#each phoneFavorites.list as f (f.path)}
            <button class="list-item" onclick={() => nav(f.path)} data-testid="phone-favorite">
              <Icon name="star" /><span class="main"><span class="title">{f.name}</span><span class="sub">{f.root}</span></span>
            </button>
          {/each}
        </div>
      {/if}
      <h2 class="group">{t('phone.folders')}</h2>
      {#if roots === null && !error}
        <Skeleton rows={2} />
      {:else if roots && roots.length}
        <div class="list" data-testid="phone-roots">
          {#each roots as r (r.id)}
            <div class="list-item file" data-testid="phone-root">
              <button class="main tap" onclick={() => nav(`/${r.id}`)} data-testid="phone-root-open">
                <span class="ico dir"><Icon name={r.all ? 'phone' : 'folder'} /></span>
                <span class="text">
                  <span class="title">{r.name}</span>
                  {#if r.all}<span class="sub">{t('phone.allFilesSub')}</span>{:else if r.lost}<span class="sub warn">{t('phone.lost')}</span>{:else if !r.writable}<span class="sub">{t('phone.readOnlyFolder')}</span>{/if}
                </span>
              </button>
              {#if r.all}
                <button class="icon-btn" disabled={busy} aria-label={t('phone.allFilesOff')} title={t('phone.allFilesOff')} onclick={() => allFilesTo(false)} data-testid="phone-all-off"><Icon name="close" size={20} /></button>
              {:else}
                <button class="icon-btn" aria-label={t('phone.removeName', { name: r.name })} title={t('phone.removeName', { name: r.name })} onclick={() => removeFolder(r)} data-testid="phone-root-remove"><Icon name="trash" size={20} /></button>
              {/if}
            </div>
          {/each}
        </div>
      {:else if roots}
        <p class="empty" data-testid="phone-none">{t('phone.none')}</p>
      {/if}
      <h2 class="group">{t('phone.add')}</h2>
      <div class="list">
        <button class="list-item" disabled={busy} onclick={() => addFolder('documents')} data-testid="phone-add-documents">
          <Icon name="file" /><span class="main"><span class="title">{t('phone.addDocuments')}</span><span class="sub">{t('phone.addDocumentsSub')}</span></span>
        </button>
        <button class="list-item" disabled={busy} onclick={() => addFolder('downloads')} data-testid="phone-add-downloads">
          <Icon name="download" /><span class="main"><span class="title">{t('phone.addDownloads')}</span><span class="sub">{t('phone.addDownloadsSub')}</span></span>
        </button>
        <button class="list-item" disabled={busy} onclick={() => addFolder('')} data-testid="phone-add-other">
          <Icon name="plus" /><span class="main"><span class="title">{t('phone.addOther')}</span><span class="sub">{t('phone.addOtherSub')}</span></span>
        </button>
        {#if allFiles?.available && !(allFiles.on && allFiles.granted)}
          <button class="list-item" disabled={busy} onclick={() => allFilesTo(true)} data-testid="phone-all-on">
            <Icon name="phone" /><span class="main"><span class="title">{t('phone.allFiles')}</span><span class="sub">{allFiles.on ? t('phone.allFilesTaken') : t('phone.allFilesAddSub')}</span></span>
          </button>
        {/if}
      </div>
    {:else if inner !== undefined}
      <!-- Inside an archive: its folders and files, read only; a file is shown by another app. -->
      <nav use:scrollCue class="crumbs" aria-label={t('files.path')}>
        <button class="crumb" aria-current={inner === '' ? 'page' : undefined} onclick={() => navIn('')}>{name}</button>
        {#each inner ? inner.split('/') : [] as part, i (i)}
          <span class="sep">/</span>
          <button class="crumb" aria-current={i === inner.split('/').length - 1 ? 'page' : undefined} onclick={() => navIn(inner.split('/').slice(0, i + 1).join('/'))}>{part}</button>
        {/each}
        {#if loading}<span class="dim small" aria-live="polite">...</span>{/if}
      </nav>
      {#if error}
        <p class="alert error" data-testid="phone-error">{error}</p>
        <button class="btn" onclick={() => nav(phoneDir(path))}>{t('phone.toArchiveFolder')}</button>
      {:else if !archive}
        <Skeleton rows={6} />
      {:else if archiveEntries.length === 0}
        <p class="empty">{t('files.emptyFolder')}</p>
      {:else}
        {#if archive.truncated}<p class="alert warn small">{t('phone.truncated', { n: archive.entries.length })}</p>{/if}
        <div class="list" data-testid="phone-archive-list">
          <div class="fhead from-tablet" aria-hidden="true"><span></span><span>{t('files.colName')}</span><span class="r">{t('files.colSize')}</span><span>{t('files.colModified')}</span></div>
          {#each archiveEntries as e (e.path)}
            <div class="list-item file" data-testid="phone-archive-row">
              <button class="main tap" onclick={() => openInArchive(e)} data-testid="phone-archive-open">
                <span class="ico" class:dir={e.type === 'dir'}><Icon name={e.type === 'dir' ? 'folder' : icon({ ...e, writable: false })} /></span>
                <span class="text">
                  <span class="title">{e.name}</span>
                  <span class="sub until-tablet">{e.type === 'dir' ? '' : formatBytes(e.size)}{e.type !== 'dir' && e.mtime ? ' | ' : ''}{e.mtime ? relativeTime(e.mtime) : ''}</span>
                </span>
                <span class="cell num from-tablet">{e.type === 'dir' ? '' : formatBytes(e.size)}</span>
                <span class="cell from-tablet">{e.mtime ? relativeTime(e.mtime) : ''}</span>
              </button>
              {#if e.type === 'file'}
                <button class="icon-btn" aria-label={t('files.menuFor', { name: e.name })} onclick={() => (entryItem = e)} data-testid="phone-archive-menu"><Icon name="more" size={20} /></button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <!-- The star beside the path, not at its end: the path scrolls, and took the star out of sight (report b7caab). -->
      <div class="pathrow">
      <nav use:scrollCue class="crumbs" aria-label={t('files.path')}>
        <button class="crumb" onclick={() => nav('/')}>{t('phone.thisPhone')}</button>
        {#each crumbs as c, i (c.path)}
          <span class="sep">/</span>
          <button class="crumb" aria-current={i === crumbs.length - 1 ? 'page' : undefined} onclick={() => nav(c.path)}>{c.name}</button>
        {/each}
        {#if loading}<span class="dim small" aria-live="polite">...</span>{/if}
      </nav>
        {#if listing}
          {@const l = listing}
          <!-- A favourite, as a host's folder: kept on this phone only (report 9980fa). -->
          <button
            class="icon-btn star"
            class:on={isPhoneFavorite(l.path)}
            aria-pressed={isPhoneFavorite(l.path)}
            aria-label={t('files.bookmark')}
            title={t('files.bookmark')}
            onclick={() => toast(togglePhoneFavorite({ path: l.path, name: l.names.at(-1) ?? l.root.name, root: l.root.name }) ? t('phone.favoriteAdded') : t('phone.favoriteRemoved'))}
            data-testid="phone-bookmark"><Icon name="star" size={18} /></button
          >
        {/if}
      </div>
      {#if error}
        <p class="alert error" data-testid="phone-error">{error}</p>
        <button class="btn" onclick={() => nav('/')}>{t('phone.toFolders')}</button>
      {:else if !listing}
        <Skeleton rows={6} />
      {:else if entries.length === 0}
        <p class="empty">{t('files.emptyFolder')}</p>
      {:else}
        {#if listing.truncated}<p class="alert warn small">{t('phone.truncated', { n: listing.entries.length })}</p>{/if}
        <div class="list" data-testid="phone-list">
          <div class="fhead from-tablet" aria-hidden="true"><span></span><span>{t('files.colName')}</span><span class="r">{t('files.colSize')}</span><span>{t('files.colModified')}</span></div>
          {#each entries as e (e.path)}
            <div class="list-item file" class:sel={selected.has(e.path)} data-testid="phone-row">
              <button
                class="main tap"
                data-testid="phone-open"
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
                <span class="ico" class:dir={e.type === 'dir'}><Icon name={icon(e)} /></span>
                <span class="text">
                  <span class="title">{e.name}</span>
                  <span class="sub until-tablet">{e.type === 'dir' ? '' : formatBytes(e.size)}{e.type !== 'dir' && e.mtime ? ' | ' : ''}{e.mtime ? relativeTime(e.mtime) : ''}</span>
                </span>
                <!-- A wide screen: the line below the name in columns, as a host's folder (A3-WEB-15). -->
                <span class="cell num from-tablet">{e.type === 'dir' ? '' : formatBytes(e.size)}</span>
                <span class="cell from-tablet">{e.mtime ? relativeTime(e.mtime) : ''}</span>
              </button>
              <button class="icon-btn" aria-label={t('files.menuFor', { name: e.name })} onclick={() => openMenu(e)} data-testid="phone-menu"><Icon name="more" size={20} /></button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  <Dialog tour="phone-file-menu" menu bind:open={menuOpen} title={sheetItem?.name ?? listing?.root.name ?? ''}>
    {#if sheetItem}
      {@const e = sheetItem}
      {@const kind = openKind(e.name)}
      <p class="dim small">{e.type === 'dir' ? t('files.folder') : formatBytes(e.size)}{e.mtime ? ` | ${relativeTime(e.mtime)}` : ''}</p>
      {#if e.type === 'dir'}
        <button class="btn primary" onclick={() => ((menuOpen = false), nav(e.path))}>{t('files.openFolder')}</button>
      {:else}
        {#if kind === 'image'}
          <button class="btn primary" onclick={() => ((menuOpen = false), (viewerIndex = images.findIndex((x) => x.path === e.path)))} data-testid="phone-view">{t('phone.view')}</button>
        {:else}
          <button class="btn" class:primary={kind === 'text'} onclick={() => ((menuOpen = false), go(to('/edit/phone', { p: e.path })))} data-testid="phone-edit">{kind === 'text' ? (e.writable ? t('files.edit') : t('phone.open')) : t('files.editAsText')}</button>
          {#if e.writable}<button class="btn" onclick={() => ((menuOpen = false), go(to('/edit/phone', { p: e.path, ro: '1' })))} data-testid="phone-read-only">{t('phone.openReadOnly')}</button>{/if}
          <button class="btn" onclick={() => ((menuOpen = false), go(to('/files/phone', { p: e.path, view: 'log' })))} data-testid="phone-as-log">{t('files.openAsLog')}</button>
        {/if}
        {#if archives && isArchive(e.name)}
          <button class="btn" class:primary={!isApk(e.name)} onclick={() => ((menuOpen = false), go(to('/files/phone', { p: e.path, in: '' })))} data-testid="phone-browse">{t('phone.browse')}</button>
          {#if listing?.canCreate}<button class="btn" disabled={busy || unpacking !== null} onclick={() => unpack(e.path, e.name)} data-testid="phone-unpack">{t('phone.unpack')}</button>{/if}
        {/if}
        <button class="btn" class:primary={isApk(e.name)} onclick={() => phoneOpen(e, true)} data-testid="phone-open-app">{isApk(e.name) ? t('phone.install') : archives ? t('phone.openWith') : t('phone.openInApp')}</button>
        {#if archives}<button class="btn" onclick={() => share([e.path])} data-testid="phone-share">{t('phone.share')}</button>{/if}
        <button class="btn" disabled={busy} onclick={() => copyToHost([e.path])} data-testid="phone-copy">{t('phone.copyToHost')}</button>
        <button class="btn" onclick={() => ((menuOpen = false), (selected = new Set([...selected, e.path])))} data-testid="phone-select">{t('files.select')}</button>
      {/if}
      <button class="btn" onclick={() => ((menuOpen = false), (properties = e))} data-testid="phone-properties">{t('phone.properties')}</button>
      {#if change && e.renamable}<button class="btn" onclick={() => startNaming('rename', e)} data-testid="phone-rename">{t('files.rename')}</button>{/if}
      {#if change && e.deletable}<button class="btn danger" disabled={busy} onclick={() => remove([e.path])} data-testid="phone-delete">{t('common.delete')}</button>{/if}
    {:else if listing}
      {#if change && listing.canCreate}<button class="btn" onclick={() => startNaming('mkdir', null)} data-testid="phone-new-folder">{t('files.newFolder')}</button>{/if}
      <label class="check"><input type="checkbox" checked={hidden} onchange={(e) => setHidden(e.currentTarget.checked)} data-testid="phone-hidden" /> {t('files.showHidden')}</label>
      {#if atTop}
        <button class="btn danger" onclick={() => ((menuOpen = false), removeFolder(listing!.root))} data-testid="phone-remove-here">{t('phone.remove')}</button>
      {/if}
    {/if}
  </Dialog>

  <Dialog tour="phone-name" open={naming !== null} title={naming?.kind === 'rename' ? t('files.rename') : t('files.newFolder')} onclose={() => (naming = null)}>
    <form id="phone-name-form" class="stack" onsubmit={saveName}>
      <label class="field">
        <span>{naming?.kind === 'rename' ? t('files.newName') : t('files.name')}</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={newName} required autofocus autocapitalize="none" spellcheck="false" data-testid="phone-name" />
      </label>
      {#if nameError}<p class="alert error" data-testid="phone-name-error">{nameError}</p>{/if}
    </form>
    {#snippet actions()}
      <button type="button" class="btn" onclick={() => (naming = null)}>{t('common.cancel')}</button>
      <button class="btn primary" form="phone-name-form" disabled={busy}>{t('common.save')}</button>
    {/snippet}
  </Dialog>

  <Dialog tour="phone-properties" open={properties !== null} title={properties?.name ?? ''} onclose={() => (properties = null)}>
    {#if properties}
      {@const e = properties}
      <dl class="props" data-testid="phone-props">
        <dt>{t('phone.propType')}</dt><dd>{e.type === 'dir' ? t('files.folder') : e.mime || '-'}</dd>
        {#if e.type === 'file'}<dt>{t('files.colSize')}</dt><dd>{formatBytes(e.size)} ({t('phone.bytes', { n: e.size })})</dd>{/if}
        <dt>{t('files.colModified')}</dt><dd>{e.mtime ? dateTime(e.mtime) : '-'}</dd>
        <dt>{t('phone.propWhere')}</dt><dd class="where">{whereIs(e)}</dd>
        <dt>{t('phone.propAccess')}</dt><dd>{e.writable ? t('phone.accessReadWrite') : t('phone.accessRead')}</dd>
      </dl>
    {/if}
    {#snippet actions()}
      <button type="button" class="btn" onclick={() => (properties = null)}>{t('common.close')}</button>
    {/snippet}
  </Dialog>

  <Dialog tour="phone-archive-entry" menu open={entryItem !== null} title={entryItem?.name ?? ''} onclose={() => (entryItem = null)}>
    {#if entryItem}
      {@const e = entryItem}
      <p class="dim small">{formatBytes(e.size)}{e.mtime ? ` | ${relativeTime(e.mtime)}` : ''}</p>
      <button class="btn primary" onclick={() => openInArchive(e)} data-testid="phone-archive-view">{t('phone.openInApp')}</button>
      <button class="btn" onclick={() => openInArchive(e, true)} data-testid="phone-archive-with">{t('phone.openWith')}</button>
    {/if}
  </Dialog>

  <Viewer hostId={0} items={images.map(asEntry)} index={viewerIndex} srcOf={picture} onclose={() => (viewerIndex = null)} />
{/if}

<style>
  .unpacking {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 0 0 8px;
    font-size: 0.9rem;
  }
  .unpacking progress {
    flex: 1 1 120px;
  }
  .props {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px 12px;
    margin: 0;
  }
  .props dt {
    color: var(--text-dim);
  }
  .props dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .pathrow {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 -4px 8px;
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
  /* As on a host's folder: at the end of the path, yellow when the folder is a favourite. */
  .star {
    flex: none;
    color: var(--text-dim);
  }
  .star.on {
    color: var(--warn);
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
  .ico.dir {
    color: var(--accent);
  }
  @media (min-width: 720px) {
    [data-testid='phone-list'] .tap {
      display: grid;
      grid-template-columns: 24px minmax(0, 2.4fr) 90px minmax(0, 1fr);
      column-gap: 14px;
      min-height: 42px;
      padding-top: 6px;
      padding-bottom: 6px;
    }
    .fhead {
      display: grid !important;
      grid-template-columns: 24px minmax(0, 2.4fr) 90px minmax(0, 1fr);
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
  }
  .sub.warn {
    color: var(--warn);
  }
  .selbar h1.count {
    font-size: 1.05rem;
  }
  /* On a phone five buttons and the count share 343 px: the count whole (it ended in dots). */
  @media (max-width: 899px) {
    .selbar :global(.icon-btn) {
      width: 40px;
    }
  }
  .detail {
    position: fixed;
    inset: 0 0 calc(var(--nav-h) + env(safe-area-inset-bottom)) var(--rail-w);
    display: flex;
    flex-direction: column;
    padding: 0 12px 8px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  @media (min-width: 900px) {
    .detail {
      padding: 0 28px 16px;
    }
    .detail > .topbar {
      margin: 0 -28px 8px;
      padding: 0 28px;
      min-height: 64px;
    }
  }
</style>
