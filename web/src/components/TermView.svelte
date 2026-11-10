<script lang="ts" module>
  // Terminals on screen with the app's keyboard, volume keys and screen on: split panes are several,
  // and closing one turned these off for the others (review 2026-10-24).
  let devicePanes = 0;
  // What is typed in the text box and not sent yet, per session: kept while another tab is in front,
  // each tab its own view made anew (report e55d04: switching tabs and back, it was gone).
  const drafts = new Map<string, string>();
</script>

<script lang="ts">
  import { scrollCue } from '../lib/scrollcue.js';
  import { composePlan, oneLine, pasteSafely } from '../lib/pastesafe.js';
  import { fingerSpeed, speedUp } from '../lib/wheel.js';
  import { cellCount, ordered, rangeText, wordAt, type Cell, type CellRange } from '../lib/termselect.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { keyBars, softKeyboard } from '../lib/keyboard.svelte.js';
  import Icon from './Icon.svelte';
  import { Terminal as XTerm } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import { SearchAddon } from '@xterm/addon-search';
  import '@xterm/xterm/css/xterm.css';
  import { isTermReply, type PathEntry, type ShellState, type Snippet } from '@burrow/shared';
  import { suggest, type HistoryItem, type Suggestion } from '../lib/complete/engine.js';
  import { attachTextInput } from '../lib/textinput.js';
  import { noteKey, termDebug } from '../lib/termdebug.js';
  import { note, noteEvent, noteTouch, terminalState } from '../lib/inputlog.js';
  import { cursorLine, inputAtCursor, type BufferView } from '../lib/complete/line.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import { onDestroy, untrack } from 'svelte';
  import { sendQueue } from '../lib/sendqueue.js';
  import { cssVar, termTheme } from '../lib/termtheme.js';
  import { ansiLines } from '../lib/ansi.js';
  import { touch } from '../lib/touch.js';
  import { prefs, savePrefs } from '../lib/sessions.svelte.js';
  import { applyModifiers, DEFAULT_BAR, parseBar, volumeUpKey, type BarKey, type DeviceTerminal } from '../lib/terminal.js';

  // The terminal itself, without knowing where its bytes go: xterm, the
  // suggestion chips, the compose box and the key bar. Used for sessions on
  // the server (pages/Terminal.svelte) and for the Android app's direct route
  // (direct/). The parent feeds output in (write, reset, applySize) and gets
  // keystrokes and sizes out (oninput, onresize).

  let {
    owner = true,
    shell = null,
    history = [],
    snippets = [],
    run = null,
    ls = null,
    onai = null,
    oninput: toSession,
    onresize,
    onready = null,
    onswipe = null,
    onforget = null,
    device = null,
    onscrollback = null,
    onhistory = null,
    arrowScroll = false,
    canSend = true,
    draftKey = null,
    // Written below and read by the parent through bind:limited.
    // eslint-disable-next-line no-useless-assignment
    limited = $bindable(false),
  }: {
    /** This device sets the size (else the terminal shows another device's size). */
    owner?: boolean;
    shell?: ShellState | null;
    history?: HistoryItem[];
    snippets?: Snippet[];
    /** Run a completion generator script on the host. */
    run?: ((script: string[] | string, cwd: string | null) => Promise<string>) | null;
    ls?: ((path: string) => Promise<{ dir: string; entries: PathEntry[] }>) | null;
    /** A line starting with # becomes an "ask the AI" chip; null hides it. */
    onai?: ((question: string) => void) | null;
    oninput: (data: string) => void;
    onresize: (cols: number, rows: number, active: boolean) => void;
    onready?: ((term: XTerm) => void) | null;
    onswipe?: ((step: number) => void) | null;
    /** A history suggestion held down (or right-clicked): forget that command. */
    onforget?: ((command: string) => void) | null;
    /** The Android app, when in it: plain keyboard input, volume keys, screen on. */
    device?: DeviceTerminal | null;
    /** Scrolling back is done elsewhere (Burrow's tmux keeps the history): lines back, negative forward. */
    onscrollback?: ((lines: number) => void) | null;
    /** Ask the session for its whole history (answered through showHistory): scrolled back, it is shown in the history layer. */
    onhistory?: ((mouse: boolean) => void) | null;
    /** A program on its alternate screen without the mouse (less, vim; told by the session): a scroll is arrow keys, as xterm's alternate scroll. */
    arrowScroll?: boolean;
    /** Out: the input line is a guess (no shell integration). */
    limited?: boolean;
    /** The session is connected: what the text box sends arrives. */
    canSend?: boolean;
    /** The session this is: what is typed in the text box is kept under it while the view is gone. */
    draftKey?: string | null;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let ctrl = $state(false);
  let alt = $state(false);
  // Volume up was pressed (in the app): the next key is a special one (lib/terminal.ts volumeUpKey).
  let fn = $state(false);
  /** What a key typed becomes with the modifiers held (Ctrl, Alt, volume up), which then let go. */
  function typedKey(d: string): string {
    const out = fn && [...d].length === 1 ? volumeUpKey(d) : applyModifiers(d, ctrl, alt);
    ctrl = false;
    alt = false;
    fn = false;
    return out;
  }
  // Everything for the session goes through here, in order (lib/sendqueue.ts):
  // a part sent a moment later holds back what comes after it.
  const out = sendQueue(sendNow);
  const oninput = (d: string): void => out.now(d);
  onDestroy(() => out.flush());
  // Noted for a problem report's input recording (lib/inputlog.ts; its text only when allowed).
  function sendNow(d: string): void {
    note({ e: 'sent', text: d });
    // Typing stops a glide and a scroll still to go: they went on after the
    // first key, and the typed text ended in tmux's copy mode (audit BR-01).
    // Not the wheel's own reports, which are how a glide scrolls a program.
    if (!d.startsWith('\x1b[<') && !d.startsWith('\x1b[M')) {
      glide++;
      scrollPending = 0;
      // Typed: back to the live screen (not the terminal's own answers, a focus report).
      if (layer && !isTermReply(d)) closeLayer();
    }
    toSession(d);
  }
  let suggestions = $state<Suggestion[]>([]);
  // Where the suggestions were read from, and so where a picked one goes:
  // the text box, or the terminal's own line (typed straight in, box open or not).
  let fromBox = false;
  $effect(() => note({ e: 'suggestions', n: suggestions.length }));
  // The line they were worked out for: typed on since, a pick adds only what is still missing.
  let suggestedFor = '';
  // For a problem report: what is shown now (lib/termdebug.ts).
  $effect(() => {
    termDebug.suggestions = suggestions.length;
  });
  let aiLine = $state<string | null>(null);
  const bar = $derived(parseBar(prefs.keyBar ?? DEFAULT_BAR));

  let term: XTerm | null = null;
  let fit: FitAddon | null = null;

  // ---- output side, driven by the parent

  // xterm parses what is written later (write is queued), a size or a reset
  // took effect at once: output from before a size change was then read at
  // the new size. A size or a reset waits for the writes before it, and the
  // writes after it wait for it (AUDIT2 TERM-14).
  let inflight = 0;
  let waiting: (() => void)[] = [];
  function put(data: string, done?: () => void): void {
    const t = term;
    if (!t) return;
    if (waiting.length) return void waiting.push(() => term === t && written(t, data, done));
    written(t, data, done);
  }
  function written(t: XTerm, data: string, done?: () => void): void {
    inflight++;
    t.write(data, () => {
      if (term !== t) return;
      inflight--;
      done?.();
      while (!inflight && waiting.length) waiting.shift()!();
    });
  }
  function inTurn(fn: (t: XTerm) => void): void {
    const t = term;
    if (!t) return;
    if (!inflight && !waiting.length) fn(t);
    else waiting.push(() => term === t && fn(t));
  }

  export function write(data: string): void {
    put(data);
    if (layer?.lines) layer.newer = true;
  }

  // Output played again (a kept tab back in front, lib/termpool.ts): the
  // terminal's answers to the queries in it (a tmux asks what terminal this
  // is) went out the first time, and would land in the shell as text.
  let replaying = 0;
  export function replay(data: string): void {
    if (!term) return;
    replaying++;
    put(data, () => replaying--);
  }

  /** A full screen (snapshot) at a given size. */
  export function reset(data: string, cols: number, rows: number): void {
    closeLayer();
    inTurn((t) => {
      t.reset();
      t.resize(cols, rows);
      written(t, data);
    });
  }

  /** The size the session runs at; ours when we own it, else shown as is. */
  export function applySize(cols: number, rows: number, isOwner: boolean): void {
    if (!isOwner) return inTurn((t) => t.resize(cols, rows));
    fit?.fit();
    // Ours, but the session runs at another size (reported while the
    // keyboard or the text box took room): tell it this one, or the program
    // draws for fewer rows than shown and leaves empty rows below it.
    if (term && (term.cols !== cols || term.rows !== rows)) onresize(term.cols, term.rows, false);
  }

  // ---- search in what the terminal shows (its scrollback)

  let searchAddon: SearchAddon | null = null;
  let searching = $state(false);
  let query = $state('');
  let matchCase = $state(false);
  let found = $state<{ at: number; of: number } | null>(null);
  let searchEl: HTMLInputElement | undefined = $state();
  const DECORATIONS = { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#888', matchBackground: '#d9a40066', activeMatchBackground: '#d9a400' };

  export function openSearch(): void {
    searching = true;
    queueMicrotask(() => searchEl?.focus());
  }
  function find(dir: 1 | -1) {
    if (!searchAddon || !query) return void (found = null);
    const opts = { caseSensitive: matchCase, decorations: DECORATIONS };
    if (dir === 1) searchAddon.findNext(query, opts);
    else searchAddon.findPrevious(query, opts);
  }
  function closeSearch() {
    searching = false;
    query = '';
    found = null;
    searchAddon?.clearDecorations();
    term?.focus();
  }

  export function focus(): void {
    term?.focus();
  }

  // The keyboard up on a phone: the terminal keeps the rows it had, and the
  // part around the cursor shows (the box scrolls). Fewer rows would make the
  // programs redraw for each keyboard, and some do that badly: an assistant
  // in a tmux attach lost its input line (report f18108; anthropics/claude-
  // code #52660, #74122). The height those rows take, while kept.
  let keptHeight = $state<number | null>(null);
  let rowsDown = 0;

  /** Our own fitted size; applied locally only while this device is the active one. */
  export function refit(active = false): void {
    if (!term || !fit) return;
    const keep = softKeyboard.open && keyBars.show;
    if (keep !== (keptHeight !== null)) {
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
      keptHeight = keep && rowsDown && screen ? (screen.offsetHeight / term.rows) * rowsDown + 8 : null;
      if (keptHeight === null && wrapEl) wrapEl.scrollTop = 0;
      // The kept height first on the page, then the fit measures it.
      if (keep === (keptHeight !== null)) return void requestAnimationFrame(() => (refit(active), followCursor()));
    }
    const dims = fit.proposeDimensions();
    if (!dims || !dims.cols || !dims.rows) return;
    if (owner || active) fit.fit();
    onresize(dims.cols, dims.rows, active);
    if (!softKeyboard.open) rowsDown = dims.rows;
    Object.assign(terminalState, { cols: dims.cols, rows: dims.rows });
  }

  // A phone's keyboard slides in and out in steps (Android animates it): fitted
  // once it has settled, not at every step. The steps before it counted as a
  // keyboard went out as fewer rows (the program in the terminal redrew for
  // each) and were taken for the rows without it (report b00aad).
  const SETTLE_MS = 200;
  let settling: ReturnType<typeof setTimeout> | undefined;
  function refitSettled(): void {
    clearTimeout(settling);
    if (!keyBars.show) return refit(false);
    settling = setTimeout(() => refit(false), SETTLE_MS);
  }
  $effect(() => () => clearTimeout(settling));

  // The keyboard's coming and going is measured on its own (keyboard.svelte.ts),
  // not always before the terminal's box resizes: fit again when it changes.
  $effect(() => {
    void softKeyboard.open;
    queueMicrotask(refitSettled);
  });

  /**
   * While the rows are kept: the bottom of the terminal in sight, where a
   * program keeps its input line and what goes under it (an assistant's box
   * edge and status lines fell off when the view followed the cursor,
   * report c7f699). Only a cursor above that part is followed, with a line
   * of room below it.
   */
  function followCursor(): void {
    if (keptHeight === null || !term || !wrapEl) return;
    const line = (keptHeight - 8) / term.rows;
    const y = 4 + term.buffer.active.cursorY * line;
    const view = wrapEl.clientHeight;
    // The terminal's own bottom edge (the box can hold more under it).
    const bottom = el ? Math.max(0, Math.ceil(el.getBoundingClientRect().bottom - wrapEl.getBoundingClientRect().top + wrapEl.scrollTop - view)) : 0;
    if (y >= bottom) wrapEl.scrollTop = bottom;
    else if (y + 2 * line > wrapEl.scrollTop + view) wrapEl.scrollTop = Math.ceil(y + 2 * line - view);
    else if (y < wrapEl.scrollTop) wrapEl.scrollTop = Math.max(0, Math.floor(y - line));
  }
  // For the input recording: how the terminal was set when a report is made.
  $effect(() => void (terminalState.compose = prefs.compose));

  export function zoom(step: number): void {
    if (!term) return;
    const size = Math.max(8, Math.min(32, (term.options.fontSize ?? 14) + step));
    term.options.fontSize = size;
    prefs.fontSize = size;
    savePrefs();
    refit(true);
  }

  /**
   * Put a command on the input line without running it (AI answer): into
   * the compose box, or typed after clearing the line (Ctrl-E, Ctrl-U).
   */
  export function insertCommand(command: string): void {
    // One line, nothing in it that acts as Enter (a CR in an AI answer ran it).
    const line = oneLine(command);
    if (prefs.compose) {
      composeText = line;
      composeEl?.focus();
      return;
    }
    oninput(`\x05\x15${line}`);
    term?.focus();
  }

  /** A snippet: typed, and run when asked. Pasted only: never run by a line break in it. */
  export function typeLine(command: string, runIt: boolean): void {
    if (runIt) {
      typed(`${command}\r`);
      term?.focus();
      return;
    }
    const how = pasteSafely(command);
    if ('send' in how) {
      oninput(how.send);
      term?.focus();
      return;
    }
    // Several lines: into the text box, to be looked at and sent by hand.
    if (!prefs.compose) toggleCompose();
    composeText = how.stage;
    queueMicrotask(() => composeEl?.focus());
  }

  // Text and its Enter go out as separate writes, a moment apart. Arriving
  // together ("ls\r" in one read), programs that watch for pastes (an
  // assistant in the person's own tmux) took the Enter for part of a paste
  // and did not run the line.
  const ENTER_PAUSE_MS = 100;
  function typed(data: string): void {
    data
      .split(/(\r)/)
      .filter(Boolean)
      .forEach((part, i) => (i === 0 ? out.now(part) : out.after(part, ENTER_PAUSE_MS)));
  }

  export function toggleCompose(): void {
    prefs.compose = !prefs.compose;
    savePrefs();
    suggestions = [];
    setTimeout(() => (prefs.compose ? composeEl?.focus() : term?.focus()), 50);
  }

  // ---- auto-complete

  const noRun = async () => '';
  let completeSeq = 0;
  let completeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleComplete() {
    if (completeTimer) clearTimeout(completeTimer);
    completeTimer = setTimeout(() => void runComplete(), 60);
  }
  // Again when the shell's state changes, and when the history arrives (it
  // comes a moment after a command ran: the list stayed without it until
  // the next key).
  $effect(() => {
    void shell;
    void history;
    scheduleComplete();
  });

  async function runComplete() {
    if (!term) return;
    const buf = term.buffer.active;
    // With the compose box, the input is exactly what is in the box.
    const line = cursorLine(buf as unknown as BufferView);
    // The text box when something is in it; else the terminal's own line
    // (typed straight in with the box open: that got no suggestions).
    const boxed = prefs.compose && !!composeText;
    const input = currentInput(boxed);
    const seq = ++completeSeq;
    // For a problem report: how this went, without the text (lib/termdebug.ts).
    Object.assign(termDebug, {
      compose: prefs.compose,
      buffer: buf.type,
      integration: !!shell?.integration,
      atPrompt: !!shell?.atPrompt,
      promptKnown: !!shell?.prompt,
      cursorLineLength: line.length,
      inputFound: input !== null,
      inputLength: input?.text.length ?? 0,
      completeRuns: termDebug.completeRuns + 1,
    });
    // Nothing typed yet, right after a command: what usually comes next here.
    // Not inside another program's screen (a tmux of your own): the last
    // command there is not this shell's.
    const emptyPrompt = input !== null && !input.text.trim();
    if (emptyPrompt && shell?.lastCommand && buf.type !== 'alternate' && (shell.atPrompt || !shell.integration)) {
      aiLine = null;
      const next = history.find((h) => h.command === shell!.lastCommand)?.next ?? [];
      suggestions = next.map((c) => ({ label: c, insert: c, kind: 'history' as const, description: t('term.nextHint') }));
      fromBox = boxed;
      suggestedFor = input.text;
      return;
    }
    if (!input || !input.text.trim()) {
      suggestions = [];
      aiLine = null;
      return;
    }
    limited = input.limited;
    if (onai && input.text.trimStart().startsWith('#')) {
      aiLine = input.text.trimStart().replace(/^#+\s*/, '');
      suggestions = [];
      return;
    }
    aiLine = null;
    // The session's own run function, the same each time: the generator
    // answers are kept per run function (complete/engine.ts).
    const result = await suggest({
      line: input.text,
      history,
      snippets,
      cwd: shell?.cwd ?? null,
      run: run ?? noRun,
      ls: (path) => (ls ? ls(path) : Promise.resolve({ dir: path, entries: [] })),
    }).catch(() => []);
    // A slower, older request must not overwrite a newer answer.
    if (seq === completeSeq) {
      suggestions = result;
      fromBox = boxed;
      suggestedFor = input.text;
    }
  }

  /** What is typed now: the text box's text, or the terminal's own line. */
  function currentInput(boxed: boolean): { text: string; limited: boolean } | null {
    if (boxed) return { text: composeText, limited: false };
    if (!term) return null;
    const buf = term.buffer.active;
    return inputAtCursor(buf as unknown as BufferView, term.cols, shell, buf.type === 'alternate');
  }

  // Held down (a phone) or right-clicked: a history chip asks to be forgotten.
  let chipTimer: ReturnType<typeof setTimeout> | null = null;
  let chipHeld = false;
  async function forget(s: Suggestion) {
    if (!onforget || s.kind !== 'history') return;
    if (!(await ask({ text: t('term.forgetConfirm', { command: s.label }), confirm: t('term.forget'), danger: true }))) return;
    onforget(s.label);
    suggestions = suggestions.filter((x) => !(x.kind === 'history' && x.label === s.label));
  }
  function chipDown(s: Suggestion) {
    chipHeld = false;
    if (!onforget || s.kind !== 'history') return;
    chipTimer = setTimeout(() => {
      chipHeld = true;
      forget(s);
    }, 600);
  }
  function chipUp() {
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = null;
  }

  function pick(s: Suggestion) {
    // The click that ends a hold picks nothing.
    if (chipHeld) return void (chipHeld = false);
    suggestions = [];
    // Typed on after the list was made: only the rest (typed past it: nothing).
    const now = currentInput(prefs.compose && fromBox)?.text ?? suggestedFor;
    const ahead = now.startsWith(suggestedFor) ? now.slice(suggestedFor.length) : null;
    if (ahead === null || !s.insert.startsWith(ahead)) return;
    const insert = oneLine(s.insert.slice(ahead.length));
    if (prefs.compose && fromBox) {
      composeText += insert;
      composeEl?.focus();
      scheduleComplete();
      return;
    }
    oninput(insert);
    term?.focus();
  }

  // ---- compose box: a plain text field, sent as a whole

  let composeText = $state(untrack(() => (draftKey ? (drafts.get(draftKey) ?? '') : '')));
  $effect(() => {
    if (!draftKey) return;
    if (composeText) drafts.set(draftKey, composeText);
    else drafts.delete(draftKey);
  });
  let composeEl: HTMLTextAreaElement | undefined = $state();
  // Typing straight into the terminal with the keyboard up: the box folds
  // to a key in the bar, so the terminal gets its rows (on a foldable's
  // inner screen an assistant's input line fell off: report e03c6e). A tap
  // on that key, or the keyboard going down, brings it back.
  let termFocused = $state(false);
  let unfolded = $state(false);
  const composeFolded = $derived(prefs.compose && softKeyboard.open && termFocused && !unfolded && !composeText);
  function unfoldCompose() {
    unfolded = true;
    setTimeout(() => composeEl?.focus(), 0);
  }

  function sendCompose(enter = true) {
    // Not connected: the text stays, it would be dropped on the way and
    // the box emptied as if sent (AUDIT2 TERM-06).
    if (!canSend) {
      toast(t('term.notSent'));
      composeEl?.focus();
      return;
    }
    const plan = composePlan(composeText, enter, !!term?.modes.bracketedPasteMode);
    if ('keep' in plan) {
      // Held with several lines: nothing goes out (a line break could run a
      // line); they stay here to be sent with Send.
      toast(t('term.keepLines'));
      composeEl?.focus();
      return;
    }
    if ('paste' in plan) {
      // A program that asks for pastes to be marked (tmux, an assistant, a
      // shell's line editor): the lines as one paste, then Enter apart.
      // One by one they were a message each (reported with a log pasted).
      term?.paste(plan.paste);
      out.after('\r', ENTER_PAUSE_MS);
    } else typed(plan.type);
    composeText = '';
    suggestions = [];
    aiLine = null;
    composeEl?.focus();
  }

  // The text box in the terminal's own font size, one line of it high (and
  // never below 28 px, the key bar's height): at 36 px at least, a small font sat in a
  // box that looked empty (reports efc5af, 03f3f5).
  const composeLine = $derived(Math.round(prefs.fontSize * 1.4));
  const composeOne = $derived(Math.max(28, composeLine + 10));
  function autoGrow() {
    const box = composeEl;
    if (!box) return;
    box.style.height = `${composeOne}px`;
    // Empty: one line, whatever the placeholder (which can wrap) measures.
    if (!box.value) return;
    if (box.scrollHeight > box.clientHeight) {
      box.style.height = `${Math.min(box.scrollHeight + 2, window.innerHeight * 0.3)}px`;
      box.style.overflowY = box.scrollHeight + 2 > window.innerHeight * 0.3 ? 'auto' : 'hidden';
    }
  }
  // Also after sending (the box empties) or a suggestion is added.
  $effect(() => {
    void composeText;
    queueMicrotask(autoGrow);
  });

  let shiftHeld = false;
  function composeKey(e: KeyboardEvent) {
    shiftHeld = e.shiftKey;
    // Enter sends; Shift+Enter makes a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      enterPressed();
    }
  }
  function enterPressed() {
    if (composeText.trim()) sendCompose(true);
    else oninput('\r');
  }
  // A phone's keyboard often sends its Enter as "a new line" (no Enter
  // key event, or one marked as composing): that sends too.
  function composeBeforeInput(e: InputEvent) {
    if (e.inputType !== 'insertLineBreak' || shiftHeld) return;
    e.preventDefault();
    enterPressed();
  }

  // The send button sends and runs. Held down: onto the line without Enter, to edit there.
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  function sendDown() {
    held = false;
    holdTimer = setTimeout(() => {
      held = true;
      if (composeText) sendCompose(false);
    }, 500);
  }
  function sendUp() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  }

  // The text size is set on the terminal there is (below), not by making a new
  // one: a zoom or a pinch built it afresh, and the screen and its history were
  // gone while the session went on (AUDIT2 TERM-04).
  $effect(() => {
    const size = prefs.fontSize;
    if (term && term.options.fontSize !== size) {
      term.options.fontSize = size;
      refit(true);
    }
  });

  $effect(() => {
    if (!el) return;
    const xterm = new XTerm({
      fontFamily: cssVar('--mono'),
      fontSize: untrack(() => prefs.fontSize),
      scrollback: 5000,
      cursorBlink: true,
      allowProposedApi: true,
      // A program's own colours can be unreadable on ours (tmux's black on
      // green bar was 2:1): xterm lightens or darkens the text to 4.5:1.
      minimumContrastRatio: 4.5,
      theme: termTheme(),
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());
    searchAddon = new SearchAddon();
    xterm.loadAddon(searchAddon);
    searchAddon.onDidChangeResults((r) => (found = r.resultCount > 0 ? { at: r.resultIndex + 1, of: r.resultCount } : { at: 0, of: 0 }));
    // Ctrl+Shift+F searches what the terminal shows (Ctrl+F stays the
    // shell's: one character forward).
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        // The terminal's own: not also the workspace's search around it.
        e.preventDefault();
        openSearch();
        return false;
      }
      return true;
    });
    xterm.loadAddon(new Unicode11Addon());
    xterm.unicode.activeVersion = '11';
    xterm.open(el);
    term = xterm;
    inflight = 0;
    waiting = [];
    fit = fitAddon;
    untrack(() => onready?.(xterm));

    // Light/dark or the accent changed (Settings, or the system): new colours.
    const retheme = () => (xterm.options.theme = termTheme());
    const themeWatch = new MutationObserver(retheme);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', retheme);

    const onParsed = xterm.onWriteParsed(() => (scheduleComplete(), followCursor()));
    // The grips go along when the lines scroll.
    const onScrolled = xterm.onScroll(() => picked && placeHandles());
    const onData = xterm.onData((d) => {
      // Its answers to the questions in output played again went out the first time; keys typed meanwhile go (review 2026-10-24: every Esc-led key was dropped).
      if (replaying && isTermReply(d)) return;
      // Mouse reports (a finger's scroll as the wheel) of one moment go out
      // as one message: a flick made dozens, each its own round trip.
      if (d.startsWith('\x1b[<') || d.startsWith('\x1b[M')) {
        mouseBuf += d;
        if (mouseBuf === d) queueMicrotask(oninputMouse);
        return;
      }
      oninput(typedKey(d));
    });
    // Focusing the terminal on this device takes over the size, like tmux's
    // window-size "latest".
    const ta = xterm.textarea;
    const onFocus = () => ((termFocused = true), (unfolded = false), refit(true));
    // Not in the blur itself: leaving the page takes the field away mid-teardown.
    const onBlur = () => queueMicrotask(() => (termFocused = false));
    ta?.addEventListener('focus', onFocus);
    ta?.addEventListener('blur', onBlur);
    // Soft keyboards: no autocorrect, capitals or suggestions in a shell.
    for (const [k, v] of Object.entries({ autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' })) {
      ta?.setAttribute(k, v);
    }
    // The keyboard's events, by kind, for a problem report. On the
    // terminal's element and before the soft keyboard's handling below: that
    // stops the keyboard's own events (229, input, composition) before they
    // reach the field, and a report then held only the real keys (report
    // 117251: its replay typed "00" and two backspaces, not "/logout").
    const keyKinds = ['keydown', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend'];
    const recordKinds = [...keyKinds, 'compositionupdate'];
    const fromField = (e: Event) => !!ta && e.target === ta;
    const keyNoted = (e: Event) => fromField(e) && noteKey(e);
    const record = (e: Event) => fromField(e) && noteEvent(e, ta ?? null);
    for (const k of keyKinds) xterm.element?.addEventListener(k, keyNoted, { capture: true });
    for (const k of recordKinds) xterm.element?.addEventListener(k, record, { capture: true });
    // A soft keyboard's typing: sent once and exactly (lib/textinput.ts),
    // not through xterm's guesses, which sent corrected text twice. Only on
    // a touch screen; a computer's keyboard stays xterm's.
    const stopText =
      ta && xterm.element && navigator.maxTouchPoints > 0
        ? attachTextInput(
            xterm.element,
            ta,
            (d) => {
              // Ctrl, Alt or Vol+ held from the bar: a control key went, not the letter (lib/textinput.ts starts over).
              const held = ctrl || alt || fn;
              oninput(typedKey(d));
              return held;
            },
            (text) => xterm.paste(text),
          )
        : () => {};
    // In the app: while the terminal has the keyboard, plain characters (no
    // suggestions or corrections, as Termux and Termius type).
    // After the event, not in it: leaving the page takes the field away while
    // it has the focus, and its blur comes while Svelte tears the page down
    // (where changing state is refused: state_unsafe_mutation).
    const onTextFocus = () => queueMicrotask(() => (typing = true));
    const onTextBlur = () => queueMicrotask(() => (typing = false));
    ta?.addEventListener('focus', onTextFocus);
    ta?.addEventListener('blur', onTextBlur);
    // A terminal bell: a short buzz, as a phone does for a message.
    const onBell = xterm.onBell(() => navigator.vibrate?.(60));
    // Shift + the wheel scrolls Burrow's own history, also under a program
    // that takes the mouse (the wheel alone scrolls that program's).
    // In Burrow's tmux the wheel goes back through tmux's history, as a finger
    // does: output that came too fast was redrawn by tmux, not scrolled, and is
    // only there (review 2026-10-24: the wheel found nothing above the screen).
    let wheelPx = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey && xterm.modes.mouseTrackingMode !== 'none') {
        e.preventDefault();
        e.stopPropagation();
        // Shift turns the wheel sideways in some browsers.
        xterm.scrollLines(Math.sign(e.deltaY || e.deltaX) * 3);
      } else if (!e.shiftKey && (onscrollback || arrowScroll) && xterm.modes.mouseTrackingMode === 'none') {
        e.preventDefault();
        e.stopPropagation();
        const cell = (xterm.element?.clientHeight ?? 0) / xterm.rows || 16;
        wheelPx += e.deltaMode === 1 ? e.deltaY * cell : e.deltaMode === 2 ? e.deltaY * cell * xterm.rows : e.deltaY;
        const lines = Math.trunc(wheelPx / cell);
        if (!lines) return;
        wheelPx -= lines * cell;
        if (arrowScroll) arrows(-lines);
        else scrollBack(-lines);
      }
    };
    xterm.element?.addEventListener('wheel', onWheel, { capture: true, passive: false });

    const ro = new ResizeObserver(refitSettled);
    ro.observe(el);

    return () => {
      ro.disconnect();
      ta?.removeEventListener('focus', onFocus);
      ta?.removeEventListener('blur', onBlur);
      ta?.removeEventListener('focus', onTextFocus);
      ta?.removeEventListener('blur', onTextBlur);
      onBell.dispose();
      for (const k of keyKinds) xterm.element?.removeEventListener(k, keyNoted, { capture: true });
      for (const k of recordKinds) xterm.element?.removeEventListener(k, record, { capture: true });
      xterm.element?.removeEventListener('wheel', onWheel, { capture: true });
      stopText();
      onData.dispose();
      onParsed.dispose();
      onScrolled.dispose();
      themeWatch.disconnect();
      scheme.removeEventListener('change', retheme);
      if (completeTimer) clearTimeout(completeTimer);
      xterm.dispose();
      term = null;
      fit = null;
    };
  });

  // ---- the Android app: keyboard, volume keys, screen

  let typing = $state(false);
  $effect(() => {
    if (!device) return;
    void device.terminal({ input: typing, keys: true, screen: true }).catch(() => {});
  });
  $effect(() => {
    const d = device;
    if (!d) return;
    // Volume down is Ctrl, volume up the next key's special meaning; each for one key.
    const off = d.on('volumeKey', (k) => {
      if (k === 'down') ctrl = !ctrl;
      else if (k === 'up') fn = !fn;
    });
    devicePanes++;
    return () => {
      off();
      if (--devicePanes === 0) void d.terminal({ input: false, keys: false, screen: false }).catch(() => {});
    };
  });

  // Not in the app: a phone's own browser keeps the screen on while here.
  $effect(() => {
    if (device || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let done = false;
    const take = () => {
      if (document.visibilityState !== 'visible' || done) return;
      navigator.wakeLock.request('screen').then(
        (l) => (done ? void l.release() : (lock = l)),
        () => {},
      );
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', take);
      void lock?.release();
    };
  });

  // A cursor or delete key of the bar held down goes again and again, as a keyboard's own does:
  // a whole line took a tap per letter (report 0bc1fe; Termux's extra keys repeat the arrows too).
  // The key then went while held: the click of letting go sends nothing more.
  const REPEAT_AFTER_MS = 400;
  const REPEAT_EVERY_MS = 60;
  type Hold = { wait: ReturnType<typeof setTimeout> | null; every: ReturnType<typeof setInterval> | null; went: boolean };
  let hold: Hold | null = null;
  function holdKey(k: BarKey) {
    letGo();
    hold = null;
    if (!k.repeat || k.send === undefined) return;
    const send = k.send;
    const h: Hold = { wait: null, every: null, went: false };
    h.wait = setTimeout(() => {
      h.wait = null;
      // With a sticky Ctrl or Alt: each repeat the same key (Ctrl+Left word after word).
      const d = typedKey(send);
      h.went = true;
      oninput(d);
      h.every = setInterval(() => oninput(d), REPEAT_EVERY_MS);
    }, REPEAT_AFTER_MS);
    hold = h;
  }
  function letGo() {
    if (hold?.wait) clearTimeout(hold.wait);
    if (hold?.every) clearInterval(hold.every);
    if (hold) hold.wait = hold.every = null;
  }
  onDestroy(letGo);
  function pressBar(k: BarKey) {
    const went = hold?.went;
    hold = null;
    if (went) return;
    press(k);
  }
  function press(k: BarKey) {
    if (k.mod === 'ctrl') ctrl = !ctrl;
    else if (k.mod === 'alt') alt = !alt;
    else if (k.send !== undefined) oninput(typedKey(k.send));
    // Typing in the text box: it keeps the focus (and its keyboard); the key went to the shell all the same.
    if (!composeEl || document.activeElement !== composeEl) term?.focus();
  }

  // ---- gestures: pinch to zoom, horizontal swipe to switch session

  // Two fingers: apart or together is zoom, side by side up or down scrolls
  // Burrow's own history (also under a program that takes the mouse, where
  // one finger scrolls that program's history: a tmux of your own).
  let pinch: { dist: number; size: number; y: number; mode: 'zoom' | 'scroll' | null; lines: number } | null = null;
  const midY = (e: TouchEvent) => (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
  let swipe: { x: number; y: number; at: number } | null = null;
  const dist = (e: TouchEvent) => Math.hypot(e.touches[0]!.clientX - e.touches[1]!.clientX, e.touches[0]!.clientY - e.touches[1]!.clientY);

  // ---- select and copy with a finger: hold on a word, drag to take more

  const LONG_PRESS_MS = 450;
  let pickTimer: ReturnType<typeof setTimeout> | null = null;
  let anchor: Cell | null = null;
  let selecting = $state(false);
  let picked = $state(false);
  function cellAt(x: number, y: number): Cell | null {
    // The drawn line under the finger, asked of the page itself: working it
    // out from heights put the finger on the line below now and then.
    const lines = term?.element?.querySelector('.xterm-rows');
    if (!term || !lines) return null;
    const hit = document.elementsFromPoint(x, y).find((e) => e.parentElement === lines) ?? document.elementsFromPoint(x, y).map((e) => e.closest('.xterm-rows > div')).find(Boolean);
    const rowEls = [...lines.children];
    let row = hit ? rowEls.indexOf(hit) : -1;
    if (row < 0) {
      const r = lines.getBoundingClientRect();
      row = Math.floor(((y - r.top) / r.height) * term.rows);
    }
    const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect() ?? lines.getBoundingClientRect();
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor(((x - screen.left) / screen.width) * term.cols)));
    return { col, row: Math.max(0, Math.min(term.rows - 1, row)) + term.buffer.active.viewportY };
  }
  // What Burrow selected, kept: xterm's own touch handling can move its
  // selection after the finger lets go, so the copy is made from this.
  let pickRange: CellRange | null = null;
  function selectRange(a: Cell, b: Cell) {
    if (!term) return;
    pickRange = ordered(a, b);
    showPick();
  }
  function showPick() {
    if (!term || !pickRange) return;
    term.select(pickRange.from.col, pickRange.from.row, cellCount(pickRange, term.cols));
    picked = true;
    placeHandles();
  }
  // Two grips under the selection's ends, as on any phone: dragged, that end
  // moves and the other stays. Where they sit, in the terminal's box.
  let wrapEl: HTMLDivElement | undefined = $state();
  let handles = $state<{ from: { x: number; y: number } | null; to: { x: number; y: number } | null } | null>(null);
  let dragEnd: 'from' | 'to' | null = null;
  function placeHandles() {
    const screen = term?.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!term || !pickRange || !wrapEl || !screen) return void (handles = null);
    const box = wrapEl.getBoundingClientRect();
    const cw = screen.width / term.cols;
    const ch = screen.height / term.rows;
    const top = term.buffer.active.viewportY;
    // Under the row: the start's grip at its left edge, the end's at its right.
    const at = (c: Cell, end: boolean) =>
      c.row < top || c.row >= top + term!.rows ? null : { x: screen.left - box.left + (c.col + (end ? 1 : 0)) * cw, y: screen.top - box.top + (c.row - top + 1) * ch };
    handles = { from: at(pickRange.from, false), to: at(pickRange.to, true) };
  }
  // How far the finger is from the character it moves: kept while dragging,
  // so the end goes where the finger goes, not where it covers the grip.
  let aim = { x: 0, y: 0 };
  function grab(e: TouchEvent, end: 'from' | 'to') {
    e.stopPropagation();
    e.preventDefault();
    const p = handles?.[end];
    const screen = term?.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!pickRange || !p || !wrapEl || !term || !screen) return;
    dragEnd = end;
    // The end that stays.
    anchor = end === 'from' ? pickRange.to : pickRange.from;
    const box = wrapEl.getBoundingClientRect();
    const cw = screen.width / term.cols;
    const ch = screen.height / term.rows;
    // The middle of the end's character: right of the start's edge, left of the end's.
    aim = { x: e.touches[0]!.clientX - (box.left + p.x + (end === 'from' ? cw / 2 : -cw / 2)), y: e.touches[0]!.clientY - (box.top + p.y - ch / 2) };
  }
  function dragGrip(e: TouchEvent) {
    if (!dragEnd || !anchor || !term?.element || e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const at = cellAt(e.touches[0]!.clientX - aim.x, e.touches[0]!.clientY - aim.y);
    if (at) selectRange(anchor, at);
  }
  function dropGrip(e: TouchEvent) {
    if (!dragEnd) return;
    e.stopPropagation();
    dragEnd = null;
    // Shown again once the touch is over, whatever xterm did with it.
    setTimeout(showPick, 60);
  }
  /** The selected text, from the terminal's own lines (wrapped lines joined). */
  function pickText(): string {
    return term && pickRange ? rangeText(term.buffer.active, pickRange, term.cols) : '';
  }
  function selectWord(at: Cell) {
    const line = term?.buffer.active.getLine(at.row);
    const w = line ? wordAt(line, at.col) : { from: at.col, to: at.col };
    selectRange({ col: w.from, row: at.row }, { col: w.to, row: at.row });
  }
  // A finger held on the text: Burrow's selection, not the phone's menu nor
  // xterm's own word pick (which took the line below). A mouse's right
  // click keeps the browser's menu (copy, paste).
  function holdMenu(e: MouseEvent) {
    if ((e as PointerEvent).pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
  }
  function cancelHold() {
    if (pickTimer) clearTimeout(pickTimer);
    pickTimer = null;
  }
  function clearPick() {
    pickRange = null;
    handles = null;
    dragEnd = null;
    term?.clearSelection();
    picked = false;
    selecting = false;
  }
  async function copyPick() {
    const text = pickText();
    if (text && (await copyText(text))) toast(t('common.copied'));
    clearPick();
  }
  // In the app: Android's own floating menu over the selection (Copy,
  // Paste, Select all), as anywhere else on the phone, in place of the
  // page's bar. An older app has no such menu: the bar stays.
  let nativeMenu = $state(false);
  $effect(() => {
    const d = device;
    nativeMenu = false;
    void d?.info().then((i) => (nativeMenu = !!i?.selectionMenu && !!d.selectionMenu), () => {});
  });
  /** The selection's box on the page: its rows, from the start's edge to the end's on one row. */
  function pickBox(): { x: number; y: number; w: number; h: number } | null {
    const screen = term?.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!term || !wrapEl || !screen || !handles || (!handles.from && !handles.to)) return null;
    const box = wrapEl.getBoundingClientRect();
    const ch = screen.height / term.rows;
    const top = handles.from ? box.top + handles.from.y - ch : screen.top;
    const bottom = handles.to ? box.top + handles.to.y : screen.bottom;
    const oneRow = handles.from && handles.to && Math.abs(handles.from.y - handles.to.y) < 1;
    const left = oneRow ? box.left + handles.from!.x : screen.left;
    const right = oneRow ? box.left + handles.to!.x : screen.right;
    return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
  }
  $effect(() => {
    if (!nativeMenu || !device?.selectionMenu) return;
    const at = picked && !selecting ? pickBox() : null;
    void device.selectionMenu(at).catch(() => {});
  });
  $effect(() => {
    const d = device;
    if (!nativeMenu || !d?.selectionMenu) return;
    const off = d.on('selectionAction', (a) => {
      if (a === 'copy') void copyPick();
      else if (a === 'paste') void pasteHere();
      else if (a === 'all' && term) selectRange({ col: 0, row: 0 }, { col: term.cols - 1, row: term.buffer.active.length - 1 });
      else clearPick();
    });
    return () => {
      off();
      void d.selectionMenu?.(null).catch(() => {});
    };
  });
  async function pasteHere() {
    clearPick();
    try {
      const text = await navigator.clipboard.readText();
      if (text) term?.paste(text);
    } catch {
      toast(t('term.pasteDenied'), 'error');
    }
    term?.focus();
  }

  function touchStart(e: TouchEvent) {
    noteTouch(e, el ?? null);
    // The history layer scrolls itself (the device's own scrolling and selection).
    if (inLayer(e)) return;
    // The selection's own buttons: theirs, not a tap on the terminal (which clears it).
    if ((e.target as Element | null)?.closest?.('.pickbar, .grip')) return;
    cancelHold();
    if (e.touches.length === 1 && picked) clearPick();
    if (e.touches.length === 1) {
      const x = e.touches[0]!.clientX;
      const y = e.touches[0]!.clientY;
      // Where the finger went down: the screen can shift under it while it
      // is held (the suggestions come and go), which took the line below.
      const at = cellAt(x, y);
      pickTimer = setTimeout(() => {
        pickTimer = null;
        if (!at) return;
        anchor = at;
        selecting = true;
        glide++;
        selectWord(at);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    }
    if (e.touches.length === 2) {
      pinch = { dist: dist(e), size: prefs.fontSize, y: midY(e), mode: null, lines: 0 };
      swipe = null;
    } else if (e.touches.length === 1) {
      swipe = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, at: performance.now() };
      wheelY = e.touches[0]!.clientY;
      wheelAt = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
      // A new touch stops a glide.
      glide++;
      track = [];
      wheelCarry = 0;
    }
  }
  // A program that takes the mouse (tmux with "mouse on", vim, htop) has
  // no scrollback here: a finger's scroll becomes its mouse wheel, so tmux
  // scrolls its own history. xterm turns the wheel into the program's codes.
  // Like a phone's own scrolling (and Termius): the wheel turns once a frame
  // with what the finger moved, and after a flick it glides on and slows.
  let wheelY = 0;
  // Where the swipe began: the wheel turns there. Where the finger is now
  // could be over tmux's status line, where the wheel scrolls nothing.
  let wheelAt = { x: 0, y: 0 };
  let mouseBuf = '';
  let track: { y: number; t: number }[] = [];
  let glide = 0;
  function oninputMouse() {
    const d = mouseBuf;
    mouseBuf = '';
    if (d) oninput(d);
  }
  let wheelCarry = 0;
  function turnWheel(y: number, speed: number) {
    if (!term?.element) return;
    // The history layer open: moved by the pixel, as the finger went (lines are for the session).
    if (layer?.lines) {
      moveLayer(y - wheelY);
      wheelY = y;
      return;
    }
    const cell = term.element.clientHeight / term.rows;
    const moved = Math.trunc((y - wheelY) / cell);
    if (!moved) return;
    wheelY += moved * cell;
    let steps = moved;
    // Scrolled on the host (a tmux, a program with the mouse): faster with
    // a faster finger (lib/wheel.ts). Burrow's own history stays one to one.
    if (term.modes.mouseTrackingMode !== 'none' || onscrollback) {
      wheelCarry += moved * speedUp(speed);
      steps = Math.trunc(wheelCarry);
      wheelCarry -= steps;
      if (!steps) return;
    }
    // A full-screen program without the mouse: arrow keys (review 2026-10-24: its screen was not scrolled at all).
    // Unless it is a tmux of the person's own (a `tmux attach` without Burrow's tmux, its mouse off): that
    // tmux's history in the layer. The session says which (alt: the keys, for a while after).
    if (term.modes.mouseTrackingMode === 'none' && arrowScroll) {
      if (onhistory && performance.now() >= altUntil && (layer || steps > 0)) return scrollBack(steps, 'keys');
      if (performance.now() < altUntil) altUntil = performance.now() + ALT_KEEP_MS;
      return arrows(steps);
    }
    // A plain shell: Burrow's own history, line by line (xterm reads a wheel
    // there only on an inner element, which an event sent here never reaches).
    if (term.modes.mouseTrackingMode === 'none') return scrollBack(steps);
    // A program that took the mouse: its wheel, unless it is a tmux of the person's own (Claude
    // Code in it): that tmux's history in the layer. The session says which (alt: the wheel, for
    // a while after; asked again on the next swipe).
    if (onhistory) {
      if (performance.now() < altUntil) altUntil = performance.now() + ALT_KEEP_MS;
      else if (layer || steps > 0) return scrollBack(steps, 'mouse');
    }
    turnProgramWheel(steps);
  }
  // A notch for every this many lines the finger moved: a notch a line ran Claude Code's view (and a
  // tmux's copy mode, five lines a notch) far ahead of the finger (the user, 2026-11-07).
  const LINES_PER_NOTCH = 2;
  let notchCarry = 0;
  /** The wheel of a program that took the mouse, for `steps` lines the finger moved (finger down, positive: back). */
  function turnProgramWheel(steps: number) {
    if (!term?.element) return;
    notchCarry += steps / LINES_PER_NOTCH;
    let notches = Math.trunc(notchCarry);
    notchCarry -= notches;
    // In lines, one notch each: in pixels xterm took a row's height for a trackpad's small step and
    // sent a notch for every third, Claude Code's own scroll slow and jerky (2026-11-06).
    const at = { clientX: wheelAt.x, clientY: wheelAt.y, bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE };
    // Finger down: back in history (the wheel turned up).
    for (; notches !== 0; notches -= Math.sign(notches)) term.element.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: -Math.sign(notches) }));
  }
  /** Up (back) or down by arrow keys, in the cursor mode the program asked for. */
  function arrows(lines: number) {
    if (!term || !lines) return;
    const app = term.modes.applicationCursorKeysMode;
    oninput((lines > 0 ? (app ? '\x1bOA' : '\x1b[A') : app ? '\x1bOB' : '\x1b[B').repeat(Math.min(Math.abs(lines), 50)));
  }
  // Back through the history: Burrow's own, or (a session in Burrow's tmux)
  // tmux's, gathered for a moment so a flick is one message, not dozens.
  let scrollPending = 0;
  /** `over`: what the finger is over when it is not the session's own history: a program with the mouse, or one taking keys. */
  function scrollBack(lines: number, over: Over = null) {
    // The history layer: asked for, or open (moved by the finger itself, in turnWheel).
    if (layer) {
      if (!layer.lines) layerPx += lines * cellPx();
      else moveLayer(lines * cellPx());
      return;
    }
    // A program on tmux's alternate screen (less, man): as before, a while after the server said so.
    const legacy = performance.now() < altUntil;
    if (legacy) altUntil = performance.now() + ALT_KEEP_MS;
    if (onhistory && !legacy) {
      if (lines > 0) openLayer(lines, over);
      // Forward from the live screen: nothing is below it.
      return;
    }
    if (!onscrollback) return void term?.scrollLines(-lines);
    if (!scrollPending)
      setTimeout(() => {
        const n = scrollPending;
        scrollPending = 0;
        if (n) onscrollback?.(n);
      }, 40);
    scrollPending += lines;
  }
  // ---- the history layer (2.19.0): scrolled back, the session's whole
  // history is fetched once and shown over the terminal in a box the device
  // scrolls itself, at the screen's rate, with its own fling and selection.
  // Before, each step of a finger was a tmux command over SSH and a redraw
  // back (Burrow's tmux): a few frames a second. Typing, scrolling to the
  // bottom, Escape or "Back to live" closes it; the session never noticed.
  // Prior art: iTerm2's tmux integration keeps the history in the app.
  // `over`: asked over a program that took the mouse, or one on a full screen without it (a tmux of the
  // person's own, either way); not there, its wheel turns or it gets arrow keys.
  type Over = 'mouse' | 'keys' | null;
  let layer = $state<{ lines: string[] | null; newer: boolean; size: number; cell: number; over: Over } | null>(null);
  let layerEl: HTMLDivElement | undefined = $state();
  // Scrolled while the history was on its way: where to open it.
  let layerPx = 0;
  // Positioned and shown: from then on the bottom closes it.
  let layerSettled = false;
  let layerTimer: ReturnType<typeof setTimeout> | null = null;
  // The server said a program is on tmux's alternate screen (less, man): scrolled as before until the scrolling stops.
  let altUntil = 0;
  const ALT_KEEP_MS = 1000;
  const HISTORY_WAIT_MS = 8000;
  const CHUNK = 200;
  const cellPx = () => (term?.element ? term.element.clientHeight / term.rows : 16);
  const layerChunks = $derived(layer?.lines ? Array.from({ length: Math.ceil(layer.lines.length / CHUNK) }, (_, i) => layer!.lines!.slice(i * CHUNK, (i + 1) * CHUNK)) : []);

  function openLayer(lines: number, over: Over = null) {
    if (!onhistory) return;
    layer = { lines: null, newer: false, size: term?.options.fontSize ?? prefs.fontSize, cell: cellPx(), over };
    layerPx = lines * cellPx();
    layerSettled = false;
    onhistory(over === 'mouse');
    layerTimer = setTimeout(() => {
      if (layer && !layer.lines) {
        closeLayer();
        toast(t('term.historyFailed'), 'error');
      }
    }, HISTORY_WAIT_MS);
  }

  export function closeLayer() {
    if (layerTimer) clearTimeout(layerTimer);
    layerTimer = null;
    if (!layer) return;
    layer = null;
    layerPx = 0;
    layerSettled = false;
    glide++;
  }

  /** The session's answer to onhistory(). */
  export function showHistory(answer: { data: string; alt?: boolean; failed?: boolean }) {
    // Asked for no longer (typed meanwhile, or closed).
    if (!layer || layer.lines) return;
    const px = layerPx;
    const over = layer.over;
    if (answer.alt) {
      closeLayer();
      altUntil = performance.now() + ALT_KEEP_MS;
      const n = Math.round(px / cellPx());
      // What the finger moved meanwhile: the program's wheel or keys, or tmux's history as before.
      if (n) void (over === 'mouse' ? turnProgramWheel(n) : over === 'keys' ? arrows(n) : onscrollback?.(n));
      return;
    }
    if (answer.failed) {
      closeLayer();
      return void toast(t('term.historyFailed'), 'error');
    }
    if (layerTimer) clearTimeout(layerTimer);
    layerTimer = null;
    const lines = ansiLines(answer.data.replace(/\r/g, ''));
    // The empty rows under the last line (a screen not yet full) are not history.
    while (lines.length && !lines.at(-1)) lines.pop();
    layer = { ...layer, lines, newer: false };
    requestAnimationFrame(() => {
      const box = layerEl;
      if (!box || !layer) return;
      const max = box.scrollHeight - box.clientHeight;
      // Nothing above the screen: nothing to scroll.
      if (max <= 1) return closeLayer();
      box.scrollTop = Math.max(0, max - px);
      requestAnimationFrame(() => (layerSettled = true));
    });
  }

  // The part of the box in sight while the rows are kept (the keyboard up): the
  // box scrolls, and a layer at its top lay above the screen with the live
  // terminal in sight under it (seen on the Android emulator, 2.19.0).
  let layerView = $state<{ top: number; height: number } | null>(null);
  $effect(() => {
    const w = wrapEl;
    if (!layer || !w) return void (layerView = null);
    const kept = keptHeight !== null;
    const place = () => (layerView = kept ? { top: w.scrollTop, height: w.clientHeight } : null);
    place();
    if (!kept) return;
    const ro = new ResizeObserver(place);
    ro.observe(w);
    w.addEventListener('scroll', place, { passive: true });
    return () => {
      ro.disconnect();
      w.removeEventListener('scroll', place);
    };
  });

  /** Back `px` pixels in the history (forward when negative). */
  function moveLayer(px: number) {
    if (!layerEl) return;
    layerEl.scrollTop -= px;
    atBottom();
  }

  // A key while the history is open (on a computer, after selecting in it): back to the live screen, where typing goes.
  $effect(() => {
    if (!layer?.lines) return;
    const key = (e: KeyboardEvent) => {
      if (term?.element?.contains(document.activeElement) || e.ctrlKey || e.metaKey || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      closeLayer();
      term?.focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const inLayer = (e: Event) => !!(e.target as Element | null)?.closest?.('.backlog');

  function atBottom() {
    const box = layerEl;
    if (layerSettled && box && box.scrollTop + box.clientHeight >= box.scrollHeight - 1) closeLayer();
  }

  let frameY: number | null = null;
  // Also in a plain shell: xterm scrolls its own history on a wheel, but not
  // on a finger (one finger did nothing there; only two did, since 1.5.1).
  function wheelFromTouch(e: TouchEvent): boolean {
    if (!term?.element || e.touches.length !== 1) return false;
    const y = e.touches[0]!.clientY;
    const now = performance.now();
    track = [...track.filter((p) => now - p.t < 100), { y, t: now }];
    // Once a frame, with where the finger is by then; not after a key typed meanwhile (glide counts
    // those): a frame still to come scrolled after the text, back into tmux's copy mode (AUDIT2 TERM-15).
    if (frameY === null) {
      const id = glide;
      requestAnimationFrame(() => {
        if (id === glide) turnWheel(frameY!, fingerSpeed(track));
        frameY = null;
      });
    }
    frameY = y;
    return true;
  }
  /** After a flick: on at the finger's speed, slowing down, until it stops. */
  function startGlide() {
    const first = track[0];
    const last = track[track.length - 1];
    track = [];
    if (!first || !last || last.t - first.t < 10) return;
    let v = (last.y - first.y) / (last.t - first.t);
    if (Math.abs(v) < 0.3) return;
    let y = wheelY;
    let at = performance.now();
    const id = ++glide;
    const step = (now: number) => {
      if (id !== glide) return;
      y += v * (now - at);
      at = now;
      v *= 0.94;
      turnWheel(y, v);
      if (Math.abs(v) > 0.05) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function touchMove(e: TouchEvent) {
    noteTouch(e, el ?? null);
    // The history layer scrolls itself (the device's own scrolling and selection).
    if (inLayer(e)) return;
    // Held: the finger drags the selection's other end.
    if (selecting && anchor && e.touches.length === 1) {
      e.preventDefault();
      const at = cellAt(e.touches[0]!.clientX, e.touches[0]!.clientY);
      if (at) selectRange(anchor, at);
      return;
    }
    if (pickTimer && e.touches.length === 1 && swipe && Math.hypot(e.touches[0]!.clientX - swipe.x, e.touches[0]!.clientY - swipe.y) > 8) cancelHold();
    if (wheelFromTouch(e)) {
      e.preventDefault();
      return;
    }
    if (!pinch || e.touches.length !== 2 || !term) return;
    e.preventDefault();
    if (!pinch.mode) {
      if (Math.abs(dist(e) - pinch.dist) > 24) pinch.mode = 'zoom';
      else if (Math.abs(midY(e) - pinch.y) > 12) pinch.mode = 'scroll';
      else return;
    }
    if (pinch.mode === 'scroll') {
      const cell = term.element ? term.element.clientHeight / term.rows : 16;
      const lines = Math.trunc((midY(e) - pinch.y) / cell);
      // Fingers down: back in history.
      if (lines !== pinch.lines) scrollBack(lines - pinch.lines);
      pinch.lines = lines;
      return;
    }
    const size = Math.round(Math.max(8, Math.min(32, (pinch.size * dist(e)) / pinch.dist)));
    if (size !== term.options.fontSize) {
      term.options.fontSize = size;
      refit(true);
    }
  }
  function touchEnd(e: TouchEvent) {
    noteTouch(e, el ?? null);
    // The history layer scrolls itself (the device's own scrolling and selection).
    if (inLayer(e)) return;
    cancelHold();
    if (selecting) {
      // The selection stays, with its buttons, until one is used or the
      // terminal is tapped. No click after it (xterm would clear it).
      e.preventDefault();
      selecting = false;
      swipe = null;
      // Shown again once the touch is over, whatever xterm did with it.
      setTimeout(showPick, 60);
      return;
    }
    if (pinch && term) {
      prefs.fontSize = term.options.fontSize ?? prefs.fontSize;
      savePrefs();
      pinch = null;
      return;
    }
    if (term && e.changedTouches.length === 1) startGlide();
    if (!swipe || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0]!.clientX - swipe.x;
    const dy = e.changedTouches[0]!.clientY - swipe.y;
    const fast = performance.now() - swipe.at < 500;
    swipe = null;
    if (fast && Math.abs(dx) > 90 && Math.abs(dy) < 40) onswipe?.(dx < 0 ? 1 : -1);
  }
</script>

{#if searching}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc closes the search from any of its controls, its buttons too) -->
  <form class="tsearch" role="search" onsubmit={(e) => (e.preventDefault(), find(1))} onkeydown={(e) => e.key === 'Escape' && closeSearch()} data-testid="term-search">
    <input
      bind:this={searchEl}
      bind:value={query}
      oninput={() => find(1)}
      onkeydown={(e) => {
        // Shift+Enter goes to the previous match (Enter: the next).
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          find(-1);
        }
      }}
      placeholder={t('term.searchHint')}
      aria-label={t('term.search')}
      autocapitalize="none"
      spellcheck="false"
      data-testid="term-search-input"
    />
    <span class="dim small count" aria-live="polite">{found ? (found.of ? t('term.searchCount', { at: found.at, of: found.of }) : t('term.searchNone')) : ''}</span>
    <button type="button" class="icon-btn" class:on={matchCase} aria-pressed={matchCase} aria-label={t('ws.caseSensitive')} title={t('ws.caseSensitive')} onclick={() => ((matchCase = !matchCase), find(1))}>Aa</button>
    <button type="button" class="icon-btn" aria-label={t('term.searchPrev')} title={t('term.searchPrev')} onclick={() => find(-1)}><Icon name="arrow-up" size={16} /></button>
    <button type="button" class="icon-btn" aria-label={t('term.searchNext')} title={t('term.searchNext')} onclick={() => find(1)} data-testid="term-search-next"><Icon name="arrow-down" size={16} /></button>
    <button type="button" class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onclick={closeSearch}><Icon name="close" size={16} /></button>
  </form>
{/if}

<div class="term-wrap" class:other={!owner} class:kept={keptHeight !== null} data-main bind:this={wrapEl} use:touch={{ start: touchStart, move: touchMove, end: touchEnd }} oncontextmenucapture={holdMenu}>
  {#if picked && !nativeMenu}
    <!-- Held on the text: what to do with the selection (in the app, Android's own menu). -->
    <div class="pickbar" role="toolbar" aria-label={t('term.selection')} data-testid="term-pickbar">
      <button class="btn small" onclick={copyPick} data-testid="term-copy"><Icon name="copy" size={16} /> {t('common.copy')}</button>
      <button class="btn small" onclick={() => term && selectRange({ col: 0, row: 0 }, { col: term.cols - 1, row: term.buffer.active.length - 1 })}><Icon name="check" size={16} /> {t('term.selectAll')}</button>
      <button class="btn small" onclick={pasteHere}><Icon name="clipboard" size={16} /> {t('term.paste')}</button>
      <button class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onclick={clearPick}><Icon name="close" size={16} /></button>
    </div>
  {/if}
  {#if picked && !selecting && handles}
    {#each [['from', handles.from], ['to', handles.to]] as const as [end, p] (end)}
      {#if p}
        <!-- A finger's grip only; a mouse selects the usual way. -->
        <span
          class="grip {end}"
          style:left="{p.x}px"
          style:top="{p.y}px"
          aria-hidden="true"
          data-testid="term-grip"
          use:touch={{ start: (e) => grab(e, end), move: dragGrip, end: dropGrip, cancel: dropGrip }}
        ></span>
      {/if}
    {/each}
  {/if}
  <div class="term" bind:this={el} style:min-height={keptHeight !== null ? `${keptHeight - 8}px` : null} data-testid="terminal" data-private></div>
  {#if layer?.lines}
    <!-- Over the part of the terminal in sight: with the keyboard up the box holds more rows and is scrolled to the cursor. -->
    <div class="layer" style:top={layerView ? `${layerView.top}px` : null} style:height={layerView ? `${layerView.height}px` : null} style:bottom={layerView ? 'auto' : null}>
    <!-- The history layer: the session's lines, scrolled by the device itself (ansiLines escapes the text first).
         Focusable: a box that scrolls must be reachable by the keyboard too (axe scrollable-region-focusable). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="backlog"
      bind:this={layerEl}
      onscroll={atBottom}
      role="log"
      aria-label={t('term.history')}
      tabindex="0"
      style:font-size="{layer.size}px"
      style:line-height="{layer.cell}px"
      data-testid="term-history"
      data-private
    >
      {#each layerChunks as chunk, i (i)}
        <div class="chunk" style:contain-intrinsic-size="auto {chunk.length * layer.cell}px">
          {#each chunk as line, j (j)}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- ansiLines escapes the text first -->
            <div class="line">{@html line || ' '}</div>
          {/each}
        </div>
      {/each}
    </div>
    <button class="btn small live" class:newer={layer.newer} onclick={() => (closeLayer(), term?.focus())} data-testid="term-history-live"><Icon name="arrow-down" size={16} /> {t('term.backToLive')}</button>
    </div>
  {/if}
</div>

<!-- On a computer (no key bar) the row stays, empty or not: coming and going
     it made the terminal jump up and down while typing (report 854cb3). -->
{#if suggestions.length || aiLine !== null || !keyBars.show}
  <!-- In the terminal's own font size, as tall as the text box: larger and brighter than the
       terminal, the row took much of its room (report c02b7a). -->
  <div use:scrollCue class="suggest" class:idle={!suggestions.length && aiLine === null} role="listbox" aria-label={t('term.suggestions')} data-testid="suggestions" style:--chip-font="{prefs.fontSize}px" style:--chip-h="{composeOne}px">
    {#if aiLine !== null}
      <button class="chip-btn ai" role="option" aria-selected="false" onpointerdown={(e) => e.preventDefault()} onclick={() => onai?.(aiLine ?? '')}
        ><Icon name="sparkle" size={14} /> {t('ai.askChip')}</button
      >
    {/if}
    {#each suggestions as s (s.kind + s.label + s.insert)}
      <button
        class="chip-btn {s.kind}"
        role="option"
        aria-selected="false"
        title={s.kind === 'history' && onforget ? t('term.historyChip', { command: s.label }) : (s.description ?? s.label)}
        data-testid={s.kind === 'history' ? 'history-chip' : undefined}
        onpointerdown={(e) => (e.preventDefault(), chipDown(s))}
        onpointerup={chipUp}
        onpointerleave={chipUp}
        oncontextmenu={(e) => {
          if (s.kind !== 'history' || !onforget) return;
          e.preventDefault();
          chipUp();
          forget(s);
        }}
        onclick={() => pick(s)}>{s.label}</button
      >
    {/each}
  </div>
{/if}

{#if prefs.compose && !composeFolded}
  <form
    class="compose"
    style:--compose-font="{prefs.fontSize}px"
    style:--compose-line="{composeLine}px"
    style:--compose-one="{composeOne}px"
    onsubmit={(e) => {
      e.preventDefault();
      // The click after a hold: already on the line.
      if (held) return void (held = false);
      sendCompose(true);
    }}
  >
    <textarea
      bind:this={composeEl}
      bind:value={composeText}
      rows="1"
      enterkeyhint="send"
      autocapitalize="off"
      placeholder={t('term.composePlaceholder')}
      aria-label={t('term.composePlaceholder')}
      data-testid="compose"
      oninput={() => (autoGrow(), scheduleComplete())}
      onkeydown={composeKey}
      onbeforeinput={composeBeforeInput}
    ></textarea>
    <button
      class="send"
      title={t('term.composeSendHold')}
      aria-label={t('term.composeSend')}
      data-testid="compose-send"
      onpointerdown={sendDown}
      onpointerup={sendUp}
      onpointerleave={sendUp}
      oncontextmenu={(e) => e.preventDefault()}><Icon name="send" size={18} /></button
    >
  </form>
{/if}

<!-- For a finger: not on a computer with its own keyboard. -->
{#if keyBars.show}
<!-- Volume up pressed: what the next key does, in a line above the bar (the
     key itself said only "Vol+"). -->
{#if fn}<p class="fnhint" data-testid="volume-up-hint">{#each t('term.volumeUpShort').split(' | ') as part (part)}<span>{part}</span> {/each}</p>{/if}
<div use:scrollCue class="keybar" role="toolbar" aria-label={t('term.keys')}>
  <!-- Volume up was pressed: says so until the next key (or a tap here). -->
  {#if composeFolded}<button class="key" title={t('term.composeShow')} aria-label={t('term.composeShow')} onpointerdown={(e) => e.preventDefault()} onclick={unfoldCompose} data-testid="compose-unfold"><Icon name="edit" size={16} /></button>{/if}
  {#if fn}<button class="key on" aria-pressed="true" title={t('term.volumeUpHint')} onpointerdown={(e) => e.preventDefault()} onclick={() => ((fn = false), term?.focus())} data-testid="volume-up-key">{t('term.volumeUp')}</button>{/if}
  {#each bar as k, i (i)}
    <button
      class="key"
      class:on={(k.mod === 'ctrl' && ctrl) || (k.mod === 'alt' && alt)}
      onpointerdown={(e) => {
        // Keep the focus (and the soft keyboard) on the terminal. The key
        // itself acts on click: a swipe to scroll the bar is no click.
        e.preventDefault();
        holdKey(k);
      }}
      onpointerup={letGo}
      onpointercancel={() => (letGo(), (hold = null))}
      onpointerleave={letGo}
      oncontextmenu={(e) => k.repeat && e.preventDefault()}
      aria-label={k.icon ? k.label : undefined}
      title={k.icon ? k.label : undefined}
      onclick={() => pressBar(k)}>{#if k.icon}{k.prefix ?? ''}<Icon name={k.icon} size={16} />{:else}{k.label}{/if}</button
    >
  {/each}
</div>
{/if}

<style>
  /* Scrolls only when another device's larger size is shown; at this
     device's own size there is nothing beyond the terminal to scroll to. */
  .term-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--bg-sunken);
    touch-action: pan-y;
    /* A finger's scroll stays in the terminal: never the browser's pull to reload. */
    overscroll-behavior: none;
  }
  .term-wrap.other {
    overflow: auto;
  }
  /* Rows kept while the keyboard is up: the box scrolls to the cursor (from script). */
  .term-wrap.kept {
    overflow-y: auto;
    scrollbar-width: none;
  }
  /* Inside the terminal's width on any phone: the buttons wrap rather than
     run off the screen (four in a row did at 343 px). */
  .pickbar {
    position: absolute;
    top: 6px;
    left: 8px;
    right: 8px;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
    box-shadow: var(--shadow);
  }
  .pickbar :global(.btn) {
    width: auto;
  }
  /* A drop under each end of the selection; the box around it is what the
     finger takes (bigger than what shows). */
  .grip {
    position: absolute;
    z-index: 4;
    width: 36px;
    height: 36px;
    margin-left: -18px;
    touch-action: none;
  }
  .grip::after {
    content: '';
    position: absolute;
    top: 0;
    width: 18px;
    height: 18px;
    background: var(--accent);
    border-radius: 0 50% 50% 50%;
  }
  .grip.from::after {
    right: 18px;
    border-radius: 50% 0 50% 50%;
  }
  .grip.to::after {
    left: 18px;
  }
  /* Its padding outside the height the fit measures: the fit addon takes the
     parent's height and width for the room, and with the padding inside them
     a row (or a column) too many went under the box's edge at some sizes
     (report de3278: the prompt half under the text box). */
  .term {
    box-sizing: content-box;
    height: calc(100% - 8px);
    padding: 4px;
  }
  /* The history layer: over the terminal, the same letters and rows, scrolled by the device. */
  .layer {
    position: absolute;
    inset: 0;
    z-index: 4;
  }
  .backlog {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
    padding: 4px;
    background: var(--bg-sunken);
    color: var(--text);
    font-family: var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }
  .backlog .chunk {
    content-visibility: auto;
  }
  .backlog .line {
    min-height: 1lh;
  }
  .live {
    position: absolute;
    right: 12px;
    bottom: 12px;
    /* Its own width, not a phone's full-width button. */
    width: auto;
    max-width: calc(100% - 24px);
    z-index: 5;
    box-shadow: var(--shadow);
  }
  /* Output came since the history was fetched. */
  .live.newer {
    border-color: var(--accent);
  }
  /* Wraps between its parts, never past the screen's edge (UIA-12: one
     line ran off the right side, its last parts unreadable). */
  .fnhint {
    margin: 0;
    padding: 3px 8px;
    display: flex;
    flex-wrap: wrap;
    column-gap: 0.5em;
    background: var(--bg-raised);
    border-top: 1px solid var(--border);
    color: var(--text-dim);
    font: 0.75rem var(--mono);
  }
  /* A pair ("1-9: F1-F9") is not broken over two lines. */
  .fnhint span {
    white-space: nowrap;
  }
  /* The separator ends a line, never starts the next one. */
  .fnhint span:not(:last-child)::after {
    content: ' |';
  }
  .suggest {
    display: flex;
    gap: 6px;
    padding: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    background: var(--bg-raised);
    border-top: 1px solid var(--border);
  }
  /* Nothing to offer: the same height, so the terminal keeps its rows. */
  .suggest.idle {
    min-height: calc(var(--chip-h, 36px) + 8px + 1px);
    /* Empty: part of the terminal, not a white band under it. */
    background: var(--bg-sunken);
    border-top-color: transparent;
  }
  .chip-btn {
    flex: none;
    max-width: 70vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
    padding: 0 10px;
    height: var(--chip-h, 36px);
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text-dim);
    font: var(--chip-font, 0.85rem) var(--mono);
    cursor: pointer;
    touch-action: manipulation;
  }
  @media (hover: hover) {
    .chip-btn:hover {
      color: var(--text);
    }
  }
  .chip-btn.history,
  .chip-btn.snippet {
    border-color: color-mix(in srgb, var(--accent) 25%, var(--border));
  }
  .chip-btn.option {
    color: var(--text-dim);
  }
  .chip-btn.ai {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
    font-family: var(--font);
    font-weight: 600;
  }
  /* The send button grows with the box beside it: one line, both as tall
     as a key (36 px at least); more lines, both taller. */
  .compose {
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding: 4px;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
  }
  /* One line in the terminal's font size, as tall as the button beside it
     (line + 2x6 + 2x1, 36 px at least); more lines grow the box from script
     (autoGrow), because field-sizing is not supported everywhere (Firefox
     on Android). */
  .compose textarea::placeholder {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .compose textarea {
    flex: 1;
    box-sizing: border-box;
    height: var(--compose-one, 30px);
    min-height: var(--compose-one, 30px);
    max-height: 30dvh;
    resize: none;
    overflow-y: hidden;
    font: var(--compose-font, 14px) / var(--compose-line, 20px) var(--mono);
    padding: 4px 8px;
  }
  .send {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    min-height: var(--compose-one, 30px);
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-text);
    font-size: 1.1rem;
    cursor: pointer;
  }
  .keybar {
    display: flex;
    gap: 4px;
    padding: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
  }
  /* As high as the text box (28 px) and only as wide as their label: the
     row took a lot of room on a narrow screen (asked 2026-10-07). */
  .key {
    flex: 0 0 auto;
    min-width: 32px;
    height: 28px;
    padding: 0 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text);
    font: 600 0.8rem var(--mono);
    cursor: pointer;
    touch-action: manipulation;
  }
  .key.on {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .tsearch {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
  }
  .tsearch input {
    flex: 1;
    min-width: 0;
    height: 32px;
  }
  .tsearch .count {
    white-space: nowrap;
  }
  .tsearch .on {
    color: var(--accent);
  }
</style>
