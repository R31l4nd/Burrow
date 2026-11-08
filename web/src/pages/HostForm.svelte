<script lang="ts">
  import LoadFailed from '../components/LoadFailed.svelte';
  import { untrack } from 'svelte';
  import type { AuthMethod, Host, HostInput, TmuxMode } from '@burrow/shared';
  import { effectiveConnection, inheritedFrom } from '@burrow/shared/effective';
  import HelpTip from '../components/HelpTip.svelte';
  import Icon from '../components/Icon.svelte';
  import InheritHint from '../components/InheritHint.svelte';
  import { errorMessage, get, post, put } from '../lib/api.js';
  import { data, dataLoad, ensureLoaded, groupPath, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go, route, up } from '../lib/router.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { sayDirectKeys } from '../lib/directkeys.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';

  let { id: idProp }: { id: number | null } = $props();
  // A computer: the form in three blocks side by side, the advanced ones open.
  const wideMq = matchMedia('(min-width: 900px)');
  let wide = $state(wideMq.matches);
  $effect(() => {
    const f = () => (wide = wideMq.matches);
    wideMq.addEventListener('change', f);
    return () => wideMq.removeEventListener('change', f);
  });
  // The form edits one host; App re-creates it (keyed on the route) for another. A new one,
  // once created, is that host: a second save changes it rather than making another.
  let id = $state(untrack(() => idProp));

  let name = $state('');
  let address = $state('');
  let port = $state<number | null>(null);
  let username = $state('');
  let groupId = $state<number | null>(null);
  let authMethod = $state<AuthMethod | null>(null);
  let keyId = $state<number | null>(null);
  let password = $state('');
  let hasPassword = $state(false);
  let clearPassword = $state(false);
  let startupCommand = $state('');
  let tmux = $state<TmuxMode | null>(null);
  let term = $state('');
  let encoding = $state('');
  let tags = $state('');
  let color = $state<string | null>(null);
  let favorite = $state(false);
  let wakeMac = $state('');
  let wakeVia = $state<number | 'burrow' | null>(null);
  // The MAC address Burrow learned while the host was up: the placeholder for one of its own.
  let learnedMac = $state('');
  // Not on the form: kept as loaded, so a save does not drop it (AUDIT2 PAGE-30).
  let icon: string | null = null;
  let busy = $state(false);
  let loaded = $state(untrack(() => id === null));
  // A new host from a Proxmox node's guest (F5): its name and address filled in.
  if (untrack(() => id) === null) {
    name = untrack(() => route.query.name ?? '').slice(0, 100);
    address = untrack(() => route.query.address ?? '').slice(0, 255);
  }
  // The form as it was loaded (or saved): anything else asks before another page.
  const form = () => JSON.stringify([name, address, port, username, groupId, authMethod, keyId, password, clearPassword, startupCommand, tmux, term, encoding, tags, color, favorite, wakeMac, wakeVia]);
  let base = $state(untrack(form));
  warnUnsaved(() => loaded && form() !== base);

  // Groups and keys to choose from: not read is said, not an empty choice (A3-WEB-01).
  ensureLoaded();
  let loadError = $state('');
  function load() {
    if (id === null) return;
    loadError = '';
    get<Host>(`/api/hosts/${id}`)
      .then((h) => {
        name = h.name;
        address = h.address;
        port = h.port;
        username = h.username ?? '';
        groupId = h.groupId;
        authMethod = h.authMethod;
        keyId = h.keyId;
        hasPassword = h.hasPassword;
        startupCommand = h.startupCommand ?? '';
        tmux = h.tmux;
        term = h.term ?? '';
        encoding = h.encoding ?? '';
        tags = h.tags.join(', ');
        color = h.color;
        favorite = h.favorite;
        icon = h.icon;
        wakeMac = h.wakeMac ?? '';
        wakeVia = h.wakeVia;
        learnedMac = h.facts?.mac ?? '';
        base = form();
        loaded = true;
      })
      .catch((err: unknown) => (loadError = errorMessage(err)));
  }
  load();

  // What the host would get from its group if the field stays empty.
  const inherited = $derived(
    effectiveConnection(
      { groupId, port: null, username: null, authMethod: null, keyId: null, startupCommand: null, tmux: null, term: null, encoding: null },
      new Map(data.groups.map((g) => [g.id, g])),
      data.hostDefaults,
    ),
  );
  // Where an empty field's value comes from: a group (its name), "all" (All hosts), or Burrow's default (null).
  const from = (field: 'username' | 'keyId') => inheritedFrom(groupId, new Map(data.groups.map((g) => [g.id, g])), data.hostDefaults, field);
  const keyName = (kid: number | null) => data.keys.find((k) => k.id === kid)?.name ?? null;
  // "Inherit" says what it inherits: "Inherit: use when available".
  const TMUX_WORDS = { auto: 'host.tmuxAuto', always: 'host.tmuxAlways', never: 'host.tmuxNever' } as const;
  const AUTH_WORDS = { key: 'host.authKey', password: 'host.authPassword' } as const;
  const inheritAs = (word: string) => t('common.inheritAs', { value: word });
  const effectiveAuth = $derived(authMethod ?? inherited.authMethod ?? (keyId || inherited.keyId ? 'key' : hasPassword || password ? 'password' : null));

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    const body: HostInput = {
      name,
      address,
      port: port || null,
      username: username || null,
      groupId,
      authMethod,
      keyId: authMethod === 'password' ? null : keyId,
      ...(password ? { password } : clearPassword ? { password: '' } : {}),
      startupCommand: startupCommand || null,
      tmux,
      term: term || null,
      encoding: encoding || null,
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      color,
      icon,
      favorite,
      wakeMac: wakeMac.trim() || null,
      wakeVia,
    };
    // What was sent is what is saved: a change made while it saves stays unsaved, and the form
    // stays open for it. Left for another page meanwhile: no going back to the list (AUDIT2 PAGE-01, PAGE-17).
    const sent = form();
    const here = route.path;
    try {
      const h = id === null ? await post<Host>('/api/hosts', body) : await put<Host>(`/api/hosts/${id}`, body);
      id = h.id;
      base = sent;
      await loadAll();
      if (route.path === here && form() === sent) go('/hosts');
      sayDirectKeys(h);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

<div class="page" class:narrow={!wide}>
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/hosts')}><Icon name="back" /></button>
    <h1>{id === null ? t('host.new') : t('host.edit')}</h1>
  </header>

  {#if !data.loaded && dataLoad.error}
    <LoadFailed message={dataLoad.error} onretry={ensureLoaded} />
  {:else if loaded}
    <form class="stack" onsubmit={save} data-unsaved>
      <div class="blocks">
      <section class="part">
      <h2 class="wide-only">{t('host.connection')}</h2>
      <label class="field">
        <span>{t('host.name')}</span>
        <input bind:value={name} name="name" required maxlength="80" />
      </label>
      <div class="grid-addr">
        <label class="field">
          <span>{t('host.address')}</span>
          <input bind:value={address} name="address" required autocapitalize="none" spellcheck="false" inputmode="url" />
        </label>
        <label class="field">
          <span>{t('host.port')}</span>
          <input type="number" bind:value={port} name="port" min="1" max="65535" placeholder={String(inherited.port)} />
        </label>
      </div>
      <label class="field">
        <span>{t('host.username')}</span>
        <input bind:value={username} name="username" autocapitalize="none" spellcheck="false" placeholder={inherited.username ?? ''} />
        <InheritHint value={username ? null : inherited.username} from={from('username')} />
      </label>
      <div class="field-wrap">
        <label class="field">
          <span>{t('host.auth')}</span>
          <select bind:value={authMethod} name="auth">
            <option value={null}>{inheritAs(inherited.authMethod ? t(AUTH_WORDS[inherited.authMethod]) : t('host.authAuto'))}</option>
            <option value="key">{t('host.authKey')}</option>
            <option value="password">{t('host.authPassword')}</option>
          </select>
        </label>
        <span class="field-help"><HelpTip text={t('help.hostAuth')} /></span>
      </div>
      {#if effectiveAuth !== 'password'}
        <label class="field">
          <span>{t('host.key')}</span>
          <select bind:value={keyId} name="key">
            <option value={null}>{from('keyId') ? inheritAs(keyName(inherited.keyId) ?? t('common.none')) : t('common.none')}</option>
            {#each data.keys as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
          </select>
          <InheritHint value={keyId ? null : keyName(inherited.keyId)} from={from('keyId')} />
        </label>
      {/if}
      {#if effectiveAuth !== 'key' || hasPassword}
        <div class="field-wrap">
          <label class="field">
            <span>{t('host.password')}</span>
            <input type="password" bind:value={password} name="password" autocomplete="off" />
            {#if hasPassword}<span class="help">{t('host.passwordStored')}</span>{/if}
          </label>
          <span class="field-help"><HelpTip text={t('help.hostPassword')} /></span>
        </div>
        {#if hasPassword}
          <label class="check"><input type="checkbox" bind:checked={clearPassword} /> {t('host.clearPassword')}</label>
        {/if}
      {/if}

      </section>
      <section class="part">
      <h2 class="wide-only">{t('host.recognize')}</h2>
      <div class="field-wrap">
        <label class="field">
          <span>{t('host.group')}</span>
          <select bind:value={groupId} name="group">
            <option value={null}>{t('common.none')}</option>
            {#each data.groups as g (g.id)}<option value={g.id}>{groupPath(g.id)}</option>{/each}
          </select>
        </label>
        <span class="field-help"><HelpTip text={t('help.hostGroup')} /></span>
      </div>
      <div class="field-wrap">
        <label class="field">
          <span>{t('host.tags')}</span>
          <input bind:value={tags} name="tags" autocapitalize="none" />
          <span class="help">{t('host.tagsHelp')}</span>
        </label>
        <span class="field-help"><HelpTip text={t('help.hostTags')} /></span>
      </div>
      <label class="check"><input type="checkbox" bind:checked={favorite} /> {t('host.favorite')}</label>
      </section>

      <details class="part" open={wide || undefined}>
        <summary>{t('host.advanced')}</summary>
        <h2 class="wide-only">{t('host.advanced')}</h2>
        <div class="stack">
          <div class="field-wrap">
            <label class="field">
              <span>{t('host.startup')}</span>
              <input bind:value={startupCommand} class="mono" autocapitalize="none" spellcheck="false" placeholder={inherited.startupCommand ?? ''} />
              <span class="help">{t('host.startupHelp')}</span>
            </label>
            <span class="field-help"><HelpTip text={t('help.hostStartup')} /></span>
          </div>
          <div class="field-wrap">
            <label class="field">
              <span>{t('host.tmux')}</span>
              <select bind:value={tmux}>
                <option value={null}>{inheritAs(t(TMUX_WORDS[inherited.tmux]))}</option>
                <option value="auto">{t('host.tmuxAuto')}</option>
                <option value="always">{t('host.tmuxAlways')}</option>
                <option value="never">{t('host.tmuxNever')}</option>
              </select>
            </label>
            <span class="field-help"><HelpTip text={t('help.hostTmux')} /></span>
          </div>
          <div class="grid2">
            <div class="field-wrap">
              <label class="field">
                <span>{t('host.term')}</span>
                <input bind:value={term} autocapitalize="none" placeholder={inherited.term} />
              </label>
              <span class="field-help"><HelpTip text={t('help.hostTerm')} /></span>
            </div>
            <div class="field-wrap">
              <label class="field">
                <span>{t('host.encoding')}</span>
                <input bind:value={encoding} autocapitalize="none" placeholder={inherited.encoding} />
              </label>
              <span class="field-help"><HelpTip text={t('help.hostEncoding')} /></span>
            </div>
          </div>
          <!-- Wake-on-LAN: who sends the packet, and the address it wakes. One under the other: the chosen sender or the MAC placeholder did not fit half a row. -->
          <div class="field-wrap">
            <label class="field">
              <span>{t('host.wakeVia')}</span>
              <select bind:value={wakeVia} data-testid="host-wake-via">
                <option value={null}>{t('host.wakeAuto')}</option>
                <option value="burrow">{t('host.wakeBurrow')}</option>
                {#each data.hosts.filter((h) => h.id !== id) as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
              </select>
            </label>
            <span class="field-help"><HelpTip text={t('help.hostWake')} /></span>
          </div>
          <label class="field">
            <span>{t('host.wakeMac')}</span>
            <input bind:value={wakeMac} class="mono" autocapitalize="none" spellcheck="false" placeholder={learnedMac || 'aa:bb:cc:dd:ee:ff'} data-testid="host-wake-mac" />
          </label>
          <div class="row">
            <label class="check">
              <input type="checkbox" checked={color !== null} onchange={(e) => (color = e.currentTarget.checked ? '#7ee787' : null)} />
              {t('host.color')}
            </label>
            {#if color !== null}<input type="color" bind:value={color} aria-label={t('host.colorPick')} />{/if}
          </div>
        </div>
      </details>
      </div>

      <div class="form-end"><button class="btn primary" disabled={busy}>{t('common.save')}</button></div>
    </form>
  {:else if loadError}
    <LoadFailed message={loadError} onretry={load} />
  {:else}
    <p class="empty">{t('common.loading')}</p>
  {/if}
</div>

<style>
  .blocks,
  section.part {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  @media (min-width: 900px) {
    .blocks {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      align-items: start;
    }
    .part {
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-raised);
    }
    /* Open on a computer: the heading in place of the fold. */
    .part > summary {
      display: none;
    }
    details.part > h2 {
      margin-bottom: 12px;
    }
    .form-end {
      grid-column: 1 / -1;
    }
  }
</style>
