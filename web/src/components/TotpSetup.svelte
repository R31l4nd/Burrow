<script lang="ts">
  import { errorMessage, post } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';

  // Shows the QR code for a new TOTP secret and confirms it with a code.
  let { ondone }: { ondone: () => void } = $props();

  let secret = $state('');
  let svg = $state('');
  let code = $state('');
  let error = $state('');
  let busy = $state(false);

  async function start() {
    const r = await post<{ secret: string; uri: string }>('/api/account/totp/setup');
    secret = r.secret;
    // Loaded here, not with the app: only this step draws a QR code (it was a sixth of the first download).
    const { default: QRCode } = await import('qrcode');
    svg = await QRCode.toString(r.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  async function confirm(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      await post('/api/account/totp/confirm', { code });
      ondone();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  start().catch((err: unknown) => (error = errorMessage(err)));
</script>

<div class="stack">
  <p class="dim small">{t('settings.totpScan')}</p>
  {#if svg}
    <!-- A name for the picture (W-FUNC-12: the QR had none). -->
    <div class="qr" role="img" aria-label={t('settings.totpQr')}>{@html svg}</div>
    <p class="mono small center" data-testid="totp-secret">{secret.replace(/(.{4})/g, '$1 ').trim()}</p>
  {/if}
  <form class="stack" onsubmit={confirm}>
    <label class="field">
      <span>{t('login.totp')}</span>
      <input bind:value={code} inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern={'[0-9]{6}'} required />
    </label>
    <button class="btn primary block" disabled={busy || code.length !== 6}>{t('stepup.confirm')}</button>
  </form>
  {#if error}<p class="alert error">{error}</p>{/if}
</div>

<style>
  .qr {
    width: 200px;
    margin: 0 auto;
    background: #fff;
    border-radius: 8px;
    padding: 6px;
  }
  .qr :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .center {
    text-align: center;
  }
</style>
