<script lang="ts">
  import type { DiskActivity, DiskHistory, DiskIo, ProcessIo } from '@burrow/shared';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import LoadFailed from './LoadFailed.svelte';
  import HistoryChart from './HistoryChart.svelte';
  import { errorMessage, get, post } from '../lib/api.js';
  import { formatBytes } from '../lib/files.svelte.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { diskTitle, iops, perSecond, powerNote } from '../lib/diskio.js';

  // One whole disk (report d4a9c0: "which processes are writing? my hard
  // disk spins all the time"): its reads, writes and busy time now and over
  // the history, whether it spins, and - for an admin, sampled while this
  // is open and only then - which processes read and write, with their
  // container and the files that put them on this disk.

  let { open = $bindable(false), hostId, disk, range, admin }: { open?: boolean; hostId: number; disk: DiskIo | null; range: 'day' | 'week' | 'month'; admin: boolean } = $props();

  let activity = $state<DiskActivity | null>(null);
  let whoError = $state('');
  let tries = $state(0);
  // Sampled while open, one after another: the next a few seconds after
  // the last answer (each takes two seconds on the host), never in the background.
  $effect(() => {
    if (!open || !admin) return;
    void tries;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      try {
        const a = await post<DiskActivity>(`/api/hosts/${hostId}/disks/activity`);
        if (stopped) return;
        activity = a;
        whoError = '';
      } catch (err) {
        if (stopped) return;
        // Failed is not empty: said, and not sampled again until asked (the list is not kept as if current).
        activity = null;
        whoError = errorMessage(err) || t('common.loadFailed');
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

  let history = $state<DiskHistory[] | null>(null);
  let historyError = $state('');
  let historyAsked = $state(0);
  $effect(() => {
    if (!open) return;
    const r = range;
    void historyAsked;
    let current = true;
    get<DiskHistory[]>(`/api/hosts/${hostId}/stats/disks?range=${r}`).then(
      (x) => current && ((history = x), (historyError = '')),
      (err: unknown) => current && ((history = null), (historyError = errorMessage(err))),
    );
    return () => (current = false);
  });

  const name = $derived(disk?.name ?? '');
  // The latest numbers: the sample's when there is one (the same seconds as its processes, and as root the drive's own power state).
  const live = $derived(activity?.disks.find((d) => d.name === name) ?? disk);
  const samples = $derived(history?.find((h) => h.disk === name)?.samples ?? []);
  const samplesAt = $derived(samples.map((s) => Date.parse(s.at)));
  // The moment pointed at, the same in each chart (as on the host's own page).
  let picked = $state<number | null>(null);
  const charts = $derived([
    [t('disk.chart.write'), samples.map((s) => s.writeBps), perSecond],
    [t('disk.chart.read'), samples.map((s) => s.readBps), perSecond],
    [t('disk.chart.writes'), samples.map((s) => s.writeIops), iops],
    [t('disk.chart.reads'), samples.map((s) => s.readIops), iops],
    [t('disk.chart.busy'), samples.map((s) => s.util), (v: number) => `${v.toFixed(1)}%`],
  ] as const);
  const here = $derived((activity?.top ?? []).filter((p) => p.disks.includes(name)));
  const elsewhere = $derived((activity?.top ?? []).filter((p) => !p.disks.includes(name)));
  const containersHere = $derived((activity?.containers ?? []).flatMap((c) => c.disks.filter((d) => d.disk === name).map((d) => ({ container: c.container, readBps: d.readBps, writeBps: d.writeBps }))));
  // The disk did I/O in the sample and no process seen has a file on it: said why that can be.
  const unexplained = $derived(!!activity && !!live && here.length === 0 && live.writeBps + live.readBps > 0);
</script>

<Dialog tour="disk-activity" bind:open title={disk ? diskTitle(disk) : ''} size="wide" onclose={() => ((activity = null), (whoError = ''), (history = null))}>
  <!-- Drawn only while open: a closed dialog's "Loading..." is still in the page. -->
  {#if open}
    {#if live}
      <section class="stack" aria-label={t('disk.now')} data-testid="disk-now">
        <p class="dim small what">{[live.model, formatBytes(live.sizeBytes)].filter(Boolean).join(' | ')}</p>
        <div class="nums">
          <div><span class="dim small">{t('disk.write')}</span><b>{perSecond(live.writeBps)}</b><span class="dim small">{t('disk.ops', { ops: iops(live.writeIops) })}</span></div>
          <div><span class="dim small">{t('disk.read')}</span><b>{perSecond(live.readBps)}</b><span class="dim small">{t('disk.ops', { ops: iops(live.readIops) })}</span></div>
          <div><span class="dim small">{t('disk.busy')}</span><b>{live.util}%</b></div>
        </div>
        {#if live.power}
          <p class="small" data-testid="disk-power"><b class="power {live.power}">{t(`stats.io.power.${live.power}`)}:</b> <span class="dim">{powerNote(live)}</span></p>
        {/if}
      </section>
    {/if}

    <section class="stack" aria-label={t('disk.history')}>
      <h3>{t('disk.history')} <span class="dim small">({t(`stats.range.${range}`)})</span></h3>
      {#if historyError}
        <LoadFailed inline message={historyError} onretry={() => historyAsked++} />
      {:else if history === null}
        <p class="dim small">{t('common.loading')}</p>
      {:else if samples.length < 2}
        <p class="dim small">{t('disk.noHistory')}</p>
      {:else}
        <div class="charts" data-testid="disk-charts">
          {#each charts as [label, values, fmt] (label)}
            <HistoryChart {label} {values} at={samplesAt} format={fmt} width={300} height={40} bind:picked testid="disk-chart" />
          {/each}
        </div>
      {/if}
    </section>

    <section class="stack" aria-label={t('disk.who')} data-testid="disk-who">
      <h3>{t('disk.who')} <HelpTip text={t('help.diskWho')} /></h3>
      {#if !admin}
        <p class="dim small" data-testid="disk-admin-only">{t('disk.adminOnly')}</p>
      {:else if whoError}
        <LoadFailed inline message={t('disk.failed', { error: whoError })} onretry={() => tries++} />
      {:else if !activity}
        <p class="dim small" data-testid="disk-sampling">{t('disk.sampling')}</p>
      {:else}
        <p class="dim small" data-testid="disk-sampled">{t('disk.sampled', { s: activity.seconds, at: dateTime(activity.at) })}</p>
        {#if !activity.asRoot}
          <div class="alert small" data-testid="disk-as-user">
            {t('disk.asUser', { seen: activity.processes.readable, total: activity.processes.total })}
            {#if activity.rootRefused}<span class="mono why">{t('disk.sudoSaid', { why: activity.rootRefused })}</span>{/if}
          </div>
        {:else if activity.processes.readable < activity.processes.total}
          <p class="dim small" data-testid="disk-partial">{t('disk.partial', { seen: activity.processes.readable, total: activity.processes.total })}</p>
        {/if}
        {#snippet proc(p: ProcessIo)}
          <li class="proc" data-testid="disk-proc">
            <div class="pline">
              <span class="pname"><b>{p.name || t('disk.ended')}</b> <span class="dim small">{t('disk.pid', { pid: p.pid })}</span></span>
              {#if p.container}<span class="tag small mono" title={t('disk.container')}>{p.container}</span>{/if}
              <span class="rates small"><span class="dim">{t('disk.write')}</span> {perSecond(p.writeBps)} <span class="dim">{t('disk.read')}</span> {perSecond(p.readBps)}</span>
            </div>
            {#if p.filesUnread}
              <p class="dim small">{t('disk.proc.unread')}</p>
            {:else if p.files.length}
              <ul class="files small mono">
                {#each p.files as f (f.path)}
                  <li class:dim={!f.write}>
                    <span>{f.write ? 'W' : 'R'}</span>
                    <span class="path">{f.path}{#if !f.disks.includes(name)}<span class="dim"> ({f.disks.length ? f.disks.join(', ') : t('disk.proc.notTold')})</span>{/if}</span>
                  </li>
                {/each}
                {#if p.moreFiles}<li class="dim more">{t('disk.proc.more', { n: p.moreFiles })}</li>{/if}
              </ul>
            {:else}
              <p class="dim small">{t('disk.proc.noFiles')}</p>
            {/if}
          </li>
        {/snippet}
        <h4 class="small">{t('disk.onThis', { name })}</h4>
        {#if here.length}
          <ul class="procs" data-testid="disk-here">{#each here as p (p.pid)}{@render proc(p)}{/each}</ul>
        {:else}
          <p class="dim small" data-testid="disk-nobody">{t('disk.nobodyHere', { name })}</p>
        {/if}
        {#if unexplained && live}
          <p class="small note" data-testid="disk-unexplained">{t('disk.unexplained', { name, w: perSecond(live.writeBps + live.readBps) })}</p>
        {/if}
        <!-- Each container's bytes on this disk, from its cgroup (written back from the cache too, which the processes' counters miss; decision 6). -->
        {#if activity.containers}
          <h4 class="small">{t('disk.containers', { name })}</h4>
          {#if containersHere.length}
            <ul class="procs" data-testid="disk-containers">
              {#each containersHere as c (c.container)}
                <li class="pline small"><span class="tag mono">{c.container}</span><span class="rates"><span class="dim">{t('disk.write')}</span> {perSecond(c.writeBps)} <span class="dim">{t('disk.read')}</span> {perSecond(c.readBps)}</span></li>
              {/each}
            </ul>
          {:else}
            <p class="dim small">{t('disk.noContainers', { name })}</p>
          {/if}
        {/if}
        <h4 class="small">{t('disk.elsewhere')}</h4>
        {#if elsewhere.length}
          <ul class="procs" data-testid="disk-elsewhere">{#each elsewhere as p (p.pid)}{@render proc(p)}{/each}</ul>
        {:else}
          <p class="dim small">{t('disk.nothingElse')}</p>
        {/if}
        <p class="dim small">{t('disk.totals')}</p>
      {/if}
    </section>
  {/if}
</Dialog>

<style>
  section + section {
    margin-top: 16px;
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  h4 {
    margin: 8px 0 0;
  }
  .nums {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 8px;
  }
  .nums > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
    min-width: 0;
  }
  .nums b {
    font-size: 1.15rem;
    font-variant-numeric: tabular-nums;
  }
  .power.standby {
    color: var(--ok);
  }
  .power.active {
    color: var(--warn);
  }
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
    gap: 10px 16px;
  }
  .procs,
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .procs {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  /* One block per process, a line between: its files ran into the next one's name. */
  .procs > li + li {
    border-top: 1px solid var(--border);
    padding-top: 10px;
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
  .rates {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tag {
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    overflow-wrap: anywhere;
  }
  /* W or R, then the path wrapping beside it (a long path breaks anywhere). */
  .files li {
    display: grid;
    grid-template-columns: 1.4em minmax(0, 1fr);
  }
  .path {
    overflow-wrap: anywhere;
  }
  .files li.more {
    display: block;
  }
  .why {
    display: block;
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .note {
    margin: 4px 0 0;
  }
  .what {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
