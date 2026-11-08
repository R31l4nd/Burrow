<script lang="ts">
  import AuthShell from '../components/AuthShell.svelte';
  import { untrack } from 'svelte';
  import type { AuthState, Role } from '@burrow/shared';
  import { errorMessage, get, post } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { setSession } from '../lib/session.svelte.js';

  // An invite link: pick a user name (the setup wizard follows for a way
  // to sign in), or accept it through single sign-on when that is set up.

  let { token: tokenProp }: { token: string } = $props();
  const token = untrack(() => tokenProp);
  let info = $state<{ role: Role; expiresAt: string } | null>(null);
  let sso = $state<{ enabled: boolean; label: string } | null>(null);
  let error = $state('');
  let username = $state('');
  let busy = $state(false);

  get<{ role: Role; expiresAt: string }>(`/api/invites/${encodeURIComponent(token)}`).then(
    (x) => (info = x),
    () => (error = t('invite.invalid')),
  );
  get<{ enabled: boolean; label: string }>('/api/auth/oidc').then(
    (x) => (sso = x),
    () => {},
  );

  async function accept(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      setSession(await post<AuthState>(`/api/invites/${encodeURIComponent(token)}/accept`, { username }));
      location.hash = '#/';
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<AuthShell>
  <div class="card stack login" data-testid="invite-page">
    <h1>{t('invite.title')}</h1>
    {#if info}
      <p>{t('invite.intro', { role: t(`users.role.${info.role}`) })}</p>
      <!-- Said to the one invited ("you may"), not the admin's view ("the folders you allow", W-FUNC-12). -->
      <p class="dim small">{info.role === 'operator' ? t('invite.operatorWhat') : t('invite.adminWhat')}</p>
      <form class="stack" onsubmit={accept}>
        <label class="field"><span>{t('invite.username')}</span><input bind:value={username} required autocomplete="username" autocapitalize="none" spellcheck="false" data-testid="invite-username" /></label>
        <button class="btn primary block" disabled={busy} data-testid="invite-accept">{t('invite.accept')}</button>
      </form>
      {#if sso?.enabled}
        <a class="btn block" href={`/api/auth/oidc/start?purpose=invite&invite=${encodeURIComponent(token)}`} data-testid="invite-sso">{t('invite.withSso', { label: sso.label })}</a>
      {/if}
    {/if}
    {#if error}<p class="alert error" role="alert">{error}</p>{/if}
  </div>
</AuthShell>

<style>
  .login {
    width: min(420px, 100%);
  }
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
</style>
