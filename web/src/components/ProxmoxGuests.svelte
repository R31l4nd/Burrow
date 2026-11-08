<script lang="ts">
  import type { Guest, GuestAction, GuestList } from '@burrow/shared';
  import Dialog from './Dialog.svelte';
  import HelpTip from './HelpTip.svelte';
  import Icon from './Icon.svelte';
  import Skeleton from './Skeleton.svelte';
  import { errorMessage, get, post } from '../lib/api.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go, to } from '../lib/router.svelte.js';
  import { toast } from '../lib/ui.svelte.js';

  // The guests of a Proxmox VE node (F5): its virtual machines and
  // containers, read with qm and pct over SSH. An admin starts, shuts down,
  // stops and reboots them (a step-up, in the audit log) and adds one as a
  // host of its own, its address filled in where the node knows it.

  let { hostId, admin }: { hostId: number; admin: boolean } = $props();

  let list = $state<GuestList | null>(null);
  let error = $state('');
  let busy = $state<string | null>(null);
  const key = (g: Guest) => `${g.kind}:${g.vmid}`;
  // The guest whose menu is open; a tap in it closes it first, then acts.
  let menuFor = $state<Guest | null>(null);
  const fromMenu = (fn: (g: Guest) => unknown) => () => {
    const g = menuFor!;
    menuFor = null;
    void fn(g);
  };

  async function load() {
    try {
      list = await get<GuestList>(`/api/hosts/${hostId}/guests`);
      error = '';
    } catch (err) {
      error = errorMessage(err);
    }
  }
  void load();

  async function act(g: Guest, action: GuestAction) {
    if ((action === 'stop' || action === 'shutdown' || action === 'reboot') && !(await ask({ text: t(`pve.confirm.${action}`, { name: g.name }), confirm: t(`pve.action.${action}`), danger: action === 'stop' }))) return;
    busy = key(g);
    try {
      await post(`/api/hosts/${hostId}/guests/${g.kind}/${g.vmid}/${action}`);
      toast(t(`pve.done.${action}`, { name: g.name }));
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }

  async function addAsHost(g: Guest) {
    busy = key(g);
    try {
      const { address } = await get<{ address: string | null }>(`/api/hosts/${hostId}/guests/${g.kind}/${g.vmid}/address`);
      if (!address) toast(t('pve.noAddress', { name: g.name }));
      go(to('/hosts/new', { name: g.name, address: address ?? '' }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }
</script>

<section class="card stack" aria-label={t('pve.title')} data-testid="pve-guests">
  <div class="toolbar">
    <h2>{t('pve.title')} <HelpTip text={t('help.pve')} /></h2>
  </div>
  {#if error}
    <p class="alert error small" data-testid="pve-error">{error}</p>
  {:else if !list}
    <Skeleton rows={3} />
  {:else}
    {#if list.error}<p class="alert warn small" data-testid="pve-partial">{t('pve.partial', { error: list.error })}</p>{/if}
    {#if !list.guests.length}
      <p class="dim small">{t('pve.none')}</p>
    {:else}
      <div class="list">
        {#each list.guests as g (key(g))}
          <div class="list-item guest" data-testid="pve-guest">
            <div class="main">
              <strong>{g.name}</strong>
              <span class="dim small">{g.kind === 'vm' ? t('pve.vm', { id: g.vmid }) : t('pve.ct', { id: g.vmid })}{g.lock ? ` | ${t('pve.locked', { lock: g.lock })}` : ''}</span>
            </div>
            <span class="pill {g.status === 'running' ? 'ok' : ''}" data-testid="pve-status">{t(`pve.status.${g.status === 'running' || g.status === 'stopped' || g.status === 'paused' ? g.status : 'other'}`)}</span>
            <!-- Start, shut down, reboot, stop and add as host in the row's menu: under the guest on a phone they took two lines (report e6fc13). -->
            {#if admin}<button class="icon-btn" aria-label={t('common.menuFor', { name: g.name })} title={t('common.menuFor', { name: g.name })} disabled={busy !== null} onclick={() => (menuFor = g)} data-testid="pve-menu"><Icon name="more" size={20} /></button>{/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<Dialog tour="pve-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.name ?? ''}>
  {#if menuFor}
    {@const g = menuFor}
    {#if g.status === 'running'}
      <button class="btn" disabled={!!g.lock} onclick={fromMenu((x) => act(x, 'shutdown'))} data-testid="pve-shutdown">{t('pve.action.shutdown')}</button>
      <button class="btn" disabled={!!g.lock} onclick={fromMenu((x) => act(x, 'reboot'))} data-testid="pve-reboot">{t('pve.action.reboot')}</button>
      <button class="btn danger" disabled={!!g.lock} onclick={fromMenu((x) => act(x, 'stop'))} data-testid="pve-stop">{t('pve.action.stop')}</button>
    {:else}
      <button class="btn" disabled={!!g.lock} onclick={fromMenu((x) => act(x, 'start'))} data-testid="pve-start">{t('pve.action.start')}</button>
    {/if}
    <button class="btn" onclick={fromMenu(addAsHost)} data-testid="pve-add-host">{t('pve.addHost')}</button>
  {/if}
</Dialog>

<style>
  /* Its title as the other cards of a host's statistics have theirs: the page's rules stop at its
     own markup, and the plain h2's margin put Guests 20 px lower in its card. */
  h2 {
    margin: 0;
    font-size: 1rem;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .guest .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
