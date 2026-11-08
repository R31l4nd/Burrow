<script lang="ts">
  import { untrack } from 'svelte';
  import { Terminal as XTerm } from '@xterm/xterm';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import '@xterm/xterm/css/xterm.css';
  import type { SharedSession } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import { errorMessage, get } from '../lib/api.js';
  import { WatchConnection } from '../lib/watchconn.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { up } from '../lib/router.svelte.js';
  import { prefs } from '../lib/sessions.svelte.js';
  import { cssVar, followTheme, termTheme } from '../lib/termtheme.js';

  // A session someone shared with you, watched as it happens (F3): the
  // screen at the session's own size, nothing you type goes anywhere (the
  // server ignores it too). Ended, unshared or gone: said, not a blank.

  let { id: idProp }: { id: string } = $props();
  const id = untrack(() => idProp);

  let el = $state<HTMLDivElement>();
  let info = $state<SharedSession | null>(null);
  let view = $state<'connecting' | 'live' | 'lost' | 'ended' | 'unshared' | 'error'>('connecting');
  let message = $state('');
  let recording = $state(false);

  get<SharedSession[]>('/api/terminal/shared').then(
    (list) => {
      info = list.find((s) => s.id === id) ?? null;
      recording = info?.recording ?? false;
    },
    // Not read: said, not a session with no name or owner (A3-WEB-01).
    (err: unknown) => (infoError = errorMessage(err)),
  );
  let infoError = $state('');

  $effect(() => {
    if (!el) return;
    const term = new XTerm({ fontFamily: cssVar('--mono'), fontSize: untrack(() => prefs.fontSize), scrollback: 5000, disableStdin: true, cursorBlink: false, allowProposedApi: true, minimumContrastRatio: 4.5, theme: termTheme() });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(el);
    const unfollow = followTheme(term);
    // Dropped without the session ending: said, and connected again (lib/watchconn.ts).
    const conn = new WatchConnection(id, {
      message(m) {
        if (m.t === 'snapshot') {
          term.resize(m.cols, m.rows);
          term.reset();
          term.write(m.data);
          view = 'live';
        } else if (m.t === 'output') term.write(m.d);
        else if (m.t === 'size') term.resize(m.cols, m.rows);
        else if (m.t === 'recording') recording = m.on;
        else if (m.t === 'exit') {
          // Lost: Burrow restarting, or its connection to the host gone; connecting again.
          view = m.reason === 'lost' ? 'lost' : m.reason === 'error' ? 'error' : 'ended';
          message = m.message ?? '';
        }
      },
      state: (s) => (view = s),
    });
    return () => {
      conn.close();
      unfollow();
      term.dispose();
    };
  });

  const say = $derived(view === 'ended' ? t('watch.ended') : view === 'unshared' ? t('watch.unshared') : view === 'error' ? message || t('watch.lost') : view === 'lost' ? t('watch.reconnecting') : '');
</script>

<div class="page watch" data-testid="watch-page" data-content>
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/hosts')}><Icon name="back" /></button>
    <h1>{info ? (info.title ?? info.hostName) : t('watch.title')}</h1>
    <span class="pill dim" data-testid="watch-readonly">{t('watch.readOnly')}</span>
    {#if recording}<span class="pill rec" data-testid="watch-recording"><Icon name="dot" size={12} /> {t('term.recording')}</span>{/if}
  </header>
  {#if info}<p class="dim small">{t('watch.from', { owner: info.owner, host: info.hostName })}</p>{:else if infoError}<p class="alert error small">{t('watch.infoFailed', { error: infoError })}</p>{/if}
  {#if say}<p class="alert warn small" role="status" data-testid="watch-state">{say}</p>{/if}
  <div class="screen" bind:this={el} data-private></div>
</div>

<style>
  .watch {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .screen {
    flex: 1;
    min-height: 240px;
    overflow: auto;
    background: var(--bg-sunken);
    border-radius: 8px;
    padding: 6px;
  }
  .pill.rec {
    color: var(--danger);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
</style>
