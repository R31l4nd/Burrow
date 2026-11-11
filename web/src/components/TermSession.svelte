<script lang="ts">
  import { terminalState } from '../lib/inputlog.js';
  import { untrack } from 'svelte';
  import type { PathEntry, ShellState, Snippet, TerminalMode, TerminalViewer } from '@burrow/shared';
  import TermView from './TermView.svelte';
  import Icon from './Icon.svelte';
  import { android } from '../lib/android.js';
  import { errorMessage, get, post } from '../lib/api.js';
  import { suggestable, type HistoryItem } from '../lib/complete/engine.js';
  import { data } from '../lib/data.svelte.js';
  import { snippetsFor } from '../lib/snippetscope.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { refreshSession } from '../lib/session.svelte.js';
  import { loadSessions, prefs, terms } from '../lib/sessions.svelte.js';
  import type { TerminalConnection, ConnState } from '../lib/terminal.js';
  import { attach, detach } from '../lib/termpool.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';

  // One terminal session on screen: its connection (kept when it goes,
  // lib/termpool.ts), the host's history and snippets for completion, and
  // the terminal itself. On the terminal page, and in the panel under a
  // workspace or a stack.
  let {
    id,
    mode = $bindable(null),
    shell = $bindable(null),
    // Written here, read by the page they are bound to.
    // eslint-disable-next-line no-useless-assignment
    viewers = $bindable(),
    connState = $bindable(),
    owner = $bindable(true),
    limited = $bindable(false),
    onai = undefined,
    onswipe = null,
    ontyped = undefined,
  }: {
    id: string;
    mode?: TerminalMode | null;
    shell?: ShellState | null;
    viewers?: TerminalViewer[];
    connState?: ConnState;
    owner?: boolean;
    limited?: boolean;
    onai?: (question?: string) => void;
    onswipe?: ((step: number) => void) | null;
    /** What is typed here, as sent (for typing into several terminals at once). */
    ontyped?: (data: string) => void;
  } = $props();

  let view: TermView | undefined = $state();
  const info = $derived(terms.list.find((s) => s.id === id));
  const host = $derived(data.hosts.find((h) => h.id === info?.hostId));

  // ---- auto-complete sources: the host's history and its snippets

  let history = $state<HistoryItem[]>([]);
  // What is offered: used often enough, or just now (Settings -> Terminal).
  const suggestableHistory = $derived(history.filter((h) => suggestable(h, prefs.historyMin, Date.now())));
  let snippetList = $state<Snippet[]>([]);
  let historyLoadedAt = 0;
  // A command no longer suggested (a typo, a wrong autocorrect).
  async function forgetCommand(command: string) {
    const hid = info?.hostId;
    if (!hid) return;
    history = history.filter((h) => h.command !== command);
    await post(`/api/hosts/${hid}/history/forget`, { command }).catch((err: unknown) => toast(errorMessage(err), 'error'));
  }
  async function loadHistory(force = false) {
    const hid = info?.hostId;
    if (!hid || (!force && Date.now() - historyLoadedAt < 5000)) return;
    historyLoadedAt = Date.now();
    history = await get<HistoryItem[]>(`/api/hosts/${hid}/history?limit=1000`).catch(() => history);
  }
  get<Snippet[]>('/api/snippets')
    .then((s) => (snippetList = s))
    .catch(() => {});
  $effect(() => {
    if (info?.hostId) inBackground(loadHistory(true));
  });
  const hostSnippets = $derived(snippetsFor(snippetList, host, data.groups));
  const run = async (script: string[] | string, cwd: string | null) => (await post<{ stdout: string }>(`/api/terminal/sessions/${id}/complete/run`, { script, cwd })).stdout;
  const ls = (path: string) => get<{ dir: string; entries: PathEntry[] }>(`/api/terminal/sessions/${id}/complete/ls?path=${encodeURIComponent(path)}`);


  // tmux refused to start inside a tmux (report 7340bb: "sessions should be
  // nested with care"): a tmux of the person's own runs in this shell already
  // (Burrow's own points $TMUX at the person's server, so tmux starts in it).
  const NESTED = /sessions should be nested with care/;
  let nested = $state(false);
  // Only as the answer to a line just run: a program's redraw of the screen
  // (tmux after a resize) showed the old refusal again and brought the
  // notice back right after it was closed. Closed, it waits for the next line run.
  let ranAt = 0;

  // Without tmux, a program on its alternate screen (less, vim): a scroll goes to it as arrow keys.
  let altScreen = $state(false);
  let conn: TerminalConnection | null = null;
  // Why the server could not open the session here (A3-WEB-02): said, with Try again.
  let failure = $state('');

  $effect(() => {
    const v = view;
    if (!v) return;
    // Kept connected when this page goes (another tab, another page): back
    // here it is replayed at once (lib/termpool.ts, report cfdea9).
    // Untracked: a kept one is replayed right here, and what its handlers
    // read must not make this effect run again (it did, in a loop).
    const c = untrack(() => attach(id, {
      snapshot(snap, cols, rows, m, sh, again) {
        mode = m;
        terminalState.mode = m;
        shell = sh;
        v.reset(snap, cols, rows);
        // Drawn again on our asking (onreflow): the screen only. Fitted and sent as a size here, it went
        // out while a keyboard slid (report b00aad), and a fit to another size asked for it again.
        if (again) return;
        // Opening a session makes this the active device.
        owner = true;
        v.refit(true);
      },
      output(d, replayed) {
        if (replayed) return v.replay(d);
        v.write(d);
        if (NESTED.test(d) && Date.now() - ranAt < 3000) nested = true;
      },
      size(cols, rows, isOwner) {
        owner = isOwner;
        v.applySize(cols, rows, isOwner);
      },
      viewers: (list) => (viewers = list),
      shell(sh) {
        // A command was recorded (the server says which): the history has it now.
        // Without the shell integration that is a moment after the prompt came back.
        if ((shell?.atPrompt === false && sh.atPrompt) || (sh.lastCommand && sh.lastCommand !== shell?.lastCommand)) inBackground(loadHistory(true));
        shell = sh;
      },
      alt: (on) => (altScreen = on),
      history: (answer) => v.showHistory(answer),
      // A recording that stopped by itself (its size limit): the owner's checkbox and dot follow at once (2026-11-07).
      recording: (on) => (terms.list = terms.list.map((x) => (x.id === id ? { ...x, recording: on } : x))),
      notice: (code) => toast(code === 'password_sent' ? t('term.passwordSent') : code === 'password_refused' ? t('term.passwordRefused') : t('term.noPassword'), code === 'password_sent' ? 'info' : 'error'),
      state(s, message) {
        connState = s;
        failure = s === 'failed' ? (message ?? '') : '';
        if (s === 'signed-out') void refreshSession();
        if (s === 'ended') inBackground(loadSessions());
      },
    }));
    conn = c;
    // Back in sight, the network back, or the app back in front: the
    // connection checked (it can look open and be gone), else made again now.
    const onVisible = () => document.visibilityState === 'visible' && c.nudge();
    const nudge = () => c.nudge();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', nudge);
    const offResumed = android?.on('resumed', nudge);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', nudge);
      offResumed?.();
      detach(id);
      conn = null;
    };
  });


  /** A command typed in for the person to run (from the AI): no Enter. */
  export const insertCommand = (command: string) => view?.insertCommand(command);
  export const focus = () => view?.focus();
  export const openSearch = () => view?.openSearch();
  export const toggleCompose = () => view?.toggleCompose();
  export const zoom = (step: number) => view?.zoom(step);
  export const typeLine = (command: string, runIt: boolean) => view?.typeLine(command, runIt);
  /** Input sent to this session as if typed here (typing into several at once). */
  export const send = (data: string) => conn?.input(data);
  /** The host's stored password, typed in (where a program asks for it). */
  export function sendPassword() {
    conn?.send({ t: 'password' });
    view?.focus();
  }
</script>

  {#if connState === 'failed'}
    <div class="failed" role="alert" data-testid="term-failed">
      <p>{failure || t('term.failed')}</p>
      <button class="btn" onclick={() => conn?.retry()} data-testid="term-retry"><Icon name="reload" size={16} /> {t('common.retry')}</button>
    </div>
  {/if}
  {#if nested}
    <div class="nested" role="status" data-testid="term-nested">
      <div class="what">
        <p>{t('term.nestedOwn')}</p>
      </div>
      <button class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onclick={() => ((nested = false), (ranAt = 0), view?.focus())} data-testid="term-nested-close"><Icon name="close" size={16} /></button>
    </div>
  {/if}
  <TermView
    bind:this={view}
    bind:limited
    device={android}
    draftKey={id}
    onscrollback={mode === 'tmux' ? (lines) => conn?.send({ t: 'scroll', lines }) : null}
    onhistory={mode ? (mouse) => conn?.send({ t: 'history', ...(mouse ? { mouse } : {}) }) : null}
    arrowScroll={altScreen}
    {owner}
    {shell}
    history={suggestableHistory}
    snippets={hostSnippets}
    {run}
    {ls}
    {onai}
    oninput={(d) => {
      // Said once: gone when the next line is run.
      if (d.includes('\r')) {
        nested = false;
        ranAt = Date.now();
      }
      conn?.input(d);
      ontyped?.(d);
    }}
    onresize={(cols, rows, active) => conn?.send({ t: 'resize', cols, rows, active })}
    onreflow={() => mode && conn?.send({ t: 'redraw' })}
    {onswipe}
    onforget={forgetCommand}
    canSend={connState === 'open'}
  />

<style>
  .failed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--danger-bg);
  }
  .failed p {
    margin: 0;
    flex: 1 1 200px;
  }
  /* Why tmux would not start: the words, a way anyway under them, a close at the end. */
  .nested {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 4px 6px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
    font-size: 0.85rem;
  }
  .nested .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .nested p {
    margin: 0;
  }
</style>
