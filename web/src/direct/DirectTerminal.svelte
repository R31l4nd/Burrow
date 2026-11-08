<script lang="ts">
  import { untrack } from 'svelte';
  import { AltScreenFilter } from '@burrow/shared';
  import { toast } from '../lib/ui.svelte.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { closeTopDialog } from '../lib/back.js';
  import type { Terminal } from '@xterm/xterm';
  import type { DirectCache, DirectHost, ShellState } from '@burrow/shared';
  import { watchShell } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import TermView from '../components/TermView.svelte';
  import type { HistoryItem } from '../lib/complete/engine.js';
  import { remembered } from './history.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { prefs } from '../lib/sessions.svelte.js';
  import { direct } from './bridge.js';

  // One direct SSH session, drawn by the same TermView as Burrow's own
  // sessions. The shell integration's marks are read here (Burrow's server
  // does that otherwise), for the completion and the history.

  let {
    sessionId,
    host,
    snippets,
    viaWireGuard = false,
    kept = false,
    keepOpen: keptOpen = false,
    onclose,
  }: {
    sessionId: string;
    host: DirectHost;
    snippets: DirectCache['snippets'];
    viaWireGuard?: boolean;
    /** In tmux on the host: leaving detaches, and it is there again next time. */
    kept?: boolean;
    /** Kept open already (the page loaded again while the app held the session open). */
    keepOpen?: boolean;
    /** ended: the session on the host is gone (not just this connection). */
    onclose: (ended: boolean) => void;
  } = $props();

  // Through the app's WireGuard, the connection goes down a minute after the
  // app leaves the screen (the battery). Unless kept open, on purpose.
  let keepOpen = $state(untrack(() => keptOpen));
  async function setKeepOpen(on: boolean) {
    keepOpen = on;
    await direct?.keepAlive(sessionId, on).catch(() => (keepOpen = !on));
  }

  let view: TermView | undefined = $state();
  let shell = $state<ShellState | null>(null);
  let ended = $state<string | null>(null);
  let menuOpen = $state(false);
  let snippetsOpen = $state(false);
  let limited = $state(false);

  const initialHistory = (() => host.history.map((h) => ({ command: h.command, count: h.count, lastAt: h.lastAt, score: h.count })))();
  let history = $state<HistoryItem[]>(initialHistory as HistoryItem[]);
  const hostSnippets = $derived(snippets.filter((s) => (!s.hostId && !s.groupId) || s.hostId === host.id || (s.groupId !== null && s.groupId === host.groupId)));

  const decode = (b64: string) => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  };

  $effect(() => {
    // With the terminal there to write into: what the app held comes at attach, below.
    if (!direct || !view) return;
    // No alternate screen, as in Burrow: what came before a tmux or vim of
    // your own stays in the scrollback (shared/src/altscreen.ts).
    const alt = new AltScreenFilter();
    const offOutput = direct.on('output', (d) => {
      const m = d as { sessionId: string; data: string };
      if (m.sessionId !== sessionId) return;
      view?.write(alt.write(m.data));
      altOn = alt.on;
    });
    // Android's back button: an open dialog (the question itself) closes first, else out of the session.
    const offBack = direct.on('back', () => closeTopDialog() || void leave());
    // Stop in the app's notification: no longer kept open.
    const offCleared = direct.on('keepCleared', () => (keepOpen = false));
    const offClosed = direct.on('closed', (d) => {
      const m = d as { sessionId: string; message?: string };
      if (m.sessionId === sessionId) ended = m.message ?? '';
    });
    // Listening now: the app sends what came before (the first prompt), then the rest.
    void direct.attach(sessionId).catch(() => {});
    return () => {
      offOutput();
      offBack();
      offCleared();
      offClosed();
    };
  });

  // Arguments of a completion generator, quoted for the host's shell.
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  // One function for the session: completion answers are kept per run function.
  // Without tmux, a program on its alternate screen (less, vim): a scroll goes to it as arrow keys.
  let altOn = $state(false);
  // In the kept tmux, a scroll goes through tmux's own history as in Burrow (server/src/terminal/
  // manager.ts): copy mode, or arrow keys for a full-screen program; typing leaves copy mode first
  // (review 2026-10-24: only the phone's own scrollback, which tmux's redraws had left empty).
  const TMUX_DIRECT = 'tmux -L burrow-direct';
  let inHistory = false;
  let leaving: Promise<unknown> | null = null;
  function scrollKept(lines: number) {
    const n = Math.abs(lines);
    if (!n) return;
    inHistory = true;
    const keys = `send-keys -t phone -N ${n} ${lines > 0 ? 'Up' : 'Down'}`;
    const back = `copy-mode -e -t phone ; send-keys -t phone -X -N ${n} ${lines > 0 ? 'scroll-up' : 'scroll-down'}`;
    void run(`${TMUX_DIRECT} if-shell -F -t phone '#{&&:#{alternate_on},#{!=:#{pane_current_command},tmux}}' '${keys}' '${back}'`, null).catch(() => {});
  }
  function type(d: string) {
    if (inHistory) {
      inHistory = false;
      leaving = run(`${TMUX_DIRECT} if-shell -F -t phone '#{pane_in_mode}' 'send-keys -t phone -X cancel' 2>/dev/null; true`, null).catch(() => {});
    }
    const send = () => void direct?.input(sessionId, d).catch(() => {});
    if (leaving) {
      const l = (leaving = leaving.then(send));
      void l.then(() => leaving === l && (leaving = null));
    } else send();
  }
  const run = async (script: string[] | string, cwd: string | null) => (await direct!.exec(sessionId, Array.isArray(script) ? script.map(quote).join(' ') : script, cwd)).stdout;

  function ready(term: Terminal) {
    watchShell(term.parser, decode, {
      patch: (p) => (shell = { ...(shell ?? { integration: false, atPrompt: false, cwd: null, prompt: null }), ...p }),
      command: (cmd) => {
        // Not one with a password on it: neither kept on the phone nor suggested.
        const next = remembered(history, cmd);
        if (!next) return;
        void direct?.record(host.id, cmd).catch(() => {});
        history = next;
      },
    });
    // Burrow sizes the session once the terminal knows its real size.
    setTimeout(() => view?.refit(true), 50);
  }

  // Leaving a kept session only detaches: no question, it waits on the host.
  // A session without tmux ends when left, so that asks first.
  async function leave() {
    if (kept && ended === null) {
      void direct?.close(sessionId).catch(() => {});
      toast(t('direct.detached', { host: host.name }));
      return onclose(false);
    }
    if (ended === null && !(await ask({ text: t('direct.confirmClose', { host: host.name }), confirm: t('term.close'), danger: true }))) return;
    void direct?.close(sessionId).catch(() => {});
    onclose(true);
  }

  /** Ends the session on the host too (everything running in it stops). */
  async function endSession() {
    menuOpen = false;
    if (!(await ask({ text: t('direct.confirmEnd', { host: host.name }), confirm: t('direct.end'), danger: true }))) return;
    void direct?.close(sessionId, true).catch(() => {});
    onclose(true);
  }
</script>

<main class="term-page">
  <header class="term-top">
    <button class="icon-btn" aria-label={t('common.back')} onclick={leave}><Icon name="back" /></button>
    <span class="title">{host.name}</span>
    <span class="badge warn" data-testid="route-direct">{t('direct.badge')}</span>
    <button class="icon-btn" aria-label={t('term.snippets')} title={t('term.snippets')} onclick={() => (snippetsOpen = true)}><Icon name="bolt" /></button>
    <button class="icon-btn" aria-label={t('term.sessions')} onclick={() => (menuOpen = true)}><Icon name="more" /></button>
  </header>

  {#if limited && !shell?.integration}
    <div class="status-row"><span class="badge">{t('term.limited')}</span></div>
  {/if}

  {#if ended !== null}
    <div class="ended stack">
      <p>{t('direct.ended')}{ended ? `: ${ended}` : ''}</p>
      <button class="btn primary" onclick={() => onclose(true)}>{t('direct.hosts')}</button>
    </div>
  {/if}

  <TermView
    bind:this={view}
    bind:limited
    device={direct}
    draftKey={`direct:${sessionId}`}
    {shell}
    {history}
    snippets={hostSnippets}
    {run}
    ls={(path) => direct!.ls(sessionId, path, shell?.cwd ?? null)}
    onready={ready}
    oninput={type}
    onscrollback={kept ? scrollKept : null}
    arrowScroll={altOn}
    onresize={(cols, rows) => void direct?.resize(sessionId, cols, rows).catch(() => {})}
  />
</main>

<Dialog tour="direct-menu" bind:open={menuOpen} title={host.name}>
  {#if viaWireGuard}
    <label class="check">
      <input type="checkbox" checked={keepOpen} onchange={(e) => setKeepOpen(e.currentTarget.checked)} data-testid="keep-open" />
      {t('direct.keepOpen')}
    </label>
    <p class="dim small">{t('direct.keepOpenHelp')}</p>
  {/if}
  <button class="btn" onclick={() => ((menuOpen = false), view?.openSearch())}><Icon name="search" size={18} /> {t('term.search')}</button>
  <label class="check">
    <input type="checkbox" checked={prefs.compose} onchange={() => ((menuOpen = false), view?.toggleCompose())} />
    {t('term.composeMode')}
  </label>
  <div class="row">
    <button class="btn small" onclick={() => view?.zoom(-1)} aria-label={t('term.smaller')}>A-</button>
    <button class="btn small" onclick={() => view?.zoom(1)} aria-label={t('term.larger')}>A+</button>
  </div>
  {#if kept}
    <p class="dim small">{t('direct.keptHelp')}</p>
    <button class="btn danger" onclick={endSession} data-testid="direct-end">{t('direct.end')}</button>
  {:else}
    <button class="btn danger" onclick={() => ((menuOpen = false), leave())}>{t('term.closeThis')}</button>
  {/if}
</Dialog>

<Dialog tour="direct-snippets" bind:open={snippetsOpen} title={t('term.snippets')}>
  <div class="list">
    {#each hostSnippets as s (s.id)}
      <div class="list-item">
        <span class="main"><span class="title wrap">{s.name}</span><span class="sub mono">{s.command}</span></span>
        <button class="btn small" onclick={() => ((snippetsOpen = false), view?.typeLine(s.command, false))}>{t('snippets.paste')}</button>
      </div>
    {:else}
      <p class="dim">{t('direct.noSnippets')}</p>
    {/each}
  </div>
</Dialog>

<style>
  .term-page {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .term-top {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-row {
    padding: 4px 8px;
  }
  .badge.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .ended {
    padding: 16px;
  }
</style>
