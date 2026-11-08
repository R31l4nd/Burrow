<script lang="ts">
  import LoadFailed from '../components/LoadFailed.svelte';
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import type { Alert, AlertEvent, AlertKind, AlertMute, AlertRule, Channel } from '@burrow/shared';
  import { ALERT_EVENTS, alertTitle, HOST_EVENTS, isHostSubject, subjectLabel } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import Icon from '../components/Icon.svelte';
  import SectionTabs from '../components/SectionTabs.svelte';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { loadAlertCount } from '../lib/alerts.svelte.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { dateTime, locale, relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { go, to } from '../lib/router.svelte.js';
  import { attempt, toast, inBackground, undoCheck } from '../lib/ui.svelte.js';
  import { FormSave } from '../lib/formsave.svelte.js';

  // What went wrong in which container, newest first; the rules that decide
  // it; containers that are muted; whether any channel sends alerts.

  if (!data.loaded) inBackground(loadAll());
  // The form's Save: once at a time, and its end for the form it was pressed in (AUDIT2 PAGE-11, PAGE-12).
  const saving = new FormSave();
  // The form as opened: changed, closing it asks first (AUDIT2 PAGE-09).
  let formBase = '';
  let list = $state<Alert[]>([]);
  let rules = $state<AlertRule[]>([]);
  let mutes = $state<AlertMute[]>([]);
  let channels = $state<Channel[] | null>(null);
  let loaded = $state(false);
  let watching = $state<number[] | null>(null);
  get<{ hostIds: number[] }>('/api/alerts/status').then(
    (s) => (watching = s.hostIds),
    () => {},
  );

  async function load() {
    try {
      [list, rules, mutes, channels] = await Promise.all([
        get<Alert[]>('/api/alerts'),
        get<AlertRule[]>('/api/alerts/rules'),
        get<AlertMute[]>('/api/alerts/mutes'),
        // Channels are the admin's (the hint about push is theirs too).
        session.state?.user?.role === 'admin' ? get<Channel[]>('/api/channels') : Promise.resolve([]),
      ]);
      loaded = true;
      loadError = '';
      if (list.some((a) => !a.read)) {
        await post('/api/alerts/read');
        inBackground(loadAlertCount());
      }
    } catch (err) {
      loadError = errorMessage(err);
    }
  }
  // Said on the page, not an empty list (audit WP-07).
  let loadError = $state('');
  // Pulled down on a phone: read again.
  $effect(() => pullToRefresh(() => load()));

  void load();

  // The built-in rules' names in the reader's language.
  const builtinIds = $derived(new Set(rules.filter((r) => r.builtin).map((r) => r.id)));
  const ruleName = (id: number | null, name: string) =>
    id !== null && builtinIds.has(id) ? (name === 'Host health' ? t('alerts.builtinHost') : t('alerts.builtin')) : name;

  // A host's own trouble (disk, temperature) is on its statistics page; a container's in its logs.
  const logsLink = (a: Alert, analyze = false) =>
    isHostSubject(a.container) ? `/hosts/${a.hostId}/stats` : to('/logs', { t: `${a.hostId}:${a.container}`, at: a.at, ...(analyze ? { analyze: '1' } : {}) });

  // ---- delete

  async function remove(a: Alert) {
    try {
      await del(`/api/alerts/${a.id}`);
      list = list.filter((x) => x.id !== a.id);
      inBackground(loadAlertCount());
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function clearAll() {
    // All of them, also those beyond the latest 200 shown (AUDIT2 PAGE-24).
    const total = await get<{ total: number }>('/api/alerts/unread').then((x) => x.total, () => list.length);
    if (!(await ask({ text: t('alerts.clearConfirm', { n: total }), confirm: t('alerts.clearAll'), danger: true }))) return;
    try {
      await del('/api/alerts');
      list = [];
      inBackground(loadAlertCount());
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ---- mute

  // The alert or rule whose menu is open; a tap in it closes it first, then acts.
  let menuFor = $state<{ alert?: Alert; rule?: AlertRule } | null>(null);
  const fromMenu = (fn: (x: { alert?: Alert; rule?: AlertRule }) => unknown) => () => {
    const x = menuFor!;
    menuFor = null;
    void fn(x);
  };
  let muteFor = $state<Alert | null>(null);
  async function mute(minutes: number | null) {
    const a = muteFor!;
    muteFor = null;
    try {
      await post('/api/alerts/mutes', { hostId: a.hostId, container: a.container, minutes });
      toast(t('alerts.muted', { name: a.container }));
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  async function unmute(m: AlertMute) {
    if (await attempt(() => del(`/api/alerts/mutes/${m.hostId}/${encodeURIComponent(m.container)}`))) await load();
  }

  // ---- rules

  let editing = $state<AlertRule | null>(null);
  let formOpen = $state(false);
  // The form's kinds: a Docker event and a problem of the host itself are
  // both stored as 'event' rules, told apart by their events.
  type FormKind = AlertKind | 'host';
  const DOCKER_EVENTS = ALERT_EVENTS.filter((e) => !HOST_EVENTS.includes(e));
  const isHostRule = (r: AlertRule) => r.kind === 'event' && r.events.length > 0 && r.events.every((e) => HOST_EVENTS.includes(e));
  // An older rule with both kinds of event shows them all.
  let mixed = $state(false);
  let f = $state({
    name: '',
    kind: 'pattern' as FormKind,
    hostId: null as number | null,
    container: '',
    project: '',
    events: [...DOCKER_EVENTS] as AlertEvent[],
    pattern: '',
    threshold: 10,
    windowMinutes: 5,
    enabled: true,
  });
  const shownEvents = $derived(f.kind === 'host' ? HOST_EVENTS : mixed ? ALERT_EVENTS : DOCKER_EVENTS);

  function openForm(r: AlertRule | null) {
    editing = r;
    f = {
      name: r?.name ?? '',
      kind: r && isHostRule(r) ? 'host' : (r?.kind ?? 'pattern'),
      hostId: r?.hostId ?? null,
      container: r?.container ?? '',
      project: r?.project ?? '',
      events: r?.events.length ? [...r.events] : [...DOCKER_EVENTS],
      pattern: r?.pattern ?? '',
      threshold: r?.threshold ?? 10,
      windowMinutes: r?.windowMinutes ?? 5,
      enabled: r?.enabled ?? true,
    };
    mixed = !!r && r.kind === 'event' && !isHostRule(r) && r.events.some((e) => HOST_EVENTS.includes(e));
    saving.opened();
    formBase = JSON.stringify(f);
    formOpen = true;
  }
  // Switching between Docker and host: the other kind's events go.
  function setKind(k: FormKind) {
    const was = f.kind;
    f.kind = k;
    if (k === 'host' && was !== 'host') {
      f.events = [...HOST_EVENTS];
      f.container = '';
      f.project = '';
      mixed = false;
    }
    if (k === 'event' && was === 'host') f.events = [...DOCKER_EVENTS];
  }

  async function saveRule(e: SubmitEvent) {
    e.preventDefault();
    const body = { ...f, kind: f.kind === 'host' ? ('event' as const) : f.kind, events: f.events.filter((e) => shownEvents.includes(e)), container: f.container.trim() || null, project: f.project.trim() || null };
    const rule = editing;
    const done = await saving.run(() => (rule ? put(`/api/alerts/rules/${rule.id}`, body) : post('/api/alerts/rules', body)));
    if (done === 'saved') formOpen = false;
    if (done) await load();
  }

  async function toggle(r: AlertRule, box: HTMLInputElement) {
    const on = box.checked;
    if (await attempt(() => put(`/api/alerts/rules/${r.id}`, { ...r, enabled: on }))) await load();
    else undoCheck(box, on);
  }

  async function removeRule(r: AlertRule) {
    if (!(await ask({ text: t('common.confirmDelete', { name: r.name }), confirm: t('common.delete'), danger: true }))) return;
    if (await attempt(() => del(`/api/alerts/rules/${r.id}`))) await load();
  }

  const scope = (r: { hostId: number | null; container: string | null; project: string | null }) =>
    [r.hostId ? (data.hosts.find((h) => h.id === r.hostId)?.name ?? '?') : t('alerts.allHosts'), r.project ? t('alerts.stackX', { name: r.project }) : null, r.container]
      .filter(Boolean)
      .join(' | ');

  const what = (r: AlertRule) =>
    r.kind === 'event'
      ? r.events.map((e) => t(`alerts.event.${e}`)).join(', ')
      : r.kind === 'pattern'
        ? t('alerts.patternIs', { p: r.pattern ?? '' })
        : t('alerts.rateIs', { n: r.threshold ?? 0, m: r.windowMinutes ?? 0 });
  const admin = $derived(session.state?.user?.role === 'admin');
</script>

<div class="page">
  <header class="topbar">
    <h1>{t('alerts.title')} <HelpTip text={t('help.alerts')} /></h1>
  </header>
  <SectionTabs current="alerts" />

  {#if admin && channels && !channels.some((c) => c.enabled && c.topics.includes('alerts'))}
    <!-- Content, not a bar: on a new Burrow the first thing to do here. -->
    <p class="alert small" data-testid="push-off" data-content>
      {t('alerts.pushOff')} <button class="link" onclick={() => go(to('/settings', { s: 'channels' }))} data-testid="set-up-push">{t('alerts.setUpPush')}</button>
    </p>
  {/if}

  <!-- A computer: the alerts on the left, the rules and mutes beside them. -->
  <div class="alcols spread">
  <div class="almain">
  {#if loadError && !loaded}<LoadFailed message={loadError} onretry={load} />
  {:else if loadError}<p class="alert error small">{loadError}</p>{/if}
  {#if loaded && !list.length}<p class="empty">{t('alerts.none')}</p>{/if}
  {#if list.length}
    <div class="toolbar listhead">
      <span class="dim small">{t('alerts.shown', { n: list.length })}</span>
      <span class="spacer"></span>
      {#if admin}<button class="btn small danger" onclick={clearAll} data-testid="alerts-clear">{t('alerts.clearAll')}</button>{/if}
    </div>
  {/if}
  <div class="list" class:hidden={!list.length} data-testid="alerts">
    {#each list as a (a.id)}
      <div class="list-item arow" class:unread={!a.read} data-testid="alert">
        <button class="main plain" onclick={() => go(logsLink(a))} data-testid="alert-open">
          <!-- The name may be cut short; its pills stay whole beside it. -->
          <span class="title trow"><Icon name="alert" size={16} /><span class="tname">{subjectLabel(a.container, locale())}</span><span class="host">{a.hostName}</span>{#if !a.read}<span class="new" data-testid="alert-new">{t('alerts.new')}</span>{/if}</span>
          <span class="sub">{alertTitle(a.title, locale())}{a.count > 1 ? ` | ${a.count}x` : ''} | {relativeTime(a.at)} | {ruleName(a.ruleId, a.ruleName)}{a.pushed === 'muted' ? ` | ${t('alerts.mutedShort')}` : a.pushed === 'failed' ? ` | ${t('alerts.pushFailed')}` : ''}</span>
        </button>
        <!-- Analyse, mute and delete in the row's menu: on a phone they took a line of their own under it (reports 232696, e6fc13). -->
        {#if admin || !isHostSubject(a.container)}<button class="icon-btn" aria-label={t('common.menuFor', { name: subjectLabel(a.container, locale()) })} title={t('common.menuFor', { name: subjectLabel(a.container, locale()) })} onclick={() => (menuFor = { alert: a })} data-testid="alert-menu"><Icon name="more" size={20} /></button>{/if}
        <!-- The last lines under the whole row: room to read them on a phone. -->
        {#if a.detail}<button class="detail mono" onclick={() => go(logsLink(a))} data-testid="alert-detail">{a.detail}</button>{/if}
      </div>
    {/each}
  </div>
  <!-- Under the alerts, not above them: on a small phone the lines above took a quarter of the screen. -->
  {#if watching}
    <p class="dim small" data-testid="watching">
      {watching.length ? t('alerts.watching', { hosts: watching.map((id) => data.hosts.find((h) => h.id === id)?.name ?? id).join(', ') }) : t('alerts.watchingNone')}
    </p>
  {/if}
  </div>

  <div class="alside">
  <section class="stack">
    <div class="toolbar">
      <h2>{t('alerts.rules')}</h2>
      <span class="spacer"></span>
      <button class="btn small" class:hidden={!admin} onclick={() => openForm(null)} data-testid="new-rule"><Icon name="plus" size={16} /> {t('alerts.newRule')}</button>
    </div>
    <div class="list">
      {#each rules as r (r.id)}
        <div class="list-item" data-testid="rule">
          <input type="checkbox" checked={r.enabled} disabled={!admin} aria-label={t('alerts.ruleOn', { name: r.name })} onchange={(e) => toggle(r, e.currentTarget)} />
          <span class="main">
            <span class="title">{ruleName(r.id, r.name)}</span>
            <span class="sub whole">{what(r)} | {scope(r)}</span>
            <!-- A host with more containers than Burrow follows for log rules: this rule sees only some (OPS-W-09). -->
            {#each r.partial ?? [] as p (p.hostId)}<span class="sub partial">{t('alerts.partial', { following: p.following, total: p.total, host: p.hostName })}</span>{/each}
          </span>
          {#if !r.builtin && admin}<button class="icon-btn" aria-label={t('common.menuFor', { name: ruleName(r.id, r.name) })} title={t('common.menuFor', { name: ruleName(r.id, r.name) })} onclick={() => (menuFor = { rule: r })} data-testid="rule-menu"><Icon name="more" size={20} /></button>{/if}
        </div>
      {/each}
    </div>
  </section>

  {#if mutes.length}
    <section class="stack">
      <h2>{t('alerts.mutes')}</h2>
      <div class="list">
        {#each mutes as m (`${m.hostId}:${m.container}`)}
          <div class="list-item">
            <span class="main">
              <span class="title">{subjectLabel(m.container, locale())}</span>
              <span class="sub">{data.hosts.find((h) => h.id === m.hostId)?.name ?? ''} | {m.until ? t('alerts.until', { at: dateTime(m.until) }) : t('alerts.forever')}</span>
            </span>
            {#if admin}<button class="btn small" onclick={() => unmute(m)}>{t('alerts.unmute')}</button>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
  </div>
  </div>
</div>

<Dialog tour="alert-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.alert ? subjectLabel(menuFor.alert.container, locale()) : menuFor?.rule ? ruleName(menuFor.rule.id, menuFor.rule.name) : ''}>
  {#if menuFor?.alert}
    {@const a = menuFor.alert}
    {#if !isHostSubject(a.container)}<button class="btn" onclick={fromMenu((x) => go(logsLink(x.alert!, true)))} data-testid="alert-analyze">{t('alerts.analyze')}</button>{/if}
    {#if admin}
      <!-- A host's own health (its temperature, a disk): not "this container" (W-FUNC-12). -->
      <button class="btn" onclick={fromMenu((x) => (muteFor = x.alert!))} data-testid="alert-mute">{isHostSubject(a.container) ? t('alerts.muteHost') : t('alerts.mute')}</button>
      <button class="btn danger" onclick={fromMenu((x) => remove(x.alert!))} data-testid="alert-delete">{t('alerts.delete')}</button>
    {/if}
  {:else if menuFor?.rule}
    <button class="btn" onclick={fromMenu((x) => openForm(x.rule!))} data-testid="rule-edit">{t('common.edit')}</button>
    <button class="btn danger" onclick={fromMenu((x) => removeRule(x.rule!))} data-testid="rule-remove">{t('common.delete')}</button>
  {/if}
</Dialog>

<Dialog tour="alert-mute" menu open={muteFor !== null} title={t('alerts.muteTitle', { name: muteFor ? subjectLabel(muteFor.container, locale()) : '' })} onclose={() => (muteFor = null)}>
  <div class="stack">
    {#each [[60, t('alerts.for1h')], [480, t('alerts.for8h')], [1440, t('alerts.for24h')], [null, t('alerts.forever')]] as const as [m, label] (label)}
      <button class="btn" onclick={() => mute(m)}>{label}</button>
    {/each}
  </div>
</Dialog>

<Dialog tour="alert-rule" bind:open={formOpen} title={editing ? t('alerts.editRule') : t('alerts.newRule')} dirty={() => JSON.stringify(f) !== formBase}>
  <form id="rule-form" class="stack" onsubmit={saveRule}>
    <label class="field"><span>{t('alerts.ruleName')}</span><input bind:value={f.name} required maxlength="80" data-testid="rule-name" /></label>
    <label class="field">
      <span>{t('alerts.kind')}</span>
      <select value={f.kind} onchange={(e) => setKind(e.currentTarget.value as FormKind)} data-testid="rule-kind">
        <option value="pattern">{t('alerts.kind.pattern')}</option>
        <option value="rate">{t('alerts.kind.rate')}</option>
        <option value="event">{t('alerts.kind.event')}</option>
        <option value="host">{t('alerts.kind.host')}</option>
      </select>
    </label>
    {#if f.kind === 'pattern'}
      <label class="field"><span>{t('alerts.pattern')}</span><input bind:value={f.pattern} required class="mono" autocapitalize="none" spellcheck="false" data-testid="rule-pattern" /></label>
    {:else if f.kind === 'rate'}
      <div class="grid2">
        <label class="field"><span>{t('alerts.threshold')}</span><input type="number" min="1" bind:value={f.threshold} required /></label>
        <label class="field"><span>{t('alerts.window')}</span><input type="number" min="1" bind:value={f.windowMinutes} required /></label>
      </div>
    {:else}
      {#each shownEvents as ev (ev)}
        <label class="check"><input type="checkbox" bind:group={f.events} value={ev} data-testid="rule-event" /> {t(`alerts.event.${ev}`)}</label>
      {/each}
    {/if}
    <label class="field">
      <span>{t('alerts.host')}</span>
      <select bind:value={f.hostId} data-testid="rule-host">
        <option value={null}>{t('alerts.allHosts')}</option>
        <!-- A host's own problems concern every host; the rest needs Docker. -->
        {#each data.hosts.filter((h) => f.kind === 'host' || h.facts?.hasDocker) as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
      </select>
    </label>
    {#if f.kind !== 'host'}
      <div class="grid2">
        <label class="field"><span>{t('alerts.stack')}</span><input bind:value={f.project} placeholder={t('common.optional')} autocapitalize="none" /></label>
        <label class="field"><span>{t('alerts.container')}</span><input bind:value={f.container} placeholder={t('common.optional')} autocapitalize="none" data-testid="rule-container" /></label>
      </div>
    {/if}
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (formOpen = false)}>{t('common.cancel')}</button>
    <button class="btn primary" form="rule-form" disabled={saving.busy} data-testid="rule-save">{t('common.save')}</button>
  {/snippet}
</Dialog>

<style>
  .alcols,
  .almain,
  .alside {
    display: contents;
  }
  @media (min-width: 900px) {
    .alcols {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
      gap: 20px;
      align-items: start;
    }
    .almain,
    .alside {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .alside section {
      margin-top: 0;
    }
  }
  section {
    margin-top: 20px;
  }
  .hidden {
    display: none;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .arow {
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* The menu beside the words, the last lines under both. */
  .arow .main {
    flex: 1 1 0;
    min-width: 0;
  }
  .listhead {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
  }
  /* New since the last visit: marked as new, not red (red means an error). */
  .arow.unread {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .new {
    margin-left: 6px;
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 0 6px;
  }
  .plain {
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .title :global(svg) {
    vertical-align: -2px;
  }
  .trow {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .trow :global(svg) {
    flex: none;
  }
  .tname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trow .host,
  .trow .new {
    flex: none;
    margin-left: 0;
  }
  .host {
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0 6px;
  }
  .partial {
    color: var(--warn);
  }
  .detail {
    flex-basis: 100%;
    /* The room around the lines as a border, not padding: cut off after three, the padding showed half of a fourth. */
    border: solid transparent;
    border-width: 6px 8px;
    background: var(--bg-sunken);
    border-radius: 6px;
    padding: 0;
    text-align: left;
    cursor: pointer;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    font-size: 0.75rem;
    color: var(--text-dim);
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin-top: 2px;
  }
</style>
