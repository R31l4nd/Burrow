<script lang="ts" module>
  export interface PaneState {
    dirty: boolean;
    lang: string;
    lsp: boolean;
    sudo: boolean;
    /** Problems found: shown as one badge in the page's top bar when there are any. */
    errors: number;
    warnings: number;
    notes: number;
    /** Goes up a moment after the text changed (and when it is there): the outline is read again then. */
    rev: number;
  }
</script>

<script lang="ts">
  import { scrollCue } from '../lib/scrollcue.js';
  import { changeGutter, setSaved } from '../lib/editor/changes.js';
  import { problemNumbers } from '../lib/editor/problems.js';
  import DiffView from './DiffView.svelte';
  import { localPicture, markdownToHtml } from '../lib/markdown.js';
  import { releaseImageAllowed } from '@burrow/shared';
  import { keyBars, softKeyboard } from '../lib/keyboard.svelte.js';
  import { untrack } from 'svelte';
  import { editorSetup } from '../lib/editor/setup.js';
  import { EditorView, keymap } from '@codemirror/view';
  import { asEditor, lineEnd, withLineEnd } from '../lib/editor/eol.js';
  import { EditorState, Compartment } from '@codemirror/state';
  import { indentWithTab, redo, undo } from '@codemirror/commands';
  import { gotoLine as askLine, openSearchPanel } from '@codemirror/search';
  import type { Command } from '../lib/commands.js';
  import { outline, type OutlineItem } from '../lib/editor/outline.js';
  import { foldAll, unfoldAll } from '@codemirror/language';
  import { forEachDiagnostic, type Diagnostic } from '@codemirror/lint';
  import {
    formatDocument,
    formatKeymap,
    hoverTooltips,
    jumpToDefinitionKeymap,
    LSPClient,
    renameKeymap,
    serverCompletion,
    signatureHelp,
  } from '@codemirror/lsp-client';
  import type { Diagnostic as BurrowDiagnostic, FileEntry, HostContainers, TextFile } from '@burrow/shared';
  import Dialog from './Dialog.svelte';
  import FileAskDialog, { type FilePart } from './FileAskDialog.svelte';
  import Icon from './Icon.svelte';
  import { noteSaved } from '../lib/stackbase.js';
  import { hangingIndent } from '../lib/editor/hanging.js';
  import LoadFailed from './LoadFailed.svelte';
  import Skeleton from './Skeleton.svelte';
  import { ApiFailure, errorMessage, get, post, put } from '../lib/api.js';
  import { fromBurrow, mergedServerDiagnostics, setSource } from '../lib/editor/diagnostics.js';
  import { detectLanguage } from '../lib/editor/languages.js';
  import { lspTransport, type Refusal } from '../lib/editor/lsp.js';
  import { burrowEditorTheme, editorLabel } from '../lib/editor/theme.js';
  import { rawUrl } from '../lib/files.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { brokenPictures } from '../lib/brokenpictures.js';
  import { keepPictures } from '../lib/keeppictures.js';
  import type { TextSource } from '../lib/phonefiles.js';

  // One file on one host, with its language server, problems, the mobile key
  // bar and safe saving: a temporary file renamed over the original; if the
  // file changed on the host since it was opened, a diff instead. Files only
  // root may touch open and save through sudo (after a step-up).
  // Used by the single-file editor page and by every workspace tab.
  // A file of the phone (the Android app's Files page) comes from `source`
  // instead: nothing of it goes to Burrow (no language server, no checks on
  // the server, no pictures fetched through it).

  let {
    hostId: hostProp,
    path: pathProp,
    source: sourceProp,
    active = true,
    onstate = () => {},
    ongone = () => {},
    oncompare,
    gitBase,
  }: {
    hostId: number;
    path: string;
    /** Not a host's file: read and saved through this (the phone's, PhoneFiles). */
    source?: TextSource;
    /** Hidden tabs keep their state; the active one gets the keyboard. */
    active?: boolean;
    onstate?: (s: PaneState) => void;
    /** The file could not be opened and there is nothing to show. */
    ongone?: () => void;
    /** In a workspace: "Compare with..." another file (report 9d710d). */
    oncompare?: () => void;
    /** In a repository (a workspace): the file as last committed ('' new), else null; the change marks are against it, as VS Code's. */
    gitBase?: () => Promise<string | null>;
  } = $props();
  const hostId = untrack(() => hostProp);
  const path = untrack(() => pathProp);
  const source = untrack(() => sourceProp);
  const editorId = crypto.randomUUID().replace(/-/g, '');
  // The change marks against the last commit (gitBase), after each time they were set to the saved text.
  let baseSeq = 0;
  function headBase() {
    if (!gitBase) return;
    const mine = ++baseSeq;
    gitBase().then(
      (head) => head !== null && mine === baseSeq && view?.dispatch({ effects: setSaved.of(head) }),
      () => {},
    );
  }

  let el: HTMLDivElement | undefined = $state();
  let view: EditorView | null = null;
  let file = $state<TextFile | null>(null);
  let loadError = $state('');
  let loadCode = $state('');
  // Operators read a host's files; a phone's file is read only when the phone says so (or it was opened to read).
  let readOnly = $state(untrack(() => !sourceProp && session.state?.user?.role !== 'admin'));
  let dirty = $state(false);
  let saving = $state(false);
  let lspState = $state<'none' | 'connecting' | 'open' | 'closed'>('none');
  // Why it is not connected (the bridge's own words, or the connection gone), and the way to try again.
  let lspWhy = $state('');
  let retryLsp = $state<(() => void) | null>(null);
  let problems = $state<{ line: number; severity: string; message: string; from: number }[]>([]);
  let problemsOpen = $state(false);
  let conflict = $state<TextFile | null>(null);
  let composeBusy = $state(false);
  // Opened through sudo; the password (if sudo wanted one) for saving.
  let sudo = $state(false);
  let sudoPassword: string | undefined;
  // Readable, but only root may change it (most of /etc): read only until "Edit with sudo" (W-FUNC-01).
  let rootOnly = $state(false);
  let askPassword = $state<null | ((pw: string | null) => void)>(null);
  let passwordInput = $state('');
  // The key bar only while typing; the tools in a menu from the page's top bar.
  let focused = $state(false);
  let versus = $state<{ saved: string; now: string } | null>(null);
  let toolsOpen = $state(false);
  let preview = $state<string | null>(null);
  // On a wide pane the Markdown reads beside its text, live (report ac7481:
  // the preview in a dialog was small); on a narrow one it opens a dialog.
  const SIDE_KEY = 'burrow.markdownSide';
  const SIDE_MIN = 960;
  let paneW = $state(0);
  let side = $state(readSide());
  let sideHtml = $state('');
  let sideTimer: ReturnType<typeof setTimeout> | undefined;
  const sideShown = $derived(side && paneW >= SIDE_MIN);
  function readSide() {
    try {
      return localStorage.getItem(SIDE_KEY) === '1';
    } catch {
      return false;
    }
  }
  // Its pictures: GitHub's through Burrow, the ones beside the file from the host (a picture, never a page).
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  function picture(src: string): string | null {
    // A phone's file: no picture is fetched for it (through Burrow or else).
    if (source) return null;
    if (releaseImageAllowed(src)) return `/api/changelog/image?url=${encodeURIComponent(src)}`;
    const p = localPicture(dir, src);
    return p ? rawUrl(hostId, p) : null;
  }
  const md = (text: string) => markdownToHtml(text, { links: true, image: picture, pictureLabel: t('changelog.picture') });
  function renderSide() {
    sideHtml = md(view ? view.state.doc.toString() : (file?.content ?? ''));
  }
  // Shown again (the pane wider, the file loaded, the choice kept from before): made from the text as it is now.
  $effect(() => {
    if (sideShown && file) untrack(renderSide);
  });
  function togglePreview() {
    toolsOpen = false;
    if (paneW < SIDE_MIN) {
      preview = view ? md(view.state.doc.toString()) : null;
      return;
    }
    side = !side;
    try {
      localStorage.setItem(SIDE_KEY, side ? '1' : '0');
    } catch {
      // Not kept: the choice holds for this page only.
    }
    if (side) renderSide();
  }
  export const openTools = () => (toolsOpen = true);

  // "Ask AI about this file" (report 76bcda): the chosen lines (whole lines) or the whole text as the editor holds it now.
  let askPart = $state<FilePart | null>(null);
  let askOpen = $state(false);
  function askAi() {
    const v = view;
    if (!v) return;
    const doc = v.state.doc;
    const sel = v.state.selection.main;
    let chosen: FilePart['chosen'] = null;
    if (!sel.empty) {
      const from = doc.lineAt(sel.from).number;
      // A selection that ends at the start of a line leaves that line out, as an editor's line commands do.
      let to = doc.lineAt(sel.to).number;
      if (to > from && doc.line(to).from === sel.to) to--;
      chosen = { from, to, text: doc.sliceString(doc.line(from).from, doc.line(to).to) };
    }
    // A file's last line end is not one more line.
    const total = doc.lines > 1 && doc.line(doc.lines).length === 0 ? doc.lines - 1 : doc.lines;
    askPart = { text: doc.sliceString(0, doc.line(total).to), total, chosen };
    askOpen = true;
  }

  /** What this file can do now, for the command palette: the tools menu's actions, and Go to line. */
  export function commands(): Command[] {
    const v = view;
    if (!v) return [];
    const out: Command[] = [
      { id: 'editor.find', title: t('editor.find'), keys: 'Ctrl+F', run: () => openSearchPanel(v) },
      { id: 'editor.goToLine', title: t('editor.goToLine'), keys: 'Ctrl+Alt+G', run: () => askLine(v) },
      { id: 'editor.problems', title: t('editor.problemsTitle'), run: () => (problemsOpen = true) },
      { id: 'editor.foldAll', title: t('editor.foldAll'), run: () => foldAll(v) },
      { id: 'editor.unfoldAll', title: t('editor.unfoldAll'), run: () => unfoldAll(v) },
    ];
    if (lspState === 'open') out.push({ id: 'editor.format', title: t('editor.format'), run: () => void formatDocument(v) });
    if (lang.compose && !source) out.push({ id: 'editor.composeCheck', title: t('editor.composeCheck'), run: () => void composeCheck() });
    if (lang.name === 'nginx' && !source) out.push({ id: 'editor.nginx', title: 'nginx -t', run: () => void openNginx() });
    if (lang.name === 'Markdown') out.push({ id: 'editor.preview', title: sideShown ? t('editor.hidePreview') : t('editor.preview'), run: togglePreview });
    if (dirty) out.push({ id: 'editor.compareSaved', title: t('editor.compareSaved'), run: () => (versus = { saved: held, now: v.state.doc.toString() }) });
    if (oncompare) out.push({ id: 'editor.compareWith', title: t('files.compareWith'), run: oncompare });
    if (rootOnly) out.push({ id: 'editor.editSudo', title: t('editor.editSudo'), run: () => void editWithSudo() });
    if (!source) out.push({ id: 'editor.askAi', title: t('editor.askAi'), run: askAi });
    return out;
  }
  export const openProblems = () => (problemsOpen = true);
  let nginxOpen = $state(false);
  // null while read; the read's failure (or docker's on the host) said, never "none running" (A3-WEB-03).
  let nginxContainers = $state<string[] | null>(null);
  let nginxError = $state('');
  let nginxResult = $state<{ ok: boolean; output: string } | null>(null);
  let nginxBusy = $state(false);

  // The file's own line ends, kept on a save (a Windows file stays "\r\n"); the editor holds "\n".
  const eol = $derived(file ? lineEnd(file.content) : '\n');
  const held = $derived(file ? asEditor(file.content) : '');
  const lang = $derived(detectLanguage(path, file?.content.split('\n', 1)[0] ?? ''));
  const name = path.split('/').pop() ?? path;

  // Reported outside this effect's dependencies: the parent reads and writes
  // its own state in onstate, which must not loop back into this effect.
  $effect(() => {
    const s = { dirty, lang: lang.name, lsp: lspState === 'open', sudo, errors: counts.errors, warnings: counts.warnings, notes: counts.notes, rev };
    untrack(() => onstate(s));
  });


  export const isDirty = () => dirty;
  /** The text as it is here (typed too); null while it is not read, or could not be. */
  export const text = () => (view ? view.state.doc.toString() : null);

  async function load() {
    try {
      if (source) {
        const f = await source.read();
        readOnly = !f.writable;
        file = f;
        return;
      }
      // Only root may read it: said here, with "Open with sudo" (not a failure of the page).
      const f = await get<TextFile>(`/api/files/${hostId}/text?path=${encodeURIComponent(path)}`, ['permission_denied']);
      // Root's and readable to all: said before any typing, with sudo at hand, not after a refused save.
      if (f.writable === false && !readOnly) rootOnly = readOnly = true;
      file = f;
    } catch (err) {
      loadError = errorMessage(err);
      loadCode = err instanceof ApiFailure ? err.code : '';
    }
  }
  void load();

  /** Ask for the sudo password in a dialog; null when cancelled. */
  function promptPassword(): Promise<string | null> {
    passwordInput = '';
    return new Promise((resolve) => (askPassword = resolve));
  }

  async function withSudo<T>(fn: (password: string | undefined) => Promise<T>): Promise<T | null> {
    for (;;) {
      try {
        return await fn(sudoPassword);
      } catch (err) {
        if (err instanceof ApiFailure && (err.code === 'sudo_password' || err.code === 'sudo_wrong_password')) {
          if (err.code === 'sudo_wrong_password') toast(t('editor.sudoWrong'), 'error');
          const pw = await promptPassword();
          if (pw === null) return null;
          sudoPassword = pw;
          continue;
        }
        throw err;
      }
    }
  }

  /** A root file opened read only: the same text, read again through sudo, and editable. */
  async function editWithSudo() {
    try {
      const f = await withSudo((password) => post<TextFile>(`/api/files/${hostId}/sudo/read`, { path, ...(password !== undefined ? { password } : {}) }));
      if (!f) return;
      sudo = true;
      rootOnly = readOnly = false;
      file = f;
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content }, effects: [roConf.reconfigure([]), setSaved.of(f.content)] });
      headBase();
      dirty = false;
      view?.focus();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function openWithSudo() {
    try {
      const f = await withSudo((password) => post<TextFile>(`/api/files/${hostId}/sudo/read`, { path, ...(password !== undefined ? { password } : {}) }));
      if (!f) return;
      sudo = true;
      loadError = '';
      loadCode = '';
      file = f;
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const langConf = new Compartment();
  // Read only, or not: changed in place when a root file is opened through sudo.
  const roConf = new Compartment();


  $effect(() => {
    if (!el || !file || view) return;
    const f = file;
    const l = detectLanguage(path, f.content.split('\n', 1)[0] ?? '');
    const extensions = [
      editorSetup(),
      keymap.of([
        indentWithTab,
        { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
        ...formatKeymap,
        ...renameKeymap,
        ...jumpToDefinitionKeymap,
      ]),
      EditorView.lineWrapping,
      hangingIndent,
      // Operators read files; saving is the admin's.
      // Read only: still reachable by keyboard to scroll and select (a not editable text had no focus at all).
      roConf.of(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '0', 'aria-readonly': 'true' })] : []),
      problemNumbers,
      changeGutter,
      langConf.of([]),
      EditorView.updateListener.of((u) => {
        if (u.focusChanged) focused = u.view.hasFocus;
        if (u.docChanged) dirty = u.state.doc.toString() !== held;
        if (u.docChanged) {
          clearTimeout(revTimer);
          revTimer = setTimeout(() => rev++, 400);
        }
        if (u.docChanged && sideShown) {
          clearTimeout(sideTimer);
          sideTimer = setTimeout(renderSide, 150);
        }
        if (u.docChanged || u.transactions.some((tr) => tr.effects.length)) collectProblems();
      }),
      burrowEditorTheme,
      editorLabel(path),
    ];
    view = new EditorView({ parent: el, state: EditorState.create({ doc: f.content, extensions }) });
    headBase();
    rev++;
    if (pendingJump) gotoLine(pendingJump.line, pendingJump.col);
    void setupLanguage(l);
  });

  // Closed while the language was still being set up (it loads, asks the
  // server, connects): what comes after that is dropped, and a connection
  // made by then closed (audit WC-06).
  const gone = new AbortController();
  async function setupLanguage(l: ReturnType<typeof detectLanguage>) {
    if (!view) return;
    const exts = [await l.load()];
    if (gone.signal.aborted) return;
    // A phone's file is checked by nothing on the server (its text would go there).
    if (l.hadolint && !source) {
      // Not @codemirror/lint's linter(): it replaces all diagnostics with its
      // own result, which would wipe the language server's. Debounced by hand.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const run = (v: EditorView) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          // Not checked is said on the first line, not shown as no findings (AUDIT2 FS-21);
          // without hadolint in the image there is simply nothing to say.
          const doc = v.state.doc;
          const list = await post<BurrowDiagnostic[]>('/api/lint/dockerfile', { content: doc.toString() }).catch((err: unknown): BurrowDiagnostic[] =>
            err instanceof ApiFailure && err.code === 'no_linter' ? [] : [{ line: 1, column: 1, severity: 'info', message: t('editor.lintFailed', { message: errorMessage(err) }), source: 'hadolint' }],
          );
          // Only for the text it checked: changed since, the next run says (an older clean
          // result wiped newer findings, AUDIT2 UI-16).
          if (!gone.signal.aborted && v.state.doc === doc) setSource(v, 'hadolint', fromBurrow(v, list));
        }, 800);
      };
      destroyers.push(() => timer && clearTimeout(timer));
      exts.push(EditorView.updateListener.of((u) => u.docChanged && run(u.view)));
      run(view);
    }
    if (l.server && !source) {
      // A tab restored but not looked at yet starts no language server: twelve hidden ones filled
      // the limit per person, and the tab in front got none (review 2026-10-24).
      if (!untrack(() => active)) {
        // Its highlighting meanwhile; the server's part joins once shown.
        view?.dispatch({ effects: langConf.reconfigure([...exts]) });
        await new Promise<void>((r) => (whenShown = r));
      }
      if (gone.signal.aborted) return;
      const available = await get<Record<string, boolean>>('/api/lsp').catch(() => ({}) as Record<string, boolean>);
      if (gone.signal.aborted) return;
      if (available[l.server]) {
        const server = l.server;
        const client = new LSPClient({
          rootUri: `file:///burrow/${hostId}`,
          extensions: [serverCompletion(), hoverTooltips(), signatureHelp(), mergedServerDiagnostics()],
        });
        let transport: { close(): void } | null = null;
        let tries = 0;
        let openedAt = 0;
        // Connected again by itself when the connection went (Burrow restarted for an update, the
        // network): a few times, then said with why and Connect again (report 76bcda: "not
        // connected" for good, and nothing said what it meant).
        const connect = async (): Promise<boolean> => {
          lspState = 'connecting';
          try {
            const tr = await lspTransport(server, editorId, (s, why) => (s === 'closed' ? dropped(why) : (lspState = s)), gone.signal);
            if (gone.signal.aborted) return (tr.close(), false);
            transport = tr;
            openedAt = Date.now();
            lspWhy = '';
            client.connect(tr);
            return true;
          } catch (err) {
            const m = (err as Error).message;
            lspWhy = m === 'too_many' ? t('editor.lspTooMany') : /too slow/.test(m) ? t('editor.lspSlow') : t('editor.lspUnavailable');
            return false;
          }
        };
        const dropped = (why?: Refusal) => {
          if (gone.signal.aborted) return;
          client.disconnect();
          // Refused by the bridge (its limit per person): said, not tried again by itself.
          if (why) return void ((lspWhy = why === 'too_many' ? t('editor.lspTooMany') : t('editor.lspUnavailable')), (lspState = 'closed'));
          lspWhy = t('editor.lspDropped');
          // A connection that stayed a while starts the count again; one that goes at once does not loop.
          if (Date.now() - openedAt > 60_000) tries = 0;
          if (tries >= 5) return void (lspState = 'closed');
          lspState = 'connecting';
          setTimeout(() => void connect().then((ok) => !ok && dropped()), 1000 * 2 ** tries++);
        };
        retryLsp = () => {
          tries = 0;
          void connect().then((ok) => !ok && (lspState = 'closed'));
        };
        exts.push(client.plugin(`file:///burrow/${hostId}${path}`, server));
        if (!(await connect())) lspState = 'closed';
        destroyers.push(() => {
          client.disconnect();
          transport?.close();
        });
      }
    }
    view?.dispatch({ effects: langConf.reconfigure(exts) });
  }
  const destroyers: (() => void)[] = [];
  $effect(() => () => {
    gone.abort();
    clearTimeout(sideTimer);
    clearTimeout(revTimer);
    for (const d of destroyers) d();
    view?.destroy();
    view = null;
  });

  let rev = $state(0);
  let revTimer: ReturnType<typeof setTimeout> | undefined;

  /** Its outline now (lib/editor/outline.ts), for the workspace's Outline. */
  export const outlineNow = (): OutlineItem[] => (view ? outline(view.state.doc.toString(), lang.name) : []);

  /** Its problems now, for the workspace's list of the open files' problems. */
  export function problemList(): { line: number; severity: string; message: string }[] {
    if (!view) return [];
    const list: { line: number; severity: string; message: string }[] = [];
    forEachDiagnostic(view.state, (d: Diagnostic, from: number) => void list.push({ line: view!.state.doc.lineAt(from).number, severity: d.severity, message: d.message }));
    return list.sort((a, b) => a.line - b.line);
  }

  function collectProblems() {
    if (!view) return;
    const list: { line: number; severity: string; message: string; from: number }[] = [];
    forEachDiagnostic(view.state, (d: Diagnostic, from: number) => {
      list.push({ line: view!.state.doc.lineAt(from).number, severity: d.severity, message: d.message, from });
    });
    problems = list.sort((a, b) => a.line - b.line);
  }

  function jump(from: number) {
    problemsOpen = false;
    view?.dispatch({ selection: { anchor: from }, scrollIntoView: true });
    view?.focus();
  }

  let pendingJump: { line: number; col: number } | null = null;
  /** Put the cursor on a line (a search result), once the file is there. */
  export function gotoLine(line: number, col = 1) {
    if (!view) {
      pendingJump = { line, col };
      return;
    }
    pendingJump = null;
    const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    const at = Math.min(l.from + col - 1, l.to);
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    view.focus();
  }

  export function focus() {
    view?.focus();
  }

  // A tab that was hidden measured nothing; measure again when it shows.
  let whenShown: (() => void) | null = null;
  $effect(() => {
    if (!active) return;
    view?.requestMeasure();
    whenShown?.();
    whenShown = null;
  });

  /**
   * Read again when it changed on the host (a git pull, a terminal, another program) and nothing
   * here is unsaved: told by its size and time in its folder's list, without reading it. An open
   * file kept the old text, and the first save after typing was a conflict (review 2026-10-24).
   */
  export async function checkFresh() {
    if (!view || !file || dirty || saving || source || sudo) return;
    const dir = path.replace(/\/[^/]*$/, '') || '/';
    const list = await get<{ entries: FileEntry[] }>(`/api/files/${hostId}/list?path=${encodeURIComponent(dir)}`).catch(() => null);
    const e = list?.entries.find((x) => x.path === path);
    // Gone: a save says so. A link: its own time is not its file's.
    if (!e || e.type === 'link') return;
    // The same time and size: unchanged, unless that time is a moment ago. Times are whole
    // seconds, so a change in the second it was read in looked the same; its text is compared then.
    const recent = Date.now() - Date.parse(e.mtime) < 3000;
    if (e.mtime === file.mtime && e.size === file.size && !recent) return;
    await reload().catch(() => {});
  }

  /** Read the file again (replaced elsewhere); only when there is nothing unsaved. */
  export async function reload() {
    if (!view || dirty) return;
    const before = view.state.doc.toString();
    const f = source ? await source.read() : sudo ? await withSudo((password) => post<TextFile>(`/api/files/${hostId}/sudo/read`, { path, ...(password !== undefined ? { password } : {}) })) : await get<TextFile>(`/api/files/${hostId}/text?path=${encodeURIComponent(path)}`);
    // Typed while it was read: keep that text; saving it then shows the conflict.
    if (!f || !view || dirty || view.state.doc.toString() !== before) return;
    // The same text (only touched): the cursor and the scroll stay where they are.
    if (file && f.hash === file.hash) return void (file = f);
    file = f;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content }, effects: setSaved.of(f.content) });
    headBase();
    dirty = false;
  }

  export async function save(overrideHash?: string): Promise<boolean> {
    if (!view || !file || saving || readOnly) return false;
    saving = true;
    const typed = view.state.doc.toString();
    const content = withLineEnd(typed, eol);
    const body = { path, content, baseHash: overrideHash ?? file.hash };
    try {
      const saved = source
        ? await source.write(content, body.baseHash)
        : sudo
        ? await withSudo((password) => put<TextFile>(`/api/files/${hostId}/sudo/text`, { ...body, ...(password !== undefined ? { password } : {}) }))
        : await put<TextFile>(`/api/files/${hostId}/text`, body);
      if (!saved) return false;
      file = saved;
      // A stack's file being edited: what this tab saved is still "since you started editing" (A3-WEB-14).
      if (!source) noteSaved(hostId, path, saved.hash);
      view.dispatch({ effects: setSaved.of(typed) });
      headBase();
      // Typed while the save was on its way: that part is not saved yet.
      dirty = view.state.doc.toString() !== typed;
      conflict = null;
      toast(t('editor.saved'));
      return true;
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'conflict') {
        const r = source
          ? await source.read().catch(() => null)
          : sudo
          ? await withSudo((password) => post<TextFile>(`/api/files/${hostId}/sudo/read`, { path, ...(password !== undefined ? { password } : {}) })).catch(() => null)
          : await get<TextFile>(`/api/files/${hostId}/text?path=${encodeURIComponent(path)}`).catch(() => null);
        // Changed on the host, and that version could not be read: said, not silence (AUDIT2 UI-17).
        // The text here stays, unsaved; saving again tries again.
        if (r) conflict = r;
        else toast(t('editor.conflictUnread'), 'error');
      } else if (err instanceof ApiFailure && err.code === 'permission_denied' && !sudo && !source) {
        // Refused as the SSH user (a file that turned root's since it was read): saved through sudo
        // when asked, with the same base, so a change meanwhile is still a conflict (W-FUNC-01).
        saving = false;
        if (await ask({ text: t('editor.saveSudoAsk'), confirm: t('editor.saveSudo') })) {
          sudo = true;
          return save(overrideHash);
        }
      } else toast(errorMessage(err), 'error');
      return false;
    } finally {
      saving = false;
    }
  }

  // Your text against the host's, compared as everywhere else (DiffView).
  const mine = $derived(conflict ? ((view as EditorView | null)?.state.doc.toString() ?? '') : '');

  function reloadTheirs() {
    if (!view || !conflict) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: conflict.content }, effects: setSaved.of(conflict.content) });
    headBase();
    file = conflict;
    dirty = false;
    conflict = null;
  }

  async function composeCheck() {
    if (!view) return;
    composeBusy = true;
    try {
      const doc = view.state.doc;
      const r = await post<{ ok: boolean; diagnostics: BurrowDiagnostic[] }>(`/api/files/${hostId}/compose-check`, { path, content: doc.toString() });
      // Marked in the text only when it is the text checked; the result is said either way.
      if (view && view.state.doc === doc) setSource(view, 'compose', fromBurrow(view, r.diagnostics));
      toast(r.ok ? t('editor.composeOk') : t('editor.composeErrors', { n: r.diagnostics.length }), r.ok ? 'info' : 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      composeBusy = false;
    }
  }

  let nginxAsked = 0;
  function openNginx() {
    nginxOpen = true;
    nginxResult = null;
    void readNginx();
  }
  async function readNginx() {
    const mine = ++nginxAsked;
    nginxContainers = null;
    nginxError = '';
    let h: HostContainers;
    try {
      h = await get<HostContainers>(`/api/docker/${hostId}/containers`);
    } catch (err) {
      if (mine === nginxAsked) nginxError = errorMessage(err);
      return;
    }
    if (mine !== nginxAsked) return;
    if (h.error) return void (nginxError = h.error);
    const running = h.containers.filter((c) => c.state === 'running');
    const likely = (n: string, img: string) => /nginx|swag|openresty|proxy/i.test(`${n} ${img}`);
    nginxContainers = running.sort((a, b) => Number(likely(b.name, b.image)) - Number(likely(a.name, a.image)) || a.name.localeCompare(b.name)).map((c) => c.name);
  }

  async function nginxTest(container: string) {
    if (dirty && !(await save())) return;
    nginxBusy = true;
    try {
      nginxResult = await post<{ ok: boolean; output: string }>(`/api/docker/${hostId}/nginx-test`, { container });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      nginxBusy = false;
    }
  }

  function key(insert: string) {
    if (!view) return;
    const r = view.state.selection.main;
    view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length } });
    view.focus();
  }

  const counts = $derived({
    errors: problems.filter((p) => p.severity === 'error').length,
    warnings: problems.filter((p) => p.severity === 'warning').length,
    notes: problems.filter((p) => p.severity !== 'error' && p.severity !== 'warning').length,
  });
</script>

<div class="pane" class:hidden={!active} bind:clientWidth={paneW}>
  {#if loadError}
    <div class="page stack">
      <p class="alert error">{loadError}</p>
      {#if loadCode === 'permission_denied' && !source}
        <button class="btn primary" onclick={openWithSudo} data-testid="open-sudo">{t('editor.openSudo')}</button>
        <p class="dim small">{t('help.sudo')}</p>
      {/if}
      {#if (loadCode === 'binary' || loadCode === 'too_large') && !source}
        <a class="btn" href={rawUrl(hostId, path, true)} download={name}>{t('files.download')}</a>
      {/if}
      <button class="btn" onclick={ongone}>{t('common.close')}</button>
    </div>
  {:else}
    {#if sudo}<div class="sudo-bar small" data-testid="sudo-bar">{t('editor.sudoMode')}</div>{/if}
    {#if rootOnly}
      <div class="sudo-bar small root-only" data-testid="root-only-bar"><span>{t('editor.rootOnly')}</span><button class="btn small" onclick={editWithSudo} data-testid="edit-sudo">{t('editor.editSudo')}</button></div>
    {:else if readOnly}<div class="sudo-bar small" data-testid="readonly-bar">{t(source ? 'phone.readOnly' : 'editor.readOnly')}</div>{/if}
    <div class="split">
      <div class="cm" bind:this={el} data-testid="editor" data-main data-private></div>
      {#if sideShown && lang.name === 'Markdown'}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
        <aside class="md-side" tabindex="0" aria-label={t('editor.preview')} data-testid="markdown-side"><div class="md-preview" use:brokenPictures use:keepPictures={sideHtml} data-testid="markdown-rendered" data-private></div></aside>
      {/if}
    </div>

    <!-- While typing on a phone: focused, and its keyboard open. -->
    {#if focused && !readOnly && softKeyboard.open && keyBars.show}
    <div use:scrollCue class="keys" role="toolbar" aria-label={t('term.keys')} data-testid="editor-keys">
      <button onpointerdown={(e) => e.preventDefault()} onclick={() => key('\t')}>Tab</button>
      <button onpointerdown={(e) => e.preventDefault()} onclick={() => view && undo(view)} aria-label={t('editor.undo')}><Icon name="undo" size={18} /></button>
      <button onpointerdown={(e) => e.preventDefault()} onclick={() => view && redo(view)} aria-label={t('editor.redo')}><Icon name="redo" size={18} /></button>
      <button onpointerdown={(e) => e.preventDefault()} onclick={() => view && openSearchPanel(view)} aria-label={t('editor.find')} title={t('editor.find')}><Icon name="search" size={18} /></button>
      {#if lspState === 'open'}
        <button onpointerdown={(e) => e.preventDefault()} onclick={() => view && formatDocument(view)}>{t('editor.format')}</button>
      {/if}
      {#each ['{', '}', '[', ']', '(', ')', '"', "'", '$', '|', '#', ':', '-'] as k (k)}
        <button onpointerdown={(e) => e.preventDefault()} onclick={() => key(k)}>{k}</button>
      {/each}
    </div>
    {/if}
  {/if}
</div>

<Dialog tour="editor-tools" menu bind:open={toolsOpen} title={name}>
  <div class="stack" data-testid="editor-tools">
    <button class="btn" onclick={() => ((toolsOpen = false), (problemsOpen = true))} data-testid="problems">
      <Icon name="alert" size={18} /> {t('editor.problems', { e: counts.errors, w: counts.warnings, i: counts.notes })}
    </button>
    {#if lang.compose && !source}
      <button class="btn" disabled={composeBusy} onclick={() => ((toolsOpen = false), void composeCheck())} data-testid="compose-check"><Icon name="check" size={18} /> {t('editor.composeCheck')}</button>
      <p class="dim small">{t('help.composeCheck')}</p>
    {/if}
    {#if lang.name === 'nginx' && !source}
      <button class="btn" onclick={() => ((toolsOpen = false), void openNginx())} data-testid="nginx-test"><Icon name="check" size={18} /> nginx -t</button>
    {/if}
    {#if lang.name === 'Markdown'}
      <button class="btn" onclick={togglePreview} data-testid="markdown-preview"><Icon name="info" size={18} /> {sideShown ? t('editor.hidePreview') : t('editor.preview')}</button>
    {/if}
    <button class="btn" onclick={() => ((toolsOpen = false), view && openSearchPanel(view))}><Icon name="search" size={18} /> {t('editor.find')}</button>
    {#if oncompare}
      <button class="btn" onclick={() => ((toolsOpen = false), oncompare())} data-testid="ws-compare-open"><Icon name="swap" size={18} /> {t('files.compareWith')}</button>
    {/if}
    {#if dirty}
      <button class="btn" onclick={() => ((toolsOpen = false), (versus = view ? { saved: held, now: view.state.doc.toString() } : null))} data-testid="compare-saved"
        ><Icon name="swap" size={18} /> {t('editor.compareSaved')}</button
      >
    {/if}
    {#if lspState === 'open'}
      <button class="btn" onclick={() => ((toolsOpen = false), view && formatDocument(view))}><Icon name="format" size={18} /> {t('editor.format')}</button>
      <!-- Said what it does: "Format" alone left people guessing. -->
      <p class="dim small">{t('help.format')}</p>
    {/if}
    {#if !source}
      <!-- A phone's file never goes to Burrow, so not to a model through it either. -->
      <button class="btn" onclick={() => ((toolsOpen = false), askAi())} data-testid="editor-ask-ai"><Icon name="sparkle" size={18} /> {t('editor.askAi')}</button>
    {/if}
    <button class="btn" onclick={() => ((toolsOpen = false), view && foldAll(view))}><Icon name="fold-all" size={18} /> {t('editor.foldAll')}</button>
    <button class="btn" onclick={() => ((toolsOpen = false), view && unfoldAll(view))}><Icon name="unfold-all" size={18} /> {t('editor.unfoldAll')}</button>
    {#if lspState === 'closed'}
      <!-- What it means, why, and the way back (report 76bcda). -->
      <p class="dim small" data-testid="lsp-off">{t('editor.lspOff')}{#if lspWhy}{` (${lspWhy})`}{/if}</p>
      {#if retryLsp}<button class="btn small" onclick={() => ((toolsOpen = false), retryLsp?.())} data-testid="lsp-retry"><Icon name="reload" size={16} /> {t('editor.lspRetry')}</button>{/if}
    {/if}
  </div>
</Dialog>

{#if !source}<FileAskDialog bind:open={askOpen} {hostId} {path} part={askPart} />{/if}

<!-- The Markdown as it reads: made here from the text (escaped, nothing of
     the file runs, no picture is loaded), never the file served as a page. -->
<Dialog tour="markdown-preview" size="wide" open={preview !== null} title={name} onclose={() => (preview = null)}>
  {#if preview !== null}<div class="md-preview" use:brokenPictures data-testid="markdown-rendered" data-private>{@html preview}</div>{/if}
</Dialog>

<!-- What a save would write: the text now against the file as saved. -->
<Dialog tour="compare-saved" size="wide" open={versus !== null} title={t('editor.compareSaved')} onclose={() => (versus = null)}>
  {#if versus}<DiffView original={versus.saved} modified={versus.now} label={t('editor.compareSaved')} names={[t('editor.savedVersion'), t('editor.yourVersion')]} />{/if}
</Dialog>

<Dialog tour="editor-problems" size="wide" bind:open={problemsOpen} title={t('editor.problemsTitle')}>
  <!-- None: said, without an empty list's rule under it (UIB-16). -->
  {#if problems.length === 0}<p class="dim">{t('editor.noProblems')}</p>
  {:else}
  <div class="list">
    {#each problems as p, i (i)}
      <button class="list-item" onclick={() => jump(p.from)} data-testid="problem">
        <span class="badge sev-{p.severity}">{p.line}</span>
        <span class="main"><span class="small">{p.message}</span></span>
      </button>
    {/each}
  </div>
  {/if}
</Dialog>

<Dialog tour="editor-conflict" size="wide" open={conflict !== null} title={t('editor.conflictTitle')} onclose={() => (conflict = null)}>
  <p class="small">{t('editor.conflictHelp')}</p>
  {#if conflict}<DiffView original={asEditor(conflict.content)} modified={mine} label={t('editor.conflictTitle')} names={[t('editor.hostVersion'), t('editor.yourVersion')]} />{/if}
  {#snippet actions()}
    <button class="btn" onclick={reloadTheirs}>{t('editor.takeTheirs')}</button>
    <button class="btn danger" onclick={() => conflict && save(conflict.hash)}>{t('editor.overwrite')}</button>
  {/snippet}
</Dialog>

<Dialog tour="sudo-password" open={askPassword !== null} title={t('editor.sudoPassword')} onclose={() => (askPassword?.(null), (askPassword = null))}>
  <form
    id="sudo-pw-{editorId}"
    class="stack"
    onsubmit={(e) => {
      e.preventDefault();
      askPassword?.(passwordInput);
      askPassword = null;
    }}
  >
    <p class="small dim">{t('help.sudoPassword')}</p>
    <label class="field">
      <span>{t('editor.sudoPassword')}</span>
      <input type="password" bind:value={passwordInput} autocomplete="off" required />
    </label>
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (askPassword?.(null), (askPassword = null))}>{t('common.cancel')}</button>
    <button class="btn primary" form="sudo-pw-{editorId}">{t('common.next')}</button>
  {/snippet}
</Dialog>

<Dialog tour="nginx-test" size="wide" bind:open={nginxOpen} title="nginx -t">
  <p class="small dim">{t('editor.nginxHelp')}</p>
  {#if nginxResult}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
    <pre tabindex="0" class="out" class:bad={!nginxResult.ok} data-testid="nginx-output">{nginxResult.output || (nginxResult.ok ? 'ok' : '')}</pre>
  {/if}
  {#if nginxError}
    <LoadFailed inline message={nginxError} onretry={readNginx} />
  {:else if nginxContainers === null}
    {#if nginxOpen}<Skeleton rows={3} />{/if}
  {:else if nginxContainers.length}
    <div class="list">
      {#each nginxContainers as c (c)}
        <button class="list-item" disabled={nginxBusy} onclick={() => nginxTest(c)}><Icon name="box" /> <span class="main"><span class="title">{c}</span></span></button>
      {/each}
    </div>
  {:else}
    <!-- Not inside the list's border: there it sat against its edge. -->
    <p class="dim small">{t('editor.nginxNone')}</p>
  {/if}
</Dialog>

<style>
  .pane {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .pane.hidden {
    display: none;
  }
  .sudo-bar {
    padding: 4px 10px;
    background: var(--warn-bg);
    color: var(--warn);
    font-weight: 600;
  }
  .root-only {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px 12px;
  }
  .split {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .cm {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .md-side {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 12px 20px;
    border-left: 1px solid var(--border);
    background: var(--bg-raised);
  }
  .cm :global(.cm-editor) {
    height: 100%;
  }
  .keys {
    display: flex;
    gap: 4px;
    padding: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
  }
  .keys button {
    flex: 1 0 auto;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text);
    font: 600 0.9rem var(--mono);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
  }
  .out {
    white-space: pre-wrap;
    font: 0.8rem var(--mono);
    padding: 8px;
    border-radius: 6px;
    background: var(--bg-sunken);
    border: 1px solid var(--ok);
  }
  .out.bad {
    border-color: var(--danger);
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
</style>
