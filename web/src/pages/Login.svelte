<script lang="ts">
  import AuthShell from '../components/AuthShell.svelte';
  import Mark from '../components/Mark.svelte';
  import type { AuthState } from '@burrow/shared';
  import { ApiFailure, get, post } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { android, androidInfo } from '../lib/android.js';
  import { deviceLogin, pairWithCode, passkeyLogin, setSession } from '../lib/session.svelte.js';

  // kept: over a page with work not saved yet, signed out meanwhile (App.svelte).
  let { kept = false }: { kept?: boolean } = $props();

  // In the Android app passkeys do not work (the WebView cannot use them for
  // a LAN-only domain); the app signs in with its fingerprint key instead,
  // after being paired once with a code.
  let mode = $state<'passkey' | 'password' | 'totp' | 'recovery' | 'device' | 'pair'>(android ? 'password' : 'passkey');
  let deviceId = $state<number | null>(null);
  let deviceName = $state('Android');
  let username = $state('');
  let password = $state('');
  let code = $state('');
  let ticket = $state('');
  let error = $state('');
  let busy = $state(false);

  function explain(err: unknown): string {
    if (err instanceof ApiFailure && err.status === 429) return t('login.blocked');
    if (mode === 'pair' && err instanceof ApiFailure) return t('login.pairInvalid');
    if (mode === 'device' && !(err instanceof ApiFailure)) return t('login.fingerprintCancelled');
    if (mode === 'device') return t('login.deviceFailed');
    if (err instanceof DOMException && err.name === 'NotAllowedError') return t('login.passkeyCancelled');
    return t('login.invalid');
  }

  async function run(fn: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await fn();
    } catch (err) {
      error = explain(err);
    } finally {
      busy = false;
    }
  }

  const withPasskey = () => run(async () => void (await passkeyLogin()));

  // Single sign-on, when the admin set it up: a button to the provider.
  let sso = $state<{ enabled: boolean; label: string } | null>(null);
  get<{ enabled: boolean; label: string }>('/api/auth/oidc').then(
    (x) => (sso = x),
    () => {},
  );

  const withDevice = () => run(async () => void (await deviceLogin(deviceId!)));

  const withPairCode = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => void (await pairWithCode(code, deviceName)));
  };

  // A paired app asks for the fingerprint straight away.
  void androidInfo().then((info) => {
    if (!info) return;
    deviceName = info.deviceName || 'Android';
    if (info.deviceId) {
      deviceId = info.deviceId;
      mode = 'device';
      void withDevice();
    }
  });

  const withPassword = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await post<{ ticket: string }>('/api/auth/password', { username, password });
      ticket = r.ticket;
      password = '';
      mode = 'totp';
    });
  };

  // The password step is valid for a few minutes: once that is over, back to it,
  // said why, rather than "sign-in failed" on every code (AUDIT2 PAGE-15).
  const passwordAgain = (why = '') => {
    ticket = '';
    code = '';
    mode = 'password';
    error = why;
  };
  const withTotp = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      try {
        setSession(await post<AuthState>('/api/auth/totp', { ticket, code }));
      } catch (err) {
        if (err instanceof ApiFailure && err.code === 'ticket_expired') return passwordAgain(t('login.ticketExpired'));
        throw err;
      }
    });
  };

  const withRecovery = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => setSession(await post<AuthState>('/api/auth/recovery', { username, code })));
  };
</script>

<AuthShell>
  <div class="auth-card stack">
    <div class="brand">
      <Mark size={40} />
      <h1>{t('login.title')}</h1>
    </div>
    {#if kept}<p class="alert warn" role="status" data-testid="login-kept">{t('login.keptUnsaved')}</p>{/if}

    {#if mode === 'device'}
      <button class="btn primary block" disabled={busy} onclick={withDevice}>{t('login.fingerprint')}</button>
      <button class="btn block" onclick={() => (mode = 'password')}>{t('login.usePassword')}</button>
    {:else if mode === 'pair'}
      <form class="stack" onsubmit={withPairCode}>
        <p class="dim small">{t('login.pairHint')}</p>
        <label class="field">
          <span>{t('login.pairCode')}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={code} autocomplete="off" autocapitalize="characters" spellcheck="false" required autofocus />
        </label>
        <button class="btn primary block" disabled={busy}>{t('login.pair')}</button>
      </form>
      <button class="btn block" onclick={() => (mode = 'password')}>{t('login.usePassword')}</button>
    {:else if mode === 'passkey'}
      <button class="btn primary block" disabled={busy} onclick={withPasskey}>{t('login.passkey')}</button>
      <button class="btn block" onclick={() => (mode = 'password')}>{t('login.usePassword')}</button>
    {:else if mode === 'password'}
      <form class="stack" onsubmit={withPassword}>
        <label class="field">
          <span>{t('login.username')}</span>
          <input bind:value={username} name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required />
        </label>
        <label class="field">
          <span>{t('login.password')}</span>
          <input type="password" bind:value={password} name="password" autocomplete="current-password" required />
        </label>
        <button class="btn primary block" disabled={busy}>{t('common.next')}</button>
      </form>
      {#if !android}
        <button class="btn block" onclick={() => (mode = 'passkey')}>{t('login.passkey')}</button>
      {:else if deviceId}
        <button class="btn block" onclick={() => (mode = 'device')}>{t('login.fingerprint')}</button>
      {/if}
    {:else if mode === 'totp'}
      <form class="stack" onsubmit={withTotp}>
        <label class="field">
          <span>{t('login.totp')}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={code} name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern={'[0-9]{6}'} required autofocus />
        </label>
        <button class="btn primary block" disabled={busy || code.length !== 6}>{t('login.submit')}</button>
      </form>
      <button class="btn block" onclick={() => passwordAgain()} data-testid="totp-back">{t('login.passwordAgain')}</button>
    {:else}
      <form class="stack" onsubmit={withRecovery}>
        <label class="field">
          <span>{t('login.username')}</span>
          <input bind:value={username} autocomplete="username" autocapitalize="none" required />
        </label>
        <label class="field">
          <span>{t('login.recoveryCode')}</span>
          <input bind:value={code} autocomplete="off" autocapitalize="characters" spellcheck="false" required />
        </label>
        <button class="btn primary block" disabled={busy}>{t('login.submit')}</button>
      </form>
    {/if}

    {#if sso?.enabled && mode !== 'totp'}
      <a class="btn block" href="/api/auth/oidc/start" data-testid="login-sso">{t('login.sso', { label: sso.label })}</a>
    {/if}
    {#if android && mode !== 'pair' && mode !== 'totp'}
      <button class="btn block" onclick={() => ((mode = 'pair'), (code = ''), (error = ''))}>{t('login.pairWithCode')}</button>
    {/if}
    {#if mode !== 'recovery'}
      <button class="btn block" onclick={() => ((mode = 'recovery'), (code = ''))}>{t('login.useRecovery')}</button>
    {/if}

    {#if error}<p class="alert error" role="alert">{error}</p>{/if}
  </div>
</AuthShell>
