<script lang="ts">
  import { roving } from '../lib/roving.js';
  import { issueUrl, projectPublished, type BugReportDetail, type BugReportSummary } from '@burrow/shared';
  import { del, errorMessage, get, put } from '../lib/api.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import Icon from './Icon.svelte';

  // The problem reports people sent from this Burrow, for its admins: read
  // one whole, download it, pass it on as a GitHub issue (read first, there,
  // before it is public), or delete it. Burrow itself sends nothing anywhere.

  // A build of the private tree has no public repository to report to: the
  // download is the way on, and it says so (W-FUNC-15).
  const published = projectPublished();

  let list = $state<BugReportSummary[] | null>(null);
  let open = $state<BugReportDetail | null>(null);
  let busy = $state(false);
  // The open ones first; the solved ones a tap away.
  let view = $state<'open' | 'closed'>('open');
  const openCount = $derived(list?.filter((r) => r.status === 'open').length ?? 0);
  const closedCount = $derived(list?.filter((r) => r.status === 'closed').length ?? 0);
  const shown = $derived(list?.filter((r) => r.status === view) ?? []);

  async function load() {
    try {
      list = await get<BugReportSummary[]>('/api/bugreports');
    } catch (err) {
      toast(errorMessage(err), 'error');
      list = [];
    }
  }
  void load();

  async function show(id: string) {
    try {
      open = await get<BugReportDetail>(`/api/bugreports/${id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove() {
    if (!open || !(await ask({ text: t('bug.confirmDelete'), confirm: t('common.delete'), danger: true }))) return;
    busy = true;
    try {
      await del(`/api/bugreports/${open.id}`);
      open = null;
      toast(t('bug.deleted'));
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  async function setStatus(status: 'open' | 'closed') {
    if (!open) return;
    busy = true;
    try {
      open = await put<BugReportDetail>(`/api/bugreports/${open.id}/status`, { status });
      toast(status === 'closed' ? t('bug.closedDone') : t('bug.reopenedDone'));
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  const role = (r: string) => (r === 'admin' || r === 'operator' ? t(`users.role.${r}`) : r);
  const firstLine = (s: string) => s.split('\n')[0] ?? '';
</script>

<h3>{t('bug.received')} <HelpTip text={t('bug.receivedHelp')} /></h3>
{#if list && !list.length}
  <p class="dim small" data-testid="problems-none">{t('bug.none')}</p>
{:else if list}
  <!-- A gap between Open/Solved and the list: 2 px apart they read as one (report 8a99b4). -->
  <div class="stack">
  <div class="segmented" role="radiogroup" aria-label={t('bug.received')} use:roving={'radio'}>
    <button role="radio" aria-checked={view === 'open'} class:on={view === 'open'} onclick={() => (view = 'open')} data-testid="problems-open">{t('bug.openN', { n: openCount })}</button>
    <button role="radio" aria-checked={view === 'closed'} class:on={view === 'closed'} onclick={() => (view = 'closed')} data-testid="problems-closed">{t('bug.closedN', { n: closedCount })}</button>
  </div>
  {#if !shown.length}
    <p class="dim small" data-testid="problems-empty">{view === 'open' ? t('bug.noneOpen') : t('bug.noneClosed')}</p>
  {/if}
  <div class="list" class:hidden={!shown.length} data-testid="problems">
    {#each shown as r (r.id)}
      <button class="list-item" onclick={() => show(r.id)} data-testid="problem-row">
        <span class="main">
          <span class="title">{firstLine(r.text)}</span>
          <span class="sub">{t('bug.from', { role: role(r.role), when: relativeTime(r.at), page: r.page })}{r.pictures ? ` | ${t('bug.pictures', { n: r.pictures })}` : ''}{r.closedAt ? ` | ${t('bug.solvedWhen', { when: relativeTime(r.closedAt) })}` : ''}</span>
        </span>
        <Icon name="chevron" size={16} />
      </button>
    {/each}
  </div>
  </div>
{/if}

<Dialog tour="problem-report" size="wide" open={open !== null} title={t('bug.reportTitle')} onclose={() => (open = null)}>
  {#if open}
    <div class="stack" data-testid="problem">
      <p class="text" data-testid="problem-text">{open.text}</p>
      <p class="dim small">{t('bug.from', { role: role(open.role), when: relativeTime(open.at), page: open.context.page })}</p>
      <p class="dim small">Burrow {open.serverVersion}{open.context.android ? `, Android app ${open.context.androidApp ?? ''}` : ''} | {open.context.viewport.width}x{open.context.viewport.height} | {open.context.userAgent}</p>
      {#if open.context.errors.length || open.context.failedCalls.length}
        <ul class="mono small issues">
          {#each open.context.errors as e, i (i)}<li>{e}</li>{/each}
          {#each open.context.failedCalls as f, i (i)}<li>{f.method} {f.path} -> {f.status} {f.code}{f.handled ? ` (${t('bug.handledCall')})` : ''}</li>{/each}
        </ul>
      {/if}
      {#each open.pictures as p (p)}
        <!-- Small here; the whole picture in a tab of its own. -->
        <a href={`/api/bugreports/${open.id}/pictures/${p}`} target="_blank" rel="noopener" class="piclink" data-testid="problem-picture"><img class="pic" src={`/api/bugreports/${open.id}/pictures/${p}`} alt={p} /></a>
      {/each}
      {#if open.recording}
        <p class="dim small">{t('bug.recording', { n: open.recording.entries, with: open.recording.withText ? t('bug.recordingText') : t('bug.recordingNoText') })}</p>
      {/if}
      {#if open.status === 'closed'}<p class="small solved" data-testid="problem-solved">{t('bug.solvedBy', { who: open.closedBy ?? '', when: relativeTime(open.closedAt) })}</p>{/if}
      <div class="btnrow stacks">
      {#if open.status === 'open'}
        <button class="btn" disabled={busy} onclick={() => setStatus('closed')} data-testid="problem-close"><Icon name="check" size={16} /> {t('bug.markSolved')}</button>
      {:else}
        <button class="btn" disabled={busy} onclick={() => setStatus('open')} data-testid="problem-reopen"><Icon name="reload" size={16} /> {t('bug.reopen')}</button>
      {/if}
      {#if published}<a class="btn" href={`/api/bugreports/${open.id}/archive`} download data-testid="problem-download"><Icon name="download" size={16} /> {t('bug.download')}</a>{/if}
      <button class="btn danger" disabled={busy} onclick={remove} data-testid="problem-delete"><Icon name="trash" size={16} /> {t('common.delete')}</button>
      </div>
      <!-- Said right above the button it is about. -->
      {#if published}<p class="dim small">{t('bug.githubNote')}</p>{:else}<p class="dim small" data-testid="problem-private">{t('bug.githubPrivate')}</p>{/if}
    </div>
  {/if}
  {#snippet actions()}
    {#if open && published}
      <a class="btn primary" href={issueUrl(open)} target="_blank" rel="noopener noreferrer" data-testid="problem-github"><Icon name="send" size={16} /> {t('bug.github')}</a>
    {:else if open}
      <a class="btn primary" href={`/api/bugreports/${open.id}/archive`} download data-testid="problem-download"><Icon name="download" size={16} /> {t('bug.download')}</a>
    {/if}
  {/snippet}
</Dialog>

<style>
  .hidden {
    display: none;
  }
  .solved {
    margin: 0;
    color: var(--ok);
    font-weight: 600;
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .issues {
    margin: 0;
    padding-left: 18px;
    overflow-wrap: anywhere;
  }
  .piclink {
    align-self: flex-start;
    max-width: 100%;
  }
  .pic {
    display: block;
    max-width: 100%;
    max-height: 240px;
    min-width: 48px;
    image-rendering: auto;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
</style>
