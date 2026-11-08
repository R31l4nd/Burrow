<script lang="ts">
  import { ask } from '../lib/confirm.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { targetKey, type FileEntry, type TextFile } from '@burrow/shared';
  import { ApiFailure, errorMessage, get, post } from '../lib/api.js';
  import { android, androidInfo } from '../lib/android.js';
  import { clipboard, formatBytes, followJob, openKind, pasteInto, rawUrl, setClipboard } from '../lib/files.svelte.js';
  import { data } from '../lib/data.svelte.js';
  import { dateLocale, t } from '../lib/i18n/index.svelte.js';
  import { go, goFrom, here, to } from '../lib/router.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import PhoneFolderPicker from './PhoneFolderPicker.svelte';

  // The menu for one file or folder, or (item null) for the folder on screen.
  let {
    open = $bindable(false),
    item,
    hostId,
    dir,
    prefs,
    onchanged,
    onmoved,
    onnewIn,
    onnew,
    onupload,
    onterminal,
    onselect,
    onedit,
    oncompare,
  }: {
    open?: boolean;
    item: FileEntry | null;
    hostId: number;
    dir: string | null;
    prefs: { hidden: boolean; sort: 'name' | 'size' | 'mtime'; grid: boolean };
    onchanged: () => void;
    /** Renamed (to the new path) or deleted (null): open tabs follow (a workspace). */
    onmoved?: (from: string, to: string | null) => void;
    /** A new file or folder in this folder (a workspace's tree). */
    onnewIn?: (kind: 'file' | 'dir', dir: string) => void;
    onnew?: (kind: 'file' | 'dir') => void;
    onupload?: () => void;
    onterminal?: () => void;
    /** Without it (a workspace's tree): no "Select". */
    onselect?: (e: FileEntry) => void;
    /** Open a file to edit here (a workspace's tab) instead of on its own page. */
    onedit?: (path: string) => void;
    /** A workspace's own compare (its open files and folders) instead of a path to type (report 9d710d). */
    oncompare?: (path: string) => void;
  } = $props();
  const edit = (path: string) => (onedit ? ((open = false), onedit(path)) : go(to(`/edit/${hostId}`, { p: path })));

  let view = $state<'menu' | 'rename' | 'props' | 'compare'>('menu');

  // Compare with another file, on this host or another: both read, one diff.
  let cmpHost = $state(0);
  let cmpPath = $state('');
  let cmp = $state<{ a: string; b: string; label: string; names: [string, string] } | null>(null);
  // A file only root may read: said here, with sudo to read it (as a workspace's compare says it).
  let rootOnly = $state<{ host: number; path: string } | null>(null);
  let bySudo = $state<string[]>([]);
  let sudoPw = $state('');
  let needPw = $state(false);
  function startCompare() {
    if (oncompare) return oncompare(item!.path);
    cmpHost = hostId;
    cmpPath = item!.path.slice(0, item!.path.lastIndexOf('/') + 1);
    cmp = null;
    rootOnly = null;
    bySudo = [];
    sudoPw = '';
    needPw = false;
    view = 'compare';
  }
  async function readSide(host: number, path: string): Promise<string> {
    if (bySudo.includes(`${host}:${path}`)) return (await post<TextFile>(`/api/files/${host}/sudo/read`, { path, ...(sudoPw ? { password: sudoPw } : {}) })).content;
    try {
      return (await get<TextFile>(`/api/files/${host}/text?path=${encodeURIComponent(path)}`, ['permission_denied'])).content;
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'permission_denied') rootOnly = { host, path };
      throw err;
    }
  }
  async function compare(e?: SubmitEvent) {
    e?.preventDefault();
    busy = true;
    rootOnly = null;
    // What is compared, taken before the reads: the sheet's file or the typed path may change meanwhile.
    const it = item!;
    const path = cmpPath.trim();
    const otherHost = cmpHost;
    try {
      const [a, b] = await Promise.all([readSide(hostId, it.path), readSide(otherHost, path)]);
      const other = data.hosts.find((h) => h.id === otherHost)?.name ?? '';
      cmp = { a, b, label: t('files.compareLabel', { a: it.name, b: `${other}:${path}` }), names: [`${other}:${path}`, it.path] };
      needPw = false;
    } catch (err) {
      cmp = null;
      if (err instanceof ApiFailure && (err.code === 'sudo_password' || err.code === 'sudo_wrong_password')) {
        if (err.code === 'sudo_wrong_password') toast(t('editor.sudoWrong'), 'error');
        needPw = true;
      } else if (!rootOnly) toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
  function compareBySudo() {
    if (!rootOnly) return;
    bySudo = [...bySudo, `${rootOnly.host}:${rootOnly.path}`];
    void compare();
  }
  let newName = $state('');
  let mode = $state(0);
  // Each for everything inside, apart: an owner change for a whole folder
  // also gave every file in it the folder's mode, a private 0600 file 0755
  // (AUDIT2 UI-01); and an owner the folder already had reached nothing inside.
  let recursiveMode = $state(false);
  let recursiveOwner = $state(false);
  let owner = $state('');
  let group = $state('');
  // A folder's size, with how many files and folders are below it (report 1b1aa2).
  let size = $state<{ bytes: number; files?: number | null; dirs?: number | null } | null>(null);
  let measuring = $state(false);
  const sizeText = (z: NonNullable<typeof size>) =>
    z.files != null && z.dirs != null
      ? t('files.sizeCount', { size: formatBytes(z.bytes), files: z.files.toLocaleString(dateLocale()), nf: z.files, dirs: z.dirs.toLocaleString(dateLocale()), nd: z.dirs })
      : t('files.size', { size: formatBytes(z.bytes) });
  let busy = $state(false);

  const host = $derived(data.hosts.find((h) => h.id === hostId));
  const isDir = $derived(item ? item.type === 'dir' || (item.type === 'link' && item.targetType === 'dir') : true);

  // A new name or other properties typed and not applied: closing asks first (AUDIT2 UI-25).
  const dirty = () =>
    (view === 'rename' && newName !== (item?.name ?? '')) ||
    (view === 'props' && (mode !== (item?.mode ?? 0) || owner !== (item?.owner ?? '') || group !== (item?.group ?? '')));
  $effect.pre(() => {
    if (!open) return;
    view = 'menu';
    newName = item?.name ?? '';
    mode = item?.mode ?? 0;
    owner = item?.owner ?? '';
    group = item?.group ?? '';
    recursiveMode = false;
    recursiveOwner = false;
    size = null;
  });

  // The app shows the phone's own files (2.0.0 on): a host's file can be copied into one of its folders.
  let phoneFiles = $state(false);
  if (android) void androidInfo().then((i) => (phoneFiles = !!i?.phoneFiles));
  let toPhone = $state<{ url: string; name: string } | null>(null);
  let pickOpen = $state(false);
  function copyToPhone() {
    toPhone = { url: new URL(rawUrl(hostId, item!.path, true), location.href).toString(), name: item!.name };
    open = false;
    pickOpen = true;
  }

  /** Hand the file to another Android app: to open (and maybe edit) or to share. */
  function native(action: 'openWith' | 'share') {
    const it = item!;
    open = false;
    const url = new URL(rawUrl(hostId, it.path, true), location.href).toString();
    const p = action === 'share' ? android!.share({ url, name: it.name }) : android!.openWith({ url, name: it.name, hostId, path: it.path, editable: true });
    p.catch((err: unknown) => toast(errorMessage(err), 'error'));
  }

  /** This folder as a workspace (made once; opening it again finds the same one). */
  async function openWorkspace(root: string) {
    busy = true;
    const from = here();
    try {
      const w = await post<{ id: number }>('/api/workspaces', { hostId, root });
      open = false;
      goFrom(from, `/ws/${w.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  async function run(fn: () => Promise<unknown>, close = true) {
    busy = true;
    try {
      await fn();
      if (close) open = false;
      onchanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  const parent = $derived(item ? item.path.slice(0, item.path.lastIndexOf('/')) || '/' : dir);

  const rename = (e: SubmitEvent) => {
    e.preventDefault();
    const from = item!.path;
    const to = `${parent === '/' ? '' : parent}/${newName.trim()}`;
    return run(async () => {
      await post(`/api/files/${hostId}/rename`, { from, to });
      onmoved?.(from, to);
    });
  };

  // Asked first: cancelling is no error (it showed a red "Cancel").
  const remove = async () => {
    if (!(await ask({ text: t('common.confirmDelete', { name: item!.name }), confirm: t('common.delete'), danger: true }))) return;
    const gone = item!.path;
    await run(async () => {
      await post(`/api/files/${hostId}/delete`, { paths: [gone] });
      onmoved?.(gone, null);
    });
  };

  const saveProps = (e: SubmitEvent) => {
    e.preventDefault();
    const it = item!;
    return run(async () => {
      if (mode !== it.mode || recursiveMode) await post(`/api/files/${hostId}/chmod`, { path: it.path, mode, recursive: recursiveMode });
      if (owner !== it.owner || group !== it.group || recursiveOwner) await post(`/api/files/${hostId}/chown`, { path: it.path, owner, group, recursive: recursiveOwner });
      toast(t('files.saved'));
    });
  };

  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  // What was copied or cut, into a folder; the clipboard said in a toast where it can go.
  const pasteHere = (into: string) => run(() => pasteInto(hostId, host?.name ?? '', into, onchanged));

  async function measure() {
    size = null;
    measuring = true;
    await run(async () => {
      size = await get<NonNullable<typeof size>>(`/api/files/${hostId}/du?path=${encodeURIComponent(item?.path ?? dir!)}`);
    }, false).finally(() => (measuring = false));
  }

  // The file taken first: the sheet may show another one by the time the job is made.
  const archive = () => {
    const it = item!;
    const dest = `${parent === '/' ? '' : parent}/${it.name}.tar.gz`;
    return run(async () => {
      const job = await post<{ id: string; status: 'running'; bytes: number; error: null }>(`/api/files/${hostId}/archive`, { paths: [it.path], dest });
      void followJob(job, t('files.archiving', { name: it.name }), 'archive', onchanged);
    });
  };

  const extract = () => {
    const it = item!;
    const toDir = parent;
    return run(async () => {
      const job = await post<{ id: string; status: 'running'; bytes: number; error: null }>(`/api/files/${hostId}/extract`, { path: it.path, toDir });
      void followJob(job, t('files.extracting', { name: it.name }), 'extract', onchanged);
    });
  };

  // Permission bits as a 3x3 grid of checkboxes.
  const WHO = [
    { label: 'owner', shift: 6 },
    { label: 'group', shift: 3 },
    { label: 'other', shift: 0 },
  ] as const;
  const WHAT = [
    { label: 'r', bit: 4 },
    { label: 'w', bit: 2 },
    { label: 'x', bit: 1 },
  ] as const;
  const has = (shift: number, bit: number) => (mode & (bit << shift)) !== 0;
  const flip = (shift: number, bit: number) => (mode ^= bit << shift);
  const admin = $derived(session.state?.user?.role === 'admin');
</script>

<Dialog tour="file-sheet" menu={view === 'menu'} bind:open {dirty} title={item?.name ?? dir ?? ''} actions={view === 'menu' ? undefined : formActions}>
  {#if view === 'menu'}
    {#if item}
      <p class="dim small">
        {isDir ? t('files.folder') : formatBytes(item.size)} | {item.owner}:{item.group} | {item.mode.toString(8).padStart(4, '0')}
        {#if item.type === 'link'}<br />-> {item.target}{/if}
      </p>
      {#if !isDir}
        {#if openKind(item.name) !== 'text'}
          <button class="btn" onclick={() => edit(item!.path)}>{t('files.editAsText')}</button>
        {:else}
          <button class="btn primary" onclick={() => edit(item!.path)}>{t('files.edit')}</button>
        {/if}
        <a class="btn" href={rawUrl(hostId, item.path, true)} download={item.name}>{t('files.download')}</a>
        {#if openKind(item.name) === 'text'}<button class="btn" onclick={startCompare} data-testid="compare-open">{t('files.compareWith')}</button>{/if}
        <!-- Followed like a container's logs: filters, search, analysis. -->
        <button class="btn" onclick={() => ((open = false), go(to('/logs', { t: targetKey({ hostId, container: '', file: item!.path }) })))} data-testid="open-as-log">{t('files.openAsLog')}</button>
        {#if android}
          <button class="btn" onclick={() => native('openWith')}>{t('files.openWith')}</button>
          <button class="btn" onclick={() => native('share')}>{t('files.share')}</button>
          {#if phoneFiles}<button class="btn" onclick={copyToPhone} data-testid="copy-to-phone">{t('phone.copyToPhone')}</button>{/if}
        {/if}
      {:else}
        <button class="btn primary" onclick={() => ((open = false), go(to(`/files/${hostId}`, { p: item!.path })))}>{t('files.openFolder')}</button>
        {#if admin}<button class="btn" disabled={busy} onclick={() => openWorkspace(item!.path)} data-testid="open-workspace">{t('ws.openAsWorkspace')}</button>{/if}
      {/if}
      <!-- Changing files is the admin's; operators open, read and download. -->
      <!-- Its full path, to paste in a terminal or a note (as VS Code's Copy Path). -->
      <button class="btn" onclick={() => ((open = false), void copyText(item!.path).then((ok) => ok && toast(t('common.copied'))))} data-testid="copy-path">{t('files.copyPath')}</button>
      {#if admin}
      {#if item.type === 'dir' && onnewIn}
        <button class="btn" onclick={() => ((open = false), onnewIn('file', item!.path))} data-testid="new-file-in">{t('files.newFile')}</button>
        <button class="btn" onclick={() => ((open = false), onnewIn('dir', item!.path))} data-testid="new-folder-in">{t('files.newFolder')}</button>
      {/if}
      {#if onselect}<button class="btn" onclick={() => ((open = false), onselect(item!))}>{t('files.select')}</button>{/if}
      <button class="btn" onclick={() => ((open = false), setClipboard(hostId, host?.name ?? '', [item!.path], false), toast(t('files.copyDone', { n: 1 })))}
        >{t('common.copy')}</button
      >
      <button class="btn" onclick={() => ((open = false), setClipboard(hostId, host?.name ?? '', [item!.path], true), toast(t('files.cutDone', { n: 1 })))}
        >{t('files.cut')}</button
      >
      {#if clipboard.hostId !== null}
        <!-- Into this folder, or the folder this file is in, as VS Code's explorer (report 67d3e6). -->
        <button class="btn" disabled={busy} onclick={() => pasteHere(isDir ? item!.path : parentOf(item!.path))} data-testid="sheet-paste">{t('files.pasteInto', { name: isDir ? item.name : parentOf(item.path).split('/').pop() || '/' })}</button>
      {/if}
      <button class="btn" onclick={() => (view = 'rename')}>{t('files.rename')}</button>
      <button class="btn" onclick={() => (view = 'props')}>{t('files.properties')}</button>
      {#if openKind(item.name) === 'archive'}
        <button class="btn" disabled={busy} onclick={extract}>{t('files.extractHere')}</button>
      {:else}
        <button class="btn" disabled={busy} onclick={archive}>{t('files.archive')}</button>
      {/if}
      <button class="btn danger" disabled={busy} onclick={remove}>{t('common.delete')}</button>
      {/if}
    {:else}
      <button class="btn" onclick={() => ((open = false), onnew?.('dir'))}>{t('files.newFolder')}</button>
      <button class="btn" onclick={() => ((open = false), onnew?.('file'))}>{t('files.newFile')}</button>
      <button class="btn" onclick={() => ((open = false), onupload?.())}>{t('files.upload')}</button>
      <button class="btn" onclick={() => ((open = false), onterminal?.())}>{t('files.terminalHere')}</button>
      {#if dir && clipboard.hostId !== null && admin}<button class="btn" disabled={busy} onclick={() => pasteHere(dir!)} data-testid="sheet-paste">{t('files.pasteHere')}</button>{/if}
      {#if dir}<button class="btn" disabled={busy} onclick={() => openWorkspace(dir!)} data-testid="open-workspace">{t('ws.openAsWorkspace')}</button>{/if}
      <label class="check"><input type="checkbox" bind:checked={prefs.hidden} /> {t('files.showHidden')}</label>
      <label class="check"><input type="checkbox" bind:checked={prefs.grid} /> {t('files.grid')}</label>
      <label class="field">
        <span>{t('files.sort')}</span>
        <select bind:value={prefs.sort}>
          <option value="name">{t('files.sortName')}</option>
          <option value="size">{t('files.sortSize')}</option>
          <option value="mtime">{t('files.sortDate')}</option>
        </select>
      </label>
      <button class="btn" disabled={busy} onclick={measure} data-testid="folder-size">{measuring ? t('files.measuring') : size === null ? t('files.measure') : sizeText(size)}</button>
    {/if}
  {:else if view === 'compare' && item}
    <form id="sheet-form" class="stack" onsubmit={compare}>
      <div class="grid2">
        <label class="field">
          <span>{t('files.compareHost')}</span>
          <select bind:value={cmpHost} data-testid="compare-host">
            {#each data.hosts as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>{t('files.comparePath')}</span>
          <input bind:value={cmpPath} required autocapitalize="none" spellcheck="false" class="mono" data-testid="compare-path" />
        </label>
      </div>
      {#if rootOnly}
        <div class="alert stack" data-testid="compare-root-only">
          <p class="small">{t('files.compareRootOnly', { path: rootOnly.path })}</p>
          {#if admin}<button type="button" class="btn small" disabled={busy} onclick={compareBySudo} data-testid="compare-sudo">{t('files.compareSudo')}</button>{/if}
        </div>
      {/if}
      {#if needPw}
        <label class="field">
          <span>{t('editor.sudoPassword')}</span>
          <input type="password" bind:value={sudoPw} autocomplete="off" data-testid="compare-sudo-pw" />
        </label>
      {/if}
      {#if cmp}
        <p class="dim small">{cmp.label}</p>
        {#if cmp.a === cmp.b}<p class="small">{t('files.compareSame')}</p>{:else}{#await import('./DiffView.svelte') then m}<m.default original={cmp.b} modified={cmp.a} label={cmp.label} names={cmp.names} />{/await}{/if}
      {/if}
    </form>
  {:else if view === 'rename'}
    <form id="sheet-form" class="stack" onsubmit={rename}>
      <label class="field">
        <span>{t('files.newName')}</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={newName} required autofocus autocapitalize="none" spellcheck="false" />
      </label>
    </form>
  {:else if item}
    <form id="sheet-form" class="stack" onsubmit={saveProps}>
      <p class="small">{item.path}</p>
      {#if isDir}
        <button type="button" class="btn small" disabled={busy} onclick={measure} data-testid="folder-size">{measuring ? t('files.measuring') : size === null ? t('files.measure') : sizeText(size)}</button>
      {:else}
        <p class="small">{t('files.sizeIs', { size: formatBytes(item.size) })}</p>
      {/if}
      <div class="row">
        <strong class="small">{t('files.permissions')}</strong>
        <HelpTip text={t('help.permissions')} />
        <span class="spacer"></span>
        <span class="mono small" data-testid="mode">{mode.toString(8).padStart(4, '0')}</span>
      </div>
      <table class="perm">
        <thead><tr><th></th>{#each WHAT as w (w.label)}<th>{w.label}</th>{/each}</tr></thead>
        <tbody>
          {#each WHO as who (who.label)}
            <tr>
              <th>{t(`files.who.${who.label}`)}</th>
              {#each WHAT as w (w.label)}
                <td><input type="checkbox" aria-label={`${who.label} ${w.label}`} checked={has(who.shift, w.bit)} onchange={() => flip(who.shift, w.bit)} /></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
      {#if isDir}<label class="check"><input type="checkbox" bind:checked={recursiveMode} data-testid="perm-recursive" /> {t('files.recursiveMode')}</label>{/if}
      <div class="grid2">
        <label class="field"><span>{t('files.owner')}</span><input bind:value={owner} autocapitalize="none" spellcheck="false" /></label>
        <label class="field"><span>{t('files.group')}</span><input bind:value={group} autocapitalize="none" spellcheck="false" /></label>
      </div>
      {#if isDir}<label class="check"><input type="checkbox" bind:checked={recursiveOwner} data-testid="owner-recursive" /> {t('files.recursiveOwner')}</label>{/if}
    </form>
  {/if}
</Dialog>

<!-- A form's Back and its main button in the dialog's footer, in sight (UIA-01, UIB-08). -->
{#snippet formActions()}
  <button type="button" class="btn" onclick={() => (view = 'menu')}>{t('common.back')}</button>
  <button class="btn primary" form="sheet-form" disabled={busy} data-testid={view === 'compare' ? 'compare-go' : undefined}>{view === 'compare' ? t('files.compare') : view === 'rename' ? t('files.rename') : t('common.save')}</button>
{/snippet}


{#if phoneFiles}<PhoneFolderPicker bind:open={pickOpen} file={toPhone} />{/if}

<style>
  .perm {
    border-collapse: collapse;
    width: 100%;
  }
  .perm th,
  .perm td {
    text-align: center;
    padding: 4px;
  }
  .perm th:first-child {
    text-align: left;
    font-weight: 400;
    color: var(--text-dim);
  }
</style>
