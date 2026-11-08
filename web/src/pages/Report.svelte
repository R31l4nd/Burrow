<script lang="ts">
  import { roving } from '../lib/roving.js';
  import { untrack } from 'svelte';
  import type { AiPrices, ContainerReport, Report, ReportStatus } from '@burrow/shared';
  import { fixOf, reasonText, subjectLabel, targetKey, type ReportFix } from '@burrow/shared';
  import FixRun from '../components/FixRun.svelte';
  import PageTitle from '../components/PageTitle.svelte';
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import { usageText } from '../lib/aiusage.js';
  import { updatesLine } from '../lib/packages.js';
  import { del, errorMessage, get } from '../lib/api.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { scrollCue } from '../lib/scrollcue.js';
  import { session } from '../lib/session.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { dateOnly, dateTime, locale, reportName, t } from '../lib/i18n/index.svelte.js';
  import { go, goFrom, here, to, up } from '../lib/router.svelte.js';

  // One report: the whole in a few sentences, then per container its status,
  // why, its trend over the previous reports, the kinds of error (new or
  // recurring), what got resolved, and the model's explanation and fixes.

  let { id: idProp }: { id: number } = $props();
  const id = untrack(() => idProp);
  let r = $state<(Report & { trend: Record<string, ReportStatus[]> }) | null>(null);
  // What the explanations used, with the prices to say what that cost (as on an analysis, report 18efc8).
  let prices = $state<AiPrices>({ input: null, output: null, currency: 'USD' });
  get<{ prices: AiPrices }>('/api/ai/analyze/options').then(
    (o) => (prices = o.prices),
    () => {},
  );
  let error = $state('');
  let show = $state<'all' | 'issues'>('issues');

  // The summary in the reader's language, whatever the schedule's (decision 22).
  get<Report & { trend: Record<string, ReportStatus[]> }>(`/api/reports/${id}?lang=${locale()}`).then(
    (x) => {
      r = x;
      if (!x.counts.problem && !x.counts.attention) show = 'all';
    },
    (err: unknown) => (error = errorMessage(err)),
  );

  const ORDER: Record<ReportStatus, number> = { problem: 0, attention: 1, ok: 2 };
  const shown = $derived((r?.containers ?? []).filter((c) => show === 'all' || c.status !== 'ok').sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.container.localeCompare(b.container)));
  // A fix with a command opens the run dialog; nothing runs from here.
  let fixOpen = $state(false);
  let fixing = $state<{ fix: ReportFix; hostId: number; hostName: string } | null>(null);
  function tryFix(c: ContainerReport, fix: ReportFix) {
    fixing = { fix, hostId: c.hostId, hostName: c.hostName };
    fixOpen = true;
  }
  // Gone for good, after a yes (report aafaba); the admin's.
  const admin = $derived(session.state?.user?.role === 'admin');
  async function remove() {
    if (!r || !(await ask({ text: t('reports.deleteConfirm', { name: `${reportName(r.name)} | ${dateOnly(r.createdAt)}` }), confirm: t('common.delete'), danger: true }))) return;
    const from = here();
    try {
      await del(`/api/reports/${id}`);
      goFrom(from, '/reports');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  // Its own output and the log files read with it (AUDIT2 PAGE-21).
  const logs = (c: ContainerReport) =>
    to('/logs', { t: [`${c.hostId}:${c.container}`, ...(c.files ?? []).map((file) => targetKey({ hostId: c.hostId, container: c.container, file }))].join(','), at: r!.to });
</script>

<div class="page">
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/reports')}><Icon name="back" /></button>
    <PageTitle title={r ? reportName(r.name) : t('reports.title')} sub={r ? dateOnly(r.createdAt) : ''} />
    {#if admin && r}<button class="icon-btn" aria-label={t('reports.delete')} title={t('reports.delete')} onclick={remove} data-testid="report-delete"><Icon name="trash" /></button>{/if}
  </header>

  {#if error}
    <p class="alert error small">{error}</p>
  {:else if !r}
    <Skeleton rows={4} />
  {:else}
    <section class="card stack" data-testid="report-summary">
      <p class="dim small">{t('reports.period', { from: dateTime(r.from), to: dateTime(r.to) })}</p>
      <div class="counts">
        <!-- Counted words ("2 problems", "1 needs attention"), not the status words ("2 problem", W-FUNC-12, UIB-16). -->
        <span class="count problem"><b>{r.counts.problem}</b> {t('reports.count.problem', { n: r.counts.problem })}</span>
        <span class="count attention"><b>{r.counts.attention}</b> {t('reports.count.attention', { n: r.counts.attention })}</span>
        <span class="count ok"><b>{r.counts.ok}</b> {t('reports.status.ok')}</span>
      </div>
      <p>{r.summary}</p>
      <!-- Hosts it could not read: their containers are not in it. -->
      {#if r.unreachable?.length}
        <div class="alert error small" data-testid="report-unreachable">
          <p>{t('reports.unreachable', { n: r.unreachable.length })}</p>
          <ul>
            {#each r.unreachable as u (u.hostId)}<li><strong>{u.hostName}</strong>: {u.error}</li>{/each}
          </ul>
        </div>
      {/if}
      <!-- Package updates waiting on its hosts, at their last check (each to its host's page). -->
      {#if r.updates?.length}
        <details class="small" data-testid="report-updates">
          <summary data-testid="report-updates-open">{t('reports.updatesOn', { n: r.updates.length })}</summary>
          <ul>
            {#each r.updates as u (u.hostId)}<li><a href={`#/hosts/${u.hostId}/stats`}><strong>{u.hostName}</strong></a>: {updatesLine(u)}</li>{/each}
          </ul>
        </details>
      {/if}
      {#if r.model}<p class="dim small" data-testid="report-by">{t('reports.by', { model: r.model })}{r.tokens ? ` | ${usageText(r.tokens, prices)}` : ''}</p>{:else}<p class="dim small">{t('reports.noModel')}</p>{/if}
    </section>

    <div class="seg" role="tablist" aria-label={t('reports.show')} use:roving data-testid="report-switch">
      <button role="tab" aria-selected={show === 'issues'} class:on={show === 'issues'} onclick={() => (show = 'issues')}>{t('reports.issues', { n: r.counts.problem + r.counts.attention })}</button>
      <button role="tab" aria-selected={show === 'all'} class:on={show === 'all'} onclick={() => (show = 'all')}>{t('reports.all', { n: r.containers.length })}</button>
    </div>

    {#if !shown.length}<p class="empty">{t('reports.allOk')}</p>{/if}
    <!-- A very wide screen: the containers in two columns, not one with the rest of it empty (report ddc5ea). -->
    <div class="cols creps">
    {#each shown as c (`${c.hostId}:${c.container}`)}
      <article class="card stack crep {c.status}" data-testid="container-report">
        <header class="chead">
          <span class="pill {c.status}">{t(`reports.status.${c.status}`)}</span>
          <!-- A container's page; a log file of the host has none: its lines. -->
          <button class="cname" onclick={() => go(c.container.includes(':') ? logs(c) : `/containers/${c.hostId}/${encodeURIComponent(c.container)}`)}>{subjectLabel(c.container, locale())}</button>
          <span class="host">{c.hostName}</span>
          <span class="spacer"></span>
          <span class="trend" role="img" title={t('reports.trend')} aria-label={t('reports.trend')}>
            {#each r.trend[`${c.hostId}:${c.container}`] ?? [] as s, i (i)}<span class="tdot {s}"></span>{/each}
          </span>
        </header>
        {#if c.reasons.length}<p class="small">{c.reasons.map((x) => reasonText(x, locale())).join(' | ')}</p>{/if}
        {#if c.summary}<p class="small">{c.summary}</p>{/if}
        {#if c.fixes.length}
          <ul class="fixes small">
            {#each c.fixes.map(fixOf) as fx, i (i)}
              <li data-testid="report-fix">
                {fx.step}
                {#if fx.command}
                  <span class="fixcmd">
                    <!-- A command whole on one line, scrolled sideways when long: broken up it read wrong ("burro w").
                         Faded at the edge while more is out of sight (it looked cut off). -->
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
                    <code class="mono" tabindex="0" use:scrollCue>{fx.command}</code>
                    <!-- Running it is the admin's; an operator reads the command (AUDIT2 PAGE-25). -->
                    {#if admin}<button class="btn small" onclick={() => tryFix(c, fx)} data-testid="fix-open">{t('fix.open')}</button>{/if}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if c.problems.length}
          <ul class="problems">
            {#each c.problems as p (p.key)}
              <li><span class="tag {p.trend}">{t(`reports.trend.${p.trend}`)}</span> <span class="mono small">{p.title}</span> <span class="dim small">{p.count}x</span></li>
            {/each}
          </ul>
        {/if}
        {#if c.resolved.length}<p class="small ok"><Icon name="check" size={14} /> {t('reports.resolved', { n: c.resolved.length })}</p>{/if}
        {#if c.linesTotal > c.linesRead}<p class="dim small">{t('reports.partial', { read: c.linesRead, total: c.linesTotal })}</p>{/if}
        {#if c.status !== 'ok'}<button class="link" onclick={() => go(logs(c))}>{t('reports.toLogs')}</button>{/if}
      </article>
    {/each}
    </div>
  {/if}
</div>

<FixRun bind:open={fixOpen} fix={fixing?.fix ?? null} hostId={fixing?.hostId ?? 0} hostName={fixing?.hostName ?? ''} />

<style>
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
  }
  .count b {
    font-size: 1.3rem;
  }
  .count.problem b,
  .pill.problem {
    color: var(--danger);
  }
  .count.attention b,
  .pill.attention {
    color: var(--warn);
  }
  .count.ok b,
  .pill.ok,
  .ok {
    color: var(--ok);
  }
  /* Centred over the content like the rest (margin 12px 0 put it at the left of a wide screen,
     report ddc5ea). */
  .seg {
    display: flex;
    gap: 4px;
    padding: 4px;
    margin-block: 12px;
    border-radius: 10px;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
  }
  .seg button {
    flex: 1;
    min-height: 34px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-dim);
    font: 600 0.85rem var(--font);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--bg-raised);
    color: var(--text);
  }
  .crep {
    margin-bottom: 10px;
    gap: 6px;
  }
  .crep.problem {
    border-left: 3px solid var(--danger);
  }
  .crep.attention {
    border-left: 3px solid var(--warn);
  }
  .chead {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .cname {
    border: 0;
    background: none;
    padding: 0;
    font: 700 0.95rem var(--font);
    color: var(--text);
    cursor: pointer;
  }
  .host {
    font-size: 0.75rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0 6px;
  }
  .spacer {
    flex: 1;
  }
  .trend {
    display: inline-flex;
    gap: 3px;
  }
  .tdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
  }
  .tdot.attention {
    background: var(--warn);
  }
  .tdot.problem {
    background: var(--danger);
  }
  p {
    margin: 0;
  }
  .fixes,
  .problems {
    margin: 0;
    padding-left: 18px;
  }
  .fixes li + li {
    margin-top: 4px;
  }
  .fixcmd {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  /* The button its own width: the command keeps the rest (it was squeezed
     to one letter a line beside a full-width button). */
  .fixcmd :global(.btn) {
    flex: none;
    width: auto;
  }
  .fixcmd code {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    border-radius: 6px;
    background: var(--bg-sunken);
    white-space: pre;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .problems {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .problems li {
    overflow-wrap: anywhere;
  }
  .tag {
    font: 700 0.68rem var(--font);
    border-radius: 5px;
    padding: 1px 6px;
    background: var(--bg-sunken);
  }
  .tag.new {
    color: var(--danger);
  }
  .tag.recurring {
    color: var(--warn);
  }
  .link {
    align-self: flex-start;
  }
</style>
