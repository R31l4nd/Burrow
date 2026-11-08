<script lang="ts">
  import { ask } from '../lib/confirm.svelte.js';
  import { sessionLabel, type TerminalSessionInfo, type TerminalViewer } from '@burrow/shared';
  import { errorMessage } from '../lib/api.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { closeSession, loadSessions, terms } from '../lib/sessions.svelte.js';
  import { toast } from '../lib/ui.svelte.js';

  // Every open session from every device: host, age, last activity and who
  // is looking at it right now.
  let {
    current = null,
    currentViewers = null,
    onpick,
  }: {
    current?: string | null;
    /** Who looks at the current session now (its own socket knows first). */
    currentViewers?: TerminalViewer[] | null;
    onpick: (id: string) => void;
  } = $props();

  // Who is connected changes while the list is open (a phone opens the same
  // session): read again every few seconds, not once.
  // A failed read says so (and the next one tries again), instead of an
  // empty list that looks like no sessions.
  let error = $state('');
  const load = () => loadSessions().then(
    () => (error = ''),
    (err: unknown) => (error = errorMessage(err)),
  );
  $effect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  });
  const viewersOf = (s: TerminalSessionInfo) => (s.id === current && currentViewers ? currentViewers : s.viewers);

  async function close(id: string, name: string) {
    if (!(await ask({ text: t('term.confirmClose', { name }), confirm: t('term.close'), danger: true }))) return;
    try {
      await closeSession(id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

{#if error}<p class="alert error small" role="alert" data-testid="sessions-error">{error}</p>{/if}
{#if terms.list.length === 0}
  {#if !error}<p class="empty">{t('term.none')}</p>{/if}
{:else}
  <div class="list">
    {#each terms.list as s (s.id)}
      <div class="list-item" data-testid="session-row">
        <button class="main pick" onclick={() => onpick(s.id)}>
          <span class="title">{sessionLabel(s, terms.list)} {#if s.id === current}<span class="badge">{t('term.thisOne')}</span>{/if}</span>
          <span class="sub">
            {t('term.started', { when: relativeTime(s.createdAt) })} | {t('term.active', { when: relativeTime(s.lastActivityAt) })}
          </span>
          <!-- Joined, not written around an {#if}: Svelte drops the space at its edge ("Debian |verloren", report 0b970e). -->
          <span class="sub">
            {[s.title ? s.hostName : null, s.mode === 'tmux' ? 'tmux' : t('term.memory'), viewersOf(s).length ? viewersOf(s).map((v) => (v.watching ? t('term.watchingBy', { name: v.watching }) : v.device)).join(', ') : t('term.noViewers')].filter(Boolean).join(' | ')}
          </span>
        </button>
        <!-- "Close" in the row (whose is plain from where it is): "Sessie sluiten"
             cut the session's name off on a 343 px phone. -->
        <button class="btn small danger" aria-label="{t('term.close')}: {sessionLabel(s, terms.list)}" onclick={() => close(s.id, sessionLabel(s, terms.list))} data-testid="session-close">{t('common.close')}</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .pick {
    display: flex;
    flex-direction: column;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0;
  }
</style>
