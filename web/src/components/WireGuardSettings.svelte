<script lang="ts">
  import { untrack } from 'svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import Icon from './Icon.svelte';
  import type { AppTab } from '@burrow/shared';
  import { android, androidInfo, type WireGuardStatus } from '../lib/android.js';
  import { errorMessage, get } from '../lib/api.js';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';
  import HelpTip from './HelpTip.svelte';
  import PickList, { type PickItem } from './PickList.svelte';

  // The app's own WireGuard (only in the Android app). Away from home the app
  // brings it up by itself and sends the chosen addresses through it. The
  // configuration goes from here to the phone only, never to Burrow; what
  // comes back is a summary without the private key.

  let status = $state<WireGuardStatus | null>(null);
  let apps = $state<AppTab[]>([]);
  let pasting = $state(false);
  let text = $state('');
  // A pasted config not saved yet: another page asks first (AUDIT2 UI-25).
  warnUnsaved(() => pasting && text.trim() !== '');
  let busy = $state(false);
  // The camera scan of apps from 1.26.0; older ones read a picture of the code.
  let camera = $state(false);
  void androidInfo().then((i) => (camera = !!i?.qrCamera));

  async function load() {
    if (!android) return;
    status = await android.wgStatus();
    if (!data.loaded) await loadAll();
    try {
      apps = await get<AppTab[]>('/api/apps');
      appsError = '';
      appsRead = true;
    } catch (err) {
      // Not read: said above the list, not app tabs quietly missing from it (A3-WEB-06).
      appsError = errorMessage(err);
    }
  }
  let appsError = $state('');
  let appsRead = $state(false);
  load().catch((err: unknown) => toast(errorMessage(err), 'error'));

  async function save(conf: string) {
    busy = true;
    try {
      const r = await android!.wgSave(conf);
      // Not used after the app's own question (where the tunnel goes): nothing changed.
      if ('cancelled' in r) return;
      if (r.error) toast(t('wg.invalid', { error: r.error }), 'error');
      else {
        toast(t('wg.saved'));
        pasting = false;
        text = '';
      }
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  // A photo of the QR code (wg-easy and friends show one): read it here.
  async function fromPhoto(e: Event & { currentTarget: HTMLInputElement }) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    const { default: jsQR } = await import('jsqr');
    const img = await createImageBitmap(f);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
    if (!code?.data.includes('[Interface]')) return toast(t('wg.noQr'), 'error');
    await save(code.data);
  }

  async function scan() {
    busy = true;
    try {
      const r = await android!.wgScan();
      if (r.cancelled) return;
      if (r.error) toast(t('wg.invalid', { error: r.error }), 'error');
      else toast(t('wg.saved'));
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  async function fromFile(e: Event & { currentTarget: HTMLInputElement }) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (f) await save(await f.text());
  }

  async function remove() {
    if (!(await ask({ text: t('wg.removeConfirm'), confirm: t('wg.remove'), danger: true }))) return;
    await android!.wgRemove();
    await load();
  }

  // What may go through it: Burrow, the app tabs' sites, the direct route's hosts.
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  };
  const appHosts = $derived([...new Map(apps.map((a) => [hostOf(a.url), a.name])).entries()].filter(([h]) => h));
  const sshHosts = $derived([...new Map(data.hosts.map((h) => [h.address.toLowerCase(), h.name])).entries()]);
  // One entry per address: an app and a host on the same one are one target.
  const targets = $derived([
    ...new Map([
      ...sshHosts.map(([host, name]): [string, PickItem<string>] => [host, { id: host, title: name, sub: `${t('wg.directHost')} | ${host}` }]),
      ...appHosts.map(([host, name]): [string, PickItem<string>] => [host, { id: host, title: name, sub: `${t('wg.appTab')} | ${host}` }]),
    ]).values(),
  ]);

  // Shown at once, sent one after the other, the newest answer kept: two
  // picks before the phone answered sent [A] then [B], and A was lost
  // (audit WC-19).
  let targetSeq = 0;
  let sending: Promise<unknown> = Promise.resolve();
  function apply(viaBurrow: boolean, hosts: string[]): Promise<unknown> {
    status = { ...status!, viaBurrow, hosts };
    const mine = ++targetSeq;
    sending = sending.then(async () => {
      try {
        const r = await android!.wgTargets(viaBurrow, hosts);
        if (mine === targetSeq) status = r;
      } catch (err) {
        toast(errorMessage(err), 'error');
        if (mine === targetSeq) status = await android!.wgStatus();
      }
    });
    return sending;
  }
  function setTarget(host: string | null, on: boolean) {
    const s = status!;
    const hosts = new Set(s.hosts);
    if (host) {
      if (on) hosts.add(host);
      else hosts.delete(host);
    }
    return apply(host === null ? on : s.viaBurrow, [...hosts]);
  }
  function setHosts(next: string[]) {
    return apply(status!.viaBurrow, next);
  }
  // Chosen once, gone from the list since (an app deleted, a host removed): it went through the
  // tunnel unseen and counted as chosen. Let go on the phone too, only with both lists read (one
  // not read keeps them; report 80f9de).
  $effect(() => {
    if (!status || !appsRead || appsError || !data.loaded) return;
    const known = new Set(targets.map((x) => x.id));
    const kept = status.hosts.filter((h) => known.has(h));
    if (kept.length < status.hosts.length) untrack(() => void apply(status!.viaBurrow, kept));
  });
</script>

{#if android && status}
  <h3>{t('wg.title')} <HelpTip text={t('help.wg')} /></h3>
  <div class="card stack" data-testid="wireguard">
    {#if !status.proxyOverride}
      <p class="alert error small">{t('wg.oldWebView')}</p>
    {/if}
    {#if !status.configured}
      <p class="dim small">{t('wg.none')}</p>
      <!-- Three ways in, one under the other (side by side they did not fit a phone). -->
      <div class="stack">
        {#if camera}<button class="btn small" onclick={scan} disabled={busy} data-testid="wg-scan"><Icon name="camera" size={16} /> {t('wg.camera')}</button>{/if}
        <label class="btn small pick"><Icon name="image" size={16} /> {t('wg.scan')}<input type="file" accept="image/*" onchange={fromPhoto} disabled={busy} /></label>
        <label class="btn small pick"><Icon name="file" size={16} /> {t('wg.file')}<input type="file" accept=".conf,text/plain" onchange={fromFile} disabled={busy} /></label>
        <button class="btn small" onclick={() => (pasting = !pasting)} aria-expanded={pasting}><Icon name="clipboard" size={16} /> {t('wg.paste')}</button>
      </div>
      {#if pasting}
        <label class="field">
          <span>{t('wg.pasteLabel')}</span>
          <textarea class="mono" rows="8" bind:value={text} spellcheck="false" autocapitalize="none" data-testid="wg-conf"></textarea>
        </label>
        <button class="btn primary" disabled={busy || !text.includes('[Interface]')} onclick={() => save(text)} data-testid="wg-save">{t('common.save')}</button>
      {/if}
    {:else}
      <p class="small" data-testid="wg-state">
        {#if status.error}<span class="bad">{t('wg.failed', { error: status.error })}</span>
        {:else if status.active}{t('wg.away')}{status.lastHandshake ? ` | ${t('wg.handshake', { when: relativeTime(new Date(status.lastHandshake * 1000).toISOString()) })}` : ''}
        {:else}{t('wg.home')}{/if}
      </p>
      <dl class="small">
        <dt>{t('wg.address')}</dt><dd class="mono">{status.address}</dd>
        <dt>{t('wg.endpoint')}</dt><dd class="mono">{status.endpoint}</dd>
        <dt>{t('wg.networks')}</dt><dd class="mono">{status.allowedIps}</dd>
      </dl>
      <p class="small">{t('wg.through')}</p>
      <div class="list">
        <label class="list-item check">
          <input type="checkbox" checked={status.viaBurrow} onchange={(e) => setTarget(null, e.currentTarget.checked)} data-testid="wg-burrow" />
          <span class="main"><span class="title">Burrow</span><span class="sub">{location.host}</span></span>
        </label>
      </div>
      {#if appsError}<p class="alert error small" data-testid="wg-apps-failed">{t('wg.appsFailed', { error: appsError })}</p>{/if}
      <PickList items={targets} chosen={status.hosts} onchange={setHosts} label={t('wg.through')} />
      <button class="btn small danger" onclick={remove}>{t('wg.remove')}</button>
    {/if}
  </div>
{/if}

<style>
  .pick {
    position: relative;
    overflow: hidden;
  }
  .pick input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  textarea {
    width: 100%;
    font-size: 0.8rem;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    margin: 0;
  }
  dt {
    color: var(--text-dim);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .bad {
    color: var(--danger);
  }
</style>
