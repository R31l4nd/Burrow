<script lang="ts">
  import { pullToRefresh } from '../lib/pull.svelte.js';
  import { lastSeen, remember } from '../lib/lastseen.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { untrack } from 'svelte';
  import CheckProgress from '../components/CheckProgress.svelte';
  import { activity, nudgeActivity } from '../lib/activity.svelte.js';
  import { retagCompose, type ComposeCheck, type ContainerState, type OpInfo, type StackInfo, type StackOp, type StackService, type StackUpdate, type TextFile } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import BottomPanel from '../components/BottomPanel.svelte';
  import ChangelogDialog from '../components/ChangelogDialog.svelte';
  import DiffView from '../components/DiffView.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import PageTitle from '../components/PageTitle.svelte';
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import OpOutput from '../components/OpOutput.svelte';
  import { ApiFailure, errorMessage, get, post, put } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { go, route, to, up } from '../lib/router.svelte.js';
  import { forgetBase, noteSaved, readBase, rememberBase } from '../lib/stackbase.js';
  import { toast, inBackground } from '../lib/ui.svelte.js';
  import { checkOf, checkUpdates, loadUpdates, shortDigest, updates } from '../lib/updates.svelte.js';
  import { stackCheck } from '../lib/stackcheck.js';
  import { readFirst } from '../lib/stackupdate.js';
  import { notesLabel } from '../lib/notescount.js';

  // One compose stack: its services, image updates (by hand, or
  // automatically in the maintenance window), the compose file (edit, review
  // the diff, deploy with live output) and the stack's update history.

  let { hostId: hostProp, project: projectProp }: { hostId: number; project: string } = $props();
  const hostId = untrack(() => hostProp);
  const project = untrack(() => projectProp);
  const base = `/api/docker/${hostId}/stacks/${encodeURIComponent(project)}`;

  if (!data.loaded) inBackground(loadAll());
  if (!updates.overview) inBackground(loadUpdates());

  // Opened again: what was seen, at once, until the fresh answer is in.
  const before = lastSeen<StackInfo>(base);
  let info = $state<StackInfo | null>(before);
  let stale = $state(before !== null);
  let history = $state<StackUpdate[]>([]);
  let error = $state('');
  let op = $state<OpInfo | null>(null);
  let busy = $state(false);
  let reviewing = $state(false);
  // Checking: started here, or still going on the server (the page opened again).
  let checkingHere = $state(false);
  const checking = $derived(checkingHere || activity.check !== null);
  let file = $state('');
  let notesFor = $state<{ hostId: number; image: string }[] | null>(null);

  // Review before deploy.
  let reviewOpen = $state(false);
  let review = $state<{ file: string; before: string; beforeLabel: string; after: string; check: ComposeCheck } | null>(null);

  const hostName = $derived(data.hosts.find((h) => h.id === hostId)?.name ?? '');
  // No update: what its own images' checks say (AUDIT2 PAGE-07).
  const ownCheck = $derived(stackCheck([...new Set((info?.services ?? []).map((s) => s.image))].map((image) => checkOf(hostId, image))));
  const withUpdate = $derived((info?.services ?? []).filter((s) => checkOf(hostId, s.image)?.status === 'update'));
  // The images with an update that say where their notes are, each once.
  const withNotes = $derived([...new Set(withUpdate.filter((s) => checkOf(hostId, s.image)?.source).map((s) => s.image))]);
  // Of how many images with an update (one without notes made "17" beside 18, report 2fe705).
  const notes = $derived(notesLabel(withNotes.length, new Set(withUpdate.map((s) => s.image)).size));
  // Which of them to update now: all, unless unticked (or one asked for from a container's page).
  let skipped = $state(new Set<string>());
  const chosen = $derived(withUpdate.filter((s) => !skipped.has(s.service)));
  const toggleService = (service: string) => {
    const next = new Set(skipped);
    if (next.has(service)) next.delete(service);
    else next.add(service);
    skipped = next;
  };
  const opRunning = $derived(op !== null && op.exitCode === null);
  // Newer versions under another tag (nginx:1.25 -> 1.27): a choice, made in
  // the compose file, never by itself. One row per image.
  const newer = $derived(
    [...new Map((info?.services ?? []).map((s) => [s.image, s])).values()]
      .map((s) => ({ s, tag: checkOf(hostId, s.image)?.newerTag ?? null }))
      .filter((x): x is { s: (typeof x)['s']; tag: string } => x.tag !== null),
  );

  // "Use 1.27": the compose file with that image line changed, saved, then
  // the usual review (the diff) before deploying. An image named some other
  // way (a variable) is changed by hand in the editor.
  async function useTag(image: string, tag: string) {
    // The file chosen when it was pressed, all the way through: another one picked meanwhile
    // is not the one written or reviewed (AUDIT2 PAGE-02).
    const path = file;
    if (!path) return;
    busy = true;
    try {
      const now = await get<TextFile>(`/api/files/${hostId}/text?path=${encodeURIComponent(path)}`);
      const changed = retagCompose(now.content, image, tag);
      if (changed === null) {
        toast(t('updates.retagByHand', { image }), 'error');
        edit();
        return;
      }
      rememberBase(hostId, path, now.content, now.hash);
      const saved = await put<TextFile>(`/api/files/${hostId}/text`, { path, content: changed, baseHash: now.hash });
      noteSaved(hostId, path, saved.hash);
    } catch (err) {
      toast(errorMessage(err), 'error');
      return;
    } finally {
      busy = false;
    }
    await openReview(path);
  }
  const images = $derived([...new Set((info?.services ?? []).map((s) => s.image))]);

  // Saves made while this page is open: a read that was asked before the
  // last of them comes back with the old state, and must not put it back
  // over the newer answer (a slow host, a refresh on its way).
  let saves = 0;
  async function load() {
    const asked = saves;
    try {
      const fresh = await get<StackInfo>(base);
      if (asked !== saves) return;
      info = remember(base, fresh);
      stale = false;
      history = await get<StackUpdate[]>(`${base}/history`);
      if (!file || !info.configFiles.includes(file)) file = info.configFiles[0] ?? '';
      if (info.running && !op) op = info.running;
      error = '';
    } catch (err) {
      error = errorMessage(err);
    }
  }
  // Pulled down on a phone: read again.
  $effect(() => pullToRefresh(() => load()));

  // Kept current while in sight: containers come and go outside Burrow too.
  $effect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !busy) void load();
    }, 10_000);
    return () => clearInterval(timer);
  });
  void load().then(() => {
    // Back from the editor with "Review and deploy".
    if (route.query.review === '1' && info) void openReview();
    // From a container's "Update available": to where it is updated, that one ticked.
    if (route.query.update === '1') queueMicrotask(() => document.getElementById('updates')?.scrollIntoView({ block: 'start' }));
    const only = route.query.service;
    if (only && info?.services.some((s) => s.service === only)) skipped = new Set(info.services.map((s) => s.service).filter((x) => x !== only));
  });

  // What holds the automatic update (a breaking change), read for the updates section.
  let hold = $state<{ held: string[]; released: boolean } | null>(null);
  $effect(() => {
    if (!info?.autoUpdate || !withUpdate.length) return void (hold = null);
    void get<{ held: string[]; released: boolean }>(`${base}/hold`).then((h) => (hold = h), () => (hold = null));
  });
  async function releaseHold() {
    if (!hold) return;
    try {
      hold = await post<{ held: string[]; released: boolean }>(`${base}/hold/release`, { held: hold.held });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // Updating by hand: first the release notes in between. A breaking change
  // (or a new major version) is named, and the update waits for a yes.
  async function updateNow() {
    const pick = chosen;
    if (!pick.length) return;
    // A version rolled back here before: only after a yes (W-FUNC-03).
    const bad = [...new Set(pick.filter((s) => checkOf(hostId, s.image)?.rolledBackAt).map((s) => s.image))];
    if (bad.length && !(await ask({ text: t('updates.rolledBackAsk'), items: bad.map((image) => ({ title: image, lines: [t('updates.rolledBackOn', { at: dateTime(checkOf(hostId, image)!.rolledBackAt!) })] })), confirm: t('updates.updateAnyway'), danger: true }))) return;
    busy = true;
    const go = await readFirst(hostId, pick.map((s) => s.image), project).finally(() => (busy = false));
    if (go) await run('update', [...new Set(pick.map((s) => s.service))]);
  }

  // The file a deploy was of: its edit start is forgotten when that deploy ends well, whichever file is chosen by then.
  let opFile: string | null = null;
  async function run(o: StackOp, services?: string[], deploy?: { file: string; reviewed: string }) {
    busy = true;
    try {
      opFile = deploy?.file ?? null;
      op = await post<OpInfo>(`${base}/ops`, { op: o, ...(services ? { services } : {}), ...(deploy ? { deployFile: deploy.file, reviewed: deploy.reviewed } : {}) });
      nudgeActivity();
    } catch (err) {
      const stale = err instanceof ApiFailure && err.code === 'review_stale';
      toast(stale ? t('stack.reviewStale') : errorMessage(err), 'error');
      // Changed since the review: the review again, of what is there now.
      if (stale) queueMicrotask(() => void openReview());
    } finally {
      busy = false;
    }
  }

  // Left meanwhile: the later read of the history is not made for a page that is gone.
  let again: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(again));
  function ended(code: number) {
    if (code === 0 && op?.op === 'up' && opFile) {
      forgetBase(hostId, opFile);
    }
    void load();
    // The history is written as the operation ends: read again a moment later too, so its outcome shows without a reload (W-FUNC-10).
    clearTimeout(again);
    again = setTimeout(() => void load(), 2000);
    inBackground(loadUpdates());
  }

  async function checkNow() {
    checkingHere = true;
    try {
      await checkUpdates([hostId], images);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      checkingHere = false;
    }
  }
  // A check that ends while this page is open: its results.
  let wasChecking = false;
  $effect(() => {
    if (wasChecking && !checking) inBackground(loadUpdates());
    wasChecking = checking;
  });

  // Saving takes a moment (the stack is read over SSH): not toggled again meanwhile.
  let savingAuto = $state(false);
  async function setAuto(on: boolean) {
    savingAuto = true;
    saves++;
    try {
      info = remember(base, await put<StackInfo>(`${base}/settings`, { autoUpdate: on }));
    } catch (err) {
      toast(errorMessage(err), 'error');
      await load();
    } finally {
      savingAuto = false;
    }
  }

  const remembered = (path: string): string | null => readBase(hostId, path);

  async function openReview(path = file) {
    if (!info || !path) return;
    busy = true;
    reviewing = true;
    try {
      const [now, check] = await Promise.all([
        get<TextFile>(`/api/files/${hostId}/text?path=${encodeURIComponent(path)}`),
        post<ComposeCheck>(`${base}/check`),
      ]);
      // Before: what Burrow last deployed; else the file as it was when you started editing.
      const deployed = info.deployed?.file === path ? info.deployed : null;
      const start = remembered(path);
      review = {
        file: path,
        before: deployed?.content ?? start ?? now.content,
        beforeLabel: deployed ? t('stack.sinceDeploy', { at: dateTime(deployed.at) }) : start !== null ? t('stack.sinceEdit') : t('stack.noBase'),
        after: now.content,
        check,
      };
      reviewOpen = true;
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
      reviewing = false;
    }
  }

  const differs = $derived((review?.check.recreate ?? []).filter((r) => r.why === 'differs').map((r) => r.service));
  const missing = $derived((review?.check.recreate ?? []).filter((r) => r.why === 'missing').map((r) => r.service));

  // Exactly what the review showed: changed since, the server refuses (review again).
  async function deploy() {
    reviewOpen = false;
    if (review?.check.digest) await run('up', undefined, { file: review.file, reviewed: review.check.digest });
  }

  function edit() {
    go(to(`/edit/${hostId}`, { p: file, stack: project }));
  }

  const resultText = (u: StackUpdate) => t(`stack.result.${u.result}`);
  // A stack of many services (60 on the live Burrow made the page 7400 px on
  // a phone): a filter and the first few, with those that need a look always
  // in; the history's latest few. "Show all" for the rest.
  const FEW = 8;
  let svcQuery = $state('');
  let allServices = $state(false);
  let allHistory = $state(false);
  const manyServices = $derived((info?.services.length ?? 0) > FEW + 2);
  const needsLook = (s: StackService) => s.state !== 'running' || checkOf(hostId, s.image)?.status === 'update';
  // While an operation runs, compose's own stand-in for a container being recreated ("f15d615678b5_web-1") is not a
  // service of the stack (it doubled the list and its update count, W-FUNC-10).
  const busyTemp = (s: { container: string }) => !!op && op.exitCode === null && /^[0-9a-f]{12}_/.test(s.container);
  const matchingServices = $derived((info?.services ?? []).filter((s) => !busyTemp(s) && (!svcQuery.trim() || `${s.service} ${s.container} ${s.image}`.toLowerCase().includes(svcQuery.trim().toLowerCase()))));
  const shownServices = $derived(!manyServices || allServices || svcQuery.trim() ? matchingServices : matchingServices.filter((s, i) => i < FEW || needsLook(s)));
  const shownHistory = $derived(allHistory ? history : history.slice(0, 3));
  const admin = $derived(session.state?.user?.role === 'admin');

  // The panel at the bottom: a terminal in the stack's folder, the logs of its containers.
  let panel = $state(false);
  let panelSpace = $state(0);
</script>

<div class="page" style:padding-bottom={panelSpace ? `calc(${panelSpace}px + var(--nav-h) + 24px + env(safe-area-inset-bottom))` : null}>
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/containers')}><Icon name="back" /></button>
    <PageTitle title={project} sub={`${hostName} | ${t('stack.kind')}`} />
    <!-- Once the stack is read: the terminal starts in its folder. -->
    {#if info}<button class="icon-btn" aria-label={t('panel.toggle')} title={t('panel.toggle')} aria-pressed={panel} onclick={() => (panel = !panel)} data-testid="panel-toggle"><Icon name="terminal" /></button>{/if}
  </header>

  {#if error}
    <p class="alert error small">{error}</p>
  {:else if !info}
    <Skeleton rows={4} />
  {:else}
    {#if stale}<p class="dim small" data-testid="stack-stale">{t('containers.refreshingLine')}</p>{/if}
    <!-- A computer: the services (and what runs on them) on the left, the
         updates and the compose file on the right. A phone: one column, in
         the order below (the wrappers step aside). -->
    <div class="cols">
    <div class="colmain">
    <section class="card stack o1" aria-label={t('stack.services')}>
      <div class="toolbar">
        <h2>{t('stack.services')}</h2>
        <span class="spacer"></span>
        <button class="btn small" onclick={() => go(to('/logs', { t: info!.services.map((s) => `${hostId}:${s.container}`).join(',') }))}>{t('containers.logs')}</button>
      </div>
      {#if manyServices}<input type="search" bind:value={svcQuery} placeholder={t('pick.search')} aria-label={t('stack.servicesSearch')} autocapitalize="none" spellcheck="false" data-testid="stack-services-filter" />{/if}
      <div class="list">
        {#each shownServices as s (s.container)}
          {@const c = checkOf(hostId, s.image)}
          <button class="list-item srow" onclick={() => go(`/containers/${hostId}/${encodeURIComponent(s.container)}`)} data-testid="stack-service">
            <span class="dot {s.state === 'running' ? 'ok' : 'bad'}" aria-hidden="true"></span>
            <span class="main">
              <!-- Two containers of one service (an old one left over): their own names tell them apart. -->
              <span class="title">{info.services.filter((x) => x.service === s.service).length > 1 ? s.container : s.service}</span>
              <!-- The image by name and tag; its digest only on hover (nobody reads 64 hex digits). -->
              <span class="sub"><span class="mono" title={s.image}>{s.image.replace(/@sha256:[0-9a-f]+$/, '')}</span> | {t(`containers.state.${s.state as ContainerState}`)}</span>
              <!-- A newer tag under the name, not beside it: a long one (17-vectorchord0.4.3-pgvector0.8.0) squeezed the name to a sliver. -->
              {#if c?.newerTag}<span class="sub newer" data-testid="newer-pill">{t('updates.newerTag', { tag: c.newerTag })}</span>{/if}
            </span>
            {#if c?.status === 'update'}<span class="flag upd">{t('updates.available')}</span>
            {:else if c?.status === 'unknown'}<span class="flag unk" title={c.error ?? undefined} data-testid="stack-check-failed">{t('updates.notChecked')}</span>{/if}
          </button>
        {:else}
          <p class="empty small">{t('pick.nothing')}</p>
        {/each}
      </div>
      {#if shownServices.length < matchingServices.length}<button class="btn small more" onclick={() => (allServices = true)} data-testid="stack-services-more">{t('pick.more', { n: matchingServices.length - shownServices.length })}</button>{/if}
      <!-- Brought down from Burrow: no containers, its files kept; Up starts it again. -->
      {#if info.downAt}<p class="alert small" data-testid="stack-is-down">{t('stack.isDown', { when: dateTime(info.downAt) })}</p>{/if}
      {#if admin}
      <div class="btnrow even">
        <button class="btn small" disabled={busy || opRunning} onclick={() => run('pull')}>{t('stack.op.pull')}</button>
        <button class="btn small" class:primary={!!info.downAt} disabled={busy || opRunning} onclick={() => run('up')} data-testid="stack-up">{t('stack.op.up')}</button>
        <button class="btn small" disabled={busy || opRunning || !!info.downAt} onclick={() => run('restart')}>{t('stack.op.restart')}</button>
        <button
          class="btn small danger"
          disabled={busy || opRunning || info.self || !!info.downAt}
          onclick={async () => {
            if ((await ask({ text: t('stack.confirmDown', { name: project }), confirm: t('stack.op.down'), danger: true }))) void run('down');
          }}>{t('stack.op.down')}</button
        >
      </div>
      {/if}
    </section>

    {#if op}
      <section class="card stack o3" aria-label={t('ops.output')}>
        <div class="toolbar">
          <h2>{t('ops.output')}</h2>
          <span class="spacer"></span>
          {#if op.exitCode !== null}
            <button class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onclick={() => (op = null)}><Icon name="close" size={18} /></button>
          {/if}
        </div>
        {#key op.id}
          <OpOutput
            op={op}
            onend={(code) => {
              if (op) op.exitCode = code;
              ended(code);
            }}
          />
        {/key}
      </section>
    {/if}

    {#if history.length}
      <section class="card stack o5" aria-label={t('stack.history')}>
        <h2>{t('stack.history')}</h2>
        <ul class="history" data-testid="stack-history">
          {#each shownHistory as u (u.id)}
            <!-- Each update a block of its own, a line between, its images a list under its head (report be5cf2). -->
            <li data-testid="stack-history-item">
              <div class="uhead">
                <span class="res {u.result}">{resultText(u)}</span>
                <!-- Its parts whole: wrapped inside one, its end lay over the image under it in Edge (report 71a779). -->
                <span class="dim small nowrap">{dateTime(u.startedAt)} |</span>
                <span class="dim small nowrap">{u.auto ? t('stack.auto') : t('stack.manual')}</span>
              </div>
              {#if u.images.length}
                <ul class="imgs">
                  {#each u.images as i (i.image)}<li><span class="small mono iname">{i.image}</span><span class="dim small mono">{shortDigest(i.from)} -> {shortDigest(i.to)}</span></li>{/each}
                </ul>
              {/if}
              {#if u.detail}<span class="small">{u.detail}</span>{/if}
            </li>
          {/each}
        </ul>
        {#if shownHistory.length < history.length}<button class="btn small more" onclick={() => (allHistory = true)} data-testid="stack-history-more">{t('pick.more', { n: history.length - shownHistory.length })}</button>{/if}
      </section>
    {/if}
    </div>
    <div class="colside">
    <section class="card stack o2" id="updates" aria-label={t('updates.title')}>
      <!-- The heading whole; the button under it when the line is too short ("Image-" / "updates", UIA-09). -->
      <div class="toolbar wraps">
        <h2 class="nowrap">{t('updates.title')} <HelpTip text={t('help.updates')} /></h2>
        <span class="spacer"></span>
        <button class="btn small" class:hidden={!admin} disabled={checking} onclick={checkNow} data-testid="check-stack">{checking ? t('updates.checking') : t('updates.checkNow')}</button>
      </div>
      {#if checking}<CheckProgress />{/if}
      {#if withUpdate.length}
        <ul class="digests" data-testid="stack-updates">
          {#each withUpdate as s (s.container)}
            {@const c = checkOf(hostId, s.image)!}
            <li>
              {#if admin}
                <label class="check pick">
                  <input type="checkbox" checked={!skipped.has(s.service)} onchange={() => toggleService(s.service)} data-testid="update-pick" />
                  <span><strong>{s.service}</strong></span>
                </label>
              {:else}
                <strong>{s.service}</strong>
              {/if}
              <span class="mono">{s.image}</span>
              <span class="dim small mono">{shortDigest(c.localDigest)} -> {shortDigest(c.remoteDigest)}{c.version ? ` | ${t('changelog.here', { v: c.version })}` : ''}</span>
              <!-- This very version was rolled back here: automatic updates leave it, by hand it is asked first (W-FUNC-03). -->
              {#if c.rolledBackAt}<span class="small rolled">{t('updates.rolledBackOn', { at: dateTime(c.rolledBackAt) })}</span>{/if}
              {#if c.source}<button class="link" onclick={() => (notesFor = [{ hostId, image: s.image }])} data-testid="whats-new">{t('changelog.open')}</button>{/if}
            </li>
          {/each}
        </ul>
        <!-- All their notes in one overview (report bd2d76: each one had to be opened on its own). -->
        {#if withNotes.length > 1}<button class="btn small" onclick={() => (notesFor = withNotes.map((image) => ({ hostId, image })))} data-testid="stack-whats-new">{t(notes.key, { n: notes.n, total: notes.total })}</button>{/if}
        <!-- Automatic updates wait for a person after a breaking change; this is where they read and release it. -->
        {#if info.autoUpdate && hold && hold.held.length}
          {#if hold.released}
            <p class="dim small" data-testid="hold-released">{t('updates.holdReleased', { list: hold.held.join(', ') })}</p>
          {:else}
            <div class="alert small" data-testid="hold">
              <p>{t('updates.holdWaits', { list: hold.held.join(', ') })}</p>
              {#if admin}<button class="btn small" disabled={busy} onclick={releaseHold} data-testid="hold-release">{t('updates.holdRelease')}</button>{/if}
            </div>
          {/if}
        {/if}
        {#if admin}
          {#if withUpdate.length > 1}
            <button class="btn small" onclick={() => (skipped = chosen.length === withUpdate.length ? new Set(withUpdate.map((s) => s.service)) : new Set())}>
              {chosen.length === withUpdate.length ? t('updates.pickNone') : t('updates.pickAll')}
            </button>
          {/if}
          <button class="btn primary" disabled={busy || opRunning || !chosen.length} onclick={updateNow} data-testid="update-now">
            {t('updates.updateNow', { n: chosen.length })}
          </button>
        {/if}
      {:else}
        <p class="dim small" data-testid="stack-check">
          {ownCheck.kind === 'current'
            ? t('updates.allCurrent', { at: dateTime(ownCheck.at) })
            : ownCheck.kind === 'unknown'
              ? t('updates.someUnknown', { n: ownCheck.n })
              : ownCheck.kind === 'unchecked'
                ? t('updates.someUnchecked', { n: ownCheck.n })
                : t('updates.neverChecked')}
        </p>
      {/if}
      {#if newer.length}
        <div class="stack" data-testid="newer-versions">
          <h3 class="small">{t('updates.newer')}</h3>
          <ul class="digests">
            {#each newer as n (n.s.image)}
              <li data-testid="newer-version">
                <span class="mono">{n.s.image}</span>
                <span class="small">{t('updates.newerTag', { tag: n.tag })}</span>
                {#if admin}<button class="btn small" disabled={busy || opRunning || !file} onclick={() => useTag(n.s.image, n.tag)} data-testid="use-tag">{t('updates.useTag', { tag: n.tag })}</button>{/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      <!-- Not for the stack Burrow runs in: it would stop watching halfway. -->
      {#if !info.self && admin}
        <div class="row">
          <label class="check">
            <input type="checkbox" checked={info.autoUpdate} disabled={savingAuto} onchange={(e) => setAuto(e.currentTarget.checked)} data-testid="auto-update" />
            {t('updates.auto')}
          </label>
          <HelpTip text={t('help.autoUpdate')} />
        </div>
      {/if}
    </section>

    <section class="card stack o4" aria-label={t('stack.compose')}>
      <div class="toolbar">
        <h2>{t('stack.compose')} <HelpTip text={t('help.stackCompose')} /></h2>
      </div>
      {#if info.configFiles.length > 1}
        <select bind:value={file} aria-label={t('stack.compose')}>
          {#each info.configFiles as f (f)}<option value={f}>{f}</option>{/each}
        </select>
      {:else}
        <!-- A path in the path style; the words that there is none in the text's (A3-WEB-15). -->
        {#if file}<p class="mono small break">{file}</p>{:else}<p class="small dim">{t('stack.noFile')}</p>{/if}
      {/if}
      {#if file && admin}
        <div class="btnrow stacks">
          <button class="btn" onclick={edit} data-testid="edit-compose"><Icon name="edit" size={16} /> {t('common.edit')}</button>
          <button class="btn primary" disabled={busy || opRunning} onclick={() => openReview()} data-testid="review-deploy">{reviewing ? t('stack.checking') : t('stack.review')}</button>
        </div>
      {/if}
    </section>

    </div>
    </div>
  {/if}
</div>

{#if info}
  <BottomPanel key="stack.{hostId}.{project}" {hostId} cwd={info.workingDir} auto={(c) => c.project === project} autoHelp={t('panel.autoStack')} bind:open={panel} bind:space={panelSpace} dock />
{/if}

<ChangelogDialog items={notesFor} onclose={() => (notesFor = null)} />

<Dialog tour="stack-review" size="wide" bind:open={reviewOpen} title={t('stack.reviewTitle', { name: project })}>
  {#if review}
    <div class="stack">
      <p class="dim small">{review.beforeLabel}</p>
      {#if (info?.configFiles.length ?? 0) > 1}<p class="dim small">{t('stack.reviewScope', { file: review.file })}</p>{/if}
      <!-- What runs may differ from the file although the file did not change here (W-FUNC-04): compose's own hashes say. -->
      {#if differs.length}<p class="alert warn small">{t('stack.willRecreate', { services: differs.join(', ') })}</p>{/if}
      {#if missing.length}<p class="alert warn small">{t('stack.willCreate', { services: missing.join(', ') })}</p>{/if}
      {#if review.before === review.after}
        <p class="small" data-testid="no-changes">{differs.length || missing.length ? t('stack.noChangesInFile') : t('stack.noChanges')}</p>
      {:else}
        <DiffView original={review.before} modified={review.after} label={review.beforeLabel} names={[review.beforeLabel, t('stack.reviewNow')]} />
      {/if}
      {#if review.check.ok}
        <p class="small ok" data-testid="compose-ok"><Icon name="check" size={14} /> {t('editor.composeOk')}</p>
      {:else}
        <p class="alert error small" data-testid="compose-error">{t('stack.invalid')}</p>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
        <pre tabindex="0" class="small mono out">{review.check.output}</pre>
      {/if}
    </div>
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => (reviewOpen = false)}>{t('common.cancel')}</button>
    <button class="btn primary" disabled={!review?.check.ok} onclick={deploy} data-testid="deploy">{t('stack.deploy')}</button>
  {/snippet}
</Dialog>

<style>
  .rolled {
    color: var(--warn);
  }
  .more {
    align-self: flex-start;
  }
  .newer {
    color: color-mix(in srgb, var(--accent) 75%, var(--text));
    font-weight: 600;
  }
  .hidden {
    display: none;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  section {
    margin-bottom: 12px;
  }
  .cols {
    display: flex;
    flex-direction: column;
  }
  .colmain,
  .colside {
    display: contents;
  }
  .o1 { order: 1; }
  .o2 { order: 2; }
  .o3 { order: 3; }
  .o4 { order: 4; }
  .o5 { order: 5; }
  @media (min-width: 900px) {
    .cols {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .colmain,
    .colside {
      display: flex;
      flex-direction: column;
    }
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    /* The help tip beside the title, also when the title wraps. */
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .wrap {
    flex-wrap: wrap;
  }
  .srow {
    gap: 10px;
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
  .dot.bad {
    background: var(--danger);
  }
  .flag {
    flex: none;
  }
  .digests,
  .history {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .history > li + li {
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .uhead {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 10px;
    overflow-wrap: normal;
  }
  /* The date's "|" and its source a space apart, as anywhere else. */
  .uhead > .res + span + span {
    margin-left: -6px;
  }
  .imgs {
    list-style: none;
    margin: 4px 0 0;
    padding: 0 0 0 10px;
    border-left: 2px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .imgs li {
    display: flex;
    flex-direction: column;
  }
  .iname {
    color: var(--text);
  }
  .digests li,
  .history li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-wrap: anywhere;
  }
  .link {
    align-self: flex-start;
  }
  .res {
    font-weight: 700;
  }
  .res.updated {
    color: var(--ok);
  }
  .res.rolled_back,
  .res.failed {
    color: var(--danger);
  }
  .ok {
    color: var(--ok);
  }
  .out {
    max-height: 30dvh;
    overflow: auto;
    white-space: pre-wrap;
    margin: 0;
  }
  .toolbar.wraps {
    flex-wrap: wrap;
  }
  /* Every card's title row as high as one with a small button, as on a host's statistics: a plain
     title sat 6 px above one beside Logs or Check now (a tour check). A close button keeps its
     tap area without making its row taller. */
  .card > h2:first-child,
  .card > .toolbar:first-child,
  .card > .toolbar:first-child > h2 {
    min-height: 36px;
  }
  .card > .toolbar:first-child > :global(.icon-btn) {
    margin-block: -4px;
  }
</style>
