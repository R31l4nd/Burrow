<script lang="ts">
  import AuthShell from '../components/AuthShell.svelte';
  import Mark from '../components/Mark.svelte';
  import Icon from '../components/Icon.svelte';
  import type { AuthState } from '@burrow/shared';
  import TotpSetup from '../components/TotpSetup.svelte';
  import { errorMessage, post, put } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { deviceName, refreshSession, registerPasskey, session, setSession } from '../lib/session.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';

  // Three steps: claim the instance with the token from the log, register a
  // login method, save the recovery codes.

  let token = $state('');
  let username = $state('');
  let method = $state<'passkey' | 'password' | null>(null);
  let password = $state('');
  let passwordSaved = $state(false);
  let codes = $state<string[] | null>(null);
  let finalState = $state<AuthState | null>(null);
  let saved = $state(false);
  // Shown once: a reload or another page before they are saved loses them (AUDIT2 PAGE-32).
  warnUnsaved(() => codes !== null && !saved);
  let error = $state('');
  let busy = $state(false);

  const user = $derived(session.state?.user);
  const step = $derived(codes ? 3 : user?.incomplete ? 2 : 1);
  const canFinish = $derived(!!user && (user.hasPasskey || (user.hasPassword && user.hasTotp)));
  const passkeysSupported = typeof window.PublicKeyCredential === 'function';

  async function run(fn: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await fn();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  const begin = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => setSession(await post<AuthState>('/api/setup/begin', { token, username })));
  };

  const createPasskey = () =>
    run(async () => {
      await registerPasskey(deviceName());
    });

  const savePassword = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      await put('/api/account/password', { password });
      passwordSaved = true;
      await refreshSession();
    });
  };

  const finish = () =>
    run(async () => {
      const r = await post<{ recoveryCodes: string[]; state: AuthState }>('/api/setup/finish');
      codes = r.recoveryCodes;
      // Applied only after the codes were saved: the new state ends setup mode.
      finalState = r.state;
    });

  async function copyCodes() {
    if (codes && (await copyText(codes.join('\n')))) toast(t('common.copied'));
  }
</script>

<AuthShell page="setup">
  <div class="auth-card stack">
    <div class="brand">
      <Mark size={40} />
      <!-- Someone invited finishes joining, not setting up Burrow (W-FUNC-12). -->
      <h1>{session.state?.setupRequired === false && user?.incomplete ? t('invite.title') : t('setup.title')}</h1>
    </div>

    {#if step === 1}
      <p class="dim">{t('setup.intro')}</p>
      <form class="stack" onsubmit={begin}>
        <label class="field">
          <span>{t('setup.token')}</span>
          <input bind:value={token} name="token" autocomplete="off" autocapitalize="characters" spellcheck="false" required />
          <span class="help">{t('setup.tokenHelp')}</span>
        </label>
        <label class="field">
          <span>{t('setup.username')}</span>
          <input bind:value={username} name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="2" />
        </label>
        <button class="btn primary block" disabled={busy}>{t('common.next')}</button>
      </form>
    {:else if step === 2}
      <h2>{t('setup.methodTitle')}</h2>
      {#if method !== 'password'}
        <div class="card stack">
          <strong>{t('setup.passkey')}</strong>
          <p class="dim small">{t('setup.passkeyHelp')}</p>
          {#if user?.hasPasskey}
            <p class="alert ok"><Icon name="check" size={16} /> Passkey</p>
          {:else}
            <button class="btn primary block" disabled={busy || !passkeysSupported} onclick={createPasskey}>{t('setup.addPasskey')}</button>
          {/if}
        </div>
      {/if}
      {#if !user?.hasPasskey}
        {#if method === 'password'}
          <div class="card stack">
            <strong>{t('setup.password')}</strong>
            {#if !passwordSaved && !user?.hasPassword}
              <form class="stack" onsubmit={savePassword}>
                <label class="field">
                  <span>{t('settings.newPassword')}</span>
                  <input type="password" bind:value={password} autocomplete="new-password" minlength="12" required />
                </label>
                <button class="btn primary block" disabled={busy}>{t('common.next')}</button>
              </form>
            {:else if !user?.hasTotp}
              <TotpSetup ondone={() => void refreshSession()} />
            {:else}
              <p class="alert ok"><Icon name="check" size={16} /> {t('setup.password')}</p>
            {/if}
          </div>
        {:else}
          <button class="btn block" onclick={() => (method = 'password')}>{t('setup.password')}</button>
          <p class="dim small">{t('setup.passwordHelp')}</p>
        {/if}
      {/if}
      <button class="btn primary block" disabled={busy || !canFinish} onclick={finish}>{t('setup.finish')}</button>
    {:else if codes}
      <h2>{t('setup.recoveryTitle')}</h2>
      <p class="dim">{t('setup.recoveryIntro')}</p>
      <div class="codes" data-testid="recovery-codes">
        {#each codes as c (c)}<span>{c}</span>{/each}
      </div>
      <button class="btn block" onclick={copyCodes}>{t('common.copy')}</button>
      <label class="check"><input type="checkbox" bind:checked={saved} /> {t('setup.recoverySaved')}</label>
      <button class="btn primary block" disabled={!saved} onclick={() => finalState && setSession(finalState)}>{t('common.done')}</button>
    {/if}

    {#if error}<p class="alert error" role="alert">{error}</p>{/if}
  </div>
</AuthShell>
