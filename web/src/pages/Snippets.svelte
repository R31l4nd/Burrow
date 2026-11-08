<script lang="ts">
  import LoadFailed from '../components/LoadFailed.svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import type { RunResult, Snippet, SnippetInput, SnippetSuggestion } from '@burrow/shared';
  import { fillSnippet, snippetDefaults, snippetReady, snippetVariables, suggestedName } from '@burrow/shared/snippets';
  import Dialog from '../components/Dialog.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import PickList from '../components/PickList.svelte';
  import SnippetFields from '../components/SnippetFields.svelte';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { data, groupPath, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { route } from '../lib/router.svelte.js';
  import Icon from '../components/Icon.svelte';
  import { attempt, toast, inBackground } from '../lib/ui.svelte.js';
  import { FormSave } from '../lib/formsave.svelte.js';

  // The form's Save: once at a time, and its end for the form it was pressed in (AUDIT2 PAGE-11, PAGE-12).
  const saving = new FormSave();
  let list = $state<Snippet[]>([]);
  let editing = $state<Snippet | 'new' | null>(null);
  let name = $state('');
  let command = $state('');
  let description = $state('');
  let scope = $state<string>('global');

  let running = $state<Snippet | null>(null);
  // A command typed here, on several hosts at once (not saved as a snippet).
  let adhoc = $state(false);
  let adhocCommand = $state('');
  let values = $state<Record<string, string>>({});
  let hostIds = $state<number[]>([]);
  let results = $state<RunResult[] | null>(null);
  let busy = $state(false);

  if (!data.loaded) inBackground(loadAll());
  // Commands typed often in the terminals, offered as snippets (report 8f829d).
  let suggestions = $state<SnippetSuggestion[]>([]);
  const load = () =>
    Promise.all([
      get<Snippet[]>('/api/snippets').then((s) => (list = s)),
      get<SnippetSuggestion[]>('/api/snippets/suggestions').then((s) => (suggestions = s)),
    ]);
  // Not read is not "none saved" (AUDIT2 PAGE-08): said, with a way to try again.
  let loadError = $state('');
  let loaded = $state(false);
  function firstLoad() {
    loadError = '';
    load().then(
      () => (loaded = true),
      (err: unknown) => (loadError = errorMessage(err)),
    );
  }
  firstLoad();
  const hostNames = (ids: number[]) => ids.map((id) => data.hosts.find((h) => h.id === id)?.name ?? '?').join(', ');

  // The row whose menu is open (a snippet or a suggestion); a tap in it closes it first, then acts.
  let menuFor = $state<{ snippet?: Snippet; suggestion?: SnippetSuggestion } | null>(null);
  const fromMenu = (fn: (x: { snippet?: Snippet; suggestion?: SnippetSuggestion }) => unknown) => () => {
    const x = menuFor!;
    menuFor = null;
    void fn(x);
  };

  function keep(s: SnippetSuggestion) {
    edit('new');
    name = suggestedName(s.command);
    command = s.command;
    scope = s.hostIds.length === 1 ? `h${s.hostIds[0]}` : 'global';
  }
  async function hide(s: SnippetSuggestion) {
    if (!(await attempt(() => post('/api/snippets/suggestions/dismiss', { command: s.command })))) return;
    suggestions = suggestions.filter((x) => x !== s);
  }

  const scopeLabel = (s: Snippet) =>
    s.hostId ? (data.hosts.find((h) => h.id === s.hostId)?.name ?? '?') : s.groupId ? groupPath(s.groupId) : t('snippets.global');

  // The form as opened: changed, closing it asks first (AUDIT2 PAGE-09).
  let formBase = '';
  const formNow = () => JSON.stringify([name, command, description, scope]);
  function edit(s: Snippet | 'new') {
    saving.opened();
    editing = s;
    if (s === 'new') {
      name = '';
      command = '';
      description = '';
      scope = 'global';
    } else {
      name = s.name;
      command = s.command;
      description = s.description ?? '';
      scope = s.hostId ? `h${s.hostId}` : s.groupId ? `g${s.groupId}` : 'global';
    }
    formBase = formNow();
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const body: SnippetInput = {
      name,
      command,
      description: description || null,
      hostId: scope.startsWith('h') ? Number(scope.slice(1)) : null,
      groupId: scope.startsWith('g') ? Number(scope.slice(1)) : null,
    };
    const snippet = editing;
    if (!snippet) return;
    const done = await saving.run(() => (snippet === 'new' ? post('/api/snippets', body) : put(`/api/snippets/${snippet.id}`, body)));
    if (done === 'saved') editing = null;
    if (done) await load();
  }

  async function remove(s: Snippet) {
    if (!(await ask({ text: t('common.confirmDelete', { name: s.name }), confirm: t('common.delete'), danger: true }))) return;
    if (!(await attempt(() => del(`/api/snippets/${s.id}`)))) return;
    editing = null;
    await load();
  }

  function startAdhoc() {
    adhoc = true;
    adhocCommand = '';
    startRun({ id: 0, name: t('snippets.adhoc'), command: '', description: null, hostId: null, groupId: null } as unknown as Snippet);
  }
  // From Hosts ("A command on several hosts"): straight to it.
  if (route.query.run === '1') queueMicrotask(startAdhoc);

  function startRun(s: Snippet) {
    // Another command: what the one before still brings is not shown here.
    runSeq++;
    busy = false;
    if (s.id !== 0) adhoc = false;
    running = s;
    values = snippetDefaults(snippetVariables(s.command));
    results = null;
    hostIds = s.hostId ? [s.hostId] : s.groupId ? data.hosts.filter((h) => h.groupId === s.groupId).map((h) => h.id) : [];
    runBase = runNow();
  }
  // What was typed and picked in the run dialog, not run yet: X, Escape, the backdrop and another page ask first (A3-WEB-12).
  let runBase = '';
  const runNow = () => JSON.stringify([adhocCommand.trim(), values, [...hostIds].sort()]);
  const runDirty = () => running !== null && results === null && !busy && runNow() !== runBase;

  const runVars = $derived(running && !adhoc ? snippetVariables(running.command) : []);
  const runCommand = $derived(adhoc ? adhocCommand.trim() : running ? fillSnippet(running.command, values) : '');
  const canRun = $derived(hostIds.length > 0 && runCommand !== '' && snippetReady(runVars, values));

  // The results belong to the command they came from: one that finished
  // after another was opened showed under its name (audit WP-14).
  let runSeq = 0;
  // What ran: the fields may change while it runs, and the output stays that command's (AUDIT2 PAGE-28).
  let ran = $state('');
  async function run() {
    const mine = ++runSeq;
    busy = true;
    results = null;
    const command = runCommand;
    try {
      const r = await post<RunResult[]>('/api/snippets/run', { command, hostIds: [...hostIds] });
      if (mine === runSeq) {
        results = r;
        ran = command;
      }
    } catch (err) {
      if (mine === runSeq) toast(errorMessage(err), 'error');
    } finally {
      if (mine === runSeq) busy = false;
    }
  }
</script>

<!-- A part of the settings (#/settings/snippets), its heading theirs (reports 8f4db3, 086418). -->
<div class="stack" data-testid="snippets-part">

  <!-- Side by side, as wide as their words; the saved snippets first, what was typed often after
     them: on a small phone the two buttons one under the other and the suggestions above took
     a third of the screen before a snippet (UI round 2026-10-29). On a small phone the two on one
     row without their icons, not one under the other ("Op meerdere hosts" went to a second row). -->
  <div class="btnrow adds" style:margin-bottom="12px">
    <button class="btn small" onclick={() => edit('new')}><Icon name="plus" size={16} /> {t('snippets.new')}</button>
    <button class="btn small" onclick={startAdhoc} title={t('snippets.adhoc')} data-testid="adhoc-run"><Icon name="terminal" size={16} /> {t('snippets.adhocShort')}</button>
  </div>

  {#if loadError}
    <LoadFailed message={loadError} onretry={firstLoad} />
  {:else if !loaded}
    <p class="dim">{t('common.loading')}</p>
  {:else if list.length === 0}
    <p class="empty">{t('snippets.none')}</p>
  {:else}
    <div class="list">
      {#each list as s (s.id)}
        <div class="list-item" data-testid="snippet-row">
          <button class="main pick" onclick={() => edit(s)}>
            <!-- The pill beside the name, never cut: the name is cut with ... (A3-WEB-09). -->
            <span class="titlerow"><span class="title">{s.name}</span><span class="chip">{scopeLabel(s)}</span></span>
            <span class="sub mono">{s.command}</span>
          </button>
          <!-- Run, edit and delete in the row's menu, as every row with more than one thing to do (report edfcf1): a button with words cut the command short. -->
          <button class="icon-btn" aria-label={t('common.menuFor', { name: s.name })} title={t('common.menuFor', { name: s.name })} onclick={() => (menuFor = { snippet: s })} data-testid="snippet-menu"><Icon name="more" size={20} /></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if suggestions.length}
    <h3 class="sub-head">{t('snippets.suggested')} <HelpTip text={t('help.snippetSuggestions')} /></h3>
    <div class="list" data-testid="snippet-suggestions">
      {#each suggestions as s (s.command)}
        <!-- The command beside one menu button: with two buttons it came a word a line (report 4ed704), then the buttons a line of their own (report edfcf1). -->
        <div class="list-item sugg" data-testid="snippet-suggestion">
          <!-- A tap opens it in the snippet form, to be changed before it is saved, as a saved one's row does (report 76b6df). -->
          <button class="main pick" onclick={() => keep(s)} data-testid="suggestion-open">
            <span class="sub mono cmd">{s.command}</span>
            <span class="sub">{t('snippets.typed', { n: s.count })}{s.hostIds.length ? ` | ${hostNames(s.hostIds)}` : ''}</span>
          </button>
          <button class="icon-btn" aria-label={t('common.menuFor', { name: s.command })} title={t('common.menuFor', { name: s.command })} onclick={() => (menuFor = { suggestion: s })} data-testid="suggestion-menu"><Icon name="more" size={20} /></button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<Dialog tour="snippet-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.snippet?.name ?? menuFor?.suggestion?.command ?? ''}>
  {#if menuFor?.snippet}
    <button class="btn" onclick={fromMenu((x) => x.snippet && startRun(x.snippet))} data-testid="snippet-run">{t('snippets.runOn')}</button>
    <button class="btn" onclick={fromMenu((x) => x.snippet && edit(x.snippet))} data-testid="snippet-edit">{t('common.edit')}</button>
    <button class="btn danger" onclick={fromMenu((x) => x.snippet && remove(x.snippet))} data-testid="snippet-remove">{t('common.delete')}</button>
  {:else if menuFor?.suggestion}
    <button class="btn" onclick={fromMenu((x) => x.suggestion && keep(x.suggestion))} data-testid="suggestion-keep">{t('snippets.keep')}</button>
    <button class="btn" onclick={fromMenu((x) => x.suggestion && hide(x.suggestion))} data-testid="suggestion-hide">{t('snippets.hideSuggestion')}</button>
  {/if}
</Dialog>

<Dialog tour="snippet-form" open={editing !== null} title={editing === 'new' ? t('snippets.new') : t('snippets.edit')} onclose={() => (editing = null)} dirty={() => formNow() !== formBase}>
  <form id="snippet-form" class="stack" onsubmit={save}>
    <label class="field">
      <span>{t('snippets.name')}</span>
      <input bind:value={name} name="name" required maxlength="80" />
    </label>
    <div class="field-wrap">
      <label class="field">
        <span>{t('snippets.command')}</span>
        <textarea bind:value={command} name="command" required rows="4" spellcheck="false" autocapitalize="none"></textarea>
      </label>
      <span class="field-help"><HelpTip text={t('help.snippetVariables')} /></span>
    </div>
    <label class="field">
      <span>{t('snippets.description')} ({t('common.optional')})</span>
      <input bind:value={description} />
    </label>
    <div class="field-wrap">
      <label class="field">
        <span>{t('snippets.scope')}</span>
        <select bind:value={scope}>
          <option value="global">{t('snippets.global')}</option>
          {#each data.groups as g (g.id)}<option value={`g${g.id}`}>{t('host.group')}: {groupPath(g.id)}</option>{/each}
          {#each data.hosts as h (h.id)}<option value={`h${h.id}`}>{t('snippets.host')}: {h.name}</option>{/each}
        </select>
      </label>
      <span class="field-help"><HelpTip text={t('help.snippetScope')} /></span>
    </div>
  </form>
  {#snippet actions()}
    {#if editing && editing !== 'new'}
      <button class="btn danger" onclick={() => editing && editing !== 'new' && remove(editing)}>{t('common.delete')}</button>
    {/if}
    <button type="button" class="btn" onclick={() => (editing = null)}>{t('common.cancel')}</button>
    <button class="btn primary" form="snippet-form" disabled={saving.busy}>{t('common.save')}</button>
  {/snippet}
</Dialog>

<Dialog tour="snippet-run" open={running !== null} title={running?.name ?? ''} onclose={() => (running = null)} dirty={runDirty}>
  {#if adhoc}
    <label class="field">
      <span>{t('snippets.command')}</span>
      <textarea class="mono" rows="3" bind:value={adhocCommand} autocapitalize="none" spellcheck="false" data-testid="adhoc-command"></textarea>
    </label>
    <p class="dim small">{t('snippets.adhocHint')}</p>
  {:else}
    <p class="mono small">{runCommand}</p>
  {/if}
  <SnippetFields vars={runVars} bind:values {hostIds} />
  <h3>{t('snippets.hosts')}</h3>
  <PickList items={data.hosts.map((h) => ({ id: h.id, title: h.name }))} chosen={hostIds} onchange={(next) => (hostIds = next)} label={t('snippets.hosts')} />
  <button class="btn primary" disabled={!canRun || busy} onclick={run}>
    {busy ? t('common.loading') : t('snippets.runCount', { count: hostIds.length })}
  </button>
  {#if results}
    {#if ran !== runCommand}<p class="dim small" data-testid="run-ran">{t('snippets.ran')} <span class="mono">{ran}</span></p>{/if}
    {#each results as r (r.hostId)}
      <div class="card stack result" data-testid="run-result">
        <div class="row">
          <strong>{r.hostName}</strong>
          <span class="spacer"></span>
          <span class="badge" class:bad={r.status !== 'ok'}>{r.status === 'ok' ? 'OK' : `exit ${r.exitCode ?? '-'}`}</span>
          <span class="dim small">{r.durationMs} ms</span>
        </div>
        {#if r.stdout}<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) --><pre tabindex="0">{r.stdout}</pre>{/if}
        {#if r.stderr}<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) --><pre tabindex="0" class="err">{r.stderr}</pre>{/if}
      </div>
    {/each}
  {/if}
</Dialog>

<style>
  .adds {
    container-type: inline-size;
  }
  @container (max-width: 22rem) {
    .adds :global(svg) {
      display: none;
    }
  }
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
  .titlerow .chip {
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
    cursor: pointer;
    padding: 0;
    min-width: 0;
  }
  pre {
    margin: 0;
    padding: 8px;
    max-height: 240px;
    overflow: auto;
    background: var(--bg-sunken);
    border-radius: 6px;
    font: 0.8rem/1.4 var(--mono);
    white-space: pre-wrap;
    word-break: break-all;
  }
  pre.err {
    color: var(--danger);
  }
  .sub-head {
    margin: 16px 0 8px;
    font-size: 1rem;
  }
  .cmd {
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .sugg .main {
    flex: 1;
    min-width: 0;
  }
  .badge.bad {
    background: var(--danger-bg);
    color: var(--danger);
  }
</style>
