<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import { opProgress, type OpInfo, type OpOutcome } from '@burrow/shared';
  import { formatBytes } from '../lib/files.svelte.js';
  import { dateLocale, t } from '../lib/i18n/index.svelte.js';
  import { followOp } from '../lib/updates.svelte.js';

  // The live output of a compose operation on a stack (up, pull, update,
  // rollback), as it runs on the host, and how it ended. Above it how far it
  // is, read from that output: the images (with their bytes) and the
  // containers. The output itself folds away; it opens when something fails.
  // Compact (above a container's logs): once it ended, one line, and the
  // output in a dialog when asked for, so the logs keep their room.

  let { op, onend = () => {}, compact = false }: { op: OpInfo; onend?: (code: number) => void; compact?: boolean } = $props();

  let output = $state('');
  let code = $state<number | null>(null);
  let outcome = $state<OpOutcome | null>(null);
  let lost = $state(false);
  let pre: HTMLPreElement | undefined = $state();
  let stick = true;
  let showLog = $state(false);

  $effect(() => {
    const current = op;
    output = '';
    code = null;
    outcome = null;
    lost = false;
    return followOp(current, (m) => {
      if (m.t === 'output') output += m.d;
      else if (m.t === 'exit') {
        code = m.code;
        outcome = m.outcome ?? null;
        if (m.code !== 0 && !compact) showLog = true;
        onend(m.code);
      } else if (m.t === 'error') {
        if (m.message) output += `\n${m.message}\n`;
        else if (code === null) lost = true;
        if (!compact) showLog = true;
      }
    }, () => {
      // Connected again: the server sends all output so far.
      output = '';
      lost = false;
    });
  });

  $effect(() => {
    void output;
    if (pre && stick) queueMicrotask(() => pre && (pre.scrollTop = pre.scrollHeight));
  });

  const p = $derived(opProgress(output));
  const ended = (xs: { state: string }[]) => xs.filter((x) => x.state === 'done' || x.state === 'failed').length;
  // Images: by bytes when compose gives them, else by images pulled.
  const imagePct = $derived(p.bytes?.total ? p.bytes.done / p.bytes.total : p.images.length ? ended(p.images) / p.images.length : 0);
  const containerPct = $derived(p.containers.length ? ended(p.containers) / p.containers.length : 0);
  // Nothing recognised (another compose, an old docker-compose): the output is all there is.
  const known = $derived(p.images.length > 0 || p.containers.length > 0);
  const folded = $derived(compact && (code !== null || lost));
  // What the server says it does after the containers are up: watching them, and until when (W-FUNC-10:
  // a full bar and "running" for another minute, the watch said only in the folded output).
  let watchFrom = $state<{ s: number; at: number } | null>(null);
  $effect(() => {
    const m = /Watching the containers for (\d+) s\./.exec(output);
    if (!m) watchFrom = null;
    else if (!watchFrom) watchFrom = { s: Number(m[1]), at: Date.now() };
  });
  const until = (w: { s: number; at: number }) => new Date(w.at + w.s * 1000).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  // Rolled back and well again: that is how it ended, not "failed" (W-FUNC-10).
  const rolledBack = $derived(/The previous images run again, and run well\./.test(output) ? (/Not well: (.+?)\. Putting the previous images back\./.exec(output)?.[1] ?? '') : null);
</script>

{#snippet toggle()}
  <!-- Shows or hides: a button that says so, with its chevron (a link would go somewhere). -->
  <button class="btn small toggle" aria-expanded={showLog} onclick={() => (showLog = !showLog)} data-testid="op-log-toggle"
    ><span class="chev" class:open={showLog && !folded} aria-hidden="true"><Icon name="chevron" size={14} /></span>{showLog && !folded ? t('ops.hideLog') : t('ops.showLog')}</button
  >
{/snippet}
{#snippet log()}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
  <pre tabindex="0" bind:this={pre} onscroll={() => pre && (stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8)}>{output || ' '}</pre>
{/snippet}

<div class="op" class:folded data-testid="op-output">
  <div class="status small" role="status" data-testid="op-status">
    {#if code === null && !lost && watchFrom}
      <span class="spin" aria-hidden="true"></span> <span data-testid="op-watching">{t('ops.watching', { s: watchFrom.s, until: until(watchFrom) })}</span>
    {:else if code === null && !lost}
      <span class="spin" aria-hidden="true"></span> {t('ops.running', { op: t(`ops.op.${op.op}`) })}
    {:else if outcome?.kind === 'rolled_back'}
      <!-- Put back and running well again, as the server tells it: how it ended, not "failed" (W-FUNC-10); else read from the output. -->
      <span class="warn" data-testid="op-rolled-back"><Icon name="undo" size={14} /> {t('ops.rolledBackOp', { op: t(`ops.op.${op.op}`), why: outcome.why })}</span>
    {:else if code !== 0 && rolledBack !== null}
      <span class="warn" data-testid="op-rolled-back"><Icon name="undo" size={14} /> {rolledBack ? t('ops.rolledBackWhy', { why: rolledBack }) : t('ops.rolledBack')}</span>
    {:else if lost}
      <span class="warn">{t('ops.lost')}</span>
    {:else if code === 0}
      <span class="ok"><Icon name="check" size={14} /> {t('ops.done', { op: t(`ops.op.${op.op}`) })}</span>
    {:else if outcome?.kind === 'not_well'}
      <span class="bad"><Icon name="close" size={14} /> {t('ops.notWell', { op: t(`ops.op.${op.op}`), why: outcome.why })}</span>
    {:else}
      <span class="bad"><Icon name="close" size={14} /> {t('ops.failed', { op: t(`ops.op.${op.op}`), code: code ?? '?' })}</span>
    {/if}
  </div>

  {#if folded}
    {@render toggle()}
  {:else if p.images.length}
    {@const label = t('ops.images', { done: ended(p.images), n: p.images.length })}
    <div class="prog" data-testid="op-images">
      <div class="pline small">
        <span>{label}</span>
        {#if p.bytes}<span class="dim">{formatBytes(p.bytes.done)}{p.bytes.total ? ` / ${formatBytes(p.bytes.total)}` : ''}</span>{/if}
      </div>
      <div class="bar" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(imagePct * 100)}>
        <span class="fill" class:bad={p.images.some((i) => i.state === 'failed')} style:width={`${imagePct * 100}%`}></span>
      </div>
    </div>
  {/if}
  {#if p.containers.length && !folded}
    {@const label = t('ops.containers', { done: ended(p.containers), n: p.containers.length })}
    <div class="prog" data-testid="op-containers">
      <div class="pline small"><span>{label}</span></div>
      <div class="bar" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(containerPct * 100)}>
        <span class="fill" class:bad={p.containers.some((c) => c.state === 'failed')} style:width={`${containerPct * 100}%`}></span>
      </div>
    </div>
  {/if}

  {#if folded}
    <Dialog tour="op-log" size="wide" bind:open={showLog} title={t('ops.output')}>{@render log()}</Dialog>
  {:else}
    {#if known}{@render toggle()}{/if}
    {#if showLog || !known}{@render log()}{/if}
  {/if}
</div>

<style>
  .op {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Ended, compact: its state and the button to its output on one line. */
  .op.folded {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .ok {
    color: var(--ok);
  }
  .bad {
    color: var(--danger);
  }
  .warn {
    color: var(--warn);
  }
  .prog {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .pline {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .bar {
    height: 8px;
    border-radius: 4px;
    background: var(--bg-sunken);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-3) var(--ease);
  }
  .fill.bad {
    background: var(--danger);
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
  }
  /* Opens the raw output. On a phone full width, as an action is there; on a
     computer, and folded beside its state, as wide as its words. Its words
     on one line beside the chevron ("Uitvoer verbergen" broke in two, report 1d821b). */
  .toggle {
    white-space: nowrap;
  }
  .op.folded .toggle {
    width: auto;
  }
  @media (pointer: fine) and (min-width: 900px) {
    .toggle {
      align-self: flex-start;
    }
  }
  .chev {
    display: inline-flex;
    transition: transform var(--dur-2) var(--ease);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  pre {
    margin: 0;
    max-height: 40dvh;
    min-height: 80px;
    overflow: auto;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    font: 0.78rem/1.4 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  /* Still, with less motion asked for: the ring and the words say it runs (AUDIT2 UX-06). */
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
