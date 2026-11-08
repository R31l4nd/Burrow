<script lang="ts">
  import { ask } from '../lib/confirm.svelte.js';
  import type { StackUpdate, UpdatesOverview } from '@burrow/shared';
  import { errorMessage, get, post, put } from '../lib/api.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';
  import { loadUpdates, updates } from '../lib/updates.svelte.js';
  import HelpTip from './HelpTip.svelte';
  import LoadFailed from './LoadFailed.svelte';

  // The maintenance window (daily, weekly or by cron): the update check, then the automatic
  // updates of the stacks that opted in (on the stack's page).

  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const known = (() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  })();

  let enabled = $state(true);
  let autoUpdate = $state(true);
  let autoLevel = $state<'major' | 'minor' | 'patch'>('major');
  let kind = $state<'daily' | 'weekly' | 'cron'>('daily');
  let day = $state(1);
  let cron = $state('');
  let start = $state('04:00');
  let hours = $state(1);
  let zone = $state(browserZone);
  // The list may lack UTC or the stored zone; the select must show it.
  const zones = $derived([...new Set([...known, browserZone, 'UTC', zone])].sort());
  let busy = $state(false);

  function fill(o: UpdatesOverview | null) {
    if (!o) return;
    enabled = o.settings.enabled;
    autoUpdate = o.settings.autoUpdate;
    autoLevel = o.settings.autoLevel ?? 'major';
    kind = o.settings.kind;
    day = o.settings.day;
    cron = o.settings.cron ?? '';
    start = o.settings.windowStart;
    hours = o.settings.windowHours;
    // As saved, UTC too: taking this browser's zone instead moved the window
    // on the next save of anything else (audit WC-09).
    zone = o.settings.timeZone;
  }
  // Not read: said with Try again; the form (each change saved at once) only over what was read (A3-WEB-01).
  let loadError = $state('');
  let read = $state(false);
  const loadSettings = () => {
    loadError = '';
    // Read here, not through loadUpdates (that one keeps quiet: a badge needs no error).
    get<UpdatesOverview>('/api/docker/updates').then(
      (o) => ((updates.overview = o), fill(o), (read = true)),
      (err: unknown) => (loadError = errorMessage(err)),
    );
  };
  loadSettings();

  // Each change is saved at once, as elsewhere in Settings for single
  // choices; a time that is not complete yet waits.
  async function save() {
    // Not read yet (or not at all): nothing saved over what is stored (AUDIT2 UI-21).
    if (!updates.overview) return;
    if (!/^\d{2}:\d{2}$/.test(start) || (kind === 'cron' && cron.trim().split(/\s+/).length !== 5)) return;
    busy = true;
    try {
      updates.overview = await put<UpdatesOverview>('/api/docker/updates/settings', { enabled, autoUpdate, autoLevel, kind, day, cron: kind === 'cron' ? cron.trim() : null, windowStart: start, windowHours: hours, timeZone: zone });
      toast(t('updates.saved'));
    } catch (err) {
      // Not saved: the choices back as saved (a switch stayed off as if it were, AUDIT2 UI-22).
      fill(updates.overview);
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  // Running (by its schedule, or started here before leaving the page): the
  // button says so, and the page follows until it is done.
  const windowRunning = $derived(updates.overview?.windowRunning === true);
  $effect(() => {
    if (!windowRunning) return;
    const timer = setInterval(() => inBackground(loadUpdates()), 5000);
    return () => clearInterval(timer);
  });

  async function runNow() {
    if (!(await ask({ text: t('updates.runConfirm'), confirm: t('updates.runNow') }))) return;
    busy = true;
    try {
      const r = await post<{ updates: StackUpdate[] }>('/api/docker/updates/run');
      toast(r.updates.length ? t('updates.ran', { n: r.updates.length }) : t('updates.ranNone'));
      await loadUpdates();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

{#if loadError && !read}
  <LoadFailed inline message={loadError} onretry={loadSettings} />
{:else}
<form class="card stack" onsubmit={(e) => e.preventDefault()} onchange={() => void save()}>
  <div class="row">
    <label class="check">
      <input type="checkbox" bind:checked={enabled} data-testid="updates-enabled" />
      {t('updates.enabled')}
    </label>
    <HelpTip text={t('help.updateWindow')} />
  </div>
  {#if enabled}
  <!-- Off: check and tell only (a message on the channels for "updates"). -->
  <div class="row">
    <label class="check">
      <input type="checkbox" bind:checked={autoUpdate} data-testid="updates-auto" />
      {t('updates.autoUpdate')}
    </label>
    <HelpTip text={t('help.updatesAuto')} />
  </div>
  {#if autoUpdate}
    <!-- How far by itself; a bigger step (or one Burrow cannot tell) waits for a person. -->
    <!-- for/id: the help tip's button comes first inside, and would take the caption (AUDIT2 UI-28). -->
    <label class="field" for="updates-level">
      <span>{t('updates.autoLevel')} <HelpTip text={t('help.updatesLevel')} /></span>
      <select id="updates-level" bind:value={autoLevel} data-testid="updates-level">
        <option value="major">{t('updates.level.major')}</option>
        <option value="minor">{t('updates.level.minor')}</option>
        <option value="patch">{t('updates.level.patch')}</option>
      </select>
    </label>
  {/if}
  <label class="field">
    <span>{t('updates.when')}</span>
    <select bind:value={kind} data-testid="window-kind">
      <option value="daily">{t('reports.kind.daily')}</option>
      <option value="weekly">{t('reports.kind.weekly')}</option>
      <option value="cron">{t('reports.kind.cron')}</option>
    </select>
  </label>
  {#if kind === 'cron'}
    <label class="field"><span>{t('reports.cron')}</span><input bind:value={cron} required class="mono" placeholder="0 4 * * 1-5" autocapitalize="none" spellcheck="false" data-testid="window-cron" /></label>
  {/if}
  {#if kind === 'weekly'}
    <label class="field">
      <span>{t('reports.day')}</span>
      <select bind:value={day} data-testid="window-day">
        {#each [0, 1, 2, 3, 4, 5, 6] as d (d)}<option value={d}>{new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(document.documentElement.lang || 'en', { weekday: 'long', timeZone: 'UTC' })}</option>{/each}
      </select>
    </label>
  {/if}
  <!-- Start and length side by side; the length alone (a cron window) the line's width, not half of
       it beside nothing (and the day its own line, not a third field alone under two). -->
  <div class:grid2={kind !== 'cron'} class:stack={kind === 'cron'}>
    {#if kind !== 'cron'}
      <label class="field">
        <span>{t('updates.windowStart')}</span>
        <input type="time" bind:value={start} required data-testid="window-start" />
      </label>
    {/if}
    <label class="field">
      <span>{t('updates.windowHours')}</span>
      <select bind:value={hours}>
        {#each [1, 2, 3, 4, 6, 8] as h (h)}<option value={h}>{t('updates.hours', { n: h })}</option>{/each}
      </select>
    </label>
  </div>
  <label class="field">
    <span>{t('updates.timeZone')}</span>
    <select bind:value={zone}>
      {#each zones as z (z)}<option value={z}>{z}</option>{/each}
    </select>
  </label>
  {#if updates.overview?.nextWindowAt && updates.overview.settings.enabled}
    <p class="dim small">{t('updates.next', { at: dateTime(updates.overview.nextWindowAt) })}</p>
  {/if}
  {:else}
    <p class="dim small">{t('updates.off')}</p>
  {/if}
  {#if enabled}
    <button type="button" class="btn" disabled={busy || windowRunning} onclick={runNow} data-testid="run-window">{busy || windowRunning ? t('updates.running') : t('updates.runNow')}</button>
  {/if}
</form>
{/if}
