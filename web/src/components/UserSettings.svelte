<script lang="ts">
  import { ask } from '../lib/confirm.svelte.js';
  import type { Invite, Role, UserSummary } from '@burrow/shared';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { dateOnly, dateTime, relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';
  import FileAccess from './FileAccess.svelte';
  import Icon from './Icon.svelte';
  import LoadFailed from './LoadFailed.svelte';

  // The people who use this Burrow: their role and how they sign in, open
  // invites, and a new invite (a one-time link, shown once).

  let users = $state<UserSummary[]>([]);
  let invites = $state<Invite[]>([]);
  let role = $state<Role>('operator');
  let fresh = $state<Invite | null>(null);
  let busy = $state(false);
  // The operator whose folders are being set (A3-SRV-01).
  let filesFor = $state<UserSummary | null>(null);
  // The person whose menu is open; a tap in it closes it first, then acts.
  let menuFor = $state<UserSummary | null>(null);
  const fromMenu = (fn: (u: UserSummary) => unknown) => () => {
    const u = menuFor!;
    menuFor = null;
    void fn(u);
  };
  const me = $derived(session.state?.user?.id);

  // Not read: said here with Try again; an empty list said "nobody" (A3-WEB-01).
  let loadError = $state('');
  async function load() {
    try {
      [users, invites] = await Promise.all([get<UserSummary[]>('/api/users'), get<Invite[]>('/api/invites')]);
      loadError = '';
    } catch (err) {
      loadError = errorMessage(err);
    }
  }
  void load();

  async function act(fn: () => Promise<unknown>) {
    busy = true;
    try {
      await fn();
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
      await load();
    } finally {
      busy = false;
    }
  }

  const invite = () =>
    act(async () => {
      fresh = await post<Invite>('/api/invites', { role });
    });

  const setRole = (u: UserSummary, r: Role) => act(() => put(`/api/users/${u.id}`, { role: r }));
  const unlinkSso = async (u: UserSummary) => {
    if (!(await ask({ text: t('users.ssoUnlinkConfirm', { name: u.username }), confirm: t('users.ssoUnlink') }))) return;
    void act(() => del(`/api/users/${u.id}/sso`));
  };
  const remove = async (u: UserSummary) => {
    if (!(await ask({ text: t('users.confirmRemove', { name: u.username }), confirm: t('users.remove', { name: u.username }), danger: true }))) return;
    void act(() => del(`/api/users/${u.id}`));
  };

  const how = (u: UserSummary) =>
    [u.passkeys ? t('users.passkeys', { n: u.passkeys }) : null, u.password ? t('users.password') : null, u.sso ? t('users.sso') : null].filter(Boolean).join(' | ') ||
    t('users.settingUp');
</script>

<div class="stack" data-testid="users">
  {#if loadError}<LoadFailed inline message={loadError} onretry={load} />{/if}
  <div class="list" class:hidden={!users.length}>
    {#each users as u (u.id)}
      <div class="list-item urow" data-testid="user">
        <span class="main">
          <span class="title">{u.username}{u.id === me ? ` (${t('users.you')})` : ''}</span>
          <span class="sub">{how(u)} | {u.lastSeenAt ? t('users.seen', { ago: relativeTime(u.lastSeenAt) }) : t('users.never')}</span>
        </span>
        <!-- The role as text, what can be done in the row's menu: on a phone the role, folders and
             remove came on a line of their own under the name (reports 976582, e6fc13). Your own
             role is not yours to change (another admin can), so there is no menu for you. -->
        <span class="badge" data-testid="user-role">{t(`users.role.${u.role}`)}</span>
        {#if u.id !== me}<button class="icon-btn" aria-label={t('common.menuFor', { name: u.username })} title={t('common.menuFor', { name: u.username })} disabled={busy} onclick={() => (menuFor = u)} data-testid="user-menu"><Icon name="more" size={20} /></button>{:else}<span class="nomenu"></span>{/if}
      </div>
    {/each}
  </div>

  <div class="card stack">
    <h3>{t('users.invite')}</h3>
    <label class="field">
      <span>{t('users.inviteRole')}</span>
      <select bind:value={role} data-testid="invite-role" aria-describedby="invite-role-what">
        <option value="operator">{t('users.role.operator')}</option>
        <option value="admin">{t('users.role.admin')}</option>
      </select>
    </label>
    <!-- What the role may do, in full: too long for the dropdown on a phone. -->
    <p class="dim small" id="invite-role-what">{role === 'admin' ? t('users.adminWhat') : t('users.operatorWhat')}</p>
    <button class="btn" disabled={busy} onclick={invite} data-testid="invite">{t('users.makeLink')}</button>
    {#if fresh?.url}
      <p class="small" id="invite-link">{t('users.linkOnce', { at: dateOnly(fresh.expiresAt) })}</p>
      <div class="linkrow toolbar">
        <input readonly value={fresh.url} class="mono" aria-labelledby="invite-link" data-testid="invite-url" onfocus={(e) => e.currentTarget.select()} />
        <button class="btn small" onclick={async () => (await copyText(fresh!.url!)) && toast(t('common.copied'))}>{t('common.copy')}</button>
      </div>
    {/if}
    {#if invites.length}
      <p class="dim small">{t('users.open', { n: invites.length })}</p>
      <div class="list">
        {#each invites as i (i.id)}
          <div class="list-item">
            <span class="main"><span class="title">{t(`users.role.${i.role}`)}</span><span class="sub">{t('users.until', { at: dateTime(i.expiresAt) })}</span></span>
            <button class="icon-btn" aria-label={t('users.revokeInvite')} disabled={busy} onclick={() => act(() => del(`/api/invites/${i.id}`))}><Icon name="trash" size={18} /></button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<Dialog tour="user-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.username ?? ''}>
  {#if menuFor}
    {@const u = menuFor}
    <button class="btn" onclick={fromMenu((x) => setRole(x, x.role === 'admin' ? 'operator' : 'admin'))} data-testid="user-set-role">{t(u.role === 'admin' ? 'users.makeOperator' : 'users.makeAdmin')}</button>
    {#if u.role === 'operator'}<button class="btn" onclick={fromMenu((x) => (filesFor = x))} data-testid="user-files">{t('users.files.menu')}</button>{/if}
    {#if u.sso}<button class="btn" onclick={fromMenu(unlinkSso)} data-testid="user-sso-unlink">{t('users.ssoUnlinkMenu')}</button>{/if}
    <button class="btn danger" onclick={fromMenu(remove)} data-testid="user-remove">{t('common.remove')}</button>
  {/if}
</Dialog>

<FileAccess bind:user={filesFor} />

<style>
  .hidden {
    display: none;
  }
  /* One block per person, a line between (report 976582); the name, its role, its menu on one line (report e6fc13). */
  .urow + .urow {
    border-top: 1px solid var(--border);
  }
  /* Your own row has no menu: its role stands where the others' do. */
  .nomenu {
    width: 44px;
    flex: none;
  }
  h3 {
    margin: 0;
  }
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
