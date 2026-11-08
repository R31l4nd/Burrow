<script lang="ts">
  import type { AiPrices, Analysis } from '@burrow/shared';
  import { usageText } from '../lib/aiusage.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import AnalysisAnswer from './AnalysisAnswer.svelte';

  // The questions asked further on an analysis, each with its answer
  // (report 0a86b2): in the analysis dialog and on the Reports page.
  // Without prices: the tokens alone.
  let { thread, prices = { input: null, output: null, currency: 'USD' }, hostId = null }: { thread: Analysis[]; prices?: AiPrices; hostId?: number | null } = $props();
</script>

{#each thread as q (q.id)}
  <div class="asked" data-testid="analysis-question">
    <!-- As the terminal's AI dialog says a question it was asked. -->
    <p class="q small"><span class="dim">{t('ai.youAsked')}</span> {q.ask}</p>
    {#if q.text}
      <AnalysisAnswer text={q.text} testid="analysis-reply" {hostId} />
    {:else if q.status === 'running'}
      <p class="dim small" role="status">{t('analyze.askThinking')}</p>
    {/if}
    {#if q.status === 'failed' && q.error}<p class="alert error small">{q.error}</p>{/if}
    {#if q.status !== 'running'}<p class="dim small">{t('analyze.by', { provider: q.provider })}{#if q.tokens}{` | ${usageText(q.tokens, prices)}`}{/if}</p>{/if}
  </div>
{/each}

<style>
  /* A question asked further and its answer: one after the other, a line between. */
  .asked {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .q {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
