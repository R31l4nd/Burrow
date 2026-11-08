<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { AiTurn, CommandSuggestion } from '@burrow/shared';
  import { ApiFailure, del, errorMessage, get, post } from '../lib/api.js';
  import { locale, t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';

  // Text to command, as a conversation with this terminal session (report
  // 411dbe): the earlier questions and suggestions stay, newest last, and a
  // question can follow up on them ("make it recursive", "why?"); the server
  // sends the last few along, masked. A command is put on the input line,
  // never run: reading it and pressing Enter stays with the user.
  let {
    hostId,
    cwd,
    initial = '',
    sessionId = null,
    onuse,
  }: { hostId: number; cwd: string | null; initial?: string; sessionId?: string | null; onuse: (command: string) => void } = $props();

  // Starts from the # line the user typed, and can then be edited.
  let question = $derived(initial);
  let busy = $state(false);
  let notConfigured = $state(false);
  // Kept with the session on the server (another device, the dialog closed and opened again).
  let turns = $state<AiTurn[]>([]);
  let loaded = $state(!untrack(() => sessionId));
  let historyError = $state('');
  let listEl: HTMLDivElement | undefined = $state();

  async function scrollDown() {
    await tick();
    listEl?.scrollTo({ top: listEl.scrollHeight });
  }

  const turnsUrl = (id: string) => `/api/terminal/sessions/${encodeURIComponent(id)}/ai`;

  function loadTurns() {
    const id = untrack(() => sessionId);
    if (!id) return;
    historyError = '';
    get<AiTurn[]>(turnsUrl(id)).then(
      (list) => {
        turns = list;
        loaded = true;
        void scrollDown();
      },
      (err: unknown) => {
        // Not read is said; asking still works, as a new conversation.
        historyError = errorMessage(err);
        loaded = true;
      },
    );
  }
  loadTurns();

  async function ask(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    notConfigured = false;
    const prompt = question;
    try {
      const r = await post<CommandSuggestion>('/api/ai/command', { hostId, prompt, cwd, locale: locale(), ...(sessionId ? { sessionId } : {}) });
      // As the server keeps it (the question masked as it went); without a session, here only.
      const kept = sessionId ? await get<AiTurn[]>(turnsUrl(sessionId)).catch(() => null) : null;
      turns = kept ?? [...turns, { ...r, prompt, at: new Date().toISOString() }];
      question = '';
      void scrollDown();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'ai_not_configured') notConfigured = true;
      else toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  async function startOver() {
    if (sessionId) {
      try {
        await del(turnsUrl(sessionId));
      } catch (err) {
        toast(errorMessage(err), 'error');
        return;
      }
    }
    turns = [];
  }
</script>

{#if historyError}<p class="alert error small" data-testid="ai-history-failed">{t('ai.historyFailed', { error: historyError })}</p>{/if}

{#if turns.length}
  <div class="turns" bind:this={listEl} data-testid="ai-turns">
    {#each turns as r, i (i)}
      {@const last = i === turns.length - 1}
      <div class="turn" data-testid="ai-turn">
        <p class="q small"><span class="dim">{t('ai.youAsked')}</span> {r.prompt}</p>
        <div class="card stack" data-testid={last ? 'ai-result' : undefined}>
          <pre class="cmd">{r.command}</pre>
          <p class="small">{r.explanation}</p>
          <p class="small">
            <span class="badge risk-{r.risk}" data-testid={last ? 'ai-risk' : undefined}>{t(`ai.risk.${r.risk}`)}</span>
            {#each r.riskReasons as reason (reason)}<span class="dim"> | {reason}</span>{/each}
          </p>
          <p class="dim small">{r.provider} | {r.model}</p>
          <button class="btn" class:primary={last} onclick={() => onuse(r.command)} data-testid="ai-use">{t('ai.use')}</button>
          <button class="btn" onclick={async () => (await copyText(r.command)) && toast(t('common.copied'))}>{t('common.copy')}</button>
        </div>
      </div>
    {/each}
  </div>
  <p class="help">{t('ai.neverRuns')} {t('ai.kept')}</p>
{/if}

<!-- Held at the dialog's foot: the question and its button in sight however long the conversation (UIA-01). -->
<form class="stack ask-form" onsubmit={ask}>
  <label class="field">
    <span>{turns.length ? t('ai.followUp') : t('ai.question')}</span>
    <!-- svelte-ignore a11y_autofocus -->
    <textarea bind:value={question} rows="2" required autofocus placeholder={turns.length ? t('ai.followUpPlaceholder') : t('ai.placeholder')}></textarea>
  </label>
  <button class="btn primary" disabled={busy || !question.trim() || !loaded}>{busy ? t('ai.thinking') : t('ai.ask')}</button>
  {#if turns.length}<button type="button" class="btn" onclick={startOver} data-testid="ai-start-over">{t('ai.startOver')}</button>{/if}
</form>

{#if notConfigured}
  <div class="alert warn stack">
    <span>{t('ai.notConfigured')}</span>
    <button class="btn small" onclick={() => go('/settings/ai')}>{t('ai.openSettings')}</button>
  </div>
{/if}

<style>
  .turns {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 50dvh;
    overflow: auto;
    margin-bottom: 8px;
  }
  .q {
    margin: 0 0 4px;
    overflow-wrap: anywhere;
  }
  .cmd {
    margin: 0;
    padding: 10px;
    background: var(--bg-sunken);
    border-radius: 6px;
    font: 0.9rem/1.4 var(--mono);
    white-space: pre-wrap;
    word-break: break-all;
  }
  /* Low: the text in the text colour (green on light green was too faint), as in FixRun. */
  .risk-low {
    background: color-mix(in srgb, var(--ok) 20%, transparent);
    color: var(--text);
  }
  .risk-medium {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .risk-high {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .ask-form {
    position: sticky;
    bottom: -16px;
    margin-bottom: -16px;
    padding: 8px 0 16px;
    background: var(--bg-raised);
  }
</style>
