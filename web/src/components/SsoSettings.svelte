<script lang="ts">
  import type { OidcSettings } from '@burrow/shared';
  import { errorMessage, get, put } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';

  // Single sign-on: the provider (Authelia, Authentik, Pocket ID, Keycloak),
  // the client Burrow is there, and the claim that finds a Burrow account.

  let s = $state<OidcSettings | null>(null);
  let enabled = $state(false);
  let issuer = $state('');
  let clientId = $state('burrow');
  let secret = $state('');
  let label = $state('');
  let claim = $state<'preferred_username' | 'email'>('preferred_username');
  let busy = $state(false);
  let saved = $state('');
  const snapshot = () => JSON.stringify([enabled, issuer, clientId, label, claim]);
  const dirty = $derived(s !== null && (snapshot() !== saved || !!secret));
  warnUnsaved(() => dirty);

  // Typed before the settings came: that stays, the rest is filled in (AUDIT2 UI-21: the late
  // answer wiped it). Not read: nothing is saved over what is stored.
  const blank = snapshot();
  let loadError = $state('');
  get<OidcSettings>('/api/settings/oidc').then(
    (x) => {
      const typed = snapshot() !== blank;
      s = x;
      if (!typed) {
        enabled = x.enabled;
        issuer = x.issuer;
        clientId = x.clientId || 'burrow';
        label = x.label;
        claim = x.claim;
      }
      saved = JSON.stringify([x.enabled, x.issuer, x.clientId || 'burrow', x.label, x.claim]);
    },
    (err: unknown) => (loadError = errorMessage(err)),
  );

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!s) return;
    busy = true;
    // What went out is what is saved: a field changed while it was on its way
    // stays unsaved (it was marked saved and lost, audit WC-07).
    const sent = snapshot();
    const sentSecret = secret;
    try {
      s = await put<OidcSettings>('/api/settings/oidc', { enabled, issuer, clientId, label, claim, ...(secret ? { clientSecret: secret } : {}) });
      if (secret === sentSecret) secret = '';
      saved = sent;
      toast(t('sso.saved'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

<form class="card stack" onsubmit={save} data-testid="sso" data-unsaved>
  <div class="row">
    <label class="check"><input type="checkbox" bind:checked={enabled} data-testid="sso-enabled" /> {t('sso.enabled')}</label>
  </div>
  {#if enabled}
  <label class="field"><span>{t('sso.issuer')}</span><input type="url" bind:value={issuer} required placeholder="https://auth.example.com" data-testid="sso-issuer" /></label>
  <div class="grid2">
    <label class="field"><span>{t('sso.clientId')}</span><input bind:value={clientId} required autocapitalize="none" data-testid="sso-client" /></label>
    <label class="field"><span>{t('sso.secret')}</span><input type="password" bind:value={secret} autocomplete="off" placeholder={s?.hasSecret ? t('channels.secretSet') : ''} data-testid="sso-secret" /></label>
  </div>
  <label class="field"><span>{t('sso.label')}</span><input bind:value={label} required maxlength="40" data-testid="sso-label" /></label>
  <label class="field">
    <span>{t('sso.claim')}</span>
    <select bind:value={claim}>
      <option value="preferred_username">{t('sso.claimName')}</option>
      <option value="email">{t('sso.claimEmail')}</option>
    </select>
  </label>
  {#if s}
    <p class="dim small" id="sso-redirect">{t('sso.redirect')}</p>
    <div class="linkrow toolbar">
      <input readonly value={s.redirectUri} class="mono" aria-labelledby="sso-redirect" />
      <button type="button" class="btn small" onclick={async () => (await copyText(s!.redirectUri)) && toast(t('common.copied'))}>{t('common.copy')}</button>
    </div>
  {/if}
  {/if}
  {#if loadError}<p class="alert error small">{loadError}</p>{/if}
  <!-- Off and as saved: nothing to save, so no Save (report 2359e7); turned off, Save stores that. -->
  {#if enabled || dirty}
  <div class="form-end">
    {#if dirty}<span class="dim small" data-testid="sso-unsaved">{t('common.unsaved')}</span>{/if}
    <button class="btn primary" disabled={busy || !s} data-testid="sso-save">{t('common.save')}</button>
  </div>
  {/if}
</form>

<style>
  .linkrow {
    display: flex;
    gap: 6px;
  }
  .linkrow input {
    flex: 1;
    min-width: 0;
  }
  .linkrow :global(.btn) {
    width: auto;
  }
</style>
