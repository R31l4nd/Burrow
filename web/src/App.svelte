<script lang="ts">
  import { untrack } from 'svelte';
  import PullIndicator from './components/PullIndicator.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import ShortcutsDialog from './components/ShortcutsDialog.svelte';
  import { ask } from './lib/confirm.svelte.js';
  import Mark from './components/Mark.svelte';
  import HostSheet from './components/HostSheet.svelte';
  import type { Host } from '@burrow/shared';
  import Icon from './components/Icon.svelte';
  import StepUpDialog from './components/StepUpDialog.svelte';
  import { errorMessage, onStepUpRequired, onUnauthenticated, put } from './lib/api.js';
  import LoadFailed from './components/LoadFailed.svelte';
  import { idPart, textPart } from './lib/routeparts.js';
  import { t } from './lib/i18n/index.svelte.js';
  import { go, route, unsavedHere } from './lib/router.svelte.js';
  import { keepWhenUnsaved, onAccountChange, refreshSession, session, syncDirectRoute } from './lib/session.svelte.js';
  import { onSessionDoubt } from './lib/dial.js';
  import { forgetPages, lastPages, navTarget, notePage } from './lib/navmemory.js';
  import { inBackground, requestStepUp, toast } from './lib/ui.svelte.js';
  import Toasts from './components/Toasts.svelte';
  import Transfers from './components/Transfers.svelte';
  import PasteClash from './components/PasteClash.svelte';
  import BugReport from './components/BugReport.svelte';
  import { startActivity, stopActivity } from './lib/activity.svelte.js';
  import Audit from './pages/Audit.svelte';
  import Files from './pages/Files.svelte';
  import GroupForm from './pages/GroupForm.svelte';
  import HostForm from './pages/HostForm.svelte';
  import Hosts from './pages/Hosts.svelte';
  import Import from './pages/Import.svelte';
  import Login from './pages/Login.svelte';
  import Sessions from './pages/Sessions.svelte';
  import Setup from './pages/Setup.svelte';
  import Apps from './pages/Apps.svelte';
  import Containers from './pages/Containers.svelte';
  import ContainerDetail from './pages/ContainerDetail.svelte';
  import { loadUpdates, updateCount } from './lib/updates.svelte.js';
  import { appUpdate, checkAppUpdate } from './lib/appupdate.svelte.js';
  import { hints, hintsToFix, loadHints } from './lib/hints.svelte.js';
  import { checkPush, pushEndpoint } from './lib/push.svelte.js';
  import Logs from './pages/Logs.svelte';
  import Alerts from './pages/Alerts.svelte';
  import Invite from './pages/Invite.svelte';
  import HostStats from './pages/HostStats.svelte';
  import HostJournal from './pages/HostJournal.svelte';
  import DockerResources from './pages/DockerResources.svelte';
  import Reports from './pages/Reports.svelte';
  import Report from './pages/Report.svelte';
  import { alertState, loadAlertCount } from './lib/alerts.svelte.js';
  import AppFrame from './pages/AppFrame.svelte';
  import Share from './pages/Share.svelte';
  import { android, nativeSource, syncWidgetKey, type ChangedFile } from './lib/android.js';
  import { upload } from './lib/files.svelte.js';
  import { connectHost } from './lib/sessions.svelte.js';
  import { data, loadAll } from './lib/data.svelte.js';

  let loadError = $state('');
  // xterm is most of the bundle; load it only when a terminal is opened.
  const loadTerminal = () => import('./pages/Terminal.svelte');
  // CodeMirror and its languages load only with the editor.
  const loadEditor = () => import('./pages/Editor.svelte');
  // The workspace (editor, terminal panel) and a stack (its panel, the
  // compose diff) bring CodeMirror and xterm too: loaded when opened (#149).
  const loadWorkspace = () => import('./pages/Workspace.svelte');
  const loadStack = () => import('./pages/Stack.svelte');
  // Watching a shared session and playing a recording bring xterm (F3).
  const loadWatch = () => import('./pages/Watch.svelte');
  const loadRecordings = () => import('./pages/Recordings.svelte');
  // Settings and its parts (AI, channels, users, sign-in...): loaded when opened, out of the first load (the bundle's cap).
  const loadSettings = () => import('./pages/Settings.svelte');
  // The phone's own files: only in the Android app, out of the first load (the bundle's cap, 2.19.0).
  const loadPhoneFiles = () => import('./pages/PhoneFiles.svelte');

  onStepUpRequired(requestStepUp);
  onUnauthenticated(() => void refreshSession().catch(() => {}));
  // A socket that cannot open again and again: perhaps signed out (lib/dial.ts).
  onSessionDoubt(() => void refreshSession().catch(() => {}));
  // Signed out with work not saved on the page: the page stays, the sign-in over it (lib/session.svelte.ts).
  keepWhenUnsaved(unsavedHere);

  // The sign-in over a kept page: modal, and opened again when the browser closed it anyway (a
  // second Escape with nothing pressed in between cannot be stopped, see Dialog.svelte).
  function signInOver(el: HTMLDialogElement) {
    const show = () => {
      if (!el.isConnected || el.open) return;
      el.showModal();
      window.dispatchEvent(new Event('burrow:toplayer'));
    };
    el.addEventListener('close', show);
    show();
    return { destroy: () => el.removeEventListener('close', show) };
  }

  // Who is signed in could not be read (Burrow restarting behind its proxy): said, with a way to
  // try again, not a raw error for good (AUDIT2 UX-10).
  function boot() {
    loadError = '';
    refreshSession().catch((err: unknown) => {
      loadError = errorMessage(err);
    });
  }
  boot();

  // A file opened in another Android app came back changed: offer to put it
  // back where it came from.
  android?.on('fileChanged', async (raw) => {
    const f = raw as ChangedFile;
    const host = data.hosts.find((h) => h.id === f.hostId)?.name ?? '';
    if (!(await ask({ text: t('files.changedUpload', { name: f.name, host, path: f.path }), confirm: t('files.putBack') }))) return void android!.release(f.token);
    const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
    upload(f.hostId, dir, [{ ...nativeSource(f), name: f.path.slice(f.path.lastIndexOf('/') + 1) }], () => void android!.release(f.token), true);
  });

  const s = $derived(session.state);
  const section = $derived(route.parts[0] ?? 'hosts');
  // The key vault, the snippets and the recordings' list are parts of the settings now (reports
  // 8f4db3, e34ebd): their old addresses (links, bookmarks, the app's shortcuts) lead there.
  $effect(() => {
    // All hosts too (report 5c1209).
    const moved = section === 'keys' || section === 'snippets' || (section === 'recordings' && !route.parts[1]) ? section : section === 'groups' && route.parts[1] === 'all' ? 'hosts' : null;
    if (moved) location.replace(`#/settings/${moved}${route.query.run === '1' ? '?run=1' : ''}`);
  });
  // Each section's last page, for its button in the rail or the bottom bar.
  $effect(() => notePage(route.path));
  onAccountChange(forgetPages);
  // Setup stays on screen until the wizard is finished, also after the
  // account exists but before the recovery codes were shown.
  const inSetup = $derived(s !== null && (s.setupRequired || s.user?.incomplete === true));
  // The update count on Containers: at sign-in and every ten minutes.
  // What runs on the server (the busy pill): admins start operations.
  $effect(() => {
    if (s?.user?.role !== 'admin' || inSetup) return;
    startActivity();
    // How Burrow runs (a proxy it was not told about, a full disk) and the open problem reports.
    inBackground(loadHints());
    const hintTimer = setInterval(() => inBackground(loadHints()), 300_000);
    return () => {
      stopActivity();
      clearInterval(hintTimer);
    };
  });
  $effect(() => {
    if (!s?.user || inSetup) return;
    inBackground(loadUpdates());
    inBackground(loadAlertCount());
    // The rail's "Your hosts" from the first page on, not only after Hosts was opened (UIB-05).
    if (!untrack(() => data.loaded)) void loadAll().catch(() => {});
    // In the app: where Burrow's push reaches this phone, told to Burrow
    // now and whenever the distributor gives a new address.
    void checkPush().catch(() => {});
    const offPush = android?.on('pushEndpoint', (d) => void pushEndpoint(d as Parameters<typeof pushEndpoint>[0]).catch(() => {}));
    // In the app: a newer app on this Burrow, said once per version.
    void checkAppUpdate().then(
      (v) => v && toast(t('android.updateTold', { version: v })),
      () => {},
    );
    // The widget's own key to Burrow (signed in with this phone's key): it reads its counts after the sign-in ran out.
    void syncWidgetKey(put);
    const timer = setInterval(() => inBackground(loadUpdates()), 600_000);
    const alertTimer = setInterval(() => inBackground(loadAlertCount()), 60_000);
    return () => {
      clearInterval(timer);
      clearInterval(alertTimer);
      offPush?.();
    };
  });

  // In the paired Android app: keep the direct route's key and cache current.
  let directSynced = false;
  $effect(() => {
    if (android && s?.deviceId && !directSynced) {
      directSynced = true;
      void syncDirectRoute();
    }
  });

  // Back from single sign-on: say how it went, once.
  $effect(() => {
    const r = route.query.sso;
    if (!r) return;
    const known = ['stepped_up', 'unknown', 'failed', 'expired', 'wrong_user', 'invite_invalid', 'already_linked'];
    const key = known.includes(r) ? r : 'failed';
    toast(t(`sso.back.${key}` as 'sso.back.failed'), key === 'stepped_up' ? 'info' : 'error');
    const q = { ...route.query };
    delete q.sso;
    const rest = new URLSearchParams(q).toString();
    const path = `${route.path.split('?')[0]}${rest ? `?${rest}` : ''}`;
    history.replaceState(history.state, '', `#${path}`);
    route.path = path;
    route.query = q;
  });

  // #/hosts?connect=12: a home screen shortcut of the Android app, or any
  // link. A link never acts by itself: the terminal opens only after a tap on
  // a question that names the host (A3-WEB-07, A3-AND-05). Once per link: a
  // step-up on the way renews the session state, which ran this again and
  // opened a second session (AUDIT2 PAGE-16).
  let connectTaken: string | null = null;
  $effect(() => {
    const id = Number(route.query.connect);
    if (!id) connectTaken = null;
    else if (s?.user && !inSetup && section === 'hosts' && data.loaded && connectTaken !== route.path) {
      connectTaken = route.path;
      void confirmConnect(id);
    }
  });
  async function confirmConnect(id: number) {
    // Added elsewhere since the list was read: read again before saying it is not there.
    let h = data.hosts.find((x) => x.id === id);
    if (!h) h = await loadAll().then(() => data.hosts.find((x) => x.id === id), () => undefined);
    // The link's part taken off the address: a reload does not ask again.
    history.replaceState(history.state, '', '#/hosts');
    if (!h) return toast(t('hosts.connectUnknown'), 'error');
    if (!(await ask({ text: t('hosts.connectAsk', { name: h.name, address: h.address }), confirm: t('hosts.connectGo') }))) return;
    await connectHost(id).catch(() => {});
  }

  // The rail's hosts (a wide screen): the ones used last first, a few only;
  // one opens the host menu, as a row on the Hosts page does.
  const RAIL_HOSTS = 10;
  const railHosts = $derived(
    [...data.hosts].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name)).slice(0, RAIL_HOSTS),
  );
  let railHost = $state<Host | null>(null);
  let railSheet = $state(false);
  // A page that takes the whole screen (a terminal, an editor, an app): the
  // rail narrows to its icons on a computer and the bar goes on a phone.
  // Logs of a host itself (its journals, its log files) belong to Hosts in the rail, a container's to Containers.
  const hostLogs = $derived(section === 'logs' && (route.query.t ?? '').split(',').every((x) => /^\d+::/.test(x.trim())));
  // A tablet upright (720-899 px): the rail too, as icons, rather than a phone's bar across the bottom (decision 27).
  const tabletQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 720px) and (max-width: 899px)') : null;
  const tablet = $state({ on: tabletQuery?.matches ?? false });
  tabletQuery?.addEventListener('change', () => (tablet.on = tabletQuery.matches));
  const full = $derived((section === 'term' || section === 'edit' || section === 'apps' || section === 'ws') && !!route.parts[1]);
</script>

{#snippet badAddress()}
  <div class="center-screen stack" data-testid="bad-address">
    <h1>{t('common.badAddress')}</h1>
    <a class="btn" href="#/hosts">{t('nav.hosts')}</a>
  </div>
{/snippet}

{#if loadError}
  <main class="contents"><LoadFailed message={loadError} onretry={boot} heading /></main>
{:else if !s}
  <div class="center-screen dim">{t('common.loading')}</div>
{:else if section === 'invite' && route.parts[1] && !s.user}
  <!-- Keyed: another invite's address is another invite, its role and its acceptance (AUDIT2 PAGE-14). -->
  {#key route.parts[1]}<main class="contents"><Invite token={route.parts[1]} /></main>{/key}
{:else if inSetup}
  <main class="contents"><Setup /></main>
{:else if !s.user && session.keptFor === null}
  <main class="contents"><Login /></main>
{:else}
  {#if !s.user}
    <!-- Signed out with work not saved on the page (the sign-in ran out, or was ended elsewhere):
         the page stays behind the sign-in, and is there to save from once signed in again. A modal
         of its own, opened last: over a dialog the page has open too, and the only thing to use. -->
    <dialog class="signin-over" aria-label={t('login.title')} use:signInOver oncancel={(e) => e.preventDefault()} data-testid="signin-over"><Login kept /></dialog>
  {/if}
  <!-- The page itself: one landmark, apart from the navigation. display:
       contents keeps the pages' own layout exactly as it was. -->
  <main class="contents">
  <!-- A page anew for each address, but the settings one page across their parts: made anew, the
       list at the left went back to its top at every part chosen (report a55e25). Another account
       signed in over a kept page: a page of its own. -->
  {#key `${s.user?.id ?? session.keptFor}:${section === 'settings' && route.parts[1] !== 'audit' ? 'settings' : route.path}`}
  {#if section === 'term' && route.parts[1]}
    {#await loadTerminal()}
      <div class="center-screen dim">{t('common.loading')}</div>
    {:then m}
      <m.default id={route.parts[1]} />
    {:catch err}
      <!-- The page's code did not load (often: Burrow was updated meanwhile). -->
      <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
    {/await}
  {:else if section === 'term'}
    <Sessions />
  {:else if section === 'edit' && route.parts[1]}
    {#await loadEditor()}
      <div class="center-screen dim">{t('common.loading')}</div>
    {:then m}
      <!-- #/edit/phone: a text file of the phone itself (the Android app). -->
      <m.default hostId={route.parts[1] === 'phone' ? 0 : Number(route.parts[1])} phone={route.parts[1] === 'phone'} />
    {:catch err}
      <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
    {/await}
  {:else if section === 'files' && route.parts[1] === 'phone'}
    {#await loadPhoneFiles()}
      <div class="center-screen dim">{t('common.loading')}</div>
    {:then m}
      <m.default />
    {:catch err}
      <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
    {/await}
  {:else if section === 'files'}
    <Files hostId={route.parts[1] ? Number(route.parts[1]) : null} />
  {:else if section === 'containers' && route.parts[2]}
    {@const hostId = idPart(route.parts[1])}
    {@const name = textPart(route.parts[2])}
    {#if hostId !== null && name !== null}<ContainerDetail {hostId} {name} />{:else}{@render badAddress()}{/if}
  {:else if section === 'containers'}
    <Containers />
  {:else if section === 'stacks' && route.parts[2]}
    {@const hostId = idPart(route.parts[1])}
    {@const project = textPart(route.parts[2])}
    {#if hostId !== null && project !== null}
      {#await loadStack()}
        <div class="center-screen dim">{t('common.loading')}</div>
      {:then m}
        <m.default {hostId} {project} />
      {:catch err}
        <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
      {/await}
    {:else}{@render badAddress()}{/if}
  {:else if section === 'ws' && route.parts[1]}
    {#await loadWorkspace()}
      <div class="center-screen dim">{t('common.loading')}</div>
    {:then m}
      <m.default id={Number(route.parts[1])} />
    {:catch err}
      <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
    {/await}
  {:else if section === 'logs'}
    <Logs targets={route.query.t ?? ''} at={route.query.at ?? null} atLine={route.query.ah ? { i: Number(route.query.ai ?? 0), h: route.query.ah } : null} analyze={route.query.analyze === '1'} />
  {:else if section === 'alerts'}
    <Alerts />
  {:else if section === 'reports' && route.parts[1]}
    <Report id={Number(route.parts[1])} />
  {:else if section === 'reports'}
    <Reports />
  {:else if section === 'apps' && route.parts[1]}
    <AppFrame id={Number(route.parts[1])} />
  {:else if section === 'apps'}
    <Apps />
  {:else if section === 'share'}
    <Share />
  {:else if section === 'watch' && route.parts[1]}
    {@const sid = textPart(route.parts[1])}
    {#if sid !== null}
      {#await loadWatch()}
        <div class="center-screen dim">{t('common.loading')}</div>
      {:then m}
        <m.default id={sid} />
      {:catch err}
        <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
      {/await}
    {:else}{@render badAddress()}{/if}
  {:else if section === 'recordings' && !route.parts[1]}
    <!-- Parts of the settings now (report e34ebd): the old addresses lead there (moved). -->
  {:else if section === 'recordings'}
    {#await loadRecordings()}
      <div class="center-screen dim">{t('common.loading')}</div>
    {:then m}
      <m.default id={route.parts[1] ? idPart(route.parts[1]) : null} />
    {:catch err}
      <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
    {/await}
  {:else if section === 'snippets'}
    <!-- Moved to #/settings/snippets. -->
  {:else if section === 'hosts' && route.parts[1] === 'new'}
    <HostForm id={null} />
  {:else if section === 'hosts' && route.parts[2] === 'docker'}
    <DockerResources hostId={Number(route.parts[1])} />
  {:else if section === 'hosts' && route.parts[2] === 'journal'}
    <HostJournal hostId={Number(route.parts[1])} />
  {:else if section === 'hosts' && route.parts[2] === 'stats'}
    <HostStats hostId={Number(route.parts[1])} />
  {:else if section === 'hosts' && route.parts[2] === 'edit'}
    <HostForm id={Number(route.parts[1])} />
  {:else if section === 'groups' && route.parts[1] === 'all'}
    <!-- Moved to #/settings/hosts. -->
  {:else if section === 'groups' && route.parts[1] === 'new'}
    <GroupForm id={null} />
  {:else if section === 'groups' && route.parts[2] === 'edit'}
    <GroupForm id={Number(route.parts[1])} />
  {:else if section === 'keys'}
    <!-- Moved to #/settings/keys. -->
  {:else if section === 'import'}
    <Import />
  {:else if section === 'settings' && route.parts[1] === 'audit'}
    <Audit />
  {:else if section === 'settings'}
    {#await loadSettings()}
      <div class="center-screen dim">{t('common.loading')}</div>
    {:then m}
      <m.default />
    {:catch err}
      <LoadFailed message={errorMessage(err)} onretry={() => location.reload()} heading />
    {/await}
  {:else}
    <Hosts />
  {/if}
  {/key}
  </main>

  <!-- The terminal takes the whole screen; its own bar leads back. On a
       computer a narrow rail of icons stays beside it; on a phone nothing. -->
  <nav class="bottomnav" class:compact={full || tablet.on} aria-label={t('nav.main')}>
    <!-- The mark and the name, in the rail on a wide screen. -->
    <div class="rail-brand"><Mark /><span class="rail-word">Burrow</span></div>
    {#each ([{ id: 'hosts', icon: 'server', label: t('nav.hosts') }, { id: 'term', icon: 'terminal', label: t('nav.terminal') }, { id: 'files', icon: 'folder', label: t('nav.files') }, { id: 'containers', icon: 'box', label: t('nav.containers') }, { id: 'settings', icon: 'settings', label: t('nav.settings') }] as const).filter((x) => x.id !== 'term' || s.user?.role === 'admin') as item (item.id)}
      <a
        href={`#/${item.id}`}
        aria-label={full ? item.label : undefined}
        title={full ? item.label : undefined}
        aria-current={section === item.id || (item.id === 'hosts' && (['groups', 'import', 'watch'].includes(section) || hostLogs)) || (item.id === 'settings' && ['keys', 'snippets', 'recordings'].includes(section)) || (item.id === 'containers' && ['apps', 'stacks', 'alerts', 'reports'].includes(section)) || (item.id === 'containers' && section === 'logs' && !hostLogs) ? 'page' : undefined}
        onclick={(e) => {
          e.preventDefault();
          // Back where this section was left; pressed while in it, its start (report d6ea6c).
          go(navTarget(item.id, route.path, lastPages()));
        }}
      >
        <span class="navicon">
          <Icon name={item.icon} />
          <!-- Two signs that never swap places: a red count of new alerts
               (top right), a dot for image updates (bottom right). -->
          {#if item.id === 'containers' && alertState.unread}<span class="navbadge bad" data-testid="alerts-badge" aria-label={t('alerts.unread', { n: alertState.unread })}>{alertState.unread}</span>{/if}
          {#if item.id === 'containers' && updateCount()}<span class="navdot" data-testid="updates-badge" role="img" aria-label={t('updates.count', { n: updateCount() })} title={t('updates.count', { n: updateCount() })}></span>{/if}
          {#if item.id === 'settings' && hints.h?.openReports}<span class="navbadge" data-testid="reports-badge" aria-label={t('bug.openCount', { n: hints.h.openReports })}>{hints.h.openReports}</span>{/if}
          {#if item.id === 'settings' && hintsToFix() && !appUpdate.apk}<span class="navdot" role="img" aria-label={t('hints.title')} title={t('hints.title')}></span>{/if}
          {#if item.id === 'settings' && appUpdate.apk}<span class="navdot" role="img" aria-label={t('android.updateAvailable', { version: appUpdate.apk.versionName })} title={t('android.updateAvailable', { version: appUpdate.apk.versionName })}></span>{/if}
        </span>
        <span class="navlabel">{item.label}</span>
      </a>
    {/each}
    {#if railHosts.length && !full && !tablet.on}
      <div class="rail-hosts" aria-label={t('nav.yourHosts')} role="group">
        <span class="rail-sub">{t('nav.yourHosts')}</span>
        {#each railHosts as h (h.id)}
          {@const st = data.status[h.id]}
          <button type="button" class="rail-host" onclick={() => ((railHost = h), (railSheet = true))} data-testid="rail-host">
            <span class="dot" class:up={st?.reachable} class:down={st && !st.reachable}></span>
            <span class="rail-name">{h.name}</span>
          </button>
        {/each}
      </div>
    {/if}
  </nav>
  <!-- Kept once a host was picked, as the Hosts page keeps its menu: what the menu opens after closing
       (its remembered commands) is part of it, and went with it (report 63e44b). -->
  {#if railHost}<HostSheet host={railHost} bind:open={railSheet} />{/if}
{/if}

<StepUpDialog />
<ConfirmDialog />
<PullIndicator />
{#if s?.user && !inSetup}<Transfers /><PasteClash /><BugReport /><ShortcutsDialog />{/if}

<Toasts />
