<script lang="ts">
  import { roving } from '../lib/roving.js';
  import LoadFailed from '../components/LoadFailed.svelte';
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import type { Analysis, Channel, HostContainers, LogSelection, ReportListItem, ReportSchedule, ScheduleKind } from '@burrow/shared';
  import { DEFAULT_SELECTION, targetKey, targetLabel } from '@burrow/shared';
  import LogSelectionEditor from '../components/LogSelectionEditor.svelte';
  import ScheduleFields from '../components/ScheduleFields.svelte';
  import { browserZone, whenText } from '../lib/schedule.js';
  import AnalysisAnswer from '../components/AnalysisAnswer.svelte';
  import AnalysisThread from '../components/AnalysisThread.svelte';
  import Dialog from '../components/Dialog.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import Icon from '../components/Icon.svelte';
  import SectionTabs from '../components/SectionTabs.svelte';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { dateOnly, dateTime, reportName, t } from '../lib/i18n/index.svelte.js';
  import { go, route, to } from '../lib/router.svelte.js';
  import { activity, nudgeActivity } from '../lib/activity.svelte.js';
  import ReportProgress from '../components/ReportProgress.svelte';
  import { attempt, toast, inBackground, undoCheck } from '../lib/ui.svelte.js';
  import { FormSave } from '../lib/formsave.svelte.js';
  import { selectionFromLists } from '../lib/legacyselection.js';

  // Reports on the containers: when they are made (schedules), and the ones
  // made so far, newest first.

  if (!data.loaded) inBackground(loadAll());
  // The form's Save: once at a time, and its end for the form it was pressed in (AUDIT2 PAGE-11, PAGE-12).
  const saving = new FormSave();
  // The form as opened: changed, closing it asks first (AUDIT2 PAGE-09).
  let formBase = '';
  let reports = $state<ReportListItem[]>([]);
  let schedules = $state<ReportSchedule[]>([]);
  let running = $state<number | null>(null);

  // A failed read is said on the page, not shown as "no reports" (audit WP-07).
  let loadError = $state('');
  let loaded = $state(false);
  async function load() {
    try {
      [reports, schedules] = await Promise.all([get<ReportListItem[]>('/api/reports'), get<ReportSchedule[]>('/api/reports/schedules')]);
      loadError = '';
      loaded = true;
    } catch (err) {
      loadError = errorMessage(err);
    }
  }
  // Pulled down on a phone: read again.
  $effect(() => pullToRefresh(() => load()));

  void load();

  // The AI's analyses of containers, beside the reports (loaded when shown).
  let view = $state<'reports' | 'analyses'>(route.query.view === 'analyses' ? 'analyses' : 'reports');
  let analyses = $state<Analysis[] | null>(null);
  let shownAnalysis = $state<Analysis | null>(null);
  let analysesError = $state('');
  // One still being written, opened: followed until it is done (AUDIT2 PAGE-22: it stayed half).
  $effect(() => {
    const a = shownAnalysis;
    if (a?.status !== 'running') return;
    const timer = setInterval(() => {
      get<Analysis>(`/api/ai/analyses/${a.id}`).then(
        (now) => {
          if (shownAnalysis?.id === now.id) shownAnalysis = now;
          if (analyses) analyses = analyses.map((x) => (x.id === now.id ? now : x));
        },
        () => {},
      );
    }, 2000);
    return () => clearInterval(timer);
  });
  // A target by what it is: a container's own output, a log file in it or on the host (AUDIT2 PAGE-20).
  const labelOf = (a: Analysis) => a.targets.map((x) => targetLabel({ hostId: x.hostId, container: x.container, file: x.file ?? null })).join(', ');
  // A dialog's title: the first source and how many more (its whole list under it); a list of them was cut in the title.
  const titleOf = (a: Analysis) => {
    const first = targetLabel({ hostId: a.targets[0]!.hostId, container: a.targets[0]!.container, file: a.targets[0]!.file ?? null });
    return a.targets.length > 1 ? t('reports.sourcesMore', { first, n: a.targets.length - 1 }) : first;
  };
  async function loadAnalyses() {
    analysesError = '';
    try {
      analyses = await get<Analysis[]>('/api/ai/analyses?limit=100');
    } catch (err) {
      analysesError = errorMessage(err);
    }
  }
  // Read at once, not when first shown: the switch shows them without a "Loading..." in between.
  void loadAnalyses();

  const when = (s: ReportSchedule) => whenText(s);

  // Made on the server: its progress here and in the busy pill, also when
  // this page is left. Still here when it is ready: the report opens.
  async function runNow(s: ReportSchedule) {
    running = s.id;
    nudgeActivity();
    try {
      const { id } = await post<{ id: number }>(`/api/reports/schedules/${s.id}/run`);
      if (route.parts[0] === 'reports' && !route.parts[1]) go(`/reports/${id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      running = null;
    }
  }
  const making = $derived(activity.report && activity.report.phase !== 'done' ? activity.report : null);

  // ---- the schedule form

  let open = $state(false);
  // The schedule whose menu is open; a tap in it closes it first, then acts.
  let menuFor = $state<ReportSchedule | null>(null);
  const fromMenu = (fn: (s: ReportSchedule) => unknown) => () => {
    const s = menuFor!;
    menuFor = null;
    void fn(s);
  };
  let editing = $state<ReportSchedule | null>(null);
  let f = $state({ name: '', enabled: true, kind: 'weekly' as ScheduleKind, day: 1, time: '08:00', cron: '', timeZone: browserZone, selection: structuredClone(DEFAULT_SELECTION), allChannels: true, channelIds: [] as number[], onlyAttention: false, ai: true, errorsAttention: 10, warningsAttention: 100 });
  // The channels a report can go to: those that take reports, or any chosen.
  let channelList = $state<Channel[]>([]);
  // What the rules can name: the stacks and containers Docker knows now.
  let known = $state<{ stacks: string[]; containers: string[] }>({ stacks: [], containers: [] });
  // What the form could not read: said in it, not "no channels" or no suggestions (A3-WEB-06).
  let channelsError = $state('');
  let knownMissing = $state<string[]>([]);
  const dockerHosts = $derived(data.hosts.filter((h) => h.facts?.hasDocker));

  /** An older schedule's hosts and containers, as rules: everything else skipped. */
  // An older schedule's lists become rules; too many for that: they stay lists (AUDIT2 PAGE-23).
  function selectionOf(s: ReportSchedule): { selection: LogSelection; lists: { hostIds: number[] | null; containers: string[] | null } } {
    // A snapshot: the schedule is reactive state, which structuredClone cannot copy.
    const sel = $state.snapshot(s.selection ?? DEFAULT_SELECTION) as LogSelection;
    const lists = $state.snapshot({ hostIds: s.hostIds, containers: s.containers }) as { hostIds: number[] | null; containers: string[] | null };
    const rules = selectionFromLists(sel, lists.hostIds, lists.containers);
    return rules ? { selection: rules, lists: { hostIds: null, containers: null } } : { selection: sel, lists };
  }

  // An older schedule's lists, when they stay lists.
  let lists: { hostIds: number[] | null; containers: string[] | null } = { hostIds: null, containers: null };
  function edit(s: ReportSchedule | null) {
    editing = s;
    const from = s ? selectionOf(s) : null;
    lists = from?.lists ?? { hostIds: null, containers: null };
    f = {
      name: s ? reportName(s.name) : t('reports.newName'),
      // As it is: opening one to change its name switched an unused one on (audit WP-05).
      enabled: s ? s.enabled : true,
      kind: s?.kind ?? 'weekly',
      day: s?.day ?? 1,
      time: s?.time ?? '08:00',
      cron: s?.cron ?? '0 8 * * 1',
      // Its own zone, UTC too; this browser's only for a new one (audit WP-05).
      timeZone: s ? s.timeZone : browserZone,
      selection: from ? from.selection : structuredClone(DEFAULT_SELECTION),
      allChannels: !s?.channelIds,
      channelIds: s?.channelIds ? [...s.channelIds] : [],
      onlyAttention: s?.onlyAttention ?? false,
      ai: s?.ai ?? true,
      errorsAttention: s?.errorsAttention ?? 10,
      warningsAttention: s?.warningsAttention ?? 100,
    };
    readChannels();
    knownMissing = [];
    void Promise.all(dockerHosts.map((h) => get<HostContainers>(`/api/docker/${h.id}/containers`).catch(() => null))).then((all) => {
      knownMissing = dockerHosts.filter((h, i) => !all[i] || all[i]!.error).map((h) => h.name);
      const cs = all.flatMap((x) => x?.containers ?? []);
      known = { stacks: [...new Set(cs.map((c) => c.project).filter((p): p is string => !!p))].sort(), containers: [...new Set(cs.map((c) => c.name))].sort() };
    });
    saving.opened();
    formBase = JSON.stringify(f);
    open = true;
  }

  function readChannels() {
    channelsError = '';
    void get<Channel[]>('/api/channels').then(
      (c) => (channelList = c),
      (err: unknown) => (channelsError = errorMessage(err)),
    );
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    // None chosen is not "all": it went to every channel (audit WP-06).
    if (!f.allChannels && !f.channelIds.length) return toast(t('reports.pickChannel'), 'error');
    const body = {
      name: f.name,
      enabled: f.enabled,
      kind: f.kind,
      day: Number(f.day),
      time: f.time,
      cron: f.kind === 'cron' ? f.cron : null,
      timeZone: f.timeZone,
      // The rules say which containers now (an older schedule's lists become rules, unless there are too many).
      hostIds: lists.hostIds,
      containers: lists.containers,
      selection: f.selection,
      channelIds: f.allChannels ? null : f.channelIds,
      onlyAttention: f.onlyAttention,
      ai: f.ai,
      errorsAttention: Number(f.errorsAttention),
      warningsAttention: Number(f.warningsAttention),
    };
    const schedule = editing;
    const done = await saving.run(() => (schedule ? put(`/api/reports/schedules/${schedule.id}`, body) : post('/api/reports/schedules', body)));
    if (done === 'saved') open = false;
    if (done) await load();
  }

  async function toggle(s: ReportSchedule, box: HTMLInputElement) {
    const on = box.checked;
    if (await attempt(() => put(`/api/reports/schedules/${s.id}`, { ...s, enabled: on, containers: s.containers ?? [] }))) await load();
    else undoCheck(box, on);
  }

  async function remove(s: ReportSchedule) {
    if (!(await ask({ text: t('common.confirmDelete', { name: s.name }), confirm: t('common.delete'), danger: true }))) return;
    if (await attempt(() => del(`/api/reports/schedules/${s.id}`))) await load();
  }
  const admin = $derived(session.state?.user?.role === 'admin');
  async function removeAnalysis(a: Analysis) {
    if (!(await ask({ text: t('reports.deleteAnalysisConfirm', { name: a.targets.map((x) => x.container).join(', ') }), confirm: t('common.delete'), danger: true }))) return;
    try {
      await del(`/api/ai/analyses/${a.id}`);
      analyses = (analyses ?? []).filter((x) => x.id !== a.id);
      shownAnalysis = null;
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

<div class="page">
  <header class="topbar">
    <h1>{t('reports.title')} <HelpTip text={t('help.reports')} /></h1>
  </header>
  <SectionTabs current="reports" />

  <!-- On a very wide screen the schedules beside what was made. -->
  <div class="duo spread">
  <section class="stack">
    <div class="toolbar">
      <h2>{t('reports.schedules')}</h2>
      <span class="spacer"></span>
      <button class="btn small" class:hidden={!admin} onclick={() => edit(null)} data-testid="new-schedule"><Icon name="plus" size={16} /> {t('reports.newSchedule')}</button>
    </div>
    <div class="list">
      {#each schedules as s (s.id)}
        <div class="list-item srow" data-testid="schedule">
          <input type="checkbox" checked={s.enabled} disabled={!admin} aria-label={t('reports.scheduleOn', { name: s.name })} onchange={(e) => toggle(s, e.currentTarget)} data-testid="schedule-on" />
          <span class="main">
            <span class="title">{reportName(s.name)}</span>
            <span class="sub">
              {when(s)}{s.enabled && s.nextRunAt ? ` | ${t('reports.next', { at: dateTime(s.nextRunAt) })}` : s.enabled ? '' : ` | ${t('reports.off')}`}{running === s.id || making?.scheduleId === s.id ? ` | ${t('reports.making')}` : ''}
            </span>
          </span>
          <!-- Run now, edit and delete in the row's menu: on a phone they took a line of their own under it (report e6fc13). -->
          {#if admin}<button class="icon-btn" aria-label={t('common.menuFor', { name: reportName(s.name) })} title={t('common.menuFor', { name: reportName(s.name) })} onclick={() => (menuFor = s)} data-testid="schedule-menu"><Icon name="more" size={20} /></button>{/if}
        </div>
      {/each}
    </div>
    <!-- Being made (here, by its schedule or on another device): how far, and when ready. -->
    {#if making}<div class="card">{#key making.scheduleId}<ReportProgress p={making} />{/key}</div>{/if}
  </section>

  <section class="stack">
    <!-- What was made: the periodic reports, or every AI analysis of a container. A heading and its
         switch as the schedules' beside it, the switch's halves alike: the chosen one, in bold, was
         wider and moved the other (report: Containers -> Reports jumped). -->
    <div class="toolbar">
      <h2>{t('reports.made')}</h2>
      <span class="spacer"></span>
      <div class="segmented compact" role="radiogroup" aria-label={t('reports.made')} use:roving={'radio'}>
        <button role="radio" aria-checked={view === 'reports'} class:on={view === 'reports'} onclick={() => (view = 'reports')} data-testid="made-reports">{t('reports.reportsTab')}</button>
        <button role="radio" aria-checked={view === 'analyses'} class:on={view === 'analyses'} onclick={() => (view = 'analyses')} data-testid="made-analyses">{t('reports.analyses')}</button>
      </div>
    </div>
    {#if view === 'analyses'}
      {#if analysesError}
        <LoadFailed message={analysesError} onretry={loadAnalyses} />
      {:else if analyses === null}
        <p class="dim">{t('common.loading')}</p>
      {:else if !analyses.length}
        <p class="empty">{t('reports.noAnalyses')}</p>
      {:else}
        <div class="list" data-testid="analyses">
          {#each analyses as a (a.id)}
            <button class="list-item rrow" onclick={() => (shownAnalysis = a)} data-testid="analysis-row">
              <span class="dot {a.status === 'failed' ? 'problem' : a.status === 'running' ? 'attention' : 'ok'}" aria-hidden="true"></span>
              <span class="main">
                <span class="title">{labelOf(a)}</span>
                <span class="sub">{[...new Set(a.targets.map((x) => data.hosts.find((h) => h.id === x.hostId)?.name ?? '?'))].join(', ')} | {dateTime(a.createdAt)} | {a.provider}{a.status === 'failed' ? ` | ${t('analyze.failed')}` : ''}</span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          {/each}
        </div>
      {/if}
    {:else}
    {#if loadError && !loaded}<LoadFailed message={loadError} onretry={load} />
    {:else if loadError}<p class="alert error small">{loadError}</p>
    {:else if loaded && !reports.length}<p class="empty">{t('reports.none')}</p>{/if}
    <div class="list" class:hidden={!reports.length} data-testid="reports">
      {#each reports as r (r.id)}
        <a class="list-item rrow" href={`#/reports/${r.id}`} onclick={(e) => (e.preventDefault(), go(`/reports/${r.id}`))} data-testid="report">
          <span class="dot {r.status}" aria-hidden="true"></span>
          <span class="main">
            <span class="title">{reportName(r.name)} | {dateOnly(r.createdAt)}</span>
            <span class="sub">{t('reports.counts', { p: r.counts.problem, a: r.counts.attention, o: r.counts.ok })}</span>
          </span>
          <Icon name="chevron" size={18} />
        </a>
      {/each}
    </div>
    {/if}
  </section>
  </div>
</div>

<Dialog tour="schedule-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor ? reportName(menuFor.name) : ''}>
  <button class="btn" disabled={running !== null || making !== null} onclick={fromMenu(runNow)} data-testid="run-report">{t('reports.runNow')}</button>
  <button class="btn" onclick={fromMenu(edit)} data-testid="edit-schedule">{t('common.edit')}</button>
  <button class="btn danger" onclick={fromMenu(remove)} data-testid="schedule-remove">{t('common.delete')}</button>
</Dialog>

<Dialog tour="analysis-view" size="wide" open={shownAnalysis !== null} title={shownAnalysis ? titleOf(shownAnalysis) : ''} onclose={() => (shownAnalysis = null)}>
  {#if shownAnalysis}
    {#if shownAnalysis.targets.length > 1}<p class="small">{labelOf(shownAnalysis)}</p>{/if}
    <p class="dim small">{dateTime(shownAnalysis.createdAt)} | {shownAnalysis.provider} | {t('analyze.linesN', { n: shownAnalysis.lines })}</p>
    <!-- Its commands run on its host (all its logs from one host): Run... beside each (report a7532e). -->
    {@const oneHost = new Set(shownAnalysis.targets.map((x) => x.hostId)).size === 1 ? shownAnalysis.targets[0]!.hostId : null}
    <AnalysisAnswer text={shownAnalysis.text || shownAnalysis.error || ''} testid="analysis-text" hostId={oneHost} />
    <!-- The questions asked further on it in the analysis dialog (report 0a86b2). -->
    <AnalysisThread thread={shownAnalysis.followUps} hostId={oneHost} />
  {/if}
  <!-- In the footer, in sight however long the answer (a dialog's buttons scrolled away, UIA-01). -->
  {#snippet actions()}
    {#if shownAnalysis}
      <button class="btn" onclick={() => shownAnalysis && go(to('/logs', { t: shownAnalysis.targets.map((x) => targetKey({ hostId: x.hostId, container: x.container, file: x.file ?? null })).join(',') }))} data-testid="analysis-logs"
        ><Icon name="file" size={16} /> {t('reports.toLogs')}</button
      >
      <!-- Gone for good, after a yes (report aafaba); not while it is being written. -->
      {#if admin && shownAnalysis.status !== 'running'}<button class="btn danger" onclick={() => shownAnalysis && void removeAnalysis(shownAnalysis)} data-testid="analysis-delete"><Icon name="trash" size={16} /> {t('reports.deleteAnalysis')}</button>{/if}
    {/if}
  {/snippet}
</Dialog>

<Dialog tour="report-schedule" bind:open title={editing ? t('reports.editSchedule') : t('reports.newSchedule')} dirty={() => JSON.stringify(f) !== formBase}>
  <form id="schedule-form" class="stack" onsubmit={save}>
    <label class="field"><span>{t('reports.name')}</span><input bind:value={f.name} required maxlength="80" /></label>

    <h3>{t('reports.sectionWhen')}</h3>
    <ScheduleFields bind:kind={f.kind} bind:day={f.day} bind:time={f.time} bind:cron={f.cron} bind:timeZone={f.timeZone} nextRunAt={editing?.nextRunAt ?? null} />

    <h3>{t('reports.sectionWhat')} <HelpTip text={t('help.logSelection')} /></h3>
    {#if knownMissing.length}<p class="alert error small">{t('reports.knownFailed', { hosts: knownMissing.join(', ') })}</p>{/if}
    <LogSelectionEditor bind:value={f.selection} stacks={known.stacks} containers={known.containers} />

    <h3>{t('reports.sectionSend')}</h3>
    <label class="check"><input type="checkbox" bind:checked={f.allChannels} data-testid="schedule-all-channels" /> {t('reports.allChannels')}</label>
    {#if !f.allChannels && channelsError}
      <LoadFailed inline message={channelsError} onretry={readChannels} />
    {:else if !f.allChannels}
      {#each channelList as c (c.id)}
        <label class="check"><input type="checkbox" bind:group={f.channelIds} value={c.id} data-testid="schedule-channel" /> {c.name}</label>
      {:else}
        <p class="dim small">{t('reports.noChannels')}</p>
      {/each}
    {/if}
    <div class="row">
      <label class="check"><input type="checkbox" bind:checked={f.onlyAttention} data-testid="schedule-only-attention" /> {t('reports.onlyAttention')}</label>
      <HelpTip text={t('help.reportOnlyAttention')} />
    </div>

    <h3>{t('reports.sectionContent')}</h3>
    <div class="row">
      <label class="check"><input type="checkbox" bind:checked={f.ai} data-testid="schedule-ai" /> {t('reports.ai')}</label>
      <HelpTip text={t('help.reportAi')} />
    </div>
    <details class="more">
      <summary>{t('reports.advanced')}</summary>
      <div class="stack">
        <p class="dim small">{t('reports.thresholdsHelp')}</p>
        <div class="grid2">
          <label class="field"><span>{t('reports.errorsAttention')}</span><input type="number" min="1" bind:value={f.errorsAttention} required data-testid="schedule-errors" /></label>
          <label class="field"><span>{t('reports.warningsAttention')}</span><input type="number" min="1" bind:value={f.warningsAttention} required data-testid="schedule-warnings" /></label>
        </div>
      </div>
    </details>
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (open = false)}>{t('common.cancel')}</button>
    {#if editing}<button class="btn" disabled={running !== null} onclick={() => editing && ((open = false), void runNow(editing))} data-testid="schedule-run">{t('reports.runNow')}</button>{/if}
    <button class="btn primary" form="schedule-form" disabled={saving.busy} data-testid="schedule-save">{t('common.save')}</button>
  {/snippet}
</Dialog>

<style>
  section {
    margin-bottom: 20px;
  }
  @media (min-width: 1700px) {
    .duo {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
      gap: 24px;
      align-items: start;
    }
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-height: 40px;
  }
  .segmented.compact {
    width: auto;
    min-width: 0;
    padding: 2px;
  }
  .segmented.compact button {
    flex: 1 1 0;
    min-width: 7.5em;
    min-height: 32px;
  }
  .spacer {
    flex: 1;
  }
  .srow,
  .rrow {
    gap: 8px;
  }
  .srow .main {
    flex: 1;
    min-width: 0;
  }
  .rrow {
    color: inherit;
    text-decoration: none;
  }
  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.attention {
    background: var(--warn);
  }
  .dot.problem {
    background: var(--danger);
  }
  .hidden {
    display: none;
  }
</style>
