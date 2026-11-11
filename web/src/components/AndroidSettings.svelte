<script lang="ts">
  import { ask, askText } from '../lib/confirm.svelte.js';
  import { compareVersions, PROJECT_URL, projectPublished, type AuthState, type DeviceHostResult, type DeviceInfo } from '@burrow/shared';
  import { android, refreshAndroidInfo, type AllFilesStatus, type AndroidInfo, type WidgetAway } from '../lib/android.js';
  import { switchAllFiles } from '../lib/allfiles.js';
  import { installAppUpdate } from '../lib/appupdate.svelte.js';
  import { nativeDownloads, percentOf } from '../lib/downloads.svelte.js';
  import { api, errorMessage, get, post, put } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { formatBytes } from '../lib/files.svelte.js';
  import { dateOnly, relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { session, setSession } from '../lib/session.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import Icon from './Icon.svelte';
  import PickList from './PickList.svelte';
  import WireGuardSettings from './WireGuardSettings.svelte';
  import LoadFailed from './LoadFailed.svelte';

  // The Android app: download it, pair it (a one-time code), and the list of
  // paired phones. Inside the app itself, the phone can pair in one step.

  interface Apk {
    versionName: string;
    versionCode: number;
    sha256: string;
    size: number;
  }

  let apk = $state<Apk | null>(null);
  let devices = $state<DeviceInfo[]>([]);
  let info = $state<AndroidInfo | null>(null);
  // "All files" on the Files page (report 862305): read when the app has it.
  let allFiles = $state<AllFilesStatus | null>(null);
  $effect(() => {
    if (info?.phoneAllFiles) void android?.phoneAllFiles().then((s) => (allFiles = s), () => {});
  });
  // The home screen widget (2.11.0): away from home, through the tunnel, the last numbers, or by push.
  let widget = $state<{ away: WidgetAway; placed: boolean } | null>(null);
  $effect(() => {
    if (info?.widget) void android?.widgetState().then((s) => (widget = s), () => {});
  });
  async function setWidgetAway(away: WidgetAway) {
    if (!android || !widget) return;
    const was = widget.away;
    try {
      // By push: this phone's push address carries the numbers too; it needs notifications on.
      if (away === 'push' || was === 'push') {
        const push = await android.pushState();
        if (away === 'push' && !push) throw new Error(t('error.no_push_device'));
        if (push) await put('/api/widget/push', { endpoint: push.url, on: away === 'push' });
      }
      await android.setWidgetAway(away);
      widget = { ...widget, away };
      toast(t('android.widgetSaved'));
    } catch (err) {
      widget = { ...widget, away: was };
      toast(errorMessage(err), 'error');
    }
  }
  let code = $state<{ code: string; expiresAt: string } | null>(null);
  let now = $state(Date.now());
  let busy = $state(false);

  // Burrow's side read: until then (or when it failed) no "no app built" and no pairing to offer.
  let loaded = $state(false);
  // Burrow's own version: an APK older than it was left from before a self-update (that builds no app).
  let server = $state<string | null>(null);
  async function load() {
    const [a, d, v] = await Promise.all([get<{ apk: Apk | null }>('/api/android'), get<DeviceInfo[]>('/api/account/devices'), get<{ server: string }>('/api/version').catch(() => null)]);
    apk = a.apk;
    devices = d;
    server = v?.server ?? null;
    loaded = true;
  }
  const apkOlder = $derived(!!apk && !!server && apk.versionName !== '?' && compareVersions(apk.versionName, server) < 0);
  // The app of Burrow's own release, fetched by Burrow from GitHub in place of an older one or none
  // (report a5ace5): an admin's, confirmed as the person; some tens of MB, so it says so meanwhile.
  let fetching = $state(false);
  async function fetchRelease() {
    fetching = true;
    try {
      const r = await post<{ apk: Apk | null }>('/api/android/fetch-release');
      apk = r.apk;
      toast(t('android.fetchedRelease', { version: r.apk?.versionName ?? '' }));
    } catch (err) {
      const m = errorMessage(err);
      if (m) toast(m, 'error');
    } finally {
      fetching = false;
    }
  }
  // The phones not read: said here with Try again, not "none paired" (A3-WEB-01).
  let loadError = $state('');
  const firstLoad = () => {
    loadError = '';
    // The app's own part is the phone's: read from it whether Burrow answers or not (report eedaac:
    // with Burrow away the page showed "no app built" instead of this app).
    if (android) void refreshAndroidInfo().then((i) => (info = i), () => {});
    load().catch((err: unknown) => (loadError = errorMessage(err)));
  };
  firstLoad();

  $effect(() => {
    if (!code) return;
    const timer = setInterval(() => {
      now = Date.now();
      if (code && Date.parse(code.expiresAt) <= now) code = null;
    }, 1000);
    return () => clearInterval(timer);
  });
  const left = $derived(code ? Math.max(0, Math.round((Date.parse(code.expiresAt) - now) / 1000)) : 0);

  async function run(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  const makeCode = () =>
    run(async () => {
      code = await post<{ code: string; expiresAt: string }>('/api/account/devices/pair-code');
      now = Date.now();
    });

  // The phone whose menu is open; a tap in it closes it first, then acts.
  let menuFor = $state<DeviceInfo | null>(null);
  const fromMenu = (fn: (d: DeviceInfo) => unknown) => () => {
    const d = menuFor!;
    menuFor = null;
    void fn(d);
  };
  const unpair = (d: DeviceInfo) =>
    run(async () => {
      // This phone, in an app that asks itself (2.19.0): its own question first, and the keys
      // gone before the server forgets the device; the page does not ask as well.
      const itself = d.current && !!android && info?.asksItself === true;
      if (itself) {
        const r = await android!.forgetDevice();
        if (r && 'cancelled' in r) return;
      } else if (!(await ask({ text: t('android.unpairConfirm', { name: d.name }), confirm: t('android.unpair'), danger: true }))) return;
      const r = await api<{ leftOn: DeviceHostResult[] }>('DELETE', `/api/account/devices/${d.id}`);
      if (r.leftOn.length) toast(t('android.keyLeftOn', { hosts: r.leftOn.map((h) => h.hostName).join(', ') }), 'error');
      if (d.current && !itself) await android?.forgetDevice();
    });

  // Paired under the model's name: two of the same model, or the same phone paired again, read
  // alike (UIA-15). When each was paired tells them apart, and a name of the person's own.
  const rename = (d: DeviceInfo) =>
    run(async () => {
      const name = await askText({ text: t('android.renameTitle', { name: d.name }), confirm: t('common.save'), input: { label: t('android.renameLabel'), value: d.name, max: 60 } });
      if (name === null || name.trim() === d.name) return;
      await api('PATCH', `/api/account/devices/${d.id}`, { name: name.trim() });
    });
  const pairedSub = (d: DeviceInfo) => t('android.pairedOn', { when: dateOnly(d.createdAt) });

  // ---- the direct route: which hosts carry this phone's key

  let directFor = $state<DeviceInfo | null>(null);
  let directCounts = $state<Record<number, number>>({});
  const countLabel = (n: number) => (n === 0 ? t('android.directCountNone') : n === 1 ? t('android.directCountOne') : t('android.directCount', { n }));

  // How many hosts each phone may reach directly (admins only).
  $effect(() => {
    if (user?.role !== 'admin') return;
    for (const d of devices.filter((x) => x.hasSshKey)) {
      void get<{ hostIds: number[] }>(`/api/account/devices/${d.id}/hosts`)
        .then((r) => (directCounts = { ...directCounts, [d.id]: r.hostIds.length }))
        .catch(() => {});
    }
  });
  let directHosts = $state<number[]>([]);
  // The hosts as read: picked differently and not saved, closing asks first (A3-WEB-12).
  let directBase = '';

  async function editDirect(d: DeviceInfo) {
    if (!data.loaded) await loadAll();
    directHosts = (await get<{ hostIds: number[] }>(`/api/account/devices/${d.id}/hosts`)).hostIds;
    directBase = JSON.stringify([...directHosts].sort());
    directFor = d;
  }

  const saveDirect = () =>
    run(async () => {
      const d = directFor!;
      const r = await put<{ hostIds: number[]; results: DeviceHostResult[] }>(`/api/account/devices/${d.id}/hosts`, { hostIds: directHosts });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast(t('android.directFailed', { hosts: failed.map((f) => `${f.hostName} (${f.message ?? ''})`).join(', ') }), 'error');
      else toast(t('android.directSaved'));
      directFor = null;
      directCounts = { ...directCounts, [d.id]: r.hostIds.length };
      if (d.current) void android?.syncDirect().catch(() => {});
    });

  // In the app, signed in with a password: pair this phone right here.
  const pairHere = () =>
    run(async () => {
      const c = await post<{ code: string }>('/api/account/devices/pair-code');
      const { publicKey } = await android!.createKey();
      const r = await post<{ deviceId: number; state: AuthState }>('/api/auth/pair', { code: c.code, name: info?.deviceName || 'Android', publicKey });
      await android!.saveDevice(r.deviceId);
      setSession(r.state);
      toast(t('android.paired'));
    });

  // A newer app: Android's installer asks; the first time Android asks
  // whether Burrow may install apps at all (then tap again).
  // Downloading takes a while (28 MB): said on the button and below it.
  let updating = $state(false);
  const update = $derived(nativeDownloads.items.find((d) => d.kind === 'update' && d.state === 'running'));
  const updateApp = () =>
    run(async () => {
      updating = true;
      try {
        const state = await installAppUpdate(apk!, info!.versionCode);
        if (state === 'permission') toast(t('android.updatePermission'));
      } catch (err) {
        // Before 1.7.5 the app's own tunnel could not fetch it (its proxy
        // closed too early): what to do, rather than "end of stream".
        if (info!.versionCode < 10705) throw new Error(t('android.updateOldTunnel'), { cause: err });
        throw err;
      } finally {
        updating = false;
      }
    });

  const user = $derived(session.state?.user);
  const thisPaired = $derived(!!session.state?.deviceId && info?.deviceId === session.state.deviceId);
</script>

{#snippet olderApk()}
  {#if apkOlder}
    <p class="alert small" data-testid="apk-older">
      {t('android.apkOlder', { apk: apk?.versionName ?? '', server: server ?? '' })}
      {#if projectPublished()}<a href={`${PROJECT_URL}/releases`} target="_blank" rel="noopener noreferrer">{t('android.releases')}</a>{/if}
    </p>
    {@render fromRelease()}
  {/if}
{/snippet}

{#snippet fromRelease()}
  {#if user?.role === 'admin' && server && projectPublished()}
    <button class="btn small" disabled={fetching} onclick={fetchRelease} data-testid="apk-fetch-release">{fetching ? t('android.fetchingRelease') : t('android.fetchRelease', { version: server })}</button>
    {#if fetching}<p class="dim small" role="status">{t('android.fetchingReleaseHint')}</p>{/if}
  {/if}
{/snippet}

{#if android && info}
  <div class="card stack">
    <!-- This app's version, and a newer one from this Burrow to install. -->
    <div class="stack" data-testid="app-version">
      {#if apk && apk.versionCode > info.versionCode}
        <p class="small">{t('android.updateAvailable', { version: apk.versionName })} <span class="dim">({t('android.thisVersion', { version: info.version })})</span></p>
        <button class="btn small primary" disabled={busy} onclick={updateApp}>{updating ? t('android.updating') : t('android.update', { size: formatBytes(apk.size) })}</button>
        {#if updating}
          <!-- How far (apps from 1.10.0 say so; older ones only the hint). -->
          {#if update}
            <progress max="100" value={percentOf(update) ?? undefined} aria-label={t('android.updating')} data-testid="app-update-progress"></progress>
            <span class="dim small">{formatBytes(update.done)}{update.total > 0 ? ` / ${formatBytes(update.total)}` : ''}</span>
          {/if}
          <p class="dim small" role="status">{t('android.updatingHint')}</p>
        {/if}
      {:else if loaded}
        <p class="small dim">{t('android.upToDate', { version: info.version })}</p>
      {:else}
        <!-- Burrow's side failed or is still coming: only the version, not "up to date" (audit 2026-11-09). -->
        <p class="small dim">{t('android.versionOnly', { version: info.version })}</p>
      {/if}
      {@render olderApk()}
      {#if loaded && !apk}{@render fromRelease()}{/if}
    </div>
    {#if thisPaired}
      <p class="small">{t('android.thisPaired')}</p>
    {:else}
      <button class="btn small" disabled={busy} onclick={pairHere}>{t('android.pairHere')}</button>
    {/if}
    <div class="row">
      <label class="check">
        <input
          type="checkbox"
          checked={info.shake}
          data-testid="shake-report"
          onchange={async (e) => {
            await android?.setShake(e.currentTarget.checked);
            info = await refreshAndroidInfo();
          }}
        />
        {t('android.shake')}
      </label>
      <HelpTip text={t('help.androidShake')} />
    </div>
    {#if allFiles?.available}
      <div class="row">
        <label class="check">
          <input
            type="checkbox"
            checked={allFiles.on && allFiles.granted}
            data-testid="all-files"
            onchange={async (e) => {
              const box = e.currentTarget;
              const s = await switchAllFiles(box.checked);
              if (s) allFiles = s;
              box.checked = !!allFiles && allFiles.on && allFiles.granted;
            }}
          />
          {t('android.allFiles')}
        </label>
        <HelpTip text={t('help.androidAllFiles')} />
      </div>
      {#if !allFiles.on && allFiles.granted}
        <!-- Off in Burrow, but Android still allows it: where to take that back too. -->
        <button class="btn small" onclick={() => android?.phoneAllFilesSettings()} data-testid="all-files-settings">{t('android.allFilesRevoke')}</button>
      {/if}
    {/if}
    {#if widget}
      <div class="field-wrap">
        <label class="field">
          <span>{t('android.widgetAway')}</span>
          <select
            value={widget.away}
            onchange={async (e) => {
              // Refused (no notifications): the box shows what holds again, the same value is no change to draw.
              const box = e.currentTarget;
              await setWidgetAway(box.value as WidgetAway);
              box.value = widget?.away ?? box.value;
            }}
            data-testid="widget-away"
          >
            <option value="tunnel">{t('android.widgetTunnel')}</option>
            <option value="last">{t('android.widgetLast')}</option>
            <option value="push">{t('android.widgetPush')}</option>
          </select>
        </label>
        <span class="field-help"><HelpTip text={t('help.androidWidget')} /></span>
      </div>
      {#if !widget.placed}<p class="dim small" data-testid="widget-none">{t('android.widgetNone')}</p>{/if}
    {/if}
    {#if !info.screenshotsFixed}
      <div class="row">
        <label class="check">
          <input
            type="checkbox"
            checked={info.screenshots}
            data-testid="allow-screenshots"
            onchange={async (e) => {
              const box = e.currentTarget;
              // Allowed only after the app's own question (2.19.0); No there leaves it off.
              await android?.setScreenshots(box.checked);
              info = await refreshAndroidInfo();
              box.checked = info?.screenshots ?? false;
            }}
          />
          {t('android.screenshots')}
        </label>
        <HelpTip text={t('help.androidScreenshots')} />
      </div>
    {/if}
  </div>
  <WireGuardSettings />
{:else if loaded}
  <h3>{t('android.download')} <HelpTip text={t('help.androidApk')} /></h3>
  <div class="card stack">
    {#if apk}
      <a class="btn small" href="/api/android/burrow.apk" download>{t('android.downloadApk', { version: apk.versionName, size: formatBytes(apk.size) })}</a>
      {#if apk.sha256}<p class="dim small mono break">SHA-256 {apk.sha256}</p>{/if}
      {@render olderApk()}
    {:else}
      <!-- An install on the prebuilt images has no checkout to build one: the release has it. -->
      <p class="dim small">{t('android.noApk')} {#if projectPublished()}<a href={`${PROJECT_URL}/releases`} target="_blank" rel="noopener noreferrer">{t('android.releases')}</a>{/if}</p>
      {@render fromRelease()}
    {/if}
  </div>

  <h3>{t('android.pair')} <HelpTip text={t('help.androidPair')} /></h3>
  <div class="card stack">
    {#if code}
      <p class="pair-code mono" data-testid="pair-code">{code.code}</p>
      <p class="dim small">{t('android.codeHint', { seconds: left })}</p>
    {:else}
      <button class="btn small" disabled={busy} onclick={makeCode}>{t('android.makeCode')}</button>
    {/if}
  </div>
{/if}

{#if loadError}<div class="failed-part"><LoadFailed inline message={loadError} onretry={firstLoad} /></div>{/if}
{#if devices.length}
  <h3>{t('android.devices')}</h3>
  <div class="list">
    {#each devices as d (d.id)}
      <div class="list-item top">
        <Icon name="phone" />
        <div class="main">
          <div class="title wrap">{d.name} {#if d.current}<span class="badge">{t('settings.thisDevice')}</span>{/if}</div>
          <div class="sub whole" data-testid="device-sub">{pairedSub(d)} | {d.lastUsedAt ? t('settings.lastUsed', { when: relativeTime(d.lastUsedAt) }) : t('settings.never')}</div>
        </div>
        <!-- Rename and unpair in the row's menu, as every row with more than one thing to do (report e6fc13). -->
        <button class="icon-btn" aria-label={t('common.menuFor', { name: d.name })} title={t('common.menuFor', { name: d.name })} disabled={busy} onclick={() => (menuFor = d)} data-testid="device-menu"><Icon name="more" size={20} /></button>
      </div>
    {/each}
  </div>
{/if}

<!-- The direct route in one place: which hosts each phone may reach by
     itself, and (in the app) the way in. -->
{#if devices.length && user?.role === 'admin'}
  <h3>{t('android.direct')} <HelpTip text={t('help.androidDirect')} /></h3>
  <div class="list" data-testid="direct-route">
    {#each devices as d (d.id)}
      <div class="list-item top">
        <Icon name="terminal" />
        <div class="main">
          <div class="title wrap">{d.name} {#if d.current}<span class="badge">{t('settings.thisDevice')}</span>{/if}</div>
          <div class="sub whole">{pairedSub(d)} | {d.hasSshKey ? countLabel(directCounts[d.id] ?? 0) : t('android.noSshKey')}</div>
        </div>
        <button class="btn small" disabled={busy || !d.hasSshKey} onclick={() => editDirect(d)}>{t('android.chooseHosts')}</button>
      </div>
    {/each}
  </div>
  {#if android && thisPaired}
    <button class="btn open-direct" onclick={() => android?.openDirect()}>{t('android.openDirect')}</button>
  {/if}
{/if}

<Dialog tour="device-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.name ?? ''}>
  <button class="btn" onclick={fromMenu(rename)} data-testid="device-rename">{t('android.rename')}</button>
  <button class="btn danger" onclick={fromMenu(unpair)} data-testid="device-unpair">{t('android.unpair')}</button>
</Dialog>

<Dialog tour="direct-hosts" open={directFor !== null} title={t('android.directHosts', { name: directFor?.name ?? '' })} onclose={() => (directFor = null)} dirty={() => directFor !== null && !busy && JSON.stringify([...directHosts].sort()) !== directBase}>
  <p class="dim small">{t('help.androidDirect')}</p>
  <PickList items={data.hosts.map((h) => ({ id: h.id, title: h.name, sub: h.address, testid: `direct-host-${h.id}` }))} chosen={directHosts} onchange={(next) => (directHosts = next)} label={t('android.chooseHosts')} />
  {#snippet actions()}
    <button class="btn" onclick={() => (directFor = null)}>{t('common.cancel')}</button>
    <button class="btn primary" disabled={busy} onclick={saveDirect}>{t('common.save')}</button>
  {/snippet}
</Dialog>

<style>
  /* Apart from the card above it, not against it (report eedaac). */
  .failed-part {
    margin-top: 12px;
  }
  progress {
    width: 100%;
  }
  .pair-code {
    font-size: 1.8rem;
    letter-spacing: 0.08em;
    text-align: center;
    margin: 0.25rem 0;
  }
  .break {
    word-break: break-all;
  }
  .open-direct {
    margin-top: 12px;
  }
</style>
