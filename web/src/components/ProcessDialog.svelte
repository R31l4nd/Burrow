<script lang="ts">
  import type { ProcessList } from '@burrow/shared';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import LoadFailed from './LoadFailed.svelte';
  import { errorMessage, post } from '../lib/api.js';
  import { formatBytes } from '../lib/files.svelte.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { roving } from '../lib/roving.js';

  // Which processes use the CPU and the memory now (report 387b0e: "a process
  // overview like htop"), sampled while this is open and only then, admins
  // only: every process's CPU time twice, two seconds apart, and its memory.

  let { open = $bindable(false), hostId, by = $bindable('cpu') }: { open?: boolean; hostId: number; by?: 'cpu' | 'mem' } = $props();

  let list = $state<ProcessList | null>(null);
  let failed = $state('');
  let tries = $state(0);
  // One sample after another while open, the next a few seconds after the last answer.
  $effect(() => {
    if (!open) return;
    void tries;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      try {
        const x = await post<ProcessList>(`/api/hosts/${hostId}/processes`);
        if (stopped) return;
        list = x;
        failed = '';
      } catch (err) {
        if (stopped) return;
        // Failed is not empty: said, and not sampled again until asked (the list is not kept as if current).
        list = null;
        failed = errorMessage(err) || t('common.loadFailed');
        return;
      }
      timer = setTimeout(() => void sample(), 3000);
    };
    void sample();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  const shown = $derived(
    [...(list?.top ?? [])].sort((a, b) => (by === 'cpu' ? b.cpu - a.cpu || b.memBytes - a.memBytes : b.memBytes - a.memBytes || b.cpu - a.cpu)).slice(0, 15),
  );
  const memPct = (n: number) => (list?.memTotal ? `${((n / list.memTotal) * 100).toFixed(1)}%` : '');
</script>

<Dialog tour="processes" bind:open title={t('procs.title')} size="wide" onclose={() => ((list = null), (failed = ''))}>
  <!-- Drawn only while open: a closed dialog's "Loading..." is still in the page. -->
  {#if open}
    <div class="toolbar">
      <p class="dim small what">{t('procs.what')} <HelpTip text={t('help.processes')} /></p>
      <span class="spacer"></span>
      <div class="segmented compact" role="radiogroup" aria-label={t('procs.by')} use:roving={'radio'}>
        <button role="radio" aria-checked={by === 'cpu'} class:on={by === 'cpu'} onclick={() => (by = 'cpu')} data-testid="procs-by-cpu">CPU</button>
        <button role="radio" aria-checked={by === 'mem'} class:on={by === 'mem'} onclick={() => (by = 'mem')} data-testid="procs-by-mem">{t('containers.memory')}</button>
      </div>
    </div>
    {#if failed}
      <LoadFailed inline message={failed} onretry={() => tries++} />
    {:else if !list}
      <p class="dim small" data-testid="procs-sampling">{t('procs.sampling')}</p>
    {:else}
      <p class="dim small" data-testid="procs-sampled">{t('procs.sampled', { s: list.seconds, at: dateTime(list.at), n: list.total, cores: list.cores })}</p>
      <ul class="procs" data-testid="procs">
        {#each shown as p (p.pid)}
          <li class="proc" data-testid="proc">
            <div class="pline">
              <span class="pname"><b>{p.name}</b> <span class="dim small">{t('disk.pid', { pid: p.pid })}{p.user ? ` | ${p.user}` : ''}</span></span>
              {#if p.container}<span class="tag small mono" title={t('disk.container')}>{p.container}</span>{/if}
              <span class="nums small">
                <span class:main={by === 'cpu'}><span class="dim">CPU</span> {p.cpu.toFixed(1)}%</span>
                <span class:main={by === 'mem'}><span class="dim">{t('procs.mem')}</span> {formatBytes(p.memBytes)} <span class="dim">({memPct(p.memBytes)})</span></span>
              </span>
            </div>
            {#if p.command}<p class="cmd small mono dim">{p.command}</p>{/if}
          </li>
        {/each}
      </ul>
      <p class="dim small">{t('procs.note')}</p>
    {/if}
  {/if}
</Dialog>

<style>
  .what {
    margin: 0;
  }
  .procs {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* One block per process, a line between: a long command line ran into the next one's name. */
  .procs > li + li {
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .proc {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .pline {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
  }
  .pname {
    overflow-wrap: anywhere;
  }
  /* CPU and memory at the right, the one sorted by in bold. */
  .nums {
    margin-left: auto;
    display: inline-flex;
    gap: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .nums .main {
    font-weight: 700;
  }
  .tag {
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    overflow-wrap: anywhere;
  }
  .cmd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
