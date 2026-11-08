<script lang="ts">
  import { packageSummary, type PackageManager, type PackageReport } from '@burrow/shared';
  import HelpTip from './HelpTip.svelte';
  import Icon from './Icon.svelte';
  import LoadFailed from './LoadFailed.svelte';
  import { errorMessage, get, post } from '../lib/api.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { updatesLine } from '../lib/packages.js';
  import { copyText, toast } from '../lib/ui.svelte.js';

  // A host's package updates on its statistics page: what its package
  // manager says can be updated, security updates first, how old its lists
  // are and whether it asks for a restart. Read only: updating stays the
  // person's, in a terminal (the command to copy is shown).
  let { hostId, admin }: { hostId: number; admin: boolean } = $props();

  let report = $state<PackageReport | null>(null);
  let loaded = $state(false);
  let loadError = $state('');
  let checking = $state(false);
  let all = $state(false);

  function read() {
    loadError = '';
    get<PackageReport | null>(`/api/hosts/${hostId}/packages`).then(
      (r) => ((report = r), (loaded = true)),
      (err: unknown) => (loadError = errorMessage(err)),
    );
  }
  read();

  async function check() {
    checking = true;
    try {
      report = await post<PackageReport>(`/api/hosts/${hostId}/packages`);
      loaded = true;
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      checking = false;
    }
  }

  // Old lists fetched again at a press (sudo on the host, report 1f6c0c), and the timer that has the
  // host do it itself each day, to copy.
  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    try {
      report = await post<PackageReport>(`/api/hosts/${hostId}/packages/refresh`);
      toast(t('packages.refreshed'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      refreshing = false;
    }
  }
  const TIMER: Partial<Record<PackageManager, string>> = { apt: 'sudo systemctl enable --now apt-daily.timer', dnf: 'sudo systemctl enable --now dnf-makecache.timer' };
  const REFRESHES: PackageManager[] = ['apt', 'dnf', 'apk'];

  // The command that updates, to copy into a terminal: never run from here.
  const UPGRADE: Record<PackageManager, string> = { apt: 'sudo apt update && sudo apt upgrade', dnf: 'sudo dnf upgrade', apk: 'sudo apk upgrade', pacman: 'sudo pacman -Syu' };
  // Lists not fetched for a week: what they say may be out of date.
  const stale = (at: string | null) => !!at && Date.now() - Date.parse(at) > 7 * 86_400_000;
  const SHOWN = 12;
  const shown = $derived(report ? (all ? report.updates : report.updates.slice(0, SHOWN)) : []);
</script>

<section class="card stack" aria-label={t('packages.title')} data-testid="packages">
  <div class="toolbar">
    <h2>{t('packages.title')} <HelpTip text={t('help.packages')} /></h2>
    <span class="spacer"></span>
    {#if admin}<button class="btn small" disabled={checking} onclick={check} data-testid="packages-check">{checking ? t('stats.checking') : t('stats.checkNow')}</button>{/if}
  </div>
  {#if loadError && !report}
    <LoadFailed inline message={t('packages.loadFailed', { error: loadError })} onretry={read} />
  {:else if !loaded}
    <p class="dim small">{t('common.loading')}</p>
  {:else if !report}
    <p class="dim small" data-testid="packages-state">{t('packages.never')}</p>
  {:else if report.state === 'none'}
    <p class="small" data-testid="packages-state">{t('packages.none')}</p>
  {:else if report.state === 'error'}
    <!-- Not read is not "up to date" (failed is not empty). -->
    <p class="alert error small" data-testid="packages-state">{t('packages.failed', { error: report.message ?? '' })}</p>
    <p class="dim small">{t('stats.checked', { at: dateTime(report.checkedAt) })}</p>
  {:else}
    <div class="dline">
      <span data-testid="packages-state">{report.updates.length || report.reboot ? updatesLine(packageSummary(report)) : t('packages.upToDate')}</span>
      {#if report.security}<span class="pill bad">{t('packages.security', { n: report.security })}</span>{:else if report.reboot}<span class="pill warn">{t('packages.reboot')}</span>{/if}
    </div>
    {#if report.updates.length}
      <ul class="pkgs small" data-testid="packages-list">
        {#each shown as u (u.name)}
          <li>
            <span class="mono pname">{u.name}</span>
            <span class="dim mono ver">{u.from ? `${u.from} -> ${u.to}` : u.to}</span>
            {#if u.security}<span class="pill bad">{t('packages.securityOne')}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if report.updates.length > SHOWN}
        <button class="btn small" onclick={() => (all = !all)} data-testid="packages-all">{all ? t('packages.fewer') : t('packages.allN', { n: report.updates.length })}</button>
      {/if}
      {#if report.manager}
        <div class="linkrow">
          <code class="mono small">{UPGRADE[report.manager]}</code>
          <button class="btn small" onclick={async () => (await copyText(UPGRADE[report!.manager!])) && toast(t('common.copied'))} data-testid="packages-copy"><Icon name="copy" size={16} /> {t('common.copy')}</button>
        </div>
      {/if}
    {/if}
    <p class="dim small" class:warn-text={stale(report.listAt)} data-testid="packages-age">
      {report.listAt ? t(stale(report.listAt) ? 'packages.listsOld' : 'packages.lists', { at: dateTime(report.listAt) }) : t('packages.listsUnknown')}
      | {t('stats.checked', { at: dateTime(report.checkedAt) })}
    </p>
    {#if stale(report.listAt) && report.manager}
      {@const timer = TIMER[report.manager]}
      {#if timer}
        <p class="dim small">{t('packages.timerHow')}</p>
        <div class="linkrow">
          <code class="mono small" data-testid="packages-timer">{timer}</code>
          <button class="btn small" onclick={async () => (await copyText(timer)) && toast(t('common.copied'))}><Icon name="copy" size={16} /> {t('common.copy')}</button>
        </div>
      {/if}
      {#if admin && REFRESHES.includes(report.manager)}
        <button class="btn" disabled={refreshing} onclick={refresh} data-testid="packages-refresh">{refreshing ? t('packages.refreshing') : t('packages.refresh')}</button>
      {/if}
    {/if}
  {/if}
</section>

<style>
  /* As the statistics page's own cards (HostStats.svelte): the title row as high as one with a small button. */
  section {
    margin-bottom: 12px;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 36px;
  }
  .toolbar > h2 {
    min-height: 36px;
  }
  .spacer {
    flex: 1;
  }
  .dline {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pkgs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* A line between packages: a long version breaks onto a second line on a phone. */
  .pkgs li + li {
    border-top: 1px solid var(--border);
    padding-top: 4px;
  }
  .pkgs li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    overflow-wrap: anywhere;
  }
  .pname {
    font-weight: 600;
  }
  .ver {
    min-width: 0;
  }
  .pkgs .pill {
    margin-left: auto;
  }
  .linkrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .linkrow code {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .linkrow :global(.btn) {
    width: auto;
    flex: none;
  }
  .warn-text {
    color: var(--warn);
  }
</style>
