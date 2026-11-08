<script lang="ts">
  import type { ScheduleKind } from '@burrow/shared';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { dayNames, zonesWith } from '../lib/schedule.js';

  // When it runs: weekly, daily or cron, at a time, in a time zone. The
  // reports' schedule and a scheduled command's alike (one form part).
  let {
    kind = $bindable(),
    day = $bindable(),
    time = $bindable(),
    cron = $bindable(),
    timeZone = $bindable(),
    nextRunAt = null,
    cronExample = '0 8 * * 1',
  }: { kind: ScheduleKind; day: number; time: string; cron: string; timeZone: string; nextRunAt?: string | null; cronExample?: string } = $props();
</script>

<label class="field">
  <span>{t('reports.when')}</span>
  <select bind:value={kind} data-testid="schedule-kind">
    <option value="weekly">{t('reports.kind.weekly')}</option>
    <option value="daily">{t('reports.kind.daily')}</option>
    <option value="cron">{t('reports.kind.cron')}</option>
  </select>
</label>
{#if kind === 'cron'}
  <label class="field"><span>{t('reports.cron')}</span><input bind:value={cron} required class="mono" placeholder={cronExample} data-testid="schedule-cron" /></label>
{:else}
  <!-- The day and the time side by side; the time alone (daily) as wide as the other fields, not half (report 1c454c). -->
  <div class:grid2={kind === 'weekly'} class:stack={kind !== 'weekly'}>
    {#if kind === 'weekly'}
      <label class="field">
        <span>{t('reports.day')}</span>
        <select bind:value={day} data-testid="schedule-day">
          {#each dayNames() as d, i (i)}<option value={i}>{d}</option>{/each}
        </select>
      </label>
    {/if}
    <label class="field"><span>{t('reports.time')}</span><input type="time" bind:value={time} required data-testid="schedule-time" /></label>
  </div>
{/if}
<label class="field">
  <span>{t('updates.timeZone')}</span>
  <select bind:value={timeZone}>
    {#each zonesWith(timeZone) as z (z)}<option value={z}>{z}</option>{/each}
  </select>
</label>
{#if nextRunAt}<p class="dim small">{t('reports.nextFull', { at: dateTime(nextRunAt) })}</p>{/if}
