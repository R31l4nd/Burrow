<script lang="ts">
  import { roving } from '../lib/roving.js';
  import LoadFailed from '../components/LoadFailed.svelte';
  import { ask, askText } from '../lib/confirm.svelte.js';
  import { PROJECT_URL, projectPublished, type BackgroundJob, type KnownHost, type LogEvent, type PasskeyInfo, type SessionInfo, type UpdateCheck } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import Keys from './Keys.svelte';
  import Snippets from './Snippets.svelte';
  import ScheduledCommands from '../components/ScheduledCommands.svelte';
  import GroupForm from './GroupForm.svelte';
  import ShortcutsTable from '../components/ShortcutsTable.svelte';
  import AiSettings from '../components/AiSettings.svelte';
  import SystemSettings from '../components/SystemSettings.svelte';
  import AndroidSettings from '../components/AndroidSettings.svelte';
  import UpdateSettings from '../components/UpdateSettings.svelte';
  import PushSettings from '../components/PushSettings.svelte';
  import UserSettings from '../components/UserSettings.svelte';
  import SsoSettings from '../components/SsoSettings.svelte';
  import ChannelSettings from '../components/ChannelSettings.svelte';
  import HelpTip from '../components/HelpTip.svelte';
  import Icon from '../components/Icon.svelte';
  import TotpSetup from '../components/TotpSetup.svelte';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { bug, setArmed } from '../lib/bugreport.svelte.js';
  import ProblemReports from '../components/ProblemReports.svelte';
  import { formatBytes } from '../lib/files.svelte.js';
  import { androidInfo } from '../lib/android.js';
  import { compareVersions, WEB_VERSION } from '../lib/version.js';
  import { whatsNew } from '../lib/whatsnew.js';
  import { dateTime, locale, locales, relativeTime, setLocale, t, type Locale } from '../lib/i18n/index.svelte.js';
  import type { MessageKey } from '../lib/i18n/en.js';
  import type { ComponentProps } from 'svelte';
  import { go, route, up } from '../lib/router.svelte.js';
  import { ACCENTS, appearance, setAccent, setMode, type ThemeMode } from '../lib/theme.svelte.js';
  import { prefs, savePrefs } from '../lib/sessions.svelte.js';
  import { DEFAULT_BAR } from '../lib/terminal.js';
  import { keyBars } from '../lib/keyboard.svelte.js';
  import { MOD } from '../lib/shortcuts.svelte.js';
  import { deviceName, refreshSession, registerPasskey, session } from '../lib/session.svelte.js';
  import { attempt, copyText, toast } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';
  import { hints } from '../lib/hints.svelte.js';

  let passkeys = $state<PasskeyInfo[]>([]);
  let sessions = $state<SessionInfo[]>([]);
  let known = $state<KnownHost[]>([]);
  let recoveryLeft = $state<number | null>(null);
  let newCodes = $state<string[] | null>(null);
  // New codes replace the old ones at once: kept on screen, and asked before another page, until saved (AUDIT2 PAGE-32).
  let codesKept = $state(false);
  warnUnsaved(() => newCodes !== null && !codesKept);
  let totpOpen = $state(false);
  let passwordOpen = $state(false);
  let newPassword = $state('');
  let busy = $state(false);
  // The newest few signed-in browsers; the rest one tap away.
  const SESSIONS_SHOWN = 5;
  let allSessions = $state(false);
  // Burrow's own warnings: the newest few, the rest on a tap (report 5d1b13: forty of them made the page eight screens long).
  const EVENTS_SHOWN = 5;
  let allEvents = $state(false);

  // Burrow updating itself: what the folder would start, then the update,
  // waiting until another server version answers.
  let selfUpdate = $state<UpdateCheck | null>(null);
  let selfBusy = $state<'check' | 'update' | null>(null);
  async function checkSelf() {
    selfBusy = 'check';
    try {
      selfUpdate = await get<UpdateCheck>('/api/system/update');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      selfBusy = null;
    }
  }
  const CODES = ['running', 'updated', 'nothing_new', 'not_found', 'keep_failed', 'pull_failed', 'build_failed', 'backup_failed', 'up_failed', 'rolled_back', 'both_unhealthy', 'backup_not_started'] as const;
  /** The host's words for how the update went, in the app's language when known. */
  const lastWords = (l: { code?: string; message: string }) =>
    l.code && (CODES as readonly string[]).includes(l.code) ? t(`about.msg.${l.code as (typeof CODES)[number]}`) : l.message;
  // What the check found, against what runs: an older version is not offered as an update ("Update to 1.2.0" beside 2.0.2, UIA-21).
  const found = $derived(
    !selfUpdate?.available || selfUpdate.available === selfUpdate.running ? 'same' : selfUpdate.running && compareVersions(selfUpdate.available, selfUpdate.running) < 0 ? 'older' : 'newer',
  );

  async function updateSelf() {
    if (!selfUpdate?.target) return;
    // Breaking changes in between are in the question too, and make it red.
    const breaking = selfUpdate.breaking ?? [];
    const text = breaking.length ? `${t('about.updateConfirm', { host: selfUpdate.target.hostName })}\n\n${t('about.breaking')}\n${breaking.map((b) => `- ${b}`).join('\n')}` : t('about.updateConfirm', { host: selfUpdate.target.hostName });
    if (!(await ask({ text, confirm: t('about.updateNow'), danger: breaking.length > 0 }))) return;
    selfBusy = 'update';
    try {
      const { from } = await post<{ from: string }>('/api/system/update', {});
      // Up to ten minutes: a build takes a while. Errors mean it restarts. Kept on when Settings is
      // left on purpose: the new version reloads the app wherever it is, and its outcome is said there.
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const v = await get<{ server: string }>('/api/version').catch(() => null);
        if (v && v.server !== from) return location.reload();
        const now = await get<UpdateCheck>('/api/system/update').catch(() => null);
        if (now?.last && now.last.state !== 'running' && Date.parse(now.last.at) > Date.now() - 20 * 60_000 && i > 3) {
          selfUpdate = now;
          // A new version: the page too. Nothing new: said, no reload.
          if (now.last.state === 'done' && now.last.code !== 'nothing_new') return location.reload();
          toast(lastWords(now.last), now.last.state === 'done' ? 'info' : 'error');
          return;
        }
      }
      toast(t('about.updateSlow'), 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      selfBusy = null;
    }
  }

  const user = $derived(session.state?.user);
  // Operators see their own account; the rest is the admin's.
  const admin = $derived(user?.role === 'admin');

  async function load() {
    [passkeys, sessions, known] = await Promise.all([
      get<PasskeyInfo[]>('/api/account/passkeys'),
      get<SessionInfo[]>('/api/account/sessions'),
      session.state?.user?.role === 'admin' ? get<KnownHost[]>('/api/known-hosts') : Promise.resolve([]),
    ]);
    recoveryLeft = (await get<{ remaining: number }>('/api/account/recovery-codes')).remaining;
  }
  // Not read is not "none": the lists below say nothing while this says why (AUDIT2 PAGE-08).
  let accountError = $state('');
  function firstLoad() {
    accountError = '';
    load().catch((err: unknown) => (accountError = errorMessage(err)));
  }
  firstLoad();

  async function run(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
      await Promise.all([load(), refreshSession()]);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  const addPasskey = () =>
    run(async () => {
      const name = await askText({ text: t('settings.passkeyNameHelp'), confirm: t('settings.addPasskey'), input: { label: t('settings.passkeyName'), value: deviceName() } });
      if (name) await registerPasskey(name);
    });

  const removePasskey = (p: PasskeyInfo) =>
    run(async () => {
      if ((await ask({ text: t('common.confirmDelete', { name: p.name }), confirm: t('common.delete'), danger: true }))) await del(`/api/account/passkeys/${p.id}`);
    });

  const savePassword = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      await put('/api/account/password', { password: newPassword });
      newPassword = '';
      passwordOpen = false;
    });
  };

  const removePassword = () =>
    run(async () => {
      if ((await ask({ text: t('settings.removePasswordConfirm'), confirm: t('settings.removePassword'), danger: true }))) await del('/api/account/password');
    });

  const disableTotp = () =>
    run(async () => {
      if ((await ask({ text: t('settings.totpDisableConfirm'), confirm: t('settings.totpDisable'), danger: true }))) await del('/api/account/totp');
    });

  const regenerate = async () => {
    if (!(await ask({ text: t('settings.recoveryConfirm'), confirm: t('settings.recoveryRegenerate'), danger: true }))) return;
    await newRecoveryCodes();
  };
  const newRecoveryCodes = () =>
    run(async () => {
      codesKept = false;
      newCodes = (await post<{ recoveryCodes: string[] }>('/api/account/recovery-codes')).recoveryCodes;
    });

  const revoke = (s: SessionInfo) =>
    run(async () => {
      await del(`/api/account/sessions/${s.id}`);
      if (s.current) location.reload();
    });

  const revokeOthers = () =>
    run(async () => {
      if ((await ask({ text: t('settings.revokeOthersConfirm'), confirm: t('settings.revokeOthers'), danger: true }))) await del('/api/account/sessions');
    });

  const removeKnown = (k: KnownHost) =>
    run(async () => {
      if ((await ask({ text: t('common.confirmDelete', { name: `${k.host}:${k.port}` }), confirm: t('common.delete'), danger: true }))) await del(`/api/known-hosts/${k.id}`);
    });

  async function signOut() {
    // Signed out on purpose: nothing of this page kept behind the sign-in.
    if (await attempt(() => post('/api/auth/logout'))) await refreshSession(false);
  }

  const shortUa = (ua: string | null) => {
    if (!ua) return '-';
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return [os, br].filter(Boolean).join(' | ') || ua.slice(0, 40);
  };

  // Which Burrow this is: the page (built into it), the server, the app.
  const webVersion = WEB_VERSION;
  // What this release brought, in the page's language (report 4c30b4).
  const notes = $derived(whatsNew(webVersion, locale()));
  let serverVersion = $state<string | null>(null);
  let appVersion = $state<string | null>(null);
  // Not read: said under About (the server's version unknown is not "the same as the page's", A3-WEB-01).
  let versionError = $state('');
  void get<{ server: string }>('/api/version').then(
    (v) => (serverVersion = v.server),
    (err: unknown) => (versionError = errorMessage(err)),
  );
  void androidInfo().then((i) => (appVersion = i?.version ?? null));
  // What the server does by itself, for admins: when each job last ran and its last failure (OPS-W-14).
  let jobs = $state<BackgroundJob[]>([]);
  $effect(() => {
    if (admin && at('about')) void get<BackgroundJob[]>('/api/system/jobs').then((j) => (jobs = j), () => {});
  });
  // Burrow's own warnings and errors of the last 30 days, grouped: the container's log goes with a deploy (OPS-W-13).
  let logEvents = $state<LogEvent[] | null>(null);
  $effect(() => {
    if (admin && at('about')) void get<LogEvent[]>('/api/system/log-events').then((e) => (logEvents = e), () => {});
  });

  // The backups' last round (the backup service writes it; admins only).
  let backup = $state<{ ok: boolean; at: string; file: string | null; bytes: number | null; count: number | null; remote: boolean | null; error: string | null } | null>(null);
  let backupStaleMs = $state(2 * 86_400_000);
  let backupError = $state('');
  // Asked for one now (report 445f22): the backup service takes the request
  // within seconds; it is done when its last round is newer than the request.
  let backupAsked = $state<string | null>(null);
  // The service has the request (it took the marker away): making it now.
  let backupTaken = $state(false);
  let backupDownload = $state<{ file: string; bytes: number } | null>(null);
  // How to put one back (2026-11-07): the command to copy, run on the host in Burrow's folder.
  const restoreCommand = $derived(`bash scripts/restore.sh backups/${backupDownload?.file ?? backup?.file ?? 'burrow-<time>.tar.gz.enc'}`);
  async function copyRestore() {
    if (await copyText(restoreCommand)) toast(t('backup.restoreCopied'));
    else toast(t('backup.restoreNoCopy'), 'error');
  }
  const readBackup = () =>
    get<{ status: typeof backup; staleAfterMs: number; requestedAt: string | null; download: typeof backupDownload }>('/api/backup/status').then(
      // A request taken by the service (its marker gone) is still ours until a
      // round newer than it ends: the old round was announced as the new one
      // the moment the service took it (AUDIT2 PAGE-04).
      (r) => (
        (backup = r.status),
        (backupStaleMs = r.staleAfterMs),
        (backupTaken = backupAsked !== null && r.requestedAt === null),
        (backupAsked = r.requestedAt ?? (backup && backupAsked && Date.parse(backup.at) >= Date.parse(backupAsked) ? null : backupAsked)),
        (backupDownload = r.download),
        (backupError = '')
      ),
      // Not read is not "no backup yet" (audit WP-07).
      (err: unknown) => (backupError = errorMessage(err)),
    );
  $effect(() => {
    if (!admin) return;
    void readBackup();
  });
  const backupBusy = $derived(backupAsked !== null && !(backup && Date.parse(backup.at) >= Date.parse(backupAsked)));
  // Not taken within a minute: the service is not running (or not this version).
  let backupNow = $state(Date.now());
  const backupStuck = $derived(backupBusy && !backupTaken && backupNow - Date.parse(backupAsked!) > 60_000);
  $effect(() => {
    if (!backupBusy) return;
    const timer = setInterval(() => ((backupNow = Date.now()), void readBackup()), 3000);
    return () => clearInterval(timer);
  });
  let wasBusy = false;
  $effect(() => {
    if (wasBusy && !backupBusy && backup) toast(backup.ok ? t('backup.made') : t('backup.failed', { at: dateTime(backup.at), error: backup.error ?? '' }), backup.ok ? 'info' : 'error');
    wasBusy = backupBusy;
  });
  async function backUpNow() {
    try {
      backupAsked = (await post<{ requestedAt: string }>('/api/backup/now')).requestedAt;
      backupNow = Date.now();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // The parts of the settings, each a page of its own (#/settings/<id>).
  const sections = $derived(
    (
      [
        { id: 'appearance', label: t('settings.appearance'), icon: 'settings' },
        { id: 'terminal', label: t('settings.terminal'), icon: 'terminal' },
        // What the keys do: on a computer only, a phone has none (a dialog below the list before, report 5c1209).
        ...(keyBars.show ? [] : [{ id: 'shortcuts', label: t('shortcuts.title'), icon: 'keyboard' }]),
        { id: 'notify', label: t('push.title'), icon: 'bell' },
        ...(admin
          ? [
              { id: 'ai', label: t('ai.title'), icon: 'sparkle' },
              { id: 'channels', label: t('channels.title'), icon: 'send' },
              { id: 'updates', label: t('updates.settingsTitle'), icon: 'updates' },
              { id: 'users', label: t('users.title'), icon: 'user' },
              { id: 'sso', label: t('sso.title'), icon: 'key' },
              // A page of its own before, below the list (report 5c1209).
              { id: 'hosts', label: t('group.all'), icon: 'server' },
              // Pages of their own before, set out unlike the rest (reports 8f4db3, e34ebd).
              { id: 'keys', label: t('keys.title'), icon: 'key' },
              { id: 'snippets', label: t('nav.snippets'), icon: 'code' },
              { id: 'scheduled', label: t('sched.title'), icon: 'bolt' },
              { id: 'recordings', label: t('rec.title'), icon: 'play' },
            ]
          : []),
        { id: 'android', label: t('android.title'), icon: 'phone' },
        { id: 'security', label: t('settings.security'), icon: 'lock' },
        ...(admin ? [{ id: 'backups', label: t('backup.title'), icon: 'save' }] : []),
        // What was only in the .env file (the user, 2026-11-03).
        ...(admin ? [{ id: 'system', label: t('system.title'), icon: 'layers' }] : []),
        { id: 'about', label: t('about.title'), icon: 'info' },
        { id: 'report', label: t('bug.title'), icon: 'bug' },
      ] as const
    ).map((x) => ({ ...x, icon: x.icon as ComponentProps<typeof Icon>['name'], what: t(`settings.what.${x.id}` as MessageKey) })),
  );
  const current = $derived(route.parts[1] && sections.some((x) => x.id === route.parts[1]) ? route.parts[1] : null);
  // From a tablet up the list stays at the left and a part is open beside it, the first when none was
  // chosen: the list alone in the middle of a big screen looked unlike every other part (report 774696).
  const wideQuery = typeof window === 'undefined' ? null : window.matchMedia('(min-width: 720px)');
  let wide = $state(wideQuery?.matches ?? false);
  $effect(() => {
    const q = wideQuery;
    if (!q) return;
    const on = () => (wide = q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  });
  // The list beside the part stays in view while the part scrolls, but only when all of it fits: a list
  // taller than the window scrolled on its own, a second scroll bar beside the page's (report 9abc2b).
  let sideHeight = $state(0);
  let viewHeight = $state(typeof window === 'undefined' ? 0 : window.innerHeight);
  const shown = $derived(current ?? (wide ? (sections[0]?.id ?? null) : null));
  const at = (id: string) => shown === id;

  // #/settings?s=push: straight to that section (from "Set up push").
  // #/settings?s=channels (links from elsewhere): that part's own page.
  $effect(() => {
    const id = route.query.s;
    if (id && sections.some((x) => x.id === id)) location.replace(`#/settings/${id}`);
  });
</script>


<svelte:window bind:innerHeight={viewHeight} />

<div class="page settings narrow">
  <header class="topbar">
    {#if current && !wide}
      <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/settings')} data-testid="settings-back"><Icon name="back" /></button>
      <h1>{t('settings.title')}</h1>
    {:else}
      <h1>{t('settings.title')}</h1>
      <button class="btn small" onclick={signOut}>{t('settings.signOut')}</button>
    {/if}
  </header>

  <div class="layout" class:two={wide && shown}>
  <!-- One list of the parts: the page on a phone, the column at the left of the open part from a
       tablet up (reports 117b14, ab8f2a, 774696), the same rows either way. -->
  {#if !current || wide}
  <div class="side" class:stick={sideHeight <= viewHeight - 32} bind:offsetHeight={sideHeight} data-testid="settings-side">
  <p class="dim">{user?.username}</p>
  <!-- How Burrow runs, for admins (decision 12, OPS-W-02): what to fix on the server. -->
  {#if admin && hints.h?.trustProxy}
    <!-- data-content: what to fix is the page's content here, not a bar above it. -->
    <div class="alert warn small" role="note" data-content data-testid="hint-trust-proxy">
      <p>{hints.h.trustProxy.current ? t('hints.trustProxyStale', { proxy: hints.h.trustProxy.proxies.join(', '), current: hints.h.trustProxy.current }) : t('hints.trustProxyEmpty', { proxy: hints.h.trustProxy.proxies.join(', ') })}</p>
      <p>{t('hints.trustProxySet')} <code>TRUST_PROXY={hints.h.trustProxy.suggest}</code></p>
    </div>
  {/if}
  {#if admin && hints.h?.diskFull}<p class="alert error small" role="note" data-content>{t('hints.diskFull')}</p>{/if}

  <!-- Each part of the settings on a page of its own. -->
  <nav class="list" aria-label={t('settings.sections')} data-testid="settings-sections">
    {#each sections as x (x.id)}
      <button class="list-item part" class:on={wide && x.id === shown} aria-current={wide && x.id === shown ? 'page' : undefined} onclick={() => go(`/settings/${x.id}`)} data-testid="settings-section">
        <Icon name={x.icon} />
        <span class="main"><span class="title">{x.label}</span><span class="sub">{x.what}</span></span>
        <!-- Problem reports still open: a count, so new ones are not left unread (W-FUNC-11). -->
        {#if x.id === 'report' && admin && hints.h?.openReports}<span class="badge count" data-testid="reports-open-count" aria-label={t('bug.openCount', { n: hints.h.openReports })}>{hints.h.openReports}</span>{/if}
        <Icon name="chevron" size={18} />
      </button>
    {/each}
  </nav>
  </div>
  {/if}
  {#if shown}
  <!-- Laid out as on a phone at every width: each button or field alone on its line as wide as the
       column, side by side ones sharing it (app.css .fill-controls). -->
  <div class="sections single fill-controls">

  {#if at('hosts')}
  <h2 id="hosts">{t('group.all')}</h2>
  <GroupForm id="all" />
  {/if}
  {#if at('shortcuts')}
  <h2 id="shortcuts">{t('shortcuts.title')}</h2>
  <div class="card"><ShortcutsTable /></div>
  {/if}
  {#if at('keys')}
  <h2 id="keys">{t('keys.title')} <HelpTip text={t('help.keyVault')} /></h2>
  <Keys />
  {/if}
  {#if at('snippets')}
  <h2 id="snippets">{t('snippets.title')} <HelpTip text={t('help.snippets')} /></h2>
  <Snippets />
  {/if}
  {#if at('scheduled')}
  <h2 id="scheduled">{t('sched.title')} <HelpTip text={t('help.sched')} /></h2>
  <ScheduledCommands />
  {/if}
  {#if at('recordings')}
  <h2 id="recordings">{t('rec.title')}</h2>
  <!-- Its player (xterm) loaded only when the part is opened. -->
  {#await import('./Recordings.svelte') then m}<m.default id={null} embedded />{/await}
  {/if}
  {#if at('appearance')}
  <h2 id="appearance">{t('settings.appearance')} <HelpTip text={t('help.theme')} /></h2>
  <div class="card stack">
    <label class="field">
      <span>{t('settings.language')}</span>
      <select value={locale()} onchange={(e) => setLocale(e.currentTarget.value as Locale)}>
        {#each locales as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
      </select>
    </label>
    <!-- A dropdown, like the language: four choices side by side broke over
         three rows on a 343 px phone, the last one under the colours (report 36aa3d). -->
    <label class="field">
      <span>{t('settings.theme')}</span>
      <select value={appearance.mode} onchange={(e) => setMode(e.currentTarget.value as ThemeMode)}>
        {#each [{ id: 'auto', label: t('settings.themeAuto') }, { id: 'light', label: t('settings.themeLight') }, { id: 'dark', label: t('settings.themeDark') }, { id: 'black', label: t('settings.themeBlack') }] as const as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
      </select>
    </label>
    <div class="swatches" role="radiogroup" aria-label={t('settings.accent')} use:roving={'radio'}>
      {#each ACCENTS as a (a)}
        <button
          role="radio"
          class="swatch"
          data-accent={a}
          aria-checked={appearance.accent === a}
          aria-label={t(`accent.${a}`)}
          title={t(`accent.${a}`)}
          onclick={() => setAccent(a)}
        ></button>
      {/each}
    </div>
  </div>

  {/if}
  {#if at('notify')}
  <h2 id="notify">{t('push.title')} <HelpTip text={t('help.push')} /></h2>
  <PushSettings />

  {/if}
  {#if at('terminal')}
  <h2 id="terminal">{t('settings.terminal')}</h2>
  <div class="card stack">
    <div class="field-wrap">
      <label class="field">
        <span>{t('settings.keyBar')}</span>
        <input
          class="mono"
          value={prefs.keyBar ?? DEFAULT_BAR}
          autocapitalize="none"
          spellcheck="false"
          onchange={(e) => {
            prefs.keyBar = e.currentTarget.value.trim() || null;
            savePrefs();
          }}
        />
      </label>
      <span class="field-help"><HelpTip text={t('help.keyBar')} /></span>
    </div>
    <button
      class="btn small"
      onclick={() => {
        prefs.keyBar = null;
        savePrefs();
      }}>{t('settings.keyBarReset')}</button
    >
    <div class="row">
      <label class="check">
        <input
          type="checkbox"
          checked={prefs.compose}
          onchange={(e) => {
            prefs.compose = e.currentTarget.checked;
            savePrefs();
          }}
        />
        {t('term.composeMode')}
      </label>
      <HelpTip text={t('help.composeMode')} />
    </div>
    <div class="field-wrap">
      <label class="field">
        <span>{t('settings.historyMin')}</span>
        <select
          value={String(prefs.historyMin)}
          onchange={(e) => {
            prefs.historyMin = Number(e.currentTarget.value);
            savePrefs();
          }}
          data-testid="history-min"
        >
          {#each [1, 2, 3, 5] as n (n)}<option value={String(n)}>{t('settings.historyMinN', { n })}</option>{/each}
        </select>
      </label>
      <span class="field-help"><HelpTip text={t('help.historyMin')} /></span>
    </div>
    <label class="field">
      <span>{t('settings.fontSize')}: {prefs.fontSize}px</span>
      <input
        type="range"
        min="8"
        max="32"
        value={prefs.fontSize}
        oninput={(e) => {
          prefs.fontSize = Number(e.currentTarget.value);
          savePrefs();
        }}
      />
    </label>
  </div>

  {/if}
  {#if admin}
    {#if at('system')}
    <h2 id="system">{t('system.title')}</h2>
    <SystemSettings />

    {/if}
    {#if at('ai')}
    <h2 id="ai">{t('ai.title')}</h2>
    <AiSettings />

    {/if}
    {#if at('channels')}
    <h2 id="channels">{t('channels.title')} <HelpTip text={t('help.channels')} /></h2>
    <ChannelSettings />

    {/if}
    {#if at('updates')}
    <h2 id="updates">{t('updates.settingsTitle')} <HelpTip text={t('help.updates')} /></h2>
    <UpdateSettings />

    {/if}
    {#if at('users')}
    <h2 id="users">{t('users.title')} <HelpTip text={t('help.users')} /></h2>
    <UserSettings />

    {/if}
    {#if at('sso')}
    <h2 id="sso">{t('sso.title')} <HelpTip text={t('help.sso')} /></h2>
    <SsoSettings />
    {/if}
  {/if}

  {#if at('android')}
  <h2 id="android">{t('android.title')}</h2>
  <AndroidSettings />

  {/if}
  {#if at('security')}
  <h2 id="security">{t('settings.security')}</h2>
  {#if accountError}<LoadFailed message={accountError} onretry={firstLoad} />{/if}

  <h3>{t('settings.passkeys')} <HelpTip text={t('help.passkeys')} /></h3>
  <div class="list">
    {#each passkeys as p (p.id)}
      <div class="list-item">
        <Icon name="shield" />
        <div class="main">
          <div class="title">{p.name}</div>
          <div class="sub">{p.lastUsedAt ? t('settings.lastUsed', { when: relativeTime(p.lastUsedAt) }) : t('settings.never')}</div>
        </div>
        <button class="icon-btn" aria-label={t('common.delete')} disabled={busy} onclick={() => removePasskey(p)}><Icon name="trash" /></button>
      </div>
    {/each}
    <button class="list-item" disabled={busy} onclick={addPasskey}><Icon name="plus" /> {t('settings.addPasskey')}</button>
  </div>

  <h3>{t('settings.password')} <HelpTip text={t('help.password')} /></h3>
  <div class="card stack">
    <p class="small">{user?.hasPassword ? t('settings.passwordSet') : t('settings.passwordNone')}</p>
    <div class="stack">
      <button class="btn small" onclick={() => (passwordOpen = true)}>{user?.hasPassword ? t('settings.changePassword') : t('settings.setPassword')}</button>
      {#if user?.hasPassword}<button class="btn small danger" disabled={busy} onclick={removePassword}>{t('settings.removePassword')}</button>{/if}
    </div>
  </div>

  <h3>{t('settings.totp')} <HelpTip text={t('help.totp')} /></h3>
  <div class="card stack">
    <p class="small">{user?.hasTotp ? t('settings.totpOn') : t('settings.totpOff')}</p>
    <div class="stack">
      <button class="btn small" onclick={() => (totpOpen = true)}>{t('settings.totpSetup')}</button>
      {#if user?.hasTotp}<button class="btn small danger" disabled={busy} onclick={disableTotp}>{t('settings.totpDisable')}</button>{/if}
    </div>
  </div>

  <h3>{t('settings.recovery')} <HelpTip text={t('help.recovery')} /></h3>
  <div class="card stack">
    {#if recoveryLeft !== null}<p class="small">{t('settings.recoveryLeft', { count: recoveryLeft })}</p>{/if}
    {#if newCodes}
      <div class="codes">{#each newCodes as c (c)}<span>{c}</span>{/each}</div>
      <button class="btn small" onclick={async () => (await copyText(newCodes!.join('\n'))) && toast(t('common.copied'))}>{t('common.copy')}</button>
      <label class="check"><input type="checkbox" bind:checked={codesKept} data-testid="recovery-kept" /> {t('setup.recoverySaved')}</label>
    {:else}
      <button class="btn small" disabled={busy} onclick={regenerate}>{t('settings.recoveryRegenerate')}</button>
    {/if}
  </div>

  <h3>{t('settings.sessions')} <HelpTip text={t('help.devices')} /></h3>
  <div class="list">
    <!-- This device first, its badge on a line that may wrap. -->
    {#each [...sessions].sort((a, b) => Number(b.current) - Number(a.current)).slice(0, allSessions ? undefined : SESSIONS_SHOWN) as s (s.id)}
      <div class="list-item">
        <div class="main">
          <div class="title wrap">{shortUa(s.userAgent)} {#if s.current}<span class="badge">{t('settings.thisDevice')}</span>{/if}</div>
          <div class="sub">{s.ip ?? ''} | {relativeTime(s.lastSeenAt)}</div>
        </div>
        <button class="btn small" disabled={busy} onclick={() => revoke(s)}>{t('settings.revoke')}</button>
      </div>
    {/each}
  </div>
  {#if (sessions.length > SESSIONS_SHOWN && !allSessions) || sessions.filter((s) => !s.current).length > 1}
    <div class="btnrow stacks">
      {#if sessions.length > SESSIONS_SHOWN && !allSessions}
        <button class="btn" onclick={() => (allSessions = true)} data-testid="sessions-all">{t('settings.sessionsAll', { n: sessions.length })}</button>
      {/if}
      {#if sessions.filter((s) => !s.current).length > 1}
        <button class="btn" disabled={busy} onclick={revokeOthers} data-testid="revoke-others">{t('settings.revokeOthers')}</button>
      {/if}
    </div>
  {/if}

  {#if admin}
  <h3>{t('settings.knownHosts')} <HelpTip text={t('help.knownHosts')} /></h3>
  {#if known.length === 0}
    {#if !accountError}<p class="dim small">{t('settings.knownHostsEmpty')}</p>{/if}
  {:else}
    <div class="list">
      {#each known as k (k.id)}
        <div class="list-item">
          <div class="main">
            <div class="title">{k.host}:{k.port}</div>
            <div class="sub mono">{k.keyType} {k.fingerprint}</div>
          </div>
          <button class="icon-btn" aria-label={t('common.delete')} disabled={busy} onclick={() => removeKnown(k)}><Icon name="trash" /></button>
        </div>
      {/each}
    </div>
  {/if}

  {/if}

  {#if admin}
    <h3>{t('settings.audit')}</h3>
    <button class="btn" onclick={() => go('/settings/audit')}>{t('settings.audit')}</button>
  {/if}

  {/if}
  {#if admin}
    {#if at('backups')}
    <h2 id="backups">{t('backup.title')} <HelpTip text={t('help.backups')} /></h2>
    <div class="card small" data-testid="backups">
      {#if backupError}
        <p class="alert error small" data-testid="backup-unknown">{t('backup.unknown', { error: backupError })}</p>
      {:else if !backup}
        <p class="dim">{t('backup.none')}</p>
      {:else if !backup.ok}
        <p class="alert error small">{t('backup.failed', { at: dateTime(backup.at), error: backup.error ?? '' })}</p>
      {:else}
        <p class:warn={Date.now() - Date.parse(backup.at) > backupStaleMs}>
          {t('backup.last', { at: dateTime(backup.at), ago: relativeTime(backup.at) })} | {formatBytes(backup.bytes ?? 0)} | {t('backup.kept', { n: backup.count ?? 0 })}{backup.remote ? ` | ${t('backup.remote')}` : ''}
        </p>
      {/if}
      {#if backup}
        {#if backupBusy}
          <p class:alert={backupStuck} class="small" data-testid="backup-busy">{backupStuck ? t('backup.stuck') : backupTaken ? t('backup.running') : t('backup.busy')}</p>
        {/if}
        <!-- Side by side on a wider screen; on a phone one under the other, each a full row (report cb6da8: three lines each, half a phone wide; then two rows of one ragged by chance). -->
        <div class="btnrow stacks backup-actions">
          <button class="btn" disabled={backupBusy} onclick={backUpNow} data-testid="backup-now"><Icon name="save" size={16} /> {t('backup.now')}</button>
          {#if backupDownload}
            <a class="btn" href="/api/backup/download" download={backupDownload.file} title={backupDownload.file} data-testid="backup-download"><Icon name="download" size={16} /> {t('backup.download', { size: formatBytes(backupDownload.bytes) })}</a>
          {/if}
        </div>
        {#if !backupDownload}<p class="dim small" data-testid="backup-no-download">{t('backup.noDownload')}</p>{/if}
        <details class="restore" data-testid="backup-restore">
          <summary>{t('backup.restoreTitle')}</summary>
          <p class="dim">{t('backup.restoreSteps')}</p>
          <div class="restore-cmd">
            <code class="mono" data-testid="backup-restore-cmd">{restoreCommand}</code>
            <button type="button" class="btn" onclick={copyRestore} data-testid="backup-restore-copy"><Icon name="copy" size={16} /> {t('common.copy')}</button>
          </div>
          <p class="dim">{t('backup.restoreAfter')}</p>
        </details>
      {/if}
    </div>
    {/if}
  {/if}

  {#if at('about')}
  <h2 id="about">{t('about.title')}</h2>
  <div class="card small" data-testid="about">
    <p>{t('about.web', { v: webVersion })}{serverVersion ? ` | ${t('about.server', { v: serverVersion })}` : ''}{appVersion ? ` | ${t('about.app', { v: appVersion })}` : ''}</p>
    {#if versionError}<p class="alert error small">{t('about.serverUnknown', { error: versionError })}</p>{/if}
    {#if serverVersion && serverVersion !== webVersion}
      <p class="alert small">{t('about.stale', { v: serverVersion })} <button class="btn small" onclick={() => location.reload()}>{t('about.reload')}</button></p>
    {/if}
    {#if notes}
      <h3 class="jobs-title">{t('about.whatsNew', { v: webVersion })}</h3>
      <p data-testid="about-new">{notes}</p>
    {/if}
    {#if projectPublished()}<p><a href={`${PROJECT_URL}/blob/main/CHANGELOG.md`} target="_blank" rel="noopener noreferrer">{t('about.allChanges')}</a></p>{/if}
    {#if admin}
      <div class="btnrow stacks">
        <button class="btn small" data-testid="update-check" disabled={selfBusy !== null} onclick={checkSelf}>
          <Icon name="updates" size={14} />{selfBusy === 'check' ? t('about.checking') : t('about.check')}
        </button>
        {#if selfUpdate?.target && selfUpdate.mode}
          <button class="btn small" class:primary={found === 'newer'} data-testid="update-start" disabled={selfBusy !== null} onclick={updateSelf}>
            <Icon name="download" size={14} />{selfBusy === 'update' ? t('about.updating') : found === 'newer' ? t('about.updateTo', { v: selfUpdate.available ?? '' }) : found === 'older' ? t('about.goBackTo', { v: selfUpdate.available ?? '' }) : t('about.rebuild')}
          </button>
        {/if}
      </div>
      {#if selfUpdate}
        {#if selfUpdate.breaking?.length}
          <!-- Read before updating: what the new version changes that may need you. -->
          <div class="alert error small breaking" data-testid="update-breaking">
            <strong>{t('about.breaking')}</strong>
            <ul>{#each selfUpdate.breaking as b (b)}<li>{b}</li>{/each}</ul>
          </div>
        {/if}
        <div data-testid="update-state">
          {#if !selfUpdate.target}
            <p class="dim">{t('about.notFound')}</p>
          {:else}
            <p class="dim">
              {t('about.where', { host: selfUpdate.target.hostName, dir: selfUpdate.target.dir })}
              {#if found === 'newer'}| {t('about.newer', { v: selfUpdate.available ?? '' })}{:else if found === 'older'}| <span data-testid="update-older">{t('about.older', { v: selfUpdate.available ?? '' })}</span>{:else if selfUpdate.available}| {t('about.current')}{/if}
              {#if selfUpdate.behind}| {t('about.behind', { n: selfUpdate.behind })}{/if}
            </p>
            {#if selfUpdate.pinned}<p class="alert small" data-testid="update-pinned">{t('about.pinned', { image: selfUpdate.pinned.image, next: selfUpdate.pinned.next })}</p>{/if}
            {#if selfUpdate.subject}<p class="dim"><code>{selfUpdate.subject}</code></p>{/if}
            {#if selfUpdate.problem}<p class="alert">{selfUpdate.problem}</p>{/if}
            {#if selfUpdate.last}
              <p class={selfUpdate.last.state === 'done' || selfUpdate.last.state === 'running' ? 'dim' : 'alert'}>
                <!-- The host's own words only when there is no code to say them in this language ("klaar - Updated", UIA-21). -->
                {t('about.last', { when: dateTime(selfUpdate.last.at) })}: {t(`about.state.${selfUpdate.last.state}`)}{#if (selfUpdate.last as { code?: string }).code || selfUpdate.last.state !== 'done'} - {lastWords(selfUpdate.last)}{/if}
              </p>
            {/if}
          {/if}
        </div>
      {/if}
      {#if jobs.length}
        <h3 class="jobs-title">{t('about.jobs')}</h3>
        <ul class="jobs" data-testid="about-jobs">
          {#each jobs as j (j.name)}
            <li>
              <strong>{t(`about.job.${j.name}`)}</strong>
              <span class="dim">{t('about.jobRan', { when: dateTime(j.lastRunAt), s: (j.ms / 1000).toFixed(1) })}</span>
              {#if j.lastError}<span class={j.ok ? 'dim' : 'bad'}>{t(j.ok ? 'about.jobFailedBefore' : 'about.jobFailed', { when: dateTime(j.lastErrorAt ?? j.lastRunAt), error: j.lastError })}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if logEvents}
        <h3 class="jobs-title">{t('about.logEvents')}</h3>
        {#if logEvents.length}
          <ul class="jobs" data-testid="about-log-events">
            {#each logEvents.slice(0, allEvents ? undefined : EVENTS_SHOWN) as e (e.kind)}
              <li>
                <!-- Burrow's own words, as logged: a quote, not text written for people. -->
                <span class={e.level === 'error' ? 'bad' : ''}><strong>{t(e.level === 'error' ? 'about.logError' : 'about.logWarn')}</strong> <code class="logline">{e.example}</code></span>
                <span class="dim">{t('about.logSeen', { n: e.count, when: dateTime(e.lastAt), first: dateTime(e.firstAt) })}</span>
              </li>
            {/each}
          </ul>
          {#if logEvents.length > EVENTS_SHOWN && !allEvents}<button class="btn small" onclick={() => (allEvents = true)} data-testid="log-events-all">{t('about.logAll', { n: logEvents.length })}</button>{/if}
        {:else}
          <p class="dim">{t('about.logNone')}</p>
        {/if}
      {/if}
    {/if}
  </div>

  {/if}
  {#if at('report')}
  <h2 id="report">{t('bug.title')}</h2>
  <div class="card stack">
  <p class="dim small">{t('bug.settingsText')}</p>
  {#if !keyBars.show}<p class="dim small" data-testid="bug-key-hint">{t('bug.keyHint', { keys: `${MOD}+Shift+B` })}</p>{/if}
  <button
    class="btn"
    data-testid="bug-arm"
    onclick={() => {
      setArmed(!bug.armed);
      if (bug.armed) toast(t('bug.armed'));
    }}>{bug.armed ? t('bug.disarm') : t('bug.arm')}</button
  >
  </div>
  {#if admin}<ProblemReports />{/if}
  {/if}
  </div>
  {/if}
  </div>
</div>

<Dialog tour="totp" bind:open={totpOpen} title={t('settings.totpSetup')}>
  {#if totpOpen}
    <TotpSetup
      ondone={() => {
        totpOpen = false;
        void refreshSession();
      }}
    />
  {/if}
</Dialog>

<Dialog tour="password" bind:open={passwordOpen} title={user?.hasPassword ? t('settings.changePassword') : t('settings.setPassword')} dirty={() => !!newPassword}>
  <form id="pw-form" class="stack" onsubmit={savePassword}>
    <label class="field">
      <span>{t('settings.newPassword')}</span>
      <input type="password" bind:value={newPassword} autocomplete="new-password" minlength="12" required />
    </label>
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (passwordOpen = false)}>{t('common.cancel')}</button>
    <button class="btn primary" form="pw-form" disabled={busy}>{t('common.save')}</button>
  {/snippet}
</Dialog>

<style>
  /* A part on its own page: its heading is the bar's title already. */
  .sections.single > :global(h2[id]:first-child) {
    margin-top: 0;
  }
  .warn {
    color: var(--warn);
  }
  .backup-actions {
    margin-top: 12px;
  }
  .restore {
    margin-top: 12px;
  }
  .restore summary {
    cursor: pointer;
  }
  /* The command wraps inside its line (a long file name on a phone), the button beside or under it. */
  .restore-cmd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
  }
  .restore-cmd code {
    flex: 1 1 16rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* Under the update button, not against it. */
  .jobs-title {
    margin: 12px 0 4px;
    font-size: 0.9rem;
  }
  /* One block per job or warning, a line between (report 5d1b13: they ran into one another). */
  .jobs {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .jobs li + li {
    border-top: 1px solid var(--border);
    padding-top: 6px;
  }
  .jobs li {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .jobs .bad {
    color: var(--danger);
  }
  .logline {
    white-space: normal;
    overflow-wrap: anywhere;
    color: inherit;
  }
  .breaking {
    margin-top: 12px;
  }
  /* The list at the left of the open part from a tablet up (decision 27), the column growing with the
     screen so its descriptions are read (UIB-13); the same rows as on a phone. */
  @media (min-width: 720px) {
    .page.settings > .layout.two {
      max-width: 1180px;
      display: grid;
      grid-template-columns: clamp(220px, 30%, 340px) minmax(0, 1fr);
      gap: clamp(16px, 2vw, 28px);
      align-items: start;
    }
    .layout.two > .side.stick {
      position: sticky;
      top: 16px;
    }
    .layout.two > .side > p:first-child {
      margin-top: 0;
    }
    .layout.two .part {
      position: relative;
    }
    /* The parts open beside the list: no arrow to another page. */
    .layout.two .part > :global(svg:last-child) {
      display: none;
    }
    /* The open one: tinted, a bar of the accent at its edge. */
    .part.on {
      background: color-mix(in srgb, var(--accent) 12%, var(--bg-raised));
    }
    .part.on::before {
      content: '';
      position: absolute;
      left: 0;
      top: 8px;
      bottom: 8px;
      width: 3px;
      border-radius: 0 3px 3px 0;
      background: var(--accent);
    }
    .part.on > :global(svg:first-child) {
      color: var(--accent);
    }
  }
  /* With the parts beside it, the title over the column's edge, not the narrow form's (decision 26). */
  .page.settings:has(> .layout.two) {
    --content-w: 1180px;
  }
</style>
