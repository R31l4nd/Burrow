<script lang="ts">
  import type { DirectCache, DirectHost } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import Toasts from '../components/Toasts.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { closeTopDialog } from '../lib/back.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { direct, type ConnectResult, type Forwarding } from './bridge.js';
  import DirectTerminal from './DirectTerminal.svelte';
  import { isHttps, keptSchemes, withScheme, type Schemes } from './forwards.js';

  // The direct route: hosts from the phone's cache, one SSH session at a time,
  // straight from the phone. Not through Burrow, so without the AI; with tmux
  // on the host the session is kept there (leaving detaches), without it the
  // session ends when left. Everything else looks the same.

  let { version }: { version: string } = $props();

  let cache = $state<DirectCache | null>(null);
  let loaded = $state(false);
  let session = $state<{ id: string; host: DirectHost; viaWireGuard: boolean; kept: boolean; keepOpen?: boolean } | null>(null);
  // Hosts with a session kept on them (tmux), remembered on this phone.
  const KEPT_KEY = 'burrow.direct.kept';
  const readKept = (): number[] => {
    try {
      return JSON.parse(localStorage.getItem(KEPT_KEY) ?? '[]') as number[];
    } catch {
      return [];
    }
  };
  let keptOn = $state<number[]>(readKept());
  function setKept(hostId: number, on: boolean) {
    keptOn = on ? [...new Set([...keptOn, hostId])] : keptOn.filter((x) => x !== hostId);
    try {
      localStorage.setItem(KEPT_KEY, JSON.stringify(keptOn));
    } catch {
      // Not remembered: the badge is only a hint.
    }
  }
  let connecting = $state<number | null>(null);
  let hostKey = $state<{ host: DirectHost; result: Extract<ConnectResult, { status: 'unknown_host_key' | 'host_key_changed' }> } | null>(null);

  direct
    ?.cache()
    .then(async (c) => {
      cache = c;
      // Opened for one host: straight to its session.
      const want = await direct!.takeConnectTo().catch(() => null);
      // Loaded again after Android ended the page's renderer: the session the app still holds, taken up again.
      const back = want?.resume;
      const held = back ? c?.hosts.find((x) => x.id === back.hostId) : undefined;
      if (back && held) {
        session = { id: back.sessionId, host: held, viaWireGuard: back.viaWireGuard, kept: back.kept, keepOpen: back.keepOpen ?? false };
        return;
      }
      const h = want?.hostId ? c?.hosts.find((x) => x.id === want.hostId) : undefined;
      if (h) void connect(h);
    })
    .catch((err: unknown) => toast(String(err), 'error'))
    .finally(() => (loaded = true));

  // Android's back button on the host list: back to Burrow.
  $effect(() => direct?.on('back', () => !session && !closeTopDialog() && void direct?.backToBurrow()));

  const hosts = $derived([...(cache?.hosts ?? [])].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)));

  /** A first guess at the size; the terminal sends its real one once shown. */
  const size = () => ({ cols: Math.max(20, Math.floor(window.innerWidth / 8.4)), rows: Math.max(8, Math.floor((window.innerHeight - 160) / 16.8)) });

  async function connect(h: DirectHost) {
    if (!direct || connecting) return;
    connecting = h.id;
    try {
      const { cols, rows } = size();
      const r = await direct.connect(h.id, cols, rows);
      if (r.status === 'ok') {
        session = { id: r.sessionId, host: h, viaWireGuard: r.viaWireGuard === true, kept: r.kept === true };
        setKept(h.id, r.kept === true);
      }
      else if (r.status === 'unknown_host_key' || r.status === 'host_key_changed') hostKey = { host: h, result: r };
      else if (r.status === 'auth_failed') toast(t('direct.authFailed', { host: h.name }), 'error');
      else if (r.status === 'error') toast(t('direct.failed', { message: r.message }), 'error');
    } catch (err) {
      toast(t('direct.failed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      connecting = null;
    }
  }

  // ---- port forwards: a port of a host on this phone, opened in its browser

  let forwarding = $state<DirectHost | null>(null);
  let fwdPort = $state(80);
  let fwdHost = $state('127.0.0.1');
  let fwdHttps = $state(false);
  let forwards = $state<Forwarding[]>([]);
  // http or https per forward, as chosen when it started (kept on this phone).
  const SCHEMES = 'burrow.direct.forwardSchemes';
  let schemes = $state<Schemes>(readSchemes());
  function readSchemes(): Schemes {
    try {
      return JSON.parse(localStorage.getItem(SCHEMES) ?? '{}') as Schemes;
    } catch {
      return {};
    }
  }
  function keepSchemes(next: Schemes) {
    schemes = next;
    try {
      localStorage.setItem(SCHEMES, JSON.stringify(next));
    } catch {
      // Not kept: the port decides after a reload.
    }
  }
  const loadForwards = async () => {
    forwards = (await direct?.forwards().catch(() => [])) ?? [];
    keepSchemes(keptSchemes(schemes, forwards.map((f) => f.forwardId)));
  };

  async function startForward() {
    const h = forwarding;
    if (!h || !direct) return;
    // What the dialog said when it was confirmed: another forward opened meanwhile changes these.
    const port = fwdPort;
    const target = fwdHost.trim() || '127.0.0.1';
    const https = fwdHttps;
    forwarding = null;
    const r = await direct.forward(h.id, port, target).catch((err: unknown) => ({ status: 'error' as const, message: String(err) }));
    if (r.status !== 'ok') {
      if (r.status !== 'cancelled') toast(t('direct.failed', { message: r.message }), 'error');
      return;
    }
    keepSchemes(withScheme(schemes, r.forwardId, https));
    await loadForwards();
    await direct.openForward(r.forwardId, https);
  }

  async function trustAndConnect() {
    const k = hostKey;
    if (!k || k.result.status !== 'unknown_host_key' || !direct) return;
    hostKey = null;
    await direct.trust(k.host.id, k.result.fingerprint);
    await connect(k.host);
  }
</script>

{#if session}
  <DirectTerminal
    sessionId={session.id}
    host={session.host}
    viaWireGuard={session.viaWireGuard}
    kept={session.kept}
    keepOpen={session.keepOpen ?? false}
    snippets={cache?.snippets ?? []}
    onclose={(gone) => {
      if (gone && session) setKept(session.host.id, false);
      session = null;
    }}
  />
{:else}
  <!-- The page's landmark (it had none: the layout checks never ran here before, UIA-17). -->
  <main class="page">
    <header class="topbar">
      <h1>{t('direct.title')}</h1>
      <button class="btn small" onclick={() => direct?.backToBurrow()}>{t('direct.back')}</button>
    </header>
    {#if loaded && !hosts.length}
      <p class="empty">{t('direct.none')}</p>
    {/if}

    {#if forwards.length}
      <h2 class="group">{t('direct.forwards')}</h2>
      <div class="list" data-testid="forwards">
        {#each forwards as f (f.forwardId)}
          <div class="list-item">
            <span class="main"><span class="title wrap">{f.hostName} | {f.targetHost}:{f.targetPort}</span><span class="sub">127.0.0.1:{f.localPort}</span></span>
            <button class="btn small" onclick={() => direct?.openForward(f.forwardId, isHttps(schemes, f))}>{t('direct.open')}</button>
            <button class="icon-btn" aria-label={t('direct.stopForward')} onclick={async () => (await direct?.stopForward(f.forwardId), void loadForwards())}><Icon name="close" size={18} /></button>
          </div>
        {/each}
      </div>
    {/if}

    <div class="list">
      {#each hosts as h (h.id)}
        <div class="list-item hrow">
          <button class="main plain" disabled={connecting !== null} onclick={() => connect(h)} data-testid="direct-host">
            <Icon name={h.favorite ? 'star' : 'server'} />
            <span class="text">
              <span class="title">{h.name}</span>
              <span class="sub">{h.username}@{h.address}{h.port === 22 ? '' : `:${h.port}`}</span>
            </span>
            {#if connecting === h.id}<span class="badge">{t('term.connecting')}</span>
            {:else if keptOn.includes(h.id)}<span class="badge" data-testid="direct-kept">{t('direct.keptBadge')}</span>{/if}
          </button>
          <button class="icon-btn" aria-label={t('direct.forwardOn', { host: h.name })} title={t('direct.forward')} onclick={() => ((forwarding = h), (fwdPort = 80), (fwdHost = '127.0.0.1'), (fwdHttps = false))} data-testid="direct-forward"><Icon name="external" size={18} /></button>
        </div>
      {/each}
    </div>

    <!-- Under the hosts: on a phone, above them, it took a third of the screen
         before the first host (the title bar says where this is). -->
    <p class="alert" data-testid="direct-banner">{t('direct.intro')}</p>
    <p class="dim small">
      {#if cache}{t('direct.cacheAge', { when: relativeTime(cache.generatedAt) })}{/if}
      {#if version}| {version}{/if}
    </p>
  </main>
{/if}

<Dialog tour="direct-host-key" open={hostKey !== null} title={hostKey?.result.status === 'host_key_changed' ? t('direct.keyChanged') : t('direct.keyUnknown')} onclose={() => (hostKey = null)}>
  {#if hostKey}
    {#if hostKey.result.status === 'host_key_changed'}
      <p class="alert error">{t('direct.keyChangedText', { host: hostKey.host.name })}</p>
    {:else}
      <p>{t('direct.keyUnknownText', { host: hostKey.host.name })}</p>
    {/if}
    <p class="mono small">{hostKey.result.keyType} {hostKey.result.fingerprint}</p>
  {/if}
  {#snippet actions()}
    <button class="btn" onclick={() => (hostKey = null)}>{t('common.cancel')}</button>
    {#if hostKey?.result.status === 'unknown_host_key'}
      <button class="btn primary" onclick={trustAndConnect}>{t('direct.trust')}</button>
    {/if}
  {/snippet}
</Dialog>

<Dialog tour="direct-forward" open={forwarding !== null} title={t('direct.forwardOn', { host: forwarding?.name ?? '' })} onclose={() => (forwarding = null)}>
  <p class="dim small">{t('direct.forwardHelp')}</p>
  <div class="grid2">
    <label class="field"><span>{t('direct.forwardHost')}</span><input bind:value={fwdHost} autocapitalize="none" spellcheck="false" /></label>
    <label class="field"><span>{t('direct.forwardPort')}</span><input type="number" min="1" max="65535" bind:value={fwdPort} data-testid="forward-port" /></label>
  </div>
  <label class="check"><input type="checkbox" bind:checked={fwdHttps} /> {t('direct.forwardHttps')}</label>
  {#snippet actions()}
    <button class="btn" onclick={() => (forwarding = null)}>{t('common.cancel')}</button>
    <button class="btn primary" disabled={!(fwdPort >= 1 && fwdPort <= 65535)} onclick={startForward} data-testid="forward-start">{t('direct.forwardStart')}</button>
  {/snippet}
</Dialog>

<ConfirmDialog />
<Toasts />

<style>
  .hrow {
    gap: 4px;
  }
  .plain {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
</style>
