<script lang="ts">
  import Dialog from '../components/Dialog.svelte';
  import { roving } from '../lib/roving.js';
  import { scrollCue } from '../lib/scrollcue.js';
  import { keyBars } from '../lib/keyboard.svelte.js';
  import { ask, askText } from '../lib/confirm.svelte.js';
  import { tick, untrack } from 'svelte';
  import { session } from '../lib/session.svelte.js';
  import type { ContainerInfo, FileEntry, GitStatus, Workspace } from '@burrow/shared';
  import BottomPanel from '../components/BottomPanel.svelte';
  import EditorPane, { type PaneState } from '../components/EditorPane.svelte';
  import Icon from '../components/Icon.svelte';
  import LoadFailed from '../components/LoadFailed.svelte';
  import FileSheet from '../components/FileSheet.svelte';
  import FileTree from '../components/workspace/FileTree.svelte';
  import GitPanel from '../components/workspace/GitPanel.svelte';
  import QuickOpen from '../components/workspace/QuickOpen.svelte';
  import CommandPalette from '../components/workspace/CommandPalette.svelte';
  import type { Command } from '../lib/commands.js';
  import { shortcuts } from '../lib/shortcuts.svelte.js';
  import SearchPanel from '../components/workspace/SearchPanel.svelte';
  import CompareDialog from '../components/workspace/CompareDialog.svelte';
  import { fileLabels, type FileLabel } from '../lib/tablabels.js';
  import { moveTab } from '../lib/termsplit.js';
  import { renamedTab } from '../lib/wstabs.js';
  import { errorMessage, get, post, put } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { up } from '../lib/router.svelte.js';
  import Viewer from '../components/Viewer.svelte';
  import { openKind } from '../lib/files.svelte.js';
  import { keepFresh } from '../lib/keepfresh.js';
  import { copyText, toast, inBackground } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';

  // A folder on a host as a project: the tree (a drawer on a phone), files
  // in tabs, quick open (Ctrl+P), search and replace across all files, and
  // git. The editor in each tab is the same as for a single file.

  let { id: idProp }: { id: number } = $props();
  const id = untrack(() => idProp);
  // Saving and changing the workspace are the admin's.
  const admin = $derived(session.state?.user?.role === 'admin');

  interface Tab {
    path: string;
    state: PaneState;
    pane?: EditorPane;
    /** Its side when the editor is split (1: the right one). */
    group?: 0 | 1;
    /** Opened with one click in the tree: the next one so opened takes its place, until it is kept
     *  (a double click on it or its tab, or a change in it), as in VS Code and code-server (report 96a655). */
    preview?: boolean;
  }

  let ws = $state<Workspace | null>(null);
  let tabs = $state<Tab[]>([]);
  let current = $state<string | null>(null);
  let side = $state<'files' | 'search' | 'git' | 'outline'>('files');
  let drawer = $state(false);
  let quickOpen = $state(false);
  // The status with the folder it is of: another folder chosen, it is not that one's (AUDIT2 PAGE-03).
  let gitOf = $state<{ root: string; status: GitStatus | null; error: string } | null>(null);
  let trees = $state<Record<string, FileTree | undefined>>({});
  // The workspace's folders: its root and the ones added (same host).
  const roots = $derived(ws ? [ws.root, ...(ws.folders ?? [])] : []);
  // The folder that search, git and "go to file" work in.
  let folder = $state('');
  const inFolder = $derived(folder || ws?.root || '');
  // Repositories below the folders (a few levels down): chosen like a folder,
  // and the open file's own one by itself (report 91e73c).
  let repos = $state<string[]>([]);
  const folderOptions = $derived([...roots, ...repos.filter((r) => !roots.includes(r))]);
  async function loadRepos() {
    if (!ws) return;
    const w = ws;
    const found = await Promise.all(roots.map((r) => get<string[]>(`/api/workspace/${w.hostId}/git/repos?root=${encodeURIComponent(r)}`).catch(() => [] as string[])));
    repos = [...new Set(found.flat())];
  }
  $effect(() => {
    // Not while searching: a result opened in a repository below would start the search over.
    if (!current || !ws || side === 'search') return;
    const full = fullPath(current);
    const own = folderOptions.filter((o) => full.startsWith(`${o}/`)).sort((a, b) => b.length - a.length)[0];
    if (!own) return;
    const pick = own === ws.root ? '' : own;
    untrack(() => {
      if (pick !== folder) {
        folder = pick;
        inBackground(refreshGit());
      }
    });
  });
  // The file as last committed, for the editor's change marks (as VS Code's gutter): from the
  // repository it is in ('' when new there), or null when it is in none Burrow knows.
  async function headOf(full: string): Promise<string | null> {
    if (!ws) return null;
    const repo = folderOptions.filter((o) => full.startsWith(`${o}/`)).sort((a, b) => b.length - a.length)[0];
    if (!repo || !(repos.includes(repo) || (repo === inFolder && git?.repo))) return null;
    const r = await get<{ exists: boolean; content: string }>(`/api/workspace/${ws.hostId}/git/head?root=${encodeURIComponent(repo)}&path=${encodeURIComponent(full.slice(repo.length + 1))}`);
    return r.exists ? r.content : '';
  }
  // A tree shows the changes of the repository chosen, also one below it.
  const treeChanges = (r: string): Record<string, string> => {
    if (r === inFolder) return changes;
    if (!inFolder.startsWith(`${r}/`)) return {};
    const pre = inFolder.slice(r.length + 1);
    return Object.fromEntries(Object.entries(changes).map(([k, v]) => [`${pre}/${k}`, v]));
  };
  // Tabs: a path relative to the root, or absolute in another folder.
  const tabPath = (root: string, rel: string) => (root === ws?.root ? rel : `${root}/${rel}`);
  // A root of "/" gives "/etc/x", not "//etc/x".
  const rootBase = () => ws!.root.replace(/\/+$/, '');
  const fullPath = (p: string) => (p.startsWith('/') ? p : `${rootBase()}/${p}`);
  // One spelling per file, whichever way it was opened (the tree, a search in a repository below the root):
  // relative to the root when it is below it, else absolute.
  const pathKey = (p: string) => (ws && p.startsWith(`${rootBase()}/`) ? p.slice(rootBase().length + 1) : p);
  // Open files by name, and those of the same name with the part of their folder that tells them apart (report 9d710d).
  const labels = $derived(ws ? fileLabels(tabs.map((x) => fullPath(x.path)), roots) : new Map<string, FileLabel>());
  const labelOf = (full: string): FileLabel => labels.get(full) ?? fileLabels([full], roots).get(full)!;
  const named = (full: string) => {
    const l = labelOf(full);
    return l.dir ? `${l.name} (${l.dir})` : l.name;
  };
  // The window's title says the open file too, as VS Code's does.
  $effect(() => {
    if (!ws) return;
    document.title = `${active ? `${named(fullPath(active.path))} - ` : ''}${ws.name} - Burrow`;
  });
  $effect(() => () => (document.title = 'Burrow'));

  // Compare a file with another: an open one, or any of the workspace's folders (report 9d710d).
  let comparing = $state<string | null>(null);
  let compareOpen = $state(false);
  function startCompare(full: string) {
    menuOpen = false;
    comparing = full;
    compareOpen = true;
  }
  const textOf = (full: string) => tabs.find((x) => fullPath(x.path) === full)?.pane?.text() ?? null;

  // Right click (or a long press) on the tree: the file's menu from Files
  // (report 80a8ce); "Edit" opens it in a tab here.
  let menuItem = $state<FileEntry | null>(null);
  let menuOpen = $state(false);
  const menuPrefs = $state({ hidden: true, sort: 'name' as const, grid: false });
  function openInTab(path: string) {
    const r = [...roots].sort((a, b) => b.length - a.length).find((x) => path.startsWith(`${x}/`));
    // "Edit" from the menu: as text, also a picture's.
    if (r) open(tabPath(r, path.slice(r.length + 1)), undefined, undefined, true);
  }
  const refreshTrees = () => Object.values(trees).forEach((tr) => tr?.refresh());
  // The open file read again when it changed on the host and nothing in it is unsaved: every few
  // seconds while seen, and when its tab comes to the front (the others then).
  $effect(() => keepFresh(() => void active?.pane?.checkFresh()));
  $effect(() => {
    const p = active?.pane;
    if (p) untrack(() => void p.checkFresh());
  });

  // The panel under the editor: a terminal in the root, and the logs of
  // the containers whose compose folder is in one of the workspace's folders.
  let panel = $state(false);
  const inRoots = (c: ContainerInfo) => !!c.workingDir && roots.some((r) => c.workingDir === r || c.workingDir!.startsWith(r === '/' ? '/' : `${r}/`));

  // One change of the folder list at a time, each on the list as the one before left it:
  // two added quickly both stay (AUDIT2 PAGE-29: the second sent a list without the first).
  let folderChain: Promise<void> = Promise.resolve();
  function changeFolders(change: (now: string[]) => string[]): Promise<void> {
    folderChain = folderChain.then(async () => {
      if (!ws) return;
      try {
        ws = await put<Workspace>(`/api/workspaces/${ws.id}`, { folders: change(ws.folders ?? []) });
        inBackground(loadRepos());
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    });
    return folderChain;
  }
  async function addFolder() {
    if (!ws) return;
    const parent = ws.root.slice(0, ws.root.lastIndexOf('/') + 1) || '/';
    const path = await askText({ text: t('ws.addFolderHelp', { host: ws.hostName }), confirm: t('ws.addFolder'), input: { label: t('ws.folderPath'), value: parent } });
    if (path) await changeFolders((now) => (now.includes(path) ? now : [...now, path]));
  }
  async function removeFolder(f: string) {
    if (!ws || !(await ask({ text: t('ws.removeFolderConfirm', { path: f }), confirm: t('common.remove') }))) return;
    await changeFolders((now) => now.filter((x) => x !== f));
    // The folder shown went: the root's status, read again (AUDIT2 PAGE-03).
    if (folder === f) {
      folder = '';
      inBackground(refreshGit());
    }
  }
  const TABS_KEY = `burrow.ws.${id}`;

  // Remembered tabs are written only once they were read back: the empty
  // start overwrote them while the workspace still loaded (audit WP-03).
  let restored = $state(false);
  let loadError = $state('');
  function load() {
    loadError = '';
    get<Workspace>(`/api/workspaces/${id}`)
      .then(restore)
      .catch((err: unknown) => (loadError = errorMessage(err)));
  }
  load();
  function restore(w: Workspace) {
    ws = w;
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}') as { tabs?: string[]; current?: string; right?: string[] };
      tabs = (saved.tabs ?? []).map((path) => ({ path, group: saved.right?.includes(path) ? 1 : 0, state: { dirty: false, lang: '', lsp: false, sudo: false, errors: 0, warnings: 0, notes: 0, rev: 0 } }));
      current = saved.current ?? tabs[0]?.path ?? null;
    } catch {
      // A fresh start.
    }
    restored = true;
    inBackground(refreshGit());
    inBackground(loadRepos());
  }

  // Open tabs are remembered on this device.
  $effect(() => {
    if (!restored) return;
    const list = tabs.map((x) => x.path);
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: list, current, right: tabs.filter((x) => x.group === 1).map((x) => x.path) }));
    } catch {
      // Not remembered.
    }
  });

  // The newest ask only: a slow answer for the folder before showed its
  // changes in the folder chosen since (audit WP-14).
  let gitSeq = 0;
  async function refreshGit() {
    if (!ws) return;
    const mine = ++gitSeq;
    const root = inFolder;
    // Not read is not "no repository" (AUDIT2 PAGE-08).
    const next = await get<GitStatus>(`/api/workspace/${ws.hostId}/git/status?root=${encodeURIComponent(root)}`).then(
      (status) => ({ root, status, error: '' }),
      (err: unknown) => ({ root, status: null, error: errorMessage(err) }),
    );
    if (mine === gitSeq) gitOf = next;
  }

  const git = $derived(gitOf && gitOf.root === inFolder ? gitOf.status : null);
  const gitError = $derived(gitOf && gitOf.root === inFolder ? gitOf.error : '');
  const changes = $derived(Object.fromEntries((git?.files ?? []).map((f) => [f.path, f.index === '?' ? '?' : f.worktree !== ' ' ? f.worktree : f.index])));
  // The pane itself knows best (typed while a save was on its way).
  const anyDirty = () => tabs.some((x) => x.pane?.isDirty() ?? x.state.dirty);
  const active = $derived(tabs.find((x) => x.path === current) ?? null);

  // A picture, a video or a sound from the tree: shown as on the Files page, not a tab saying "binary".
  let media = $state<FileEntry | null>(null);
  function open(opened: string, line?: number, col?: number, asText = false, preview = false) {
    const name = opened.split('/').pop() ?? opened;
    if (!asText && ['image', 'video', 'audio'].includes(openKind(name))) {
      media = { name, path: fullPath(pathKey(opened)), type: 'file', size: 0, mtime: '', mode: 0, owner: '', group: '' } as FileEntry;
      drawer = false;
      return;
    }
    const path = pathKey(opened);
    // On a phone every file keeps its tab: no double tap to keep one, no hover to tell a preview.
    const asPreview = preview && !narrow.on;
    const there = tabs.find((x) => x.path === path);
    if (there) {
      if (!asPreview) there.preview = false;
    } else {
      // In the side in front, when the editor is split; a preview in the place of that side's preview, unless that one holds changes.
      const group = split ? (active?.group ?? 0) : 0;
      const tab: Tab = { path, group, preview: asPreview, state: { dirty: false, lang: '', lsp: false, sudo: false, errors: 0, warnings: 0, notes: 0, rev: 0 } };
      const old = asPreview ? tabs.findIndex((x) => x.preview && (x.group ?? 0) === group && !(x.pane?.isDirty() ?? x.state.dirty)) : -1;
      if (old >= 0) tabs[old] = tab;
      else tabs.push(tab);
    }
    current = path;
    drawer = false;
    if (line) queueMicrotask(() => tabs.find((x) => x.path === path)?.pane?.gotoLine(line, col ?? 1));
  }

  // Renamed or deleted from the tree: its open tabs (also those below a folder) follow, or close.
  // One with unsaved text stays as it is: its save says the file is gone, the text kept.
  function moved(from: string, to: string | null) {
    for (const tab of [...tabs]) {
      const full = fullPath(tab.path);
      if (full !== from && !full.startsWith(`${from}/`)) continue;
      if (tab.pane?.isDirty() ?? tab.state.dirty) continue;
      const i = tabs.indexOf(tab);
      if (to === null) {
        tabs.splice(i, 1);
        if (current === tab.path) current = tabs[Math.min(i, tabs.length - 1)]?.path ?? null;
        continue;
      }
      const next = pathKey(to + full.slice(from.length));
      const was = tab.path;
      tabs[i] = renamedTab(tab, next);
      if (current === was) current = next;
    }
  }

  // Closed lately, the newest first: Reopen closed tab (VS Code's Ctrl+Shift+T, which a browser keeps for itself).
  let closedTabs = $state<string[]>([]);
  function reopenClosed() {
    const path = closedTabs.find((p) => !tabs.some((x) => x.path === p));
    if (!path) return;
    closedTabs = closedTabs.filter((x) => x !== path);
    open(path);
  }

  // A new file or folder from the tree's menu; a file opens in a tab at once.
  async function newIn(kind: 'file' | 'dir', dir: string) {
    const name = await askText({ text: t(kind === 'dir' ? 'files.newFolder' : 'files.newFile'), confirm: t('common.save'), input: { label: t('files.name'), value: '' } });
    if (!name?.trim() || !ws) return;
    const path = `${dir === '/' ? '' : dir}/${name.trim()}`;
    try {
      await post(`/api/files/${ws.hostId}/create`, { path, kind });
      refreshTrees();
      if (kind === 'file') open(path, undefined, undefined, true);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function close(path: string) {
    const tab = tabs.find((x) => x.path === path);
    // The pane knows best: typed while a save was on its way.
    if ((tab?.pane?.isDirty() ?? tab?.state.dirty) && !(await ask({ text: t('ws.closeUnsaved', { name: path.split('/').pop() ?? path }), confirm: t('common.closeUnsaved'), danger: true }))) return;
    const i = tabs.findIndex((x) => x.path === path);
    closedTabs = [path, ...closedTabs.filter((x) => x !== path)].slice(0, 20);
    tabs.splice(i, 1);
    if (current === path) current = tabs[Math.min(i, tabs.length - 1)]?.path ?? null;
  }

  // The open files in the person's own order (report 50a6f6), as VS Code: a tab dragged onto
  // another (before it, or after a later one: the terminal's tabs do the same), or the focused one
  // moved with Ctrl+Shift and an arrow. Kept with the open tabs.
  const narrowQuery = typeof window !== 'undefined' ? matchMedia('(max-width: 599px)') : null;
  const narrow = $state({ on: narrowQuery?.matches ?? false });
  $effect(() => {
    const on = () => (narrow.on = narrowQuery?.matches ?? false);
    narrowQuery?.addEventListener('change', on);
    return () => narrowQuery?.removeEventListener('change', on);
  });
  let dragging: string | null = null;
  function reorder(order: string[]) {
    tabs.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
  }
  function dropTab(on: string) {
    if (dragging) reorder(moveTab(tabs.map((x) => x.path), dragging, on));
    dragging = null;
  }
  function tabKey(e: KeyboardEvent, path: string) {
    const by = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!by || !(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    e.preventDefault();
    const ids = tabs.map((x) => x.path);
    const to = ids[ids.indexOf(path) + by];
    if (!to) return;
    const btn = e.currentTarget as HTMLElement;
    reorder(moveTab(ids, path, to));
    // The focus stays on the tab moved: moved in the page, its button lost it.
    void tick().then(() => btn.focus());
  }

  // Any way out (Back, the rail, the terminal, history) asks with unsaved tabs.
  warnUnsaved(anyDirty);
  const leave = () => up('/hosts');

  // Two files side by side on a wide screen (VS Code's split editor): each tab on a side, one shown on
  // each, the one in front taking the keys. One editor per file, moved by its place in a grid, so a
  // move keeps its unsaved text. On a phone or a narrow window one side, all the tabs.
  const split = $derived(!narrow.on && tabs.some((x) => x.group === 1) && tabs.some((x) => (x.group ?? 0) === 0));
  const sides = $derived<(0 | 1)[]>(split ? [0, 1] : [0]);
  let shown = $state<[string | null, string | null]>([null, null]);
  $effect(() => {
    const tab = tabs.find((x) => x.path === current);
    if (tab) untrack(() => (shown[tab.group ?? 0] = tab.path));
  });
  // The tab a side shows: the one last in front there, else its first.
  const shownIn = (g: 0 | 1) => (tabs.find((x) => x.path === shown[g] && (x.group ?? 0) === g) ?? tabs.find((x) => (x.group ?? 0) === g))?.path ?? null;
  const visible = (tab: Tab) => (split ? shownIn(tab.group ?? 0) === tab.path : tab.path === current);
  // One side left: all on the left again.
  $effect(() => {
    if (tabs.length && !tabs.some((x) => (x.group ?? 0) === 0)) untrack(() => tabs.forEach((x) => (x.group = 0)));
  });
  /** The tab in front to the other side (VS Code's Move Editor into Next Group). */
  function moveToOtherSide(path = current) {
    const tab = tabs.find((x) => x.path === path);
    if (!tab || tabs.length < 2) return;
    tab.group = (tab.group ?? 0) === 1 ? 0 : 1;
    current = tab.path;
  }
  function dropOnSide(g: 0 | 1) {
    const tab = tabs.find((x) => x.path === dragging);
    dragging = null;
    if (!tab || (tab.group ?? 0) === g) return;
    tab.group = g;
    current = tab.path;
  }

  // The outline of the file in front (lib/editor/outline.ts), read again a moment after it changed.
  const outlineItems = $derived.by(() => {
    void active?.state.rev;
    return side === 'outline' && active?.pane ? active.pane.outlineNow() : [];
  });
  // The problems of every open file, as VS Code's Problems: the badge counts them all.
  const totals = $derived(tabs.reduce((a, x) => ({ e: a.e + x.state.errors, w: a.w + x.state.warnings, i: a.i + x.state.notes }), { e: 0, w: 0, i: 0 }));
  let problemsOpen = $state(false);
  let problemFiles = $state<{ path: string; items: { line: number; severity: string; message: string }[] }[]>([]);
  function openAllProblems() {
    problemFiles = tabs.map((x) => ({ path: x.path, items: x.pane?.problemList() ?? [] })).filter((f) => f.items.length);
    problemsOpen = true;
  }
  function toProblem(path: string, line: number) {
    problemsOpen = false;
    open(path, line);
  }

  // Every command of the workspace and of the file in front (F1, Ctrl+Shift+P), as VS Code's palette.
  let palette = $state(false);
  function commands(): Command[] {
    const a = active;
    const out: Command[] = [
      { id: 'ws.quickOpen', title: t('ws.quickOpen'), keys: 'Ctrl+P', run: () => (quickOpen = true) },
      { id: 'ws.search', title: t('ws.search'), keys: 'Ctrl+Shift+F', run: () => ((side = 'search'), (drawer = true)) },
      { id: 'ws.files', title: t('ws.files'), run: () => ((side = 'files'), (drawer = true)) },
      { id: 'ws.git', title: 'Git', run: () => ((side = 'git'), (drawer = true)) },
      { id: 'ws.outline', title: t('ws.outline'), run: () => ((side = 'outline'), (drawer = true)) },
      { id: 'ws.problems', title: t('ws.problemsAll'), run: openAllProblems },
      ...(closedTabs.some((p) => !tabs.some((x) => x.path === p)) ? [{ id: 'ws.reopen', title: t('ws.reopenClosed'), run: reopenClosed }] : []),
      ...(!narrow.on && tabs.length > 1 ? [{ id: 'ws.otherSide', title: t('ws.otherSide'), run: () => moveToOtherSide() }] : []),
      { id: 'panel.toggle', title: t('panel.toggle'), run: () => (panel = !panel) },
      { id: 'ws.refresh', title: t('ws.refresh'), run: () => refreshTrees() },
      { id: 'shortcuts', title: t('shortcuts.title'), keys: '?', run: () => (shortcuts.open = true) },
    ];
    if (admin) out.push({ id: 'ws.newFile', title: t('files.newFile'), run: () => void newIn('file', ws!.root) }, { id: 'ws.newFolder', title: t('files.newFolder'), run: () => void newIn('dir', ws!.root) }, { id: 'ws.addFolder', title: t('ws.addFolder'), run: () => void addFolder() });
    if (a) {
      if (admin && a.state.dirty) out.push({ id: 'editor.save', title: t('editor.save'), keys: 'Ctrl+S', run: () => inBackground(a.pane?.save() ?? Promise.resolve(false)) });
      out.push({ id: 'files.copyPath', title: t('files.copyPath'), run: () => void copyText(fullPath(a.path)).then((ok) => ok && toast(t('common.copied'))) });
      out.push({ id: 'ws.closeTab', title: t('ws.closeTab', { name: named(fullPath(a.path)) }), run: () => void close(a.path) });
      out.push(...(a.pane?.commands() ?? []));
    }
    return out;
  }

  // Ctrl+P anywhere in the workspace; Ctrl+Shift+F for search; Ctrl+S saves the open file also with
  // the focus on the tree or the tabs (not the browser's "Save page"). A key the terminal or the editor
  // took is theirs (Ctrl+Shift+F searches a terminal).
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        palette = true;
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'p' && e.shiftKey) {
        e.preventDefault();
        palette = true;
      } else if (k === 'p' && !e.shiftKey) {
        e.preventDefault();
        quickOpen = true;
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault();
        side = 'search';
        drawer = true;
      } else if (k === 's' && !e.shiftKey) {
        e.preventDefault();
        if (active?.pane) inBackground(active.pane.save());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function onPaneState(path: string, s: PaneState) {
    const tab = tabs.find((x) => x.path === path);
    if (!tab) return;
    const saved = tab.state.dirty && !s.dirty;
    tab.state = s;
    // Changed: kept, a preview no more.
    if (s.dirty) tab.preview = false;
    // A save changes what git sees.
    if (saved) inBackground(refreshGit());
  }
</script>

{#if ws}
  <div class="ws">
    <header class="bar appbar">
      <button class="icon-btn" aria-label={t('common.back')} onclick={leave}><Icon name="back" /></button>
      <button class="icon-btn narrow-only" aria-label={t('ws.files')} aria-expanded={drawer} onclick={() => (drawer = !drawer)} data-testid="ws-drawer"><Icon name="folder" /></button>
      <div class="title">
        <span class="name">{ws.name}</span>
        <span class="dim small">{ws.hostName}:{ws.root}{git?.branch ? ` | ${git.branch}` : ''}</span>
      </div>
      <button class="icon-btn" aria-label={t('ws.quickOpen')} title="{t('ws.quickOpen')} (Ctrl+P)" onclick={() => (quickOpen = true)} data-testid="ws-quick"><Icon name="search" /></button>
      <!-- On a computer: every command, as VS Code's palette (F1). -->
      <button class="icon-btn wide-only" aria-label={t('ws.commands')} title="{t('ws.commands')} (F1)" onclick={() => (palette = true)} data-testid="ws-commands"><Icon name="keyboard" /></button>
      <button class="icon-btn" aria-label={t('panel.toggle')} title={t('panel.toggle')} aria-pressed={panel} onclick={() => (panel = !panel)} data-testid="panel-toggle"><Icon name="terminal" /></button>
{#if totals.e + totals.w > 0}
        <!-- Every open file's problems (VS Code's Problems), not only the one in front. -->
        <button class="probs-badge" class:bad={totals.e > 0} onclick={openAllProblems} aria-label={t('editor.problems', { e: totals.e, w: totals.w, i: totals.i })} title={t('editor.problems', { e: totals.e, w: totals.w, i: totals.i })} data-testid="problems-badge">
          <Icon name="alert" size={16} />{totals.e + totals.w}
        </button>
      {/if}
      {#if admin}<button class="icon-btn" aria-label={t('editor.save')} title={t('editor.save')} disabled={!active?.state.dirty} onclick={() => active?.pane?.save()} data-testid="save"><Icon name="save" /></button>{/if}
      {#if active}<button class="icon-btn" aria-label={t('editor.tools')} title={t('editor.tools')} onclick={() => active?.pane?.openTools()} data-testid="editor-menu"><Icon name="more" /></button>{/if}
    </header>

    <div class="body">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      {#if drawer}<div class="scrim narrow-only" onclick={() => (drawer = false)}></div>{/if}
      <aside class="side" class:open={drawer}>
        <div class="seg" role="tablist" use:roving>
          {#each [['files', t('ws.files')], ['search', t('ws.search')], ['git', 'Git'], ['outline', t('ws.outline')]] as const as [k, label] (k)}
            <button role="tab" aria-selected={side === k} class:on={side === k} onclick={() => (side = k)} data-testid="ws-tab-{k}">
              {label}{#if k === 'git' && git?.files.length}<span class="count">{git.files.length}</span>{/if}
            </button>
          {/each}
        </div>
        <div class="sidebody">
          <div class:hide={side !== 'files'}>
            {#each roots as r (r)}
              <!-- More than one folder: each under its own name, the extra ones removable. -->
              {#if roots.length > 1}
                <div class="rootrow" data-testid="ws-root">
                  <Icon name="folder" size={16} />
                  <span class="rname" title={r}>{r.split('/').pop() || r}</span>
                  {#if r !== ws.root && admin}<button class="icon-btn" aria-label={t('ws.removeFolder', { path: r })} title={t('ws.removeFolder', { path: r })} onclick={() => removeFolder(r)} data-testid="ws-remove-folder"><Icon name="close" size={14} /></button>{/if}
                </div>
              {/if}
              <FileTree bind:this={trees[r]} hostId={ws.hostId} root={r} changes={treeChanges(r)} current={current && fullPath(current).startsWith(`${r}/`) ? fullPath(current).slice(r.length + 1) : null} onopen={(p, keep) => open(tabPath(r, p), undefined, undefined, false, !keep)} onmenu={(e) => ((menuItem = e), (menuOpen = true))} upload={admin} />
            {/each}
            <div class="treeactions">
              <button class="btn small" onclick={addFolder} data-testid="ws-add-folder"><Icon name="plus" size={16} /> {t('ws.addFolder')}</button>
              <!-- Read again now; it also is by itself, every few seconds while seen (report 905455). -->
              <button class="icon-btn" aria-label={t('ws.refresh')} title={t('ws.refresh')} onclick={() => refreshTrees()} data-testid="ws-refresh"><Icon name="reload" size={16} /></button>
            </div>
          </div>
          {#if folderOptions.length > 1 && (side === 'search' || side === 'git')}
            <label class="field infolder">
              <span>{t('ws.inFolder')}</span>
              <select bind:value={folder} onchange={() => inBackground(refreshGit())} data-testid="ws-folder">
                {#each folderOptions as r (r)}<option value={r === ws.root ? '' : r}>{r}</option>{/each}
              </select>
            </label>
          {/if}
          {#if side === 'search'}
            {#key inFolder}
              <SearchPanel hostId={ws.hostId} root={inFolder} onopen={(p, line, col) => open(tabPath(inFolder, p), line, col)} onreplaced={(ps) => ps.forEach((p) => tabs.find((x) => x.path === pathKey(tabPath(inFolder, p)))?.pane?.reload())} />
            {/key}
          {:else if side === 'git'}
            <GitPanel workspace={ws} root={inFolder} status={git} error={gitError} onchanged={() => (inBackground(refreshGit()), Object.values(trees).forEach((x) => x?.refresh()), tabs.forEach((x) => !x.state.sudo && void x.pane?.reload().catch(() => {})))} onopen={(p) => open(tabPath(inFolder, p))} />
          {:else if side === 'outline'}
            <!-- The file in front: its headings, keys, sections or functions; a tap goes there. -->
            <div class="outline" data-testid="ws-outline">
              {#each outlineItems as o, i (i)}
                <button class="oitem" style:padding-left="{8 + o.depth * 14}px" onclick={() => ((drawer = false), active?.pane?.gotoLine(o.line))} data-testid="outline-item"><span class="oname">{o.name}</span><span class="dim small">{o.line}</span></button>
              {:else}
                <p class="dim small pad">{active ? t('ws.noOutline') : t('ws.outlineNoFile')}</p>
              {/each}
            </div>
          {/if}
        </div>
      </aside>

      <!-- With the panel open, the editor and the panel share the room (e2e checks: data-split). -->
      <div class="main" data-split={panel ? '' : undefined}>
        {#if tabs.length}
          <!-- Open files: a name to switch to, a x to close. Not ARIA tabs: a
               tab may not hold a second button. Split: a bar on each side. -->
          <div class="editors" class:split data-testid="ws-editors">
          {#each sides as g (g)}
          <div
            use:scrollCue
            class="tabs"
            class:front={split && (active?.group ?? 0) === g}
            class:right={g === 1}
            style:grid-column={g + 1}
            role="group"
            aria-label={t('ws.openFiles')}
            ondragover={(e) => dragging && e.preventDefault()}
            ondrop={(e) => (e.preventDefault(), dropOnSide(g))}
            data-testid="ws-tabbar"
          >
            {#each tabs.filter((x) => !split || (x.group ?? 0) === g) as tab (tab.path)}
              {@const label = labelOf(fullPath(tab.path))}
              <div
                class="tab"
                class:on={tab.path === current}
                class:preview={tab.preview}
                class:shown={split && tab.path !== current && visible(tab)}
                draggable={!narrow.on}
                ondragstart={(e) => ((dragging = tab.path), e.dataTransfer?.setData('text/plain', tab.path))}
                ondragover={(e) => dragging && e.preventDefault()}
                ondrop={(e) => (e.preventDefault(), e.stopPropagation(), (tabs.find((x) => x.path === dragging) ?? { group: 0 }).group !== tab.group && split ? dropOnSide(g) : dropTab(tab.path))}
                ondragend={() => (dragging = null)}
                role="presentation"
                data-testid="ws-tabbar-item"
              >
                <!-- A right click (a long press): the file's tools, Compare with... among them. -->
                <button
                  class="tname"
                  data-testid="ws-tab"
                  aria-current={tab.path === current ? 'true' : undefined}
                  onclick={() => (current = tab.path)}
                  ondblclick={() => (tab.preview = false)}
                  onkeydown={(e) => tabKey(e, tab.path)}
                  oncontextmenu={(e) => (e.preventDefault(), (current = tab.path), tab.pane?.openTools())}
                  title="{ws.hostName}:{fullPath(tab.path)}{tab.preview ? `\n${t('ws.previewTab')}` : ''}"
                  >{#if tab.state.dirty}<span class="dirty-dot" role="img" aria-label={t('common.unsaved')} data-testid="dirty"></span>{/if}{label.name}{#if label.dir}<span class="tdir" data-testid="ws-tab-dir">{label.dir}</span>{/if}</button
                >
                <button class="tclose" data-testid="ws-tab-close" aria-label={t('ws.closeTab', { name: named(fullPath(tab.path)) })} onclick={() => close(tab.path)}><Icon name="close" size={14} /></button>
              </div>
            {/each}
          </div>
          {/each}
          {#each tabs as tab (tab.path)}
            <!-- Its side by its place in the grid: moved, the same editor (its unsaved text kept). -->
            <div class="slot" class:gone={!visible(tab)} class:right={split && tab.group === 1} style:grid-column={split ? (tab.group ?? 0) + 1 : 1} onfocusin={() => tab.path !== current && (current = tab.path)} data-testid="ws-slot">
              <EditorPane
                bind:this={tab.pane}
                hostId={ws.hostId}
                path={fullPath(tab.path)}
                active={visible(tab)}
                onstate={(s) => onPaneState(tab.path, s)}
                ongone={() => close(tab.path)}
                gitBase={() => headOf(fullPath(tab.path))}
                oncompare={() => startCompare(fullPath(tab.path))}
              />
            </div>
          {/each}
          </div>
        {:else}
          <div class="empty-ws" data-content>
            <p class="dim">{t('ws.empty')}</p>
            <button class="btn" onclick={() => (quickOpen = true)} data-testid="ws-empty-quick">{t('ws.quickOpen')}{#if !keyBars.show}<span class="kbd-hint"> (Ctrl+P)</span>{/if}</button>
            <button class="btn narrow-only" onclick={() => (drawer = true)} data-testid="ws-empty-files">{t('ws.files')}</button>
          </div>
        {/if}
        <BottomPanel key="ws.{ws.id}" hostId={ws.hostId} cwd={ws.root} auto={inRoots} autoHelp={t('panel.autoWorkspace')} bind:open={panel} />
      </div>
    </div>
  </div>

  <FileSheet bind:open={menuOpen} item={menuItem} hostId={ws.hostId} dir={null} prefs={menuPrefs} onchanged={refreshTrees} onmoved={moved} onnewIn={newIn} onedit={openInTab} oncompare={startCompare} />
  <CompareDialog bind:open={compareOpen} hostId={ws.hostId} {roots} path={comparing} openFiles={tabs.map((x) => fullPath(x.path))} label={labelOf} {textOf} onopentab={openInTab} />
  <Viewer hostId={ws.hostId} items={media ? [media] : []} index={media ? 0 : null} onclose={() => (media = null)} />
  <CommandPalette bind:open={palette} {commands} />
  <Dialog tour="ws-problems" bind:open={problemsOpen} title={t('ws.problemsAll')}>
    <div class="stack" data-testid="ws-problems">
      {#each problemFiles as f (f.path)}
        <h3 class="pfile">{named(fullPath(f.path))}</h3>
        {#each f.items as p, i (i)}
          <button class="list-item" onclick={() => toProblem(f.path, p.line)} data-testid="ws-problem">
            <span class="pbadge sev-{p.severity}">{p.line}</span>
            <span class="main"><span class="small">{p.message}</span></span>
          </button>
        {/each}
      {:else}
        <p class="dim small">{t('ws.noProblems')}</p>
      {/each}
    </div>
  </Dialog>
  <QuickOpen bind:open={quickOpen} hostId={ws.hostId} {roots} onopen={(p, line) => open(p, line)} />
{:else if loadError}
  <LoadFailed message={loadError} onretry={load} heading />
{:else}
  <div class="center-screen dim">{t('common.loading')}</div>
{/if}

<style>
  .ws {
    position: fixed;
    /* Beside the narrow rail on a computer (none on a phone). */
    inset: 0 0 0 var(--rail-w);
    display: flex;
    flex-direction: column;
    background: var(--bg);
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-weight: 700;
  }
  .title span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .side {
    width: 290px;
    flex: none;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-raised);
  }
  .seg {
    display: flex;
    gap: 2px;
    padding: 4px;
    border-bottom: 1px solid var(--border);
  }
  .seg button {
    flex: 1;
    min-height: 34px;
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
  .count {
    margin-left: 4px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--warn-bg);
    color: var(--warn);
    font-size: 0.75rem;
  }
  .sidebody {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .hide {
    display: none;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .editors {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .editors.split {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .slot {
    grid-row: 2;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .slot.gone {
    display: none;
  }
  .tabs.right,
  .slot.right {
    border-left: 1px solid var(--border);
  }
  /* The side not in front: its tab shown, but not underlined. */
  .tab.shown {
    background: var(--bg-sunken);
  }
  .tabs.front {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .tabs {
    grid-row: 1;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
    flex: none;
  }
  .tab {
    display: flex;
    align-items: center;
    flex: none;
    border-right: 1px solid var(--border);
  }
  /* A preview (one click in the tree): its name in italics, as VS Code shows one (report 96a655). */
  .tab.preview .tname {
    font-style: italic;
  }
  .tab.on {
    background: var(--bg-sunken);
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .tname {
    border: 0;
    background: none;
    color: var(--text);
    font: 0.85rem var(--font);
    padding: 8px 4px 8px 12px;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  /* Which folder, for files of the same name: dim, after the name. */
  .tdir {
    margin-left: 6px;
    color: var(--text-dim);
    font-size: 0.75rem;
  }
  .tclose {
    border: 0;
    background: none;
    color: var(--text-dim);
    font-size: 1.1rem;
    min-width: 32px;
    min-height: 36px;
    cursor: pointer;
  }
  /* Near the top, as the other empty states: in the middle of a phone it sat below a third of the screen of nothing. */
  .empty-ws {
    /* The room above the panel: the panel at the bottom, not under a short hint (2.3.1 tour). */
    flex: 1 1 auto;
    min-height: 0;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    /* The hint in a readable line, not wrapped in a 200 px box in a 1000 px pane (UIB-10). */
    max-width: min(100%, 520px);
    padding: 48px 16px 16px;
    text-align: center;
  }
  .narrow-only {
    display: none;
  }
  @media (max-width: 899px) {
    .narrow-only {
      display: inline-flex;
    }
    .side {
      position: absolute;
      z-index: 20;
      inset: 0 auto 0 0;
      width: min(86vw, 340px);
      transform: translateX(-102%);
      transition:
        transform var(--dur-2) var(--ease),
        visibility var(--dur-2);
      visibility: hidden;
    }
    .side.open {
      transform: none;
      visibility: visible;
      box-shadow: var(--shadow);
    }
    .scrim {
      position: absolute;
      inset: 0;
      z-index: 19;
      background: rgb(0 0 0 / 0.35);
    }
    .empty-ws .btn.narrow-only {
      display: flex;
    }
  }
  .rootrow {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 2px;
    font-weight: 600;
    font-size: 0.85rem;
  }
  .rname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Full width inside the side bar's edges, not past them. */
  .treeactions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 8px;
  }
  .treeactions > .btn {
    flex: 1;
  }
  .infolder {
    padding: 8px 8px 0;
  }
  .outline {
    display: flex;
    flex-direction: column;
    padding: 4px 0;
  }
  .oitem {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    min-height: 32px;
    align-items: center;
    padding-right: 8px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  @media (hover: hover) {
    .oitem:hover {
      background: var(--bg-hover);
    }
  }
  .oname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pfile {
    font-size: 0.9rem;
    margin: 4px 0 0;
  }
  .pbadge {
    border-radius: 6px;
    padding: 0 6px;
    font-variant-numeric: tabular-nums;
  }
  .sev-error {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .sev-info,
  .sev-hint {
    background: color-mix(in srgb, var(--focus) 20%, transparent);
    color: var(--focus);
  }
  .sev-warning {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .pad {
    padding: 8px;
  }
</style>
