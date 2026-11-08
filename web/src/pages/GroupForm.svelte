<script lang="ts">
  import LoadFailed from '../components/LoadFailed.svelte';
  import { untrack } from 'svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import type { AuthMethod, Group, GroupInput, TmuxMode } from '@burrow/shared';
  import { effectiveConnection } from '@burrow/shared/effective';
  import HelpTip from '../components/HelpTip.svelte';
  import Icon from '../components/Icon.svelte';
  import { del, errorMessage, post, put } from '../lib/api.js';
  import { data, groupPath, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go, route, up } from '../lib/router.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';

  // A group, a new one (null), or "all": the settings every host gets when
  // neither it nor a group sets a field (above the groups, no name or parent).
  // All hosts is a part of Settings (report 5c1209): no title bar of its own there, and it stays once saved.
  let { id: idProp }: { id: number | 'all' | null } = $props();
  // Keyed on the route (App); a new group, once created, is that group for a second save.
  let id = $state(untrack(() => idProp));
  const all = $derived(id === 'all');

  let name = $state('');
  let parentId = $state<number | null>(null);
  let username = $state('');
  let port = $state<number | null>(null);
  let authMethod = $state<AuthMethod | null>(null);
  let keyId = $state<number | null>(null);
  let startupCommand = $state('');
  let tmux = $state<TmuxMode | null>(null);
  let busy = $state(false);
  let loaded = $state(false);
  // The form as it was loaded (or saved): anything else asks before another page.
  const form = () => JSON.stringify([name, parentId, username, port, authMethod, keyId, startupCommand, tmux]);
  let base = $state('');
  warnUnsaved(() => loaded && form() !== base);

  let kept: Group['defaults'] = {};
  function fill(g: Pick<Group, 'name' | 'parentId' | 'defaults'> | undefined) {
    if (g) {
      name = g.name;
      parentId = g.parentId;
      username = g.defaults.username ?? '';
      port = g.defaults.port ?? null;
      authMethod = g.defaults.authMethod ?? null;
      keyId = g.defaults.keyId ?? null;
      startupCommand = g.defaults.startupCommand ?? '';
      tmux = g.defaults.tmux ?? null;
      kept = $state.snapshot(g.defaults);
    }
    base = form();
    loaded = true;
  }

  // Failed to load, or a group that is gone: said so, not an empty form.
  let loadError = $state('');
  // Always read fresh: a form filled from what was loaded earlier saved
  // that back over changes made since (another device, the API).
  function load() {
    loadError = '';
    loadAll()
      .then(() => {
        const g = id === 'all' ? { name: '', parentId: null, defaults: data.hostDefaults } : id === null ? undefined : data.groups.find((x) => x.id === id);
        if (typeof id === 'number' && !g) loadError = t('groups.notFound');
        else fill(g);
      })
      .catch((err: unknown) => (loadError = errorMessage(err)));
  }
  load();

  // A group cannot sit inside itself or one of its descendants.
  const descendants = $derived.by(() => {
    const out = new Set<number>(typeof id === 'number' ? [id] : []);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of data.groups) {
        if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) {
          out.add(g.id);
          grew = true;
        }
      }
    }
    return out;
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    const body: GroupInput = {
      name,
      parentId,
      // What the form does not show (a terminal type, an encoding, set
      // through the API or an import) stays: it was dropped (audit WP-13).
      defaults: {
        ...kept,
        username: username || null,
        port: port || null,
        authMethod,
        keyId,
        startupCommand: startupCommand || null,
        tmux,
      },
    };
    // As on the host form: what was sent is saved, later changes stay unsaved (AUDIT2 PAGE-01, PAGE-17).
    const sent = form();
    const here = route.path;
    try {
      if (id === 'all') await put('/api/host-defaults', body.defaults);
      else if (id === null) id = (await post<Group>('/api/groups', body)).id;
      else await put(`/api/groups/${id}`, body);
      base = sent;
      await loadAll();
      if (all) toast(t('group.allSaved'));
      else if (route.path === here && form() === sent) go('/hosts');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!(await ask({ text: `${t('common.confirmDelete', { name })}\n${t('group.deleteHelp')}`, confirm: t('common.delete'), danger: true }))) return;
    try {
      await del(`/api/groups/${id}`);
      base = form();
      await loadAll();
      go('/hosts');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
  // What the group gets from its parent, All hosts or Burrow's defaults
  // when a field stays empty (All hosts itself: only Burrow's defaults).
  const fromParent = $derived(
    effectiveConnection(
      { groupId: all ? null : parentId, port: null, username: null, authMethod: null, keyId: null, startupCommand: null, tmux: null, term: null, encoding: null },
      all ? new Map() : new Map(data.groups.map((g) => [g.id, g])),
      all ? {} : data.hostDefaults,
    ),
  );
  const TMUX_WORDS = { auto: 'host.tmuxAuto', always: 'host.tmuxAlways', never: 'host.tmuxNever' } as const;
  const AUTH_WORDS = { key: 'host.authKey', password: 'host.authPassword' } as const;
  // For All hosts there is nothing above to inherit from: Burrow's own default.
  const inheritAs = (word: string) => t(all ? 'common.builtInAs' : 'common.inheritAs', { value: word });
</script>

<div class:page={!all} class:narrow={!all}>
  {#if !all}
    <header class="topbar">
      <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/hosts')}><Icon name="back" /></button>
      <h1>{id === null ? t('group.new') : t('group.edit')}</h1>
    </header>
  {/if}

  {#if loaded}
    <form class="stack" onsubmit={save} data-unsaved>
      {#if all}
        <p class="dim">{t('group.allWhat')}</p>
      {:else}
        <label class="field">
          <span>{t('group.name')}</span>
          <input bind:value={name} name="name" required maxlength="80" />
        </label>
        <label class="field">
          <span>{t('group.parent')}</span>
          <select bind:value={parentId}>
            <option value={null}>{t('group.noParent')}</option>
            {#each data.groups.filter((g) => !descendants.has(g.id)) as g (g.id)}<option value={g.id}>{groupPath(g.id)}</option>{/each}
          </select>
        </label>
      {/if}

      <h2 class="group">{t(all ? 'group.allDefaults' : 'group.defaults')} <HelpTip text={t(all ? 'help.allHosts' : 'help.groupDefaults')} /></h2>
      <div class="grid-addr">
        <label class="field">
          <span>{t('host.username')}</span>
          <input bind:value={username} name="username" autocapitalize="none" spellcheck="false" />
        </label>
        <label class="field">
          <span>{t('host.port')}</span>
          <input type="number" bind:value={port} min="1" max="65535" placeholder="22" />
        </label>
      </div>
      <label class="field">
        <span>{t('host.auth')}</span>
        <select bind:value={authMethod}>
          <option value={null}>{inheritAs(fromParent.authMethod ? t(AUTH_WORDS[fromParent.authMethod]) : t('host.authAuto'))}</option>
          <option value="key">{t('host.authKey')}</option>
          <option value="password">{t('host.authPassword')}</option>
        </select>
        <!-- What "automatic" is, under it: the choice itself is short enough for a phone (report d07225). -->
        {#if authMethod === null && !fromParent.authMethod}<span class="help" data-testid="auth-auto-help">{t('host.authAutoHelp')}</span>{/if}
      </label>
      <label class="field">
        <span>{t('host.key')}</span>
        <select bind:value={keyId}>
          <option value={null}>{inheritAs(data.keys.find((k) => k.id === fromParent.keyId)?.name ?? t('common.none'))}</option>
          {#each data.keys as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
        </select>
      </label>
      <label class="field">
        <span>{t('host.startup')}</span>
        <input bind:value={startupCommand} class="mono" autocapitalize="none" spellcheck="false" />
      </label>
      <div class="field-wrap">
        <label class="field">
          <span>{t('host.tmux')}</span>
          <select bind:value={tmux}>
            <option value={null}>{inheritAs(t(TMUX_WORDS[fromParent.tmux]))}</option>
            <option value="auto">{t('host.tmuxAuto')}</option>
            <option value="always">{t('host.tmuxAlways')}</option>
            <option value="never">{t('host.tmuxNever')}</option>
          </select>
        </label>
        <span class="field-help"><HelpTip text={t('help.hostTmux')} /></span>
      </div>

      <!-- One row at the form's end, Save last (UIB-08: full-width Save and Delete stacked here, a small one elsewhere). -->
      <div class="form-end">
        {#if id !== null && !all}<button type="button" class="btn danger" onclick={remove}>{t('common.delete')}</button>{/if}
        <button class="btn primary" disabled={busy}>{t('common.save')}</button>
      </div>
      {#if id !== null && !all}<p class="help">{t('group.deleteHelp')}</p>{/if}
    </form>
  {:else if loadError}
    <LoadFailed message={loadError} onretry={load} />
  {/if}
</div>
