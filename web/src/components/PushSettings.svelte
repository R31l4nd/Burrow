<script lang="ts">
  import type { PushDevice } from '@burrow/shared';
  import { ask } from '../lib/confirm.svelte.js';
  import { del, errorMessage, get, post } from '../lib/api.js';
  import { android } from '../lib/android.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { canPush, checkPush, push, pushOff, pushOn } from '../lib/push.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import Icon from './Icon.svelte';
  import LoadFailed from './LoadFailed.svelte';

  // Burrow's own notifications on this device (a browser, or the app), and
  // this person's other devices that have them on. What reaches them is set
  // per channel (Notification channels: "Burrow's own push").

  let devices = $state<PushDevice[]>([]);
  // Not read: said with Try again, not "no other devices" (A3-WEB-01).
  let loadError = $state('');
  const load = async () => {
    devices = await get<PushDevice[]>('/api/push/devices');
    loadError = '';
  };
  const firstLoad = () => void load().catch((err: unknown) => (loadError = errorMessage(err)));
  void checkPush().catch(() => {});
  firstLoad();

  async function toggle() {
    push.busy = true;
    try {
      if (push.on) await pushOff();
      else {
        await pushOn();
        // In the app the address comes a moment later ("pushEndpoint").
        if (android) toast(t('push.appAsked'));
      }
      await load();
    } catch (err) {
      toast((err as Error).message === 'denied' ? t('push.denied') : errorMessage(err), 'error');
    } finally {
      push.busy = false;
    }
  }

  async function test() {
    try {
      const r = await post<{ sent: number }>('/api/push/test');
      toast(t('push.testSent', { n: r.sent }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove(d: PushDevice) {
    if (!(await ask({ text: t('push.removeConfirm', { name: d.label }), confirm: t('common.remove'), danger: true }))) return;
    // Refused: said, not a rejection nobody sees (AUDIT2 UI-29).
    try {
      await del(`/api/push/devices/${d.id}`);
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

<div class="card stack" data-testid="push-card">
  {#if !canPush}
    <p class="dim small">{t('push.unsupported')}</p>
  {:else}
    <p class="small" data-testid="push-state">{push.on ? t('push.on') : t('push.off')}</p>
    <div class="row">
      <button class="btn small" class:primary={!push.on} disabled={push.busy} onclick={toggle} data-testid="push-toggle"><Icon name={push.on ? 'bell-off' : 'bell'} size={16} /> {push.on ? t('push.turnOff') : t('push.turnOn')}</button>
      {#if devices.length}<button class="btn small" onclick={test} data-testid="push-test"><Icon name="send" size={16} /> {t('push.test')}</button>{/if}
    </div>
  {/if}
  {#if loadError}<LoadFailed inline message={loadError} onretry={firstLoad} />{/if}
  {#if devices.length}
    <div class="list">
      {#each devices as d (d.id)}
        <div class="list-item" data-testid="push-device">
          <Icon name={d.kind === 'unifiedpush' ? 'phone' : 'bell'} />
          <span class="main"><span class="title">{d.label}</span><span class="sub">{d.lastOkAt ? t('push.lastOk', { when: relativeTime(d.lastOkAt) }) : t('push.notYet')}</span></span>
          <button class="icon-btn" aria-label={t('common.remove')} title={t('common.remove')} onclick={() => remove(d)}><Icon name="trash" size={18} /></button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .row :global(.btn) {
    width: auto;
  }
</style>
