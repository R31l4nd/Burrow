<script lang="ts">
  import { ask } from '../lib/confirm.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { untrack } from 'svelte';
  import type { ContainerSample, OpInfo, TerminalSessionInfo } from '@burrow/shared';
  import OpOutput from '../components/OpOutput.svelte';
  import { readFirst, updateServices } from '../lib/stackupdate.js';
  import ChangelogDialog from '../components/ChangelogDialog.svelte';
  import Dialog from '../components/Dialog.svelte';
  import PageTitle from '../components/PageTitle.svelte';
  import LoadFailed from '../components/LoadFailed.svelte';
  import Icon from '../components/Icon.svelte';
  import { del, errorMessage, get, post } from '../lib/api.js';
  import { targetKey, type LogFile } from '@burrow/shared';
  import { loadSessions } from '../lib/sessions.svelte.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';
  import { checkOf, loadUpdates, updates } from '../lib/updates.svelte.js';
  import LogView from '../components/LogView.svelte';
  import HistoryChart from '../components/HistoryChart.svelte';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { DockerWatch, formatBytesShort, since } from '../lib/docker.svelte.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { healthLabel } from '../lib/containers.js';
  import { go, goFrom, here, to, up } from '../lib/router.svelte.js';

  // One container: what it is, how it runs (live CPU and memory), and its
  // logs below.
  let { hostId, name }: { hostId: number; name: string } = $props();

  if (!data.loaded) inBackground(loadAll());
  const watch = new DockerWatch();
  watch.watch([untrack(() => hostId)]);
  $effect(() => () => watch.close());

  const host = $derived(watch.hosts[hostId]);
  const c = $derived(host?.containers.find((x) => x.name === name));
  const st = $derived(c ? host?.stats[c.id] : undefined);
  const hostName = $derived(data.hosts.find((h) => h.id === hostId)?.name ?? '');
  let showInfo = $state(false);

  // Its CPU and memory kept on the server, a day, a week or a month back
  // (report 428102), shown with the details; a moment picked on a chart is
  // said in both.
  let range = $state<'day' | 'week' | 'month'>('day');
  let kept = $state<ContainerSample[] | null>(null);
  let picked = $state<number | null>(null);
  // Not read is said with Try again, not "no history yet" (as a host's statistics, A3-WEB-06).
  let historyError = $state('');
  let historyAsked = $state(0);
  $effect(() => {
    if (!showInfo) return;
    const r = range;
    void historyAsked;
    let current = true;
    get<ContainerSample[]>(`/api/docker/${hostId}/containers/${encodeURIComponent(name)}/history?range=${r}`).then(
      (x) => current && ((kept = x), (picked = null), (historyError = '')),
      (err: unknown) => current && ((kept = []), (historyError = errorMessage(err))),
    );
    return () => (current = false);
  });
  let busy = $state<string | null>(null);
  let inspectJson = $state<string | null>(null);
  // The container's actions and the log download, in one menu.
  let menuOpen = $state(false);
  let downloadLogs: (() => void) | null = null;
  let analyseLogs = $state<(() => void) | null>(null);
  const pick = (fn: () => unknown) => () => {
    menuOpen = false;
    void fn();
  };
  if (!updates.overview) inBackground(loadUpdates());
  const upd = $derived(c ? checkOf(hostId, c.image) : undefined);
  // The version it runs: the image's own label, else what the update check read (report eaa986).
  const version = $derived(c?.version ?? upd?.version ?? null);

  // A newer image, updated from here: this container's service of its
  // stack, after a yes (and the release notes, when they warn). Without a
  // stack it cannot be done here; an operator is led to the stack's page.
  let updateOp = $state<OpInfo | null>(null);
  // Its end as the output saw it: the update buttons free again, a failed one can be tried again here (AUDIT2 PAGE-06).
  let updateEnded = $state(false);
  const updating = $derived(updateOp !== null && updateOp.exitCode === null && !updateEnded);
  async function updateHere() {
    if (!c) return;
    if (!c.project || !c.service) return toast(t('updates.noStack'));
    if (!admin) return go(to(`/stacks/${hostId}/${encodeURIComponent(c.project)}`, { update: '1', service: c.service }));
    updateAsk = true;
  }
  // The yes, with what is new in between at hand (report ac3a68).
  let updateAsk = $state(false);
  let notesFor = $state<string | null>(null);
  async function updateNow() {
    updateAsk = false;
    if (!c?.project || !c.service) return;
    busy = 'update';
    try {
      if (!(await readFirst(hostId, [c.image], c.project))) return;
      const op = await updateServices(hostId, c.project, [c.service]);
      updateEnded = false;
      updateOp = op;
      toast(t('updates.started', { name }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }

  // Changes need a fresh confirmation (step-up); the API asks for it.
  async function act(action: 'start' | 'stop' | 'restart' | 'remove') {
    if (action === 'remove' && !(await ask({ text: t('containers.confirmRemove', { name }), confirm: t('containers.removeOne'), danger: true }))) return;
    busy = action;
    try {
      await post(`/api/docker/${hostId}/containers/${encodeURIComponent(name)}/action`, { action });
      toast(t(`containers.did.${action}`, { name }));
      if (action === 'remove') up('/containers');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }

  async function shell() {
    busy = 'shell';
    const from = here();
    try {
      const s = await post<TerminalSessionInfo>(`/api/docker/${hostId}/containers/${encodeURIComponent(name)}/shell`, {
        cols: Math.max(20, Math.min(300, Math.floor(window.innerWidth / 8.4))),
        rows: Math.max(8, Math.min(120, Math.floor((window.innerHeight - 160) / 17))),
      });
      await loadSessions();
      goFrom(from, `/term/${s.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }

  async function inspect() {
    busy = 'inspect';
    try {
      const r = await post<{ json: string }>(`/api/docker/${hostId}/containers/${encodeURIComponent(name)}/inspect`);
      // Docker's own JSON, laid out; anything else as it came (never a parser's error).
      try {
        inspectJson = JSON.stringify(JSON.parse(r.json), null, 2);
      } catch {
        inspectJson = r.json ?? '';
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }
  const admin = $derived(session.state?.user?.role === 'admin');

  // Its log files (kept on the server for the container): shown beside its
  // own output, one or more at once in one timeline.
  let files = $state<LogFile[]>([]);
  let shown = $state<string[]>(['']);
  // Not read: said with Try again, not as a container without log files (the ones kept would vanish from view).
  let filesError = $state('');
  async function loadFiles() {
    try {
      files = await get<LogFile[]>(`/api/docker/${hostId}/logfiles?container=${encodeURIComponent(name)}`);
      filesError = '';
      shown = shown.filter((p) => p === '' || files.some((f) => f.path === p));
      if (!shown.length) shown = [''];
    } catch (err) {
      filesError = errorMessage(err);
    }
  }
  inBackground(loadFiles());
  const toggleShown = (p: string) => {
    const next = shown.includes(p) ? shown.filter((x) => x !== p) : [...shown, p];
    // At least one source: the last one cannot be switched off.
    if (next.length) shown = next;
  };
  const fileName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
  const sources = $derived(
    shown.map((p) => (p === '' ? { hostId, container: name, label: name } : { hostId, container: name, file: p, label: fileName(p) })),
  );
  const sourcesKey = $derived(sources.map((s) => targetKey(s)).join(','));

  // Managing them: the ones kept, what the container's mounts and /var/log suggest, a path of its own.
  let filesOpen = $state(false);
  let suggestions = $state<string[] | null>(null);
  let suggestionsError = $state('');
  let newPath = $state('');
  async function openFiles() {
    filesOpen = true;
    if (filesError) inBackground(loadFiles());
    await readSuggestions();
  }
  async function readSuggestions() {
    suggestions = null;
    suggestionsError = '';
    try {
      suggestions = await get<string[]>(`/api/docker/${hostId}/containers/${encodeURIComponent(name)}/logfile-suggestions`);
    } catch (err) {
      suggestionsError = errorMessage(err);
    }
  }
  async function addFile(path: string) {
    try {
      await post(`/api/docker/${hostId}/logfiles`, { container: name, path });
      toast(t('logfiles.added', { name: fileName(path) }));
      newPath = '';
      suggestions = suggestions?.filter((x) => x !== path) ?? null;
      await loadFiles();
      if (!shown.includes(path)) shown = [...shown, path];
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  async function removeFile(f: LogFile) {
    try {
      await del(`/api/docker/${hostId}/logfiles/${f.id}`);
      await loadFiles();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

<!-- Details open: they and the log share the screen on purpose (data-split), the log keeps the rest (report 5d0b33). -->
<div class="detail" data-split={showInfo ? '' : undefined}>
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/containers')}><Icon name="back" /></button>
    <PageTitle title={name} sub={[hostName, c?.project ? t('containers.inStack', { name: c.project }) : ''].filter(Boolean).join(' | ')} />
    {#if c && admin}
      <!-- On a wide screen the container's own actions are at hand here; on
           a phone they are in the menu (the log's options). -->
      <div class="wide-only"><div class="actions" data-testid="container-actions">
        {#if c.state === 'running'}
          <button class="btn" disabled={!!busy} onclick={shell}><Icon name="terminal" size={16} />{t('containers.shell')}</button>
          <button class="btn" disabled={!!busy} onclick={() => act('restart')}><Icon name="reload" size={16} />{t('containers.restart')}</button>
          <button class="btn" disabled={!!busy} onclick={() => act('stop')}><Icon name="stop" size={16} />{t('containers.stop')}</button>
        {:else}
          <button class="btn" disabled={!!busy} onclick={() => act('start')}><Icon name="play" size={16} />{t('containers.start')}</button>
        {/if}
        {#if c.project && upd?.status === 'update'}
          <button class="btn primary" disabled={!!busy || updating} onclick={updateHere}><Icon name="download" size={16} />{t('updates.updateOne')}</button>
        {/if}
      </div></div>
    {/if}
  </header>

  <div class="summary">
    {#if c}
      <button class="info-toggle" aria-expanded={showInfo} onclick={() => (showInfo = !showInfo)} data-testid="container-info">
        <!-- Running: how long, in the state's colour ("draait | draait 22u" said it twice, report 97e99b). -->
        <span class="state {c.state}">{c.state === 'running' ? t('containers.up', { for: since(c.startedAt) }) : t(`containers.state.${c.state}`)}</span>
        {#if c.health}<span class="dim">| {healthLabel(c.health)}</span>{/if}
        {#if version}<span class="dim mono" data-testid="container-version">| {version}</span>{/if}
        {#if c.restarts}<span class="dim">| {c.restarts === 1 ? t('containers.restartsOne') : t('containers.restarts', { n: c.restarts })}</span>{/if}
        {#if st}<span class="dim wide-only">| CPU <b class="mono">{st.cpu.toFixed(1)}%</b> | {t('containers.memory')} <b class="mono" title={st.memKnown === false ? t('containers.memUnknown') : undefined}>{st.memKnown === false ? '-' : formatBytesShort(st.memBytes)}</b></span>{/if}
        {#if !watch.fresh[hostId]}<span class="dim" data-testid="container-stale">| {t('containers.refreshing')}</span>{:else if watch.silent[hostId] !== undefined}<span class="silent">| {t('containers.silentShort', { n: watch.silent[hostId] })}</span>{/if}
        <span class="chev" aria-hidden="true"><Icon name={showInfo ? 'chevron-down' : 'chevron'} size={14} /></span>
      </button>
      {#if upd?.status === 'update'}
        <!-- A newer image: a pill that updates it from here (after a yes), or says how.
             Beside the state, short and on one line: under the log sources,
             "Update beschikbaar" broke over two lines, a second row of buttons
             on a phone (report 335855). -->
        <button
          class="pill-btn"
          title={t('updates.availableFor', { image: c.image })}
          disabled={!!busy || updating}
          onclick={updateHere}
          data-testid="container-update"><Icon name="download" size={14} /> {t('updates.pill')}</button
        >
      {/if}
      {#if files.length || admin}
        <!-- What is shown: the container's own output, its log files, together. -->
        <div class="sources" role="group" aria-label={t('logfiles.sources')} data-testid="log-sources">
          <button class="chip pick" class:on={shown.includes('')} aria-pressed={shown.includes('')} onclick={() => toggleShown('')}>{t('logfiles.output')}</button>
          {#each files as f (f.id)}
            <button class="chip pick" class:on={shown.includes(f.path)} aria-pressed={shown.includes(f.path)} title={f.path} onclick={() => toggleShown(f.path)} data-testid="logfile-source">{fileName(f.path)}</button>
          {/each}
          {#if admin}<button class="chip pick add" onclick={openFiles} data-testid="logfiles-manage"><Icon name="plus" size={14} />{t('logfiles.manage')}</button>{/if}
        </div>
      {/if}
      {#if filesError}
        <!-- Its kept log files not read: said, not left out as if there were none. -->
        <LoadFailed inline message={t('logfiles.loadFailed', { error: filesError })} onretry={() => inBackground(loadFiles())} />
      {/if}
      {#if updateOp}
        <!-- A line of its own under the state, the page's width (report 09ddbf: its
             own element, so the summary's rule for a line of its own reaches it). -->
        <div class="opwrap"><OpOutput compact op={updateOp} onend={() => ((updateEnded = true), inBackground(loadUpdates()))} /></div>
      {/if}
      {#if showInfo}
        <!-- Scrolled in their own part, the state line above them and the log below staying put (report 5d0b33). -->
        <div class="more" data-content data-testid="container-more">
        {#if st}
          <!-- CPU and memory now where the state line has no numbers (a phone): in words only, the history
               below draws them; on a computer the state line says them (reports 73982d, fd6d27). -->
          <div class="meters narrow-only" data-testid="container-meters">
            <span class="dim small">CPU {st.cpu.toFixed(1)}%</span>
            <span class="dim small">{t('containers.memory')} {st.memKnown === false ? t('containers.memUnknown') : formatBytesShort(st.memBytes)}</span>
          </div>
        {/if}
        <section class="kept stack" aria-label={t('stats.history')} data-testid="container-history">
          <div class="toolbar">
            <h2 class="group">{t('stats.history')}</h2>
            <span class="spacer"></span>
            <select bind:value={range} aria-label={t('stats.range')} data-testid="container-history-range">
              <option value="day">{t('stats.range.day')}</option>
              <option value="week">{t('stats.range.week')}</option>
              <option value="month">{t('stats.range.month')}</option>
            </select>
          </div>
          {#if historyError}
            <LoadFailed inline message={historyError} onretry={() => historyAsked++} />
          {:else if kept === null}
            <p class="dim small">{t('common.loading')}</p>
          {:else if kept.length < 2}
            <p class="dim small">{t('containers.historyNone')}</p>
          {:else}
            {#each [['CPU %', kept.map((x) => x.cpu), (v: number) => `${v.toFixed(1)}%`], [t('containers.memory'), kept.map((x) => x.memBytes), formatBytesShort]] as const as [label, values, fmt] (label)}
              <HistoryChart {label} values={[...values]} at={kept.map((x) => Date.parse(x.at))} format={fmt} height={56} bind:picked testid="container-chart" />
            {/each}
          {/if}
        </section>
        <dl class="info">
          <dt>{t('containers.image')}</dt><dd class="mono">{c.image}</dd>
          {#if version}<dt>{t('containers.version')}</dt><dd class="mono">{version}</dd>{/if}
          {#if c.project}<dt>{t('containers.stack')}</dt><dd>{c.project}{c.service ? ` / ${c.service}` : ''}</dd>{/if}
          {#if c.configFiles}<dt>{t('containers.composeFile')}</dt><dd class="mono">{c.configFiles}</dd>{/if}
          <dt>{t('containers.created')}</dt><dd>{dateTime(c.createdAt)}</dd>
          {#if c.startedAt}<dt>{t('containers.started')}</dt><dd>{dateTime(c.startedAt)}</dd>{/if}
          {#if c.state === 'exited'}<dt>{t('containers.exitCode')}</dt><dd>{c.exitCode}{c.oomKilled ? ' (OOM)' : ''}</dd>{/if}
        </dl>
        </div>
      {/if}
    {:else if host?.error}
      <p class="alert error small">{host.error}</p>
    {:else if host && watch.fresh[hostId]}
      <!-- The host answered and this container is not among them: gone or
           renamed, not "Loading..." for ever (audit WP-07). -->
      <p class="alert error small" data-testid="container-gone">{t('containers.gone', { name })}</p>
    {:else}
      <p class="dim small">{t('common.loading')}</p>
    {/if}
  </div>


  <!-- Not keyed on the container data: that arrives a moment later and
       would start the logs over; only on what is shown. -->
  {#key sourcesKey}
  <LogView
    {sources}
    onoptions={(dl, an) => {
      downloadLogs = dl;
      analyseLogs = an;
      menuOpen = true;
    }}
  />
  {/key}
</div>

<Dialog tour="logfiles" bind:open={filesOpen} title={t('logfiles.title', { name })}>
  <div class="stack" data-testid="logfiles">
    <p class="dim small">{t('logfiles.help')}</p>
    {#if filesError}
      <LoadFailed inline message={t('logfiles.loadFailed', { error: filesError })} onretry={() => inBackground(loadFiles())} />
    {:else if files.length}
      <div class="list">
        {#each files as f (f.id)}
          <div class="list-item">
            <span class="main"><span class="title mono">{f.path}</span></span>
            <button class="icon-btn" aria-label={t('logfiles.remove', { name: fileName(f.path) })} title={t('logfiles.remove', { name: fileName(f.path) })} onclick={() => removeFile(f)} data-testid="logfile-remove"><Icon name="trash" size={18} /></button>
          </div>
        {/each}
      </div>
    {/if}
    <h3>{t('logfiles.suggested')}</h3>
    {#if suggestionsError}
      <LoadFailed inline message={t('logfiles.suggestionsFailed', { error: suggestionsError })} onretry={() => void readSuggestions()} />
    {:else if suggestions === null}
      <p class="dim small">{t('common.loading')}</p>
    {:else if !suggestions.length}
      <p class="dim small" data-testid="logfiles-none">{t('logfiles.noSuggestions')}</p>
    {:else}
      <div class="list">
        {#each suggestions as p (p)}
          <button class="list-item" onclick={() => addFile(p)} data-testid="logfile-suggestion"><span class="main"><span class="title mono">{p}</span></span><Icon name="plus" size={18} /></button>
        {/each}
      </div>
    {/if}
    <form class="row" onsubmit={(e) => (e.preventDefault(), newPath.trim() && void addFile(newPath.trim()))}>
      <input class="mono" bind:value={newPath} placeholder="/app/logs/app.log" aria-label={t('logfiles.path')} autocapitalize="none" spellcheck="false" data-testid="logfile-path" />
      <button class="btn" disabled={!newPath.trim().startsWith('/')} data-testid="logfile-add">{t('logfiles.add')}</button>
    </form>
  </div>
</Dialog>

<Dialog tour="container-menu" menu bind:open={menuOpen} title={name}>
  <div class="stack" data-testid="container-menu">
    {#if !admin}
      <!-- Operators: the stack, the analysis and the download. -->
    {:else if c?.state === 'running'}
      <button class="btn" disabled={!!busy} onclick={pick(shell)} data-testid="container-shell"><Icon name="terminal" size={18} /> {t('containers.shell')}</button>
      <button class="btn" disabled={!!busy} onclick={pick(() => act('restart'))}><Icon name="reload" size={18} /> {t('containers.restart')}</button>
      <button class="btn" disabled={!!busy} onclick={pick(() => act('stop'))}><Icon name="stop" size={18} /> {t('containers.stop')}</button>
    {:else if c}
      <button class="btn" disabled={!!busy} onclick={pick(() => act('start'))} data-testid="container-start"><Icon name="play" size={18} /> {t('containers.start')}</button>
    {/if}
    {#if c?.project && upd?.status === 'update' && admin}
      <button class="btn" disabled={!!busy} onclick={pick(updateHere)} data-testid="container-update-menu"><Icon name="download" size={18} /> {t('updates.updateOne')}</button>
    {/if}
    {#if c?.project}
      <button class="btn" onclick={pick(() => go(`/stacks/${hostId}/${encodeURIComponent(c!.project!)}`))} data-testid="open-stack"><Icon name="layers" size={18} /> {t('containers.openStack', { name: c.project })}</button>
    {/if}
    {#if admin}<button class="btn" disabled={!!busy} onclick={pick(inspect)}><Icon name="code" size={18} /> {t('containers.inspect')}</button>{/if}
    {#if analyseLogs}<button class="btn" onclick={pick(() => analyseLogs?.())} data-testid="container-analyze"><Icon name="sparkle" size={18} /> {t('analyze.title')}</button>{/if}
    <button class="btn" onclick={pick(() => downloadLogs?.())}><Icon name="download" size={18} /> {t('logs.download')}</button>
    <button class="btn danger" class:hidden={!admin} disabled={!!busy} onclick={pick(() => act('remove'))}><Icon name="trash" size={18} /> {t('common.delete')}</button>
  </div>
</Dialog>

<Dialog tour="container-update" open={updateAsk} title={t('updates.updateOne')} onclose={() => (updateAsk = false)}>
  <p>{t('updates.confirmOne', { name })}</p>
  {#if c}<p class="dim small mono image">{c.image}{upd?.version ? ` | ${t('changelog.here', { v: upd.version })}` : ''}</p>{/if}
  {#if upd?.source}
    <button class="link" onclick={() => ((updateAsk = false), (notesFor = c?.image ?? null))} data-testid="container-whats-new">{t('changelog.open')}</button>
  {:else}
    <p class="dim small" data-testid="container-no-notes">{t('updates.noNotes')}</p>
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => (updateAsk = false)}>{t('common.cancel')}</button>
    <button class="btn primary" onclick={updateNow} data-testid="container-update-ok">{t('updates.updateOne')}</button>
  {/snippet}
</Dialog>

<!-- One dialog at a time: the notes in place of the question, and back to it after. -->
<ChangelogDialog items={notesFor ? [{ hostId, image: notesFor }] : null} onclose={() => ((notesFor = null), (updateAsk = true))} />

<Dialog tour="container-inspect" size="wide" open={inspectJson !== null} title={t('containers.inspectTitle', { name })} onclose={() => (inspectJson = null)}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
  <pre tabindex="0" class="inspect" data-testid="inspect-json">{inspectJson}</pre>
</Dialog>

<style>
  .silent {
    color: var(--warn);
  }
  .detail {
    position: fixed;
    inset: 0 0 calc(var(--nav-h) + env(safe-area-inset-bottom)) var(--rail-w);
    display: flex;
    flex-direction: column;
    padding: 0 12px 8px;
  }
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sources .chip {
    flex: none;
    min-height: 32px;
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
    font: 600 0.8rem var(--font);
    cursor: pointer;
  }
  /* A mouse needs less: the log keeps the height. */
  @media (pointer: fine) {
    .sources .chip {
      min-height: 26px;
      padding: 2px 9px;
    }
  }
  .sources .chip.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .sources .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex: none;
  }
  .actions .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .info-toggle b {
    color: var(--text);
    font-weight: 500;
  }
  /* A computer: the same edges as the other pages. */
  @media (min-width: 900px) {
    .detail {
      padding: 0 28px 16px;
    }
    .detail > .topbar {
      margin: 0 -28px 8px;
      padding: 0 28px;
      min-height: 64px;
    }
  }
  /* The state, what is shown and the update on one line where they fit;
     the details below take the whole width. */
  /* An update's output above the logs: a few lines high, the logs keep most of the screen. */
  .opwrap :global(.op:not(.folded) > pre) {
    max-height: 24dvh;
  }
  /* As wide as the details around it (report a6548d: 640 px, the search under it the whole width). */
  .kept {
    margin: 8px 0;
  }
  /* History and its range on one line while they fit, the range the line's width under it when
     not (report a6548d), as on a host's page. */
  .kept .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  /* Under the bar straight away: the state line has its own room above it (6 px), the log keeps the rest. */
  @media (max-width: 899px) {
    .detail > .topbar {
      margin-bottom: 0;
    }
  }
  .summary {
    padding: 6px 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
  }
  /* The details scroll in their own part and the log keeps the rest, its bar and lines 300 px where
     the screen has that (the details 35% of it at most, a few lines at least): on a phone held
     sideways they took the whole page, and the log could not be reached (report 5d0b33). Three lines at
     least: with the bar no longer over the page's top (report dc7a4c) 80 px left the log 130 px. */
  .more {
    max-height: clamp(70px, calc(100dvh - var(--nav-h) - 420px), 35dvh);
    overflow-y: auto;
    overscroll-behavior: contain;
    /* Room before their scrollbar: the history's range touched it (report 73982d). */
    padding-right: 8px;
  }
  .summary > :not(.info-toggle, .sources, .pill-btn) {
    flex-basis: 100%;
  }
  /* Done, one line: beside the state when it fits, the logs keep the room. */
  .summary > .opwrap:has(:global(.op.folded)) {
    flex-basis: auto;
  }
  .info-toggle {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    align-items: center;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .state {
    font-weight: 700;
  }
  .state.running {
    color: var(--ok);
  }
  .state.exited,
  .state.dead {
    color: var(--danger);
  }
  /* A pill, like the update dot in the list: it leads to the update. */
  .pill-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: 2px 10px;
    min-height: 28px;
    border: 1px solid var(--accent);
    border-radius: 5px;
    background: none;
    color: var(--accent);
    font: 600 0.8rem var(--font);
    white-space: nowrap;
    cursor: pointer;
  }
  .hidden {
    display: none;
  }
  .image {
    overflow-wrap: anywhere;
  }
  .inspect {
    margin: 0;
    max-height: 60dvh;
    overflow: auto;
    font: 0.75rem/1.35 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .meters {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .info {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 8px 0 0;
    font-size: 0.85rem;
  }
  .info dt {
    color: var(--text-dim);
  }
  .info dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
