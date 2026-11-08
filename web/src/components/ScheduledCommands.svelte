<script lang="ts">
  import type { CommandRun, CommandRunBrief, CommandSchedule, CommandScheduleInput, ScheduleKind } from '@burrow/shared';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import Icon from './Icon.svelte';
  import LoadFailed from './LoadFailed.svelte';
  import PickList from './PickList.svelte';
  import ScheduleFields from './ScheduleFields.svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { FormSave } from '../lib/formsave.svelte.js';
  import { browserZone, whenText } from '../lib/schedule.js';
  import { attempt, inBackground, toast, undoCheck } from '../lib/ui.svelte.js';

  // Commands on a schedule (2.11.0), a part of the settings: each runs by
  // itself on its hosts as their own user; its runs and their output are
  // kept 30 days. Made and changed with a fresh step-up (the server asks).

  const saving = new FormSave();
  let list = $state<CommandSchedule[]>([]);
  let loaded = $state(false);
  let loadError = $state('');
  if (!data.loaded) inBackground(loadAll());

  const load = () => get<CommandSchedule[]>('/api/schedules/commands').then((x) => ((list = x), (loaded = true)));
  function firstLoad() {
    loadError = '';
    load().catch((err: unknown) => (loadError = errorMessage(err)));
  }
  firstLoad();

  const hostNames = (ids: number[]) => ids.map((id) => data.hosts.find((h) => h.id === id)?.name ?? `#${id}`).join(', ');
  // How its last round went: all well, some failed, or running.
  const lastState = (s: CommandSchedule) => (!s.last.length ? null : s.last.some((r) => r.ok === null) ? 'running' : s.last.every((r) => r.ok) ? 'ok' : 'failed');

  // ---- the form
  let editing = $state<CommandSchedule | 'new' | null>(null);
  const blank = () => ({ name: '', command: '', hostIds: [] as number[], enabled: true, kind: 'daily' as ScheduleKind, day: 1, time: '03:00', cron: '', timeZone: browserZone, timeoutMinutes: 10 });
  let f = $state(blank());
  let formBase = '';
  function edit(s: CommandSchedule | 'new') {
    saving.opened();
    editing = s;
    f = s === 'new' ? blank() : { name: s.name, command: s.command, hostIds: [...s.hostIds], enabled: s.enabled, kind: s.kind, day: s.day, time: s.time, cron: s.cron ?? '', timeZone: s.timeZone, timeoutMinutes: s.timeoutMinutes };
    formBase = JSON.stringify(f);
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!f.hostIds.length) return toast(t('sched.pickHost'), 'error');
    const body: CommandScheduleInput = { ...f, cron: f.kind === 'cron' ? f.cron : null };
    const s = editing;
    if (!s) return;
    const done = await saving.run(() => (s === 'new' ? post('/api/schedules/commands', body) : put(`/api/schedules/commands/${s.id}`, body)));
    if (done === 'saved') editing = null;
    if (done) await load();
  }
  async function toggle(s: CommandSchedule, box: HTMLInputElement) {
    const on = box.checked;
    const body: CommandScheduleInput = { name: s.name, command: s.command, hostIds: s.hostIds, enabled: on, kind: s.kind, day: s.day, time: s.time, cron: s.kind === 'cron' ? s.cron : null, timeZone: s.timeZone, timeoutMinutes: s.timeoutMinutes };
    if (await attempt(() => put(`/api/schedules/commands/${s.id}`, body))) await load();
    else undoCheck(box, on);
  }
  async function remove(s: CommandSchedule) {
    if (!(await ask({ text: t('common.confirmDelete', { name: s.name }), confirm: t('common.delete'), danger: true }))) return;
    if (!(await attempt(() => del(`/api/schedules/commands/${s.id}`)))) return;
    editing = null;
    menuFor = null;
    await load();
  }

  // ---- its menu, running it now, its runs
  let menuFor = $state<CommandSchedule | null>(null);
  let runningNow = $state<number | null>(null);
  async function runNow(s: CommandSchedule) {
    menuFor = null;
    runningNow = s.id;
    try {
      await post<{ runs: number[] }>(`/api/schedules/commands/${s.id}/run`);
      await load();
      const fresh = list.find((x) => x.id === s.id);
      toast(fresh && lastState(fresh) === 'failed' ? t('sched.ranFailed', { name: s.name }) : t('sched.ran', { name: s.name }), fresh && lastState(fresh) === 'failed' ? 'error' : undefined);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      runningNow = null;
    }
  }
  let runsOf = $state<CommandSchedule | null>(null);
  let runs = $state<CommandRunBrief[] | null>(null);
  let runsError = $state('');
  function openRuns(s: CommandSchedule) {
    menuFor = null;
    runsOf = s;
    runs = null;
    runsError = '';
    get<CommandRunBrief[]>(`/api/schedules/commands/${s.id}/runs`).then(
      (x) => (runs = x),
      (err: unknown) => (runsError = errorMessage(err)),
    );
  }
  let shown = $state<CommandRun | null>(null);
  async function openRun(id: number) {
    try {
      shown = await get<CommandRun>(`/api/schedules/commands/runs/${id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  const runLine = (r: CommandRunBrief) =>
    r.ok === null ? t('sched.running') : r.timedOut ? t('sched.timedOut') : r.code === null ? t('sched.notRun') : r.ok ? t('sched.ok') : t('sched.exit', { code: r.code });
</script>

<div class="stack" data-testid="scheduled-part">
  <div class="btnrow" style:margin-bottom="12px">
    <button class="btn small" onclick={() => edit('new')} data-testid="sched-new"><Icon name="plus" size={16} /> {t('sched.new')}</button>
  </div>
  {#if loadError}
    <LoadFailed message={loadError} onretry={firstLoad} />
  {:else if !loaded}
    <p class="dim">{t('common.loading')}</p>
  {:else if list.length === 0}
    <p class="empty">{t('sched.none')}</p>
  {:else}
    <div class="list">
      {#each list as s (s.id)}
        {@const st = lastState(s)}
        <div class="list-item" data-testid="sched-row">
          <!-- On or off on its row, as channels and report schedules; not in the form (report 3f6c59). -->
          <input type="checkbox" checked={s.enabled} aria-label={t('sched.on', { name: s.name })} onchange={(e) => toggle(s, e.currentTarget)} data-testid="sched-on" />
          <button class="main pick" onclick={() => edit(s)}>
            <span class="titlerow"><span class="title">{s.name}</span>{#if !s.enabled}<span class="chip">{t('sched.off')}</span>{:else if st === 'failed'}<span class="pill bad" data-testid="sched-failed">{t('sched.failed')}</span>{:else if st === 'ok'}<span class="pill ok">{t('sched.ok')}</span>{/if}</span>
            <span class="sub mono cmd">{s.command}</span>
            <span class="sub">{whenText(s)} | {hostNames(s.hostIds)}{s.nextRunAt ? ` | ${t('reports.next', { at: dateTime(s.nextRunAt) })}` : ''}</span>
          </button>
          <button class="icon-btn" aria-label={t('common.menuFor', { name: s.name })} title={t('common.menuFor', { name: s.name })} disabled={runningNow === s.id} onclick={() => (menuFor = s)} data-testid="sched-menu"><Icon name="more" size={20} /></button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<Dialog tour="sched-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.name ?? ''}>
  <button class="btn" onclick={() => menuFor && runNow(menuFor)} data-testid="sched-run">{t('sched.runNow')}</button>
  <button class="btn" onclick={() => menuFor && openRuns(menuFor)} data-testid="sched-runs">{t('sched.runs')}</button>
  <button class="btn" onclick={() => menuFor && (edit(menuFor), (menuFor = null))} data-testid="sched-edit">{t('common.edit')}</button>
  <button class="btn danger" onclick={() => menuFor && remove(menuFor)} data-testid="sched-remove">{t('common.delete')}</button>
</Dialog>

<Dialog tour="sched-form" open={editing !== null} title={editing === 'new' ? t('sched.new') : t('sched.edit')} onclose={() => (editing = null)} dirty={() => JSON.stringify(f) !== formBase}>
  <form id="sched-form" class="stack" onsubmit={save}>
    <label class="field"><span>{t('sched.name')}</span><input bind:value={f.name} required maxlength="80" data-testid="sched-name" /></label>
    <div class="field-wrap">
      <label class="field">
        <span>{t('snippets.command')}</span>
        <textarea class="mono" rows="4" bind:value={f.command} required spellcheck="false" autocapitalize="none" data-testid="sched-command"></textarea>
      </label>
      <span class="field-help"><HelpTip text={t('help.sched')} /></span>
    </div>
    <h3>{t('snippets.hosts')}</h3>
    <PickList items={data.hosts.map((h) => ({ id: h.id, title: h.name }))} chosen={f.hostIds} onchange={(next) => (f.hostIds = next)} label={t('snippets.hosts')} />
    <h3>{t('reports.sectionWhen')}</h3>
    <ScheduleFields bind:kind={f.kind} bind:day={f.day} bind:time={f.time} bind:cron={f.cron} bind:timeZone={f.timeZone} nextRunAt={editing && editing !== 'new' ? editing.nextRunAt : null} cronExample="0 3 * * *" />
    <label class="field"><span>{t('sched.timeout')}</span><input type="number" min="1" max="1440" bind:value={f.timeoutMinutes} required data-testid="sched-timeout" /></label>
  </form>
  {#snippet actions()}
    <button type="button" class="btn" onclick={() => (editing = null)}>{t('common.cancel')}</button>
    <button class="btn primary" form="sched-form" disabled={saving.busy} data-testid="sched-save">{t('common.save')}</button>
  {/snippet}
</Dialog>

<!-- Its runs, and one run's output in the same dialog (a second dialog over it is one too many). -->
<Dialog tour="sched-runs" size="wide" open={runsOf !== null} title={shown ? `${shown.hostName} | ${dateTime(shown.startedAt)}` : t('sched.runsOf', { name: runsOf?.name ?? '' })} onclose={() => ((runsOf = null), (shown = null))}>
  {#if shown}
    <button class="btn small back" onclick={() => (shown = null)} data-testid="sched-output-back"><Icon name="back" size={16} /> {t('sched.allRuns')}</button>
    <p class="small" data-testid="sched-output-state">{runLine(shown)}</p>
    {#if shown.error}<p class="alert error small">{shown.error}</p>{/if}
    {#if shown.cut}<p class="dim small">{t('sched.cut')}</p>{/if}
    {#if shown.output}<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) --><pre tabindex="0" data-private data-testid="sched-output">{shown.output}</pre>{:else}<p class="dim small">{t('sched.noOutput')}</p>{/if}
  {:else if runsError}
    <LoadFailed inline message={runsError} onretry={() => runsOf && openRuns(runsOf)} />
  {:else if !runs}
    <p class="dim">{t('common.loading')}</p>
  {:else if !runs.length}
    <p class="empty">{t('sched.noRuns')}</p>
  {:else}
    <div class="list">
      {#each runs as r (r.id)}
        <button class="list-item" onclick={() => openRun(r.id)} data-testid="sched-run-row">
          <span class="main">
            <span class="title">{r.hostName}</span>
            <span class="sub">{dateTime(r.startedAt)} | {runLine(r)}</span>
          </span>
          <span class="pill" class:ok={r.ok === true} class:bad={r.ok === false}>{r.ok === null ? '...' : r.ok ? 'OK' : '!'}</span>
        </button>
      {/each}
    </div>
  {/if}
</Dialog>

<style>
  .titlerow {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .titlerow .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .titlerow :global(.chip),
  .titlerow .pill {
    flex: none;
  }
  .pick {
    display: flex;
    flex-direction: column;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .cmd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .back {
    align-self: flex-start;
    width: auto;
  }
  pre {
    margin: 0;
    max-height: 60vh;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
