<script lang="ts">
  import { MAX_FOLLOW_UPS, targetKey, type AiPrices, type Analysis } from '@burrow/shared';
  import { usageText } from '../lib/aiusage.js';
  import { backInSight, errorMessage, get, noConnection, post } from '../lib/api.js';
  import { copyText, toast, inBackground } from '../lib/ui.svelte.js';
  import { dateTime, locale, t } from '../lib/i18n/index.svelte.js';
  import AnalysisAnswer from './AnalysisAnswer.svelte';
  import AnalysisThread from './AnalysisThread.svelte';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';

  // "Analyse": the lines on screen (or the pinned ones) to the language
  // model; the answer streams in, in fixed sections. The server masks
  // secrets and groups the lines before anything leaves.

  interface AnalysisLine {
    i: number;
    ts: string | null;
    text: string;
  }

  let {
    open = $bindable(false),
    targets,
    shown,
    pinned,
    deepAvailable = false,
    modelAvailable = true,
    names = '',
  }: {
    open?: boolean;
    targets: { hostId: number; container: string; file?: string }[];
    /** The lines the filters show. */
    shown: AnalysisLine[];
    /** Pinned lines, when there are any. */
    pinned: AnalysisLine[];
    deepAvailable?: boolean;
    /** A model is set up in Settings (else only the question to take elsewhere). */
    modelAvailable?: boolean;
    /** The logs by name ("web, worker"), said before anything is sent. */
    names?: string;
  } = $props();

  let scope = $state<'shown' | 'pinned'>('shown');
  let deep = $state(false);
  let answer = $state('');
  let running = $state(false);
  let error = $state('');
  let provider = $state('');
  // What the answer used, and the prices to say what that cost.
  let tokens = $state<Analysis['tokens']>(null);
  let prices = $state<AiPrices>({ input: null, output: null, currency: 'USD' });
  // The model the lines go to (provider:model), named before anything is sent.
  let model = $state<string | null>(null);
  get<{ prices: AiPrices; model?: string | null }>('/api/ai/analyze/options').then(
    (o) => ((prices = o.prices), (model = o.model ?? null)),
    () => {},
  );
  let started = false;
  // Questions asked further on the analysis shown (report 0a86b2): each with its answer, kept with it.
  let thread = $state<Analysis[]>([]);
  let canAsk = $state(false);
  let done = $state(false);
  let question = $state('');
  let asking = $state(false);

  $effect(() => {
    if (pinned.length && !started) scope = 'pinned';
  });

  // Opened from a link (#/logs?...&analyze=1: an alert, a push, or anyone's link), nothing is
  // sent until Analyse is tapped here, under the words that say what goes where (A3-WEB-07).

  $effect(() => {
    if (!open) handoffFor = '';
  });

  // The same question for Claude or ChatGPT in the person's own browser and
  // account: made (and masked) by Burrow, sent by them. Also on the
  // clipboard, for when the site does not fill it in.
  let handoff = $state('');
  let handoffError = $state('');
  let handoffFor = '';
  $effect(() => {
    if (!open) return;
    // Once per opening and choice (not at every new log line): the lines as
    // they were when the dialog opened.
    const key = `${scope}:${locale()}`;
    if (key === handoffFor) return;
    handoffFor = key;
    const lines = (scope === 'pinned' && pinned.length ? pinned : shown).slice(-20_000);
    handoff = '';
    handoffError = '';
    // Only the answer for the choice made now: a late one for "shown" replaced the one for
    // "pinned only" and sent the broader set to another AI (AUDIT2 UI-06).
    post<{ text: string }>('/api/ai/analyze/prompt', { targets, lines, lang: locale() }).then(
      (r) => {
        if (handoffFor === key) handoff = r.text;
      },
      // Said, not swallowed: the buttons stayed dead without a word.
      (err: unknown) => {
        if (handoffFor === key) handoffError = errorMessage(err);
      },
    );
  });
  const copyHandoff = async () => {
    if (handoff && (await copyText(handoff))) toast(t('analyze.copied'));
  };

  // The analysis runs on the server: this dialog follows it, and picks it
  // up again after a reload (its id is kept per set of containers).
  // Its commands run on its host when all its logs are from one (report a7532e).
  const oneHost = $derived(new Set(targets.map((x) => x.hostId)).size === 1 ? targets[0]!.hostId : null);
  const storeKey = $derived(`burrow.analysis:${targets.map((x) => targetKey(x)).join(',')}`);
  let following = 0;
  // Gone from the page (Back, a link) while open: no longer followed, its polling stops (audit 2026-10-30).
  $effect(() => () => void following++);
  let history = $state<Analysis[]>([]);
  let historyError = $state('');
  let viewing = $state<number | null>(null);

  const remember = (id: number | null) => {
    try {
      if (id === null) localStorage.removeItem(storeKey);
      else localStorage.setItem(storeKey, String(id));
    } catch {
      // Not kept: only a reload loses the thread.
    }
  };

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
          // The app left for a moment (or the network): the analysis runs on
          // at the server; ask again once back instead of an error.
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
        if (a.status !== 'running' && !a.followUps.some((q) => q.status === 'running')) {
          // Failed is said, also under a part of an answer (that looked like a whole one, AUDIT2 UI-05).
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

  async function loadHistory() {
    const first = targets[0];
    if (!first) return;
    historyError = '';
    try {
      history = await get<Analysis[]>(`/api/ai/analyses?hostId=${first.hostId}&container=${encodeURIComponent(first.container)}${first.file ? `&file=${encodeURIComponent(first.file)}` : ''}`);
    } catch (err) {
      // Not read is said, not "none earlier" (A3-WEB-06).
      history = [];
      historyError = errorMessage(err);
    }
  }

  // Opened: the one still running (or just done) for these containers, and the earlier ones.
  $effect(() => {
    if (!open) {
      // Closed: no longer followed here, so not "running" here either; opened again, it is
      // picked up below (it stayed "running" for good, AUDIT2 UI-03).
      following++;
      running = false;
      return;
    }
    inBackground(loadHistory());
    let id: number | null = null;
    try {
      id = Number(localStorage.getItem(storeKey)) || null;
    } catch {
      // Nothing kept.
    }
    if (id) {
      started = true;
      void get<Analysis>(`/api/ai/analyses/${id}`).then(
        (a) => {
          const fresh = Date.now() - Date.parse(a.createdAt) < 3600_000;
          if (a.status === 'running' || fresh) void follow(id!);
        },
        () => remember(null),
      );
    }
  });

  async function run() {
    started = true;
    answer = '';
    error = '';
    thread = [];
    canAsk = false;
    done = false;
    running = true;
    const lines = (scope === 'pinned' && pinned.length ? pinned : shown).slice(-20_000);
    try {
      const { id } = await post<{ id: number }>('/api/ai/analyses', { targets, lines, deep, lang: locale() });
      remember(id);
      await follow(id);
    } catch (err) {
      error = errorMessage(err);
      running = false;
    }
  }

  async function ask() {
    const id = viewing;
    const q = question.trim();
    if (!id || !q || asking) return;
    asking = true;
    try {
      await post(`/api/ai/analyses/${id}/ask`, { question: q, lang: locale() });
      question = '';
      await follow(id);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      asking = false;
    }
  }

  function show(a: Analysis) {
    remember(a.id);
    void follow(a.id);
  }
</script>

<Dialog tour="analyze" size="wide" bind:open title={t('analyze.title')}>
  <div class="stack" data-testid="analyze">
    {#if !answer && !running}
      <fieldset class="stack">
        <legend class="small dim">{t('analyze.which')} <HelpTip text={t('help.analyze')} /></legend>
        <!-- A choice only when there is one: the shown lines, or the pinned ones. -->
        {#if pinned.length}
          <label class="check"><input type="radio" bind:group={scope} value="shown" /> {t('analyze.shown', { n: shown.length })}</label>
          <label class="check"><input type="radio" bind:group={scope} value="pinned" /> {t('analyze.pinned', { n: pinned.length })}</label>
        {:else}
          <p class="small">{t('analyze.shown', { n: shown.length })}</p>
        {/if}
        {#if deepAvailable}<label class="check"><input type="checkbox" bind:checked={deep} /> {t('analyze.deep')}</label>{/if}
      </fieldset>
    {/if}
    {#if !modelAvailable}<p class="small">{t('analyze.noModel')}</p>
    {:else if !answer && !running}
      <!-- What goes where, before Analyse is tapped (A3-WEB-07: a link may have opened this). -->
      <p class="small" data-testid="analyze-sends">{t('analyze.sends', { n: scope === 'pinned' && pinned.length ? pinned.length : shown.length, sources: names, model: deep ? 'Claude' : (model ?? t('analyze.theModel')) })}</p>
    {/if}
    {#if !answer && !running}
      <div class="elsewhere" data-testid="analyze-elsewhere">
        <span class="small dim">{t('analyze.elsewhere')}</span>
        {#if handoffError}<p class="alert error small" data-testid="analyze-handoff-error">{handoffError}</p>{/if}
        <div class="links">
          <a class="btn small" class:disabled={!handoff} href={handoff ? `https://claude.ai/new?q=${encodeURIComponent(handoff)}` : undefined} target="_blank" rel="noopener noreferrer" onclick={copyHandoff}>Claude</a>
          <a class="btn small" class:disabled={!handoff} href={handoff ? `https://chatgpt.com/?q=${encodeURIComponent(handoff)}` : undefined} target="_blank" rel="noopener noreferrer" onclick={copyHandoff}>ChatGPT</a>
          <button class="btn small" disabled={!handoff} onclick={copyHandoff} data-testid="analyze-copy">{t('analyze.copy')}</button>
        </div>
      </div>
    {/if}
    {#if running && !answer}<p class="dim small" role="status">{t('analyze.thinking')}</p>{/if}
    {#if error}<p class="alert error small">{error}</p>{/if}
    {#if answer}
      <AnalysisAnswer text={answer} testid="analysis" hostId={oneHost} />
      {#if !running || thread.length}<p class="dim small" data-testid="analysis-by">{t('analyze.by', { provider })}{#if tokens}{` | ${usageText(tokens, prices)}`}{/if}</p>{/if}
      <AnalysisThread {thread} {prices} hostId={oneHost} />
      {#if canAsk && !running}
        <form class="stack ask" onsubmit={(e) => (e.preventDefault(), void ask())}>
          <label class="field">
            <span>{t('analyze.askLabel')}</span>
            <textarea rows="2" maxlength="2000" bind:value={question} onkeydown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void ask())} data-testid="analyze-question"></textarea>
          </label>
          <p class="help small">{t('analyze.askSends', { model: provider })}</p>
          <button class="btn" disabled={asking || !question.trim()} data-testid="analyze-ask">{t('analyze.ask')}</button>
        </form>
      {:else if done && !running && !canAsk}
        <p class="dim small" data-testid="analyze-no-ask">{thread.length >= MAX_FOLLOW_UPS ? t('analyze.askMax', { n: thread.length }) : t('analyze.askOld')}</p>
      {/if}
    {/if}
    {#if historyError && !running}<p class="alert error small">{t('analyze.earlierFailed', { error: historyError })}</p>{/if}
    {#if history.length && !running}
      <details class="history" data-testid="analyze-history">
        <summary class="small">{t('analyze.earlier', { n: history.length })}</summary>
        <div class="list">
          {#each history as a (a.id)}
            <button class="list-item" class:cur={a.id === viewing} onclick={() => show(a)}>
              <span class="main"><span class="title small">{dateTime(a.createdAt)}</span><span class="sub">{a.provider} | {t('analyze.linesN', { n: a.lines })}{a.status === 'failed' ? ` | ${t('analyze.failed')}` : ''}</span></span>
            </button>
          {/each}
        </div>
      </details>
    {/if}
  </div>
  {#snippet actions()}
    <button class="btn" onclick={() => (open = false)}>{t('common.close')}</button>
    {#if modelAvailable}<button class="btn primary" disabled={running || !shown.length} onclick={() => void run()} data-testid="analyze-run">{answer ? t('analyze.again') : t('analyze.run')}</button>{/if}
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
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    margin-bottom: 4px;
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
  .elsewhere {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .links :global(.btn) {
    width: auto;
  }
  .disabled {
    pointer-events: none;
    opacity: 0.5;
  }
</style>
