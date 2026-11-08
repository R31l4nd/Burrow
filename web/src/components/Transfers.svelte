<script lang="ts">
  import Icon from './Icon.svelte';
  import { activity } from '../lib/activity.svelte.js';
  import { nativeDownloads, percentOf, retryDownload, stopDownload } from '../lib/downloads.svelte.js';
  import { cancelUpload, clearFinished, formatBytes, transfers } from '../lib/files.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import CheckProgress from './CheckProgress.svelte';
  import ReportProgress from './ReportProgress.svelte';

  // Everything that is busy, in one place: uploads and copies (from this
  // device), stack operations and an image update check (on the server). A
  // small pill shows while something runs; tap it for the list.
  const active = $derived(transfers.items.filter((x) => x.status === 'running' || x.status === 'queued' || x.status === 'paused'));
  const failed = $derived(transfers.items.filter((x) => x.status === 'failed'));
  const reportBusy = $derived(activity.report !== null && activity.report.phase !== 'done' && activity.report.phase !== 'failed');
  // The Android app's own downloads: running ones, and failed ones until
  // retried or dismissed (done ones said so in their notification).
  const downloads = $derived(nativeDownloads.items.filter((d) => d.state === 'running' || d.state === 'failed'));
  const downloading = $derived(downloads.filter((d) => d.state === 'running').length);
  const failedCount = $derived(failed.length + downloads.length - downloading);
  const busy = $derived(active.length + activity.ops.length + (activity.check ? 1 : 0) + (reportBusy ? 1 : 0) + downloading);
  // A report just made stays a little (its link to open it), as long as
  // the rest that is done; the server keeps it longer (for the page that waits on it).
  let reportSeen = $state<string | null>(null);
  const reportShown = $derived(activity.report !== null && activity.report.startedAt !== reportSeen);
  const shown = $derived(transfers.items.length > 0 || activity.ops.length > 0 || activity.check !== null || reportShown || downloads.length > 0);
  const left = (s: number | null) => (s === null ? '' : s < 60 ? t('transfers.secondsLeft', { n: s }) : t('transfers.minutesLeft', { n: Math.ceil(s / 60) }));
  const pct = (x: { bytes: number; total: number | null }) => (x.total ? Math.min(100, Math.round((x.bytes / x.total) * 100)) : null);

  // All done without errors: say so briefly, then get out of the way. A
  // failure stays until it is seen (and cleared).
  // A copy that could not be checked stays too, as a failure does.
  const unchecked = $derived(transfers.items.filter((x) => x.status === 'done' && x.unverified));
  const label = $derived(busy ? t('transfers.running', { n: busy }) : failedCount ? t('transfers.failed', { n: failedCount }) : unchecked.length ? t('transfers.unchecked', { n: unchecked.length }) : t('transfers.done'));
  $effect(() => {
    if ((!transfers.items.length && !reportShown) || active.length || failed.length || unchecked.length || activity.ops.length || activity.check || reportBusy || downloads.length) return;
    const timer = setTimeout(() => {
      clearFinished();
      reportSeen = activity.report?.startedAt ?? null;
      transfers.open = false;
    }, 4000);
    return () => clearTimeout(timer);
  });
</script>

{#if shown}
  {#if !transfers.open}
    <button class="busy" class:bad={failedCount > 0 && !busy} class:warn={!busy && !failedCount && unchecked.length > 0} aria-label={label} title={label} onclick={() => (transfers.open = true)} data-testid="transfers-pill">
      {#if busy}<span class="spin" aria-hidden="true"></span>{:else}<span class="picon" aria-hidden="true"><Icon name={failedCount || unchecked.length ? 'alert' : 'check'} size={16} /></span>{/if}
      <span class="plabel">{label}</span>
    </button>
  {:else}
    <section class="drawer" aria-label={t('activity.title')} data-testid="transfers">
      <header class="row">
        <strong>{t('activity.title')}</strong>
        <span class="spacer"></span>
        {#if transfers.items.length}<button class="btn small" onclick={clearFinished}>{t('transfers.clear')}</button>{/if}
        <button class="icon-btn" aria-label={t('common.close')} onclick={() => (transfers.open = false)}><Icon name="close" size={18} /></button>
      </header>
      {#if activity.check}
        <div class="item"><CheckProgress /></div>
      {/if}
      {#if activity.report}
        <div class="item"><ReportProgress p={activity.report} onopen={() => (transfers.open = false)} /></div>
      {/if}
      {#each activity.ops as op (op.id)}
        <div class="item" data-testid="activity-op">
          <div class="row">
            <button
              class="label oplink"
              onclick={() => {
                transfers.open = false;
                go(`/stacks/${op.hostId}/${encodeURIComponent(op.project)}`);
              }}>{t('activity.opOn', { op: t(`ops.op.${op.op}`), project: op.project })}</button
            >
            <span class="spin" aria-hidden="true"></span>
          </div>
        </div>
      {/each}
      {#each downloads as d (d.id)}
        <div class="item" data-testid="native-download">
          <div class="row">
            <span class="label">{d.kind === 'update' ? t('transfers.appUpdate') : d.name}</span>
            <span class="dim small">{t(`transfers.status.${d.state === 'running' ? 'running' : 'failed'}`)}</span>
            {#if d.state === 'failed'}<button class="btn small" onclick={() => retryDownload(d.id)} data-testid="download-retry">{t('transfers.retry')}</button>{/if}
            <button class="icon-btn" aria-label={t('transfers.stopDownload', { name: d.name })} title={t('transfers.stopDownload', { name: d.name })} onclick={() => stopDownload(d.id)} data-testid="download-stop"><Icon name="close" size={16} /></button>
          </div>
          {#if d.state === 'running'}
            {#if percentOf(d) !== null}
              <progress max="100" value={percentOf(d)} aria-label={d.name}></progress>
            {:else}
              <progress aria-label={d.name}></progress>
            {/if}
            <span class="dim small">{formatBytes(d.done)}{d.total > 0 ? ` / ${formatBytes(d.total)}` : ''}{d.secondsLeft !== null ? `, ${left(d.secondsLeft)}` : ''}</span>
          {/if}
          {#if d.error}<span class="err small">{d.error}</span>{/if}
        </div>
      {/each}
      {#each transfers.items as x (x.id)}
        <div class="item">
          <div class="row">
            <span class="label">{x.label}</span>
            <span class="dim small" data-testid="transfer-status">{t(`transfers.status.${x.status}`)}</span>
            {#if x.kind === 'upload' && (x.status === 'queued' || x.status === 'running' || x.status === 'paused')}
              <button class="icon-btn" aria-label={t('transfers.stop', { name: x.label })} title={t('transfers.stop', { name: x.label })} onclick={() => cancelUpload(x.id)} data-testid="transfer-stop"><Icon name="close" size={16} /></button>
            {/if}
          </div>
          {#if x.status === 'running' || x.status === 'paused'}
            {#if pct(x) !== null}
              <progress max="100" value={pct(x)} aria-label={x.label}></progress>
            {:else}
              <progress aria-label={x.label}></progress>
            {/if}
            <span class="dim small">{x.checking ? t('transfers.checking') : `${formatBytes(x.bytes)}${x.total ? ` / ${formatBytes(x.total)}` : ''}`}</span>
          {/if}
          {#if x.status === 'done' && x.verified != null}<span class="dim small" data-testid="transfer-verified">{t('transfers.verified', { n: x.verified })}</span>{/if}
          {#if x.status === 'done' && x.skipped}<span class="dim small" data-testid="transfer-skipped">{t('transfers.skipped', { n: x.skipped })}</span>{/if}
          {#if x.status === 'done' && x.unverified}<span class="warn small" data-testid="transfer-unverified">{t(x.unverified === 'source' ? 'transfers.unverifiedSource' : 'transfers.unverifiedDestination')}</span>{/if}
          {#if x.error}<span class="err small">{x.error}</span>{/if}
        </div>
      {/each}
    </section>
  {/if}
{/if}

<style>
  .busy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .spin {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
  /* A stack's operation: opens its page, where the output is. */
  .oplink {
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
    font: inherit;
    cursor: pointer;
  }
  /* A phone: above the bottom bar on the left (the round add button is
     on the right), clear of the title bar and the tabs. */
  .busy {
    animation: fade-in var(--dur-2) var(--ease);
    position: fixed;
    left: 12px;
    /* Above a page's foot bar too (the clipboard's, the bulk actions: lib/footbar.ts). */
    bottom: max(calc(var(--nav-h) + env(safe-area-inset-bottom) + 12px), calc(var(--foot-bar-top, 0px) + 8px));
    z-index: 30;
    padding: 6px 12px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
    box-shadow: var(--shadow);
    font: 600 0.8rem var(--font);
    cursor: pointer;
  }
  .busy.bad {
    border-color: var(--danger);
    color: var(--danger);
  }
  .busy.warn {
    border-color: var(--warn);
    color: var(--warn);
  }
  .drawer {
    animation: rise-in var(--dur-2) var(--ease);
    position: fixed;
    left: calc(8px + var(--rail-w));
    right: 8px;
    /* From the pill at the foot: at the top it covered the title bar and its back button (UIA-06). */
    bottom: max(calc(var(--nav-h) + env(safe-area-inset-bottom) + 12px), calc(var(--foot-bar-top, 0px) + 8px));
    z-index: 30;
    max-height: 60dvh;
    overflow: auto;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  @media (min-width: 640px) {
    .drawer {
      left: auto;
      width: 420px;
    }
  }
  /* A tablet: from its pill at the foot, as on a computer (at the top it lay over the title bar,
     the tour's tablet pass). */
  @media (min-width: 640px) and (max-width: 719px) {
    .drawer {
      left: 12px;
      right: auto;
    }
  }
  /* A computer: at the foot of the rail, out of the pages' bars and tabs
     (it sat on the tab row), and the list opens from there. */
  .busy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .picon {
    display: none;
  }
  /* A phone: room at the end of the page, so the pill does not cover the last lines. */
  @media (max-width: 719px) {
    :global(body:has([data-testid='transfers-pill']) .page:not(.with-fab)) {
      padding-bottom: calc(var(--nav-h) + 72px + env(safe-area-inset-bottom));
    }
  }
  @media (min-width: 720px) {
    .busy {
      bottom: 16px;
      max-width: calc(var(--rail-w) - 24px);
    }
    /* The narrow rail beside a terminal or editor: a round mark that says
       which, the words in its label (they broke over the rail's edge). */
    :global(body:has(.bottomnav.compact)) .busy {
      left: 8px;
      width: 40px;
      height: 40px;
      justify-content: center;
      padding: 0;
    }
    :global(body:has(.bottomnav.compact)) .busy .plabel {
      display: none;
    }
    :global(body:has(.bottomnav.compact)) .busy .picon {
      display: inline-flex;
    }
    .drawer {
      top: auto;
      right: auto;
      left: calc(var(--rail-w) + 8px);
      bottom: max(16px, calc(var(--foot-bar-top, 0px) + 8px));
    }
  }
  /* Room under the head: on a phone its button stood on the first item's line (report dfda31). */
  .drawer header {
    padding-bottom: 8px;
  }
  .drawer header .btn,
  .item .btn {
    flex: none;
    width: auto;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  progress {
    width: 100%;
    accent-color: var(--accent);
  }
  .err {
    color: var(--danger);
  }
  .warn {
    color: var(--warn);
  }
</style>
