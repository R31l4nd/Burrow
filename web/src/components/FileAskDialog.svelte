<script lang="ts" module>
  /** What the editor holds when the dialog opens: the whole text, and the chosen lines if any. */
  export interface FilePart {
    text: string;
    total: number;
    chosen: { from: number; to: number; text: string } | null;
  }
</script>

<script lang="ts">
  import { fileAskText, MAX_FOLLOW_UPS, type AiPrices, type Analysis } from '@burrow/shared';
  import { usageText } from '../lib/aiusage.js';
  import { backInSight, errorMessage, get, noConnection, post } from '../lib/api.js';
  import { inBackground } from '../lib/ui.svelte.js';
  import { dateTime, locale, t } from '../lib/i18n/index.svelte.js';
  import AnalysisAnswer from './AnalysisAnswer.svelte';
  import AnalysisThread from './AnalysisThread.svelte';
  import Dialog from './Dialog.svelte';

  // "Ask AI about this file" (report 76bcda): the lines chosen in the editor,
  // or the whole file as the editor holds it, with a question, to the model
  // set up in Settings. The server cuts and masks it before it goes; the
  // answer is read here, never applied to the file. Kept on the server as an
  // analysis of kind "file": it goes on after a reload and can be asked further.

  let { open = $bindable(false), hostId, path, part }: { open?: boolean; hostId: number; path: string; part: FilePart | null } = $props();

  const name = $derived(path.split('/').pop() ?? path);
  let scope = $state<'chosen' | 'whole'>('whole');
  let deep = $state(false);
  let question = $state('');
  let answer = $state('');
  let running = $state(false);
  let error = $state('');
  let provider = $state('');
  let tokens = $state<Analysis['tokens']>(null);
  let thread = $state<Analysis[]>([]);
  let canAsk = $state(false);
  let done = $state(false);
  let further = $state('');
  let asking = $state(false);
  let viewing = $state<number | null>(null);
  let history = $state<Analysis[]>([]);
  let historyError = $state('');
  let options = $state<{ available: boolean; deep: boolean; prices: AiPrices; model: string | null } | null>(null);
  let optionsError = $state('');
  let following = 0;
  // Gone from the page (Back, a link) while open: no longer followed, its polling stops (audit 2026-10-30).
  $effect(() => () => void following++);

  const storeKey = $derived(`burrow.fileask:${hostId}:${path}`);
  const remember = (id: number | null) => {
    try {
      if (id === null) localStorage.removeItem(storeKey);
      else localStorage.setItem(storeKey, String(id));
    } catch {
      // Not kept: only a reload loses the answer.
    }
  };

  const sendsPart = $derived(scope === 'chosen' && part?.chosen ? t('fileAsk.partLines', { from: part.chosen.from, to: part.chosen.to }) : t('fileAsk.partAll', { n: part?.total ?? 0 }));

  async function loadHistory() {
    historyError = '';
    try {
      history = await get<Analysis[]>(`/api/ai/analyses?kind=file&hostId=${hostId}&file=${encodeURIComponent(path)}`);
    } catch (err) {
      // Not read is said, not "none earlier".
      history = [];
      historyError = errorMessage(err);
    }
  }

  async function follow(id: number) {
    const mine = ++following;
    viewing = id;
    running = true;
    error = '';
    try {
      for (;;) {
        let a: Analysis;
        try {
          a = await get<Analysis>(`/api/ai/analyses/${id}`);
        } catch (err) {
          // Away for a moment: the answer is written on at the server.
          if (!noConnection(err)) throw err;
          await backInSight();
          if (!open || mine !== following) return;
          continue;
        }
        if (mine !== following) return;
        answer = a.text;
        provider = a.provider;
        tokens = a.tokens;
        thread = a.followUps;
        canAsk = a.canAsk;
        done = a.status === 'done';
        question = a.ask ?? question;
        if (a.status !== 'running' && !a.followUps.some((q) => q.status === 'running')) {
          if (a.status === 'failed') error = a.error || t('analyze.stopped');
          break;
        }
        await new Promise((r) => setTimeout(r, 800));
        if (!open || mine !== following) return;
      }
    } catch (err) {
      if (mine === following) error = errorMessage(err);
    } finally {
      if (mine === following) {
        running = false;
        inBackground(loadHistory());
      }
    }
  }

  // Opened: the model named before anything goes, the answer still being written (or just
  // written) for this file picked up again, and the earlier questions about it.
  $effect(() => {
    if (!open) {
      following++;
      running = false;
      return;
    }
    scope = part?.chosen ? 'chosen' : 'whole';
    optionsError = '';
    get<{ available: boolean; deep: boolean; prices: AiPrices; model: string | null }>('/api/ai/analyze/options').then(
      (o) => (options = o),
      (err: unknown) => (optionsError = errorMessage(err)),
    );
    inBackground(loadHistory());
    let id: number | null = null;
    try {
      id = Number(localStorage.getItem(storeKey)) || null;
    } catch {
      // Nothing kept.
    }
    if (id) {
      void get<Analysis>(`/api/ai/analyses/${id}`).then(
        (a) => {
          if (a.status === 'running' || Date.now() - Date.parse(a.createdAt) < 3600_000) void follow(id!);
        },
        () => remember(null),
      );
    }
  });

  async function run() {
    if (!part || !question.trim() || running) return;
    answer = '';
    error = '';
    thread = [];
    canAsk = false;
    done = false;
    running = true;
    const chosen = scope === 'chosen' ? part.chosen : null;
    try {
      const { id } = await post<{ id: number }>('/api/ai/file', {
        hostId,
        path,
        text: fileAskText(chosen ? chosen.text : part.text),
        firstLine: chosen ? chosen.from : 1,
        totalLines: part.total,
        question: question.trim(),
        deep,
        lang: locale(),
      });
      remember(id);
      await follow(id);
    } catch (err) {
      error = errorMessage(err);
      running = false;
    }
  }

  async function ask() {
    const id = viewing;
    const q = further.trim();
    if (!id || !q || asking) return;
    asking = true;
    try {
      await post(`/api/ai/analyses/${id}/ask`, { question: q, lang: locale() });
      further = '';
      await follow(id);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      asking = false;
    }
  }

  function fresh() {
    following++;
    remember(null);
    viewing = null;
    answer = '';
    error = '';
    thread = [];
    question = '';
  }

  function show(a: Analysis) {
    remember(a.id);
    void follow(a.id);
  }
</script>

<Dialog tour="file-ask" size="wide" bind:open title={t('fileAsk.title')}>
  <div class="stack" data-testid="file-ask">
    {#if optionsError}<p class="alert error small">{optionsError}</p>{/if}
    {#if options && !options.available}
      <p class="small" data-testid="file-ask-no-model">{t('fileAsk.noModel')}</p>
    {:else if !answer && !running}
      {#if part?.chosen}
        <fieldset class="stack">
          <legend class="small dim">{t('fileAsk.which')}</legend>
          <label class="check"><input type="radio" bind:group={scope} value="chosen" data-testid="file-ask-chosen" /> {t('fileAsk.chosen', { from: part.chosen.from, to: part.chosen.to })}</label>
          <label class="check"><input type="radio" bind:group={scope} value="whole" data-testid="file-ask-whole" /> {t('fileAsk.whole', { n: part.total })}</label>
        </fieldset>
      {/if}
      <label class="field">
        <span>{t('fileAsk.question')}</span>
        <textarea rows="3" maxlength="2000" placeholder={t('fileAsk.placeholder')} bind:value={question} onkeydown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void run())} data-testid="file-ask-question"></textarea>
      </label>
      {#if options?.deep}<label class="check"><input type="checkbox" bind:checked={deep} /> {t('fileAsk.deep')}</label>{/if}
      <!-- What goes where, before anything is sent. -->
      <p class="help small" data-testid="file-ask-sends">{t('fileAsk.sends', { part: sendsPart, name, model: deep ? 'Claude' : (options?.model ?? t('analyze.theModel')) })}</p>
    {:else}
      <p class="q small" data-testid="file-ask-asked"><span class="dim">{t('ai.youAsked')}</span> {question}</p>
    {/if}
    {#if running && !answer}<p class="dim small" role="status">{t('fileAsk.thinking')}</p>{/if}
    {#if error}<p class="alert error small">{error}</p>{/if}
    {#if answer}
      <AnalysisAnswer text={answer} testid="file-ask-answer" {hostId} />
      {#if !running || thread.length}<p class="dim small">{t('analyze.by', { provider })}{#if tokens && options}{` | ${usageText(tokens, options.prices)}`}{/if}</p>{/if}
      <AnalysisThread {thread} prices={options?.prices} {hostId} />
      {#if canAsk && !running}
        <form class="stack ask" onsubmit={(e) => (e.preventDefault(), void ask())}>
          <label class="field">
            <span>{t('fileAsk.askLabel')}</span>
            <textarea rows="2" maxlength="2000" bind:value={further} onkeydown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void ask())} data-testid="file-ask-further"></textarea>
          </label>
          <p class="help small">{t('fileAsk.askSends', { model: provider })}</p>
          <button class="btn" disabled={asking || !further.trim()} data-testid="file-ask-further-send">{t('analyze.ask')}</button>
        </form>
      {:else if done && !running && thread.length >= MAX_FOLLOW_UPS}
        <p class="dim small">{t('fileAsk.askMax', { n: thread.length })}</p>
      {/if}
    {/if}
    {#if historyError && !running}<p class="alert error small">{t('analyze.earlierFailed', { error: historyError })}</p>{/if}
    {#if history.length && !running}
      <details class="history" data-testid="file-ask-history">
        <summary class="small">{t('fileAsk.earlier', { n: history.length })}</summary>
        <div class="list">
          {#each history as a (a.id)}
            <button class="list-item" class:cur={a.id === viewing} onclick={() => show(a)}>
              <span class="main"><span class="title small">{a.ask ?? dateTime(a.createdAt)}</span><span class="sub">{dateTime(a.createdAt)} | {a.provider} | {t('fileAsk.linesN', { n: a.lines })}{a.status === 'failed' ? ` | ${t('analyze.failed')}` : ''}</span></span>
            </button>
          {/each}
        </div>
      </details>
    {/if}
  </div>
  {#snippet actions()}
    <button class="btn" onclick={() => (open = false)}>{t('common.close')}</button>
    {#if answer && !running}
      <button class="btn" onclick={fresh} data-testid="file-ask-new">{t('fileAsk.new')}</button>
    {:else if !options || options.available}
      <button class="btn primary" disabled={running || !part || !question.trim()} onclick={() => void run()} data-testid="file-ask-run">{t('analyze.ask')}</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    gap: 4px;
  }
  legend {
    padding: 0;
    margin-bottom: 4px;
  }
  .q {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ask .btn {
    align-self: flex-end;
  }
  .history .list {
    margin-top: 6px;
    max-height: 30dvh;
    overflow: auto;
  }
  .history .cur {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
</style>
