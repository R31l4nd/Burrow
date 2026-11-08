<script lang="ts">
  import { route } from '../lib/router.svelte.js';
  import type { AuthState } from '@burrow/shared';
  import { errorMessage, post } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { android } from '../lib/android.js';
  import { deviceStepUp, passkeyStepUp, session, setSession } from '../lib/session.svelte.js';
  import { finishStepUp, stepUp } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';

  let code = $state('');
  let error = $state('');
  let busy = $state(false);

  const user = $derived(session.state?.user);
  // Signed in through the app's fingerprint key: confirm with it too.
  const deviceId = $derived(android ? (session.state?.deviceId ?? null) : null);
  // No way to confirm on this device (the app not paired, no authenticator, the passkey not
  // offered in the app): said, with where to get one, not a dialog with only Cancel (A3-WEB-23).
  const noWay = $derived(!!user && !deviceId && !(user.hasPasskey && !android) && !user.hasTotp && !user.hasSso);

  async function withDevice() {
    error = '';
    busy = true;
    try {
      await deviceStepUp(deviceId!);
      done(true);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function withPasskey() {
    error = '';
    busy = true;
    try {
      await passkeyStepUp();
      done(true);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function withTotp(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      setSession(await post<AuthState>('/api/auth/step-up/totp', { code }));
      done(true);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  function done(ok: boolean) {
    code = '';
    error = '';
    finishStepUp(ok);
  }
</script>

<Dialog tour="step-up" open={stepUp.open} title={t('stepup.title')} onclose={() => stepUp.open && done(false)}>
  <p class="dim" data-testid="stepup-why">{stepUp.why ?? t('stepup.intro')}</p>
  {#if deviceId}
    <button class="btn primary block" disabled={busy} onclick={withDevice}>{t('stepup.fingerprint')}</button>
  {/if}
  {#if user?.hasPasskey && !android}
    <button class="btn primary block" disabled={busy} onclick={withPasskey}>{t('stepup.passkey')}</button>
  {/if}
  {#if user?.hasTotp}
    <form class="stack" onsubmit={withTotp}>
      <label class="field">
        <span>{t('stepup.totp')}</span>
        <input bind:value={code} inputmode="numeric" autocomplete="one-time-code" pattern={'[0-9]{6}'} maxlength="6" required />
      </label>
      <button class="btn block" disabled={busy || code.length !== 6}>{t('stepup.confirm')}</button>
    </form>
  {/if}
  {#if user?.hasSso}
    <!-- Off to the provider and back to this page; the action is tried again there. -->
    <a class="btn block" href={`/api/auth/oidc/start?purpose=stepup&next=${encodeURIComponent(route.path.split('?')[0] || '/')}`} data-testid="stepup-sso">{t('stepup.sso')}</a>
  {/if}
  {#if noWay}<p class="alert error" data-testid="stepup-none">{android ? t('stepup.noneApp') : t('stepup.none')}</p>{/if}
  {#if error}<p class="alert error">{error}</p>{/if}
  {#snippet actions()}
    <button class="btn" onclick={() => done(false)}>{t('common.cancel')}</button>
  {/snippet}
</Dialog>
