<script lang="ts">
  import { sayDirectKeys } from '../lib/directkeys.js';
  import { ask } from '../lib/confirm.svelte.js';
  import type { ConnectResult, Host } from '@burrow/shared';
  import { effectiveConnection } from '@burrow/shared/effective';
  import { del, errorMessage, post, put } from '../lib/api.js';
  import { data, groupPath, loadAll } from '../lib/data.svelte.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { go, goFrom, here } from '../lib/router.svelte.js';
  import { connectHost, terms } from '../lib/sessions.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { android } from '../lib/android.js';
  import { get } from '../lib/api.js';
  import HistoryDialog from './HistoryDialog.svelte';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import Icon from './Icon.svelte';

  // Everything you can do with one host. In phase 0 that is testing the
  // connection (with trust-on-first-use), installing a key and editing.
  let {
    host,
    open = $bindable(false),
    firstConnect = $bindable(false),
  }: {
    host: Host | null;
    open?: boolean;
    /** Opened by a tap on a host whose key is not trusted yet: the fingerprint at once, and trusting it connects (W-FUNC-02, decision 13). */
    firstConnect?: boolean;
  } = $props();
  const admin = $derived(session.state?.user?.role === 'admin');

  async function wake() {
    busy = true;
    try {
      const r = await post<{ relay: string }>(`/api/hosts/${host!.id}/wake`, {});
      toast(t('hosts.woken', { relay: r.relay }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  // In the app: the hosts this phone reaches by itself (the direct route).
  let directIds = $state<number[]>([]);
  $effect(() => {
    const id = session.state?.deviceId;
    if (!android || !id || !open) return;
    void get<{ hostIds: number[] }>(`/api/account/devices/${id}/hosts`).then(
      (r) => (directIds = r.hostIds),
      () => {},
    );
  });

  let result = $state<ConnectResult | null>(null);
  const eff = $derived(host ? effectiveConnection(host, new Map(data.groups.map((g) => [g.id, g])), data.hostDefaults) : null);

  // The name part of /etc/ssh/ssh_host_<type>_key.pub for a key type.
  const hostKeyFile = (keyType: string) =>
    keyType.startsWith('ecdsa') ? 'ecdsa' : keyType.replace(/^ssh-/, '');
  let busy = $state(false);
  let installing = $state(false);
  let installKeyId = $state<number | null>(null);
  let installPassword = $state('');
  // Name of the key just installed and proven by a key login; shown as its
  // own confirmation, separate from an earlier connection test.
  let installed = $state<string | null>(null);

  // Reset when another host is opened. Not on every new host object: the
  // list reloads after a test, and that must not wipe the result shown.
  let shownId: number | null = null;
  $effect.pre(() => {
    const id = host?.id ?? null;
    if (id === shownId) return;
    shownId = id;
    result = null;
    installing = false;
    installPassword = '';
    installed = null;
  });

  async function run(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  const openSessions = $derived(terms.list.filter((s) => s.hostId === host?.id));

  const connect = (fresh: boolean, tmux?: 'always' | 'never') =>
    run(async () => {
      await connectHost(host!.id, fresh, undefined, tmux);
      open = false;
    });
  // "New session" the other way than usual, in a small menu beside it.
  let otherWays = $state(false);
  $effect(() => {
    if (!open) otherWays = false;
  });

  // Each result belongs to the host it was asked for: the sheet opened for another host
  // meanwhile shows nothing of it, and nothing follows up on the first (AUDIT2 UI-18).
  const test = () =>
    run(async () => {
      const id = host!.id;
      installed = null;
      const r = await post<ConnectResult>(`/api/hosts/${id}/test`);
      if (shownId !== id) return;
      result = r;
      if (r.status === 'ok') await loadAll();
    });

  const trust = () =>
    run(async () => {
      const id = host!.id;
      if (result?.status !== 'unknown_host_key') return;
      await post(`/api/hosts/${id}/trust`, { fingerprint: result.fingerprint });
      if (shownId !== id) return void (await loadAll());
      const r = await post<ConnectResult>(`/api/hosts/${id}/test`);
      if (shownId === id) result = r;
      await loadAll();
      // The tap asked for a terminal: trusted, it opens (one step, not a test and then New session).
      if (firstConnect && r.status === 'ok' && shownId === id) {
        firstConnect = false;
        await connectHost(id);
        open = false;
      }
    });
  // The connection checked at once, so the fingerprint shows without a press of Test connection.
  let autoTested: number | null = null;
  $effect(() => {
    if (open && firstConnect && host && autoTested !== host.id) {
      autoTested = host.id;
      result = null;
      void test();
    }
  });
  $effect(() => {
    if (open) return;
    firstConnect = false;
    autoTested = null;
  });

  const install = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      const id = host!.id;
      const r = await post<ConnectResult>(`/api/hosts/${id}/install-key`, { keyId: installKeyId, password: installPassword });
      if (shownId !== id) return void (await loadAll());
      installPassword = '';
      if (r.status === 'ok') {
        installing = false;
        installed = data.keys.find((k) => k.id === installKeyId)?.name ?? '';
        result = null;
        toast(t('install.ok', { key: installed }));
      } else {
        result = r;
      }
      await loadAll();
    });
  };

  const forgetPassword = () =>
    run(async () => {
      await del(`/api/hosts/${host!.id}/password`);
      await loadAll();
      toast(t('install.passwordRemoved'));
    });

  const setIntegration = (enabled: boolean) =>
    run(async () => {
      if (!enabled && !(await ask({ text: t('hosts.integrationRemoveConfirm'), confirm: t('hosts.integrationRemove') }))) return;
      result = await put<ConnectResult>(`/api/hosts/${host!.id}/shell-integration`, { enabled });
      if (result.status === 'ok') {
        toast(enabled ? t('hosts.integrationInstalled') : t('hosts.integrationRemoved'));
        result = null;
      }
      await loadAll();
    });

  const importHistory = () =>
    run(async () => {
      const r = await post<{ imported: number; skipped: number }>(`/api/hosts/${host!.id}/history/import`);
      toast(t('hosts.historyImported', { imported: r.imported, skipped: r.skipped }));
    });

  let historyOpen = $state(false);
  const clearHistory = () =>
    run(async () => {
      if (!(await ask({ text: t('hosts.historyClearConfirm', { name: host!.name }), confirm: t('hosts.historyClear'), danger: true }))) return;
      await del(`/api/hosts/${host!.id}/history`);
      toast(t('hosts.historyCleared'));
    });

  const copy = () =>
    run(async () => {
      const from = here();
      const h = await post<Host>(`/api/hosts/${host!.id}/copy`);
      await loadAll();
      open = false;
      goFrom(from, `/hosts/${h.id}/edit`);
    });

  const remove = () =>
    run(async () => {
      if (!(await ask({ text: t('common.confirmDelete', { name: host!.name }), confirm: t('common.delete'), danger: true }))) return;
      const r = await del<unknown>(`/api/hosts/${host!.id}`);
      await loadAll();
      open = false;
      sayDirectKeys(r);
    });
</script>

{#if host}<HistoryDialog bind:open={historyOpen} hostId={host.id} hostName={host.name} />{/if}

{#snippet outcome()}
    {#if result}
      {#if result.status === 'ok'}
        <p class="alert ok" data-testid="test-ok"><Icon name="check" size={16} /> {t('test.ok', { os: result.facts.os ?? '' })}</p>
      {:else if result.status === 'unknown_host_key'}
        <div class="alert warn stack">
          <strong>{t('test.unknownKey')}</strong>
          <span class="small">{result.keyType}</span>
          <span class="mono" data-testid="fingerprint">{result.fingerprint}</span>
          <span class="small">{t('test.unknownKeyHelp', { type: hostKeyFile(result.keyType) })}</span>
          <button class="btn primary" disabled={busy} onclick={trust}>{t('test.trust')}</button>
        </div>
      {:else if result.status === 'host_key_mismatch'}
        <div class="alert error stack" role="alert">
          <strong><Icon name="alert" size={16} /> {t('test.mismatch')}</strong>
          <span class="small">{t('test.mismatchHelp')}</span>
          <span class="small">{t('test.mismatchSeen')}: <span class="mono">{result.fingerprint}</span></span>
          <span class="small">{t('test.mismatchKnown')}: <span class="mono">{result.knownFingerprint}</span></span>
          <span class="small">{t('test.mismatchFix')}</span>
        </div>
      {:else if result.status === 'auth_failed'}
        <p class="alert error">{t('test.authFailed')}</p>
      {:else if result.status === 'unreachable'}
        <p class="alert error">{t('test.unreachable', { message: result.message })}</p>
      {:else}
        <p class="alert error">{t('test.error', { message: result.message })}</p>
      {/if}
    {/if}
{/snippet}

<Dialog tour="host-sheet" menu bind:open title={host?.name ?? ''}>
  {#if host}
    <!-- A first tap on a host not trusted yet: what to check before trusting, first (W-FUNC-02). -->
    {#if firstConnect}
      {#if result}{@render outcome()}{:else}<p class="dim small" data-testid="first-check">{t('hosts.firstCheck')}</p>{/if}
    {/if}
    <p class="dim small">
      {eff?.username ? `${eff.username}@` : ''}{host.address}{eff && eff.port !== 22 ? `:${eff.port}` : ''}
      {#if host.groupId}| {groupPath(host.groupId)}{/if}
    </p>
    {#if host.facts}
      <p class="small">
        {host.facts.os ?? host.facts.kernel ?? ''}
        {#if host.facts.hasTmux}<span class="badge">tmux</span>{/if}
        {#if host.facts.hasDocker}<span class="badge">docker</span>{/if}
        <span class="dim">| {relativeTime(host.facts.checkedAt)}</span>
      </p>
    {/if}
    <!-- For everyone: how the host is doing, and its files. The rest is the admin's. -->
    {#if admin && (host?.wakeMac || host?.facts?.mac) && data.status[host.id] && !data.status[host.id]!.reachable}
      <!-- Asleep: another host that is up (or the one chosen on it, or Burrow) sends the Wake-on-LAN packet. -->
      <button class="btn" disabled={busy} onclick={wake} data-testid="host-wake">{t('hosts.wake')}</button>
    {/if}
    <button class="btn" onclick={() => ((open = false), go(`/hosts/${host!.id}/stats`))} data-testid="host-stats">{t('stats.open')}</button>
    <button class="btn" onclick={() => ((open = false), go(`/hosts/${host!.id}/journal`))} data-testid="host-journal">{t('journal.open')}</button>
    {#if admin && host?.facts?.hasDocker}
      <button class="btn" onclick={() => ((open = false), go(`/hosts/${host!.id}/docker`))} data-testid="host-docker">{t('res.open')}</button>
    {/if}
    <button class="btn" onclick={() => ((open = false), go(`/files/${host!.id}`))}>{t('nav.files')}</button>
    {#if admin}
    {#if openSessions.length}
      <button class="btn primary" disabled={busy} onclick={() => connect(false)}>{t('hosts.resume')}</button>
    {/if}
    <div class="newrow">
      <button class="btn" class:primary={!openSessions.length} disabled={busy} onclick={() => connect(true)} data-testid="new-session">{t('hosts.newSession')}</button>
      <button class="btn more" aria-expanded={otherWays} aria-label={t('hosts.otherWays')} title={t('hosts.otherWays')} onclick={() => (otherWays = !otherWays)} data-testid="session-options"><Icon name="more" size={18} /></button>
    </div>
    {#if otherWays}
      <!-- Unlike the host's setting, this once; and from the phone itself. -->
      <div class="stack otherways" data-testid="session-other-ways">
        <button class="btn small" disabled={busy} onclick={() => connect(true, 'always')} data-testid="session-tmux"><Icon name="layers" size={16} /> {t('hosts.withTmux')}</button>
        <button class="btn small" disabled={busy} onclick={() => connect(true, 'never')} data-testid="session-memory"><Icon name="terminal" size={16} /> {t('hosts.withoutTmux')}</button>
        {#if android && host && directIds.includes(host.id)}
          <button class="btn small" onclick={() => ((open = false), void android?.openDirect(host!.id))} data-testid="direct-session"><Icon name="phone" size={16} /> {t('hosts.directSession')}</button>
        {/if}
      </div>
    {/if}
    <button class="btn block" disabled={busy} onclick={test} data-testid="test-connection">{t('hosts.test')}</button>

    {#if !firstConnect}{@render outcome()}{/if}

    {#if installed !== null}
      <div class="alert ok stack" data-testid="install-ok">
        <span><Icon name="check" size={16} /> {t('install.ok', { key: installed })}</span>
        {#if host.hasPassword}
          <span class="small">{t('install.passwordLeft')}</span>
          <button class="btn small" disabled={busy} onclick={forgetPassword}>{t('host.clearPassword')}</button>
        {/if}
      </div>
    {/if}

    <details class="more">
      <summary>{t('hosts.completion')}</summary>
      <div class="stack">
        <div class="row">
          <span class="small">{host.facts?.hasShellIntegration ? t('hosts.integrationOn') : t('hosts.integrationOff')}</span>
          <HelpTip text={t('help.shellIntegration')} />
        </div>
        {#if host.facts?.hasShellIntegration}
          <button class="btn small" disabled={busy} onclick={() => setIntegration(false)}>{t('hosts.integrationRemove')}</button>
        {:else}
          <button class="btn small" disabled={busy} onclick={() => setIntegration(true)} data-testid="install-integration">{t('hosts.integrationInstall')}</button>
        {/if}
        <button class="btn small" onclick={() => ((open = false), (historyOpen = true))} data-testid="history-manage">{t('history.manage')}</button>
        <button class="btn small" disabled={busy} onclick={importHistory}>{t('hosts.historyImport')}</button>
        <button class="btn small danger" disabled={busy} onclick={clearHistory}>{t('hosts.historyClear')}</button>
      </div>
    </details>

    {#if installing}
      <form class="card stack" onsubmit={install}>
        <strong>{t('install.title')}</strong>
        <p class="dim small">{t('install.help')}</p>
        <label class="field">
          <span>{t('install.key')}</span>
          <select bind:value={installKeyId} required>
            {#each data.keys as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>{t('install.password', { user: eff?.username ?? '...', host: host.address })}</span>
          <input type="password" bind:value={installPassword} autocomplete="off" required />
        </label>
        <button class="btn primary" disabled={busy || !installKeyId}>{t('install.submit')}</button>
      </form>
    {:else}
      <button
        class="btn block"
        disabled={data.keys.length === 0}
        onclick={() => {
          installing = true;
          installKeyId = host!.keyId ?? data.keys[0]?.id ?? null;
        }}>{t('hosts.installKey')}</button>
    {/if}
    {/if}
  {/if}

  <!-- Deleting on a row of its own, apart from the everyday actions below. -->
  {#if admin}<button class="btn danger small" disabled={busy} onclick={remove}>{t('common.delete')}</button>{/if}

  {#snippet actions()}
    {#if admin}
    <button class="btn small" disabled={busy} onclick={copy}>{t('common.copy')}</button>
    <button
      class="btn small"
      onclick={() => {
        open = false;
        go(`/hosts/${host!.id}/edit`);
      }}>{t('common.edit')}</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .newrow {
    display: flex;
    gap: 8px;
  }
  .newrow > :first-child {
    flex: 1;
  }
  .newrow .more {
    width: auto;
    flex: none;
    padding: 0 12px;
  }
  .otherways {
    padding-left: 12px;
    border-left: 2px solid var(--border);
  }
</style>
