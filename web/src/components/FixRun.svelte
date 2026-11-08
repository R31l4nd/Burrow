<script lang="ts">
  import type { ReportFix, RunResult } from '@burrow/shared';
  import { judgeFix } from '../lib/fixrisk.js';
  import Dialog from './Dialog.svelte';
  import { errorMessage, post } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';

  // A fix from a report, carried out by hand: the exact command, which you
  // can change, on the container's host, with its risk. Nothing runs until
  // you press the button, and a high-risk command also needs a tick. The run
  // itself is a snippet run: fresh step-up and an audit entry.

  let {
    open = $bindable(false),
    fix,
    hostId,
    hostName,
    inline = false,
  }: { open?: boolean; fix: ReportFix | null; hostId: number; hostName: string; inline?: boolean } = $props();

  let command = $state('');
  let understood = $state(false);
  let busy = $state(false);
  let result = $state<RunResult | null>(null);
  let error = $state('');

  $effect(() => {
    if (open && fix) {
      command = fix.command ?? '';
      understood = false;
      result = null;
      error = '';
    }
  });

  // The model's label counts for its own command only; an edited command is
  // judged by Burrow's rules alone, and never below them.
  const judged = $derived(judgeFix(fix, command));
  const canRun = $derived(command.trim() !== '' && !busy && (judged.risk !== 'high' || understood));

  async function run() {
    busy = true;
    error = '';
    result = null;
    try {
      const [r] = await post<RunResult[]>('/api/snippets/run', { command: command.trim(), hostIds: [hostId] });
      result = r ?? null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet body()}
  {#if fix}
    <p class="small">{fix.step}</p>
    <p class="dim small">{t('fix.where', { host: hostName })}</p>
    <label class="field">
      <span>{t('snippets.command')}</span>
      <textarea class="mono" rows="3" bind:value={command} spellcheck="false" autocapitalize="off" data-testid="fix-command"></textarea>
    </label>
    <p class="small">
      <span class="badge risk-{judged.risk}" data-testid="fix-risk">{t(`ai.risk.${judged.risk}`)}</span>
      {#each judged.reasons as r (r)}<span class="dim"> | {r}</span>{/each}
    </p>
    <p class="alert small">{t('fix.check')}</p>
    {#if judged.risk === 'high'}
      <label class="check"><input type="checkbox" bind:checked={understood} data-testid="fix-understood" /> {t('fix.understood')}</label>
    {/if}
    {#if error}<p class="alert error small">{error}</p>{/if}
    {#if result}
      <div class="stack result" data-testid="fix-result">
        <span class="badge" class:bad={result.status !== 'ok'}>{result.status === 'ok' ? 'OK' : `exit ${result.exitCode ?? '-'}`}</span>
        {#if result.stdout}<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) --><pre tabindex="0">{result.stdout}</pre>{/if}
        {#if result.stderr}<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) --><pre tabindex="0" class="err">{result.stderr}</pre>{/if}
      </div>
    {/if}
  {/if}
{/snippet}
{#snippet acts()}
  <button class="btn" onclick={() => (open = false)}>{t('common.close')}</button>
  <button class={judged.risk === 'high' ? 'btn danger' : 'btn primary'} disabled={!canRun} onclick={() => void run()} data-testid="fix-confirm">
    {busy ? t('common.loading') : result ? t('fix.again') : t('fix.run')}
  </button>
{/snippet}

<!-- Inline: where the command already is in a dialog (an analysis's answer), never a second dialog over it. -->
{#if inline}
  {#if open}
    <div class="inline" data-testid="fix-inline">
      {@render body()}
      <div class="form-end">{@render acts()}</div>
    </div>
  {/if}
{:else}
  <Dialog bind:open title={t('fix.title')} tour="fix-run" size="wide">
    {@render body()}
    {#snippet actions()}{@render acts()}{/snippet}
  </Dialog>
{/if}

<style>
  p {
    margin: 0 0 8px;
  }
  .inline {
    margin-top: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  /* One command under the one it came from: no text field's full 140 px. */
  .inline textarea {
    min-height: 64px;
  }
  textarea {
    width: 100%;
    resize: vertical;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }
  .result {
    gap: 6px;
  }
  .result .badge {
    align-self: flex-start;
  }
  pre {
    margin: 0;
    padding: 8px;
    max-height: 240px;
    overflow: auto;
    background: var(--bg-sunken);
    border-radius: 8px;
    font: 0.8rem/1.4 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  pre.err {
    color: var(--danger);
  }
  /* Low: the text in the text colour (green on light green was too faint). */
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
</style>
