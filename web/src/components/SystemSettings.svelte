<script lang="ts">
  import type { SystemSettings, SystemSettingsInput } from '@burrow/shared';
  import { errorMessage, get, put } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';
  import LoadFailed from './LoadFailed.svelte';

  // Settings that were only in the .env file: a field left empty keeps the .env's value (shown
  // under it), a value here goes before it, at once, without a restart.

  type Key = keyof SystemSettingsInput;
  const numbers: Key[] = ['terminalMaxSessions', 'terminalIdleMinutes', 'statusIntervalSeconds'];
  let s = $state<SystemSettings | null>(null);
  let f = $state<Record<Key, string>>({ terminalMaxSessions: '', terminalIdleMinutes: '', statusIntervalSeconds: '', updateCheckExclude: '', registryEndpoints: '', appsBaseDomain: '' });
  let saved = $state('');
  let busy = $state(false);
  let loadError = $state('');
  const dirty = $derived(s !== null && JSON.stringify(f) !== saved);
  warnUnsaved(() => dirty);

  const asFields = (x: SystemSettingsInput): Record<Key, string> => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v === null ? '' : String(v)])) as Record<Key, string>;

  function load() {
    loadError = '';
    get<SystemSettings>('/api/settings/system').then(
      (x) => {
        // Typed before the settings came: that stays (as in the other parts, AUDIT2 UI-21).
        if (s === null && JSON.stringify(f) === JSON.stringify(asFields({ terminalMaxSessions: null, terminalIdleMinutes: null, statusIntervalSeconds: null, updateCheckExclude: null, registryEndpoints: null, appsBaseDomain: null }))) f = asFields(x.saved);
        s = x;
        saved = JSON.stringify(asFields(x.saved));
      },
      (err: unknown) => (loadError = errorMessage(err)),
    );
  }
  load();

  // A text field's example only while the .env sets nothing: the .env's value is said under the
  // field already, and a long one did not fit a phone's field (the tour, 2.15.0).
  const example = (k: Key, e: string) => (s && !s.env[k] ? e : '');

  const fromEnv = (k: Key) => {
    const v = s ? String(s.env[k]) : '';
    return v ? t('system.fromEnv', { value: v }) : t('system.fromEnvNone');
  };

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    const sent = JSON.stringify(f);
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() === '' ? null : numbers.includes(k as Key) ? Number(v) : v.trim()])) as SystemSettingsInput;
    try {
      s = await put<SystemSettings>('/api/settings/system', body);
      saved = sent;
      toast(t('system.saved'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

{#if loadError}
  <LoadFailed message={loadError} onretry={load} />
{:else}
<form class="card stack" onsubmit={save} data-testid="system" data-unsaved>
  <p class="dim small">{t('system.note')}</p>
  <h3 class="group">{t('settings.terminal')}</h3>
  <label class="field">
    <span>{t('system.maxSessions')}</span>
    <input inputmode="numeric" pattern="[0-9]*" bind:value={f.terminalMaxSessions} placeholder={s ? String(s.env.terminalMaxSessions) : ''} data-testid="system-max-sessions" />
    <span class="help">{fromEnv('terminalMaxSessions')}</span>
  </label>
  <label class="field">
    <span>{t('system.idleMinutes')}</span>
    <input inputmode="numeric" pattern="[0-9]*" bind:value={f.terminalIdleMinutes} placeholder={s ? String(s.env.terminalIdleMinutes) : ''} data-testid="system-idle-minutes" />
    <span class="help">{fromEnv('terminalIdleMinutes')}</span>
  </label>
  <h3 class="group">{t('system.hosts')}</h3>
  <label class="field">
    <span>{t('system.statusInterval')}</span>
    <input inputmode="numeric" pattern="[0-9]*" bind:value={f.statusIntervalSeconds} placeholder={s ? String(s.env.statusIntervalSeconds) : ''} data-testid="system-status-interval" />
    <span class="help">{fromEnv('statusIntervalSeconds')}</span>
  </label>
  <h3 class="group">{t('system.containers')}</h3>
  <label class="field">
    <span>{t('system.updateExclude')}</span>
    <input class="mono" bind:value={f.updateCheckExclude} autocapitalize="none" spellcheck="false" placeholder={example('updateCheckExclude', '^registry\\.lan/')} data-testid="system-update-exclude" />
    <span class="help">{fromEnv('updateCheckExclude')}</span>
  </label>
  <label class="field">
    <span>{t('system.registries')}</span>
    <input class="mono" bind:value={f.registryEndpoints} autocapitalize="none" spellcheck="false" placeholder={example('registryEndpoints', 'reg.lan=http://10.0.0.5:5000')} data-testid="system-registries" />
    <span class="help">{fromEnv('registryEndpoints')}</span>
  </label>
  <label class="field">
    <span>{t('system.appsDomain')}</span>
    <input bind:value={f.appsBaseDomain} autocapitalize="none" spellcheck="false" placeholder={example('appsBaseDomain', 'example.com')} data-testid="system-apps-domain" />
    <span class="help">{fromEnv('appsBaseDomain')}</span>
  </label>
  <div class="form-end">
    {#if dirty}<span class="dim small" data-testid="system-unsaved">{t('common.unsaved')}</span>{/if}
    <button class="btn primary" disabled={busy || !s} data-testid="system-save">{t('common.save')}</button>
  </div>
</form>
{/if}
