<script lang="ts">
  import LoadFailed from './LoadFailed.svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import type { Channel, ChannelKind, NotifyTopic } from '@burrow/shared';
  import { NOTIFY_TOPICS } from '@burrow/shared';
  import { del, errorMessage, get, post, put } from '../lib/api.js';
  import { locale, t } from '../lib/i18n/index.svelte.js';
  import { toast, undoCheck } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // Where notifications go: Burrow's own push, ntfy, e-mail, Discord, a webhook. Per
  // channel which kinds: alerts, reports, image updates. Secrets (tokens,
  // passwords, webhook addresses) are never shown again, only "set".

  let list = $state<Channel[]>([]);
  let busy = $state<number | 'new' | null>(null);

  // Not read is not "no channels" (AUDIT2 UI-29).
  let loadError = $state('');
  async function load() {
    try {
      list = await get<Channel[]>('/api/channels');
      loadError = '';
    } catch (err) {
      loadError = errorMessage(err);
    }
  }
  void load();

  const randomTopic = () => `burrow-${[...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16)}`;

  // ---- the form

  let open = $state(false);
  let editing = $state<Channel | null>(null);
  let kind = $state<ChannelKind>('ntfy');
  let name = $state('');
  let enabled = $state(true);
  let topics = $state<NotifyTopic[]>([]);
  let lang = $state<'en' | 'nl'>('en');
  // ntfy
  // No default server: the public ntfy.sh would carry host and container names; the person enters theirs (decision 10).
  let nUrl = $state('');
  let nTopic = $state('');
  let nToken = $state('');
  let nOpenIn = $state<'app' | 'browser'>('app');
  // e-mail
  let eHost = $state('');
  let ePort = $state(587);
  let eSecure = $state(false);
  let eUser = $state('');
  let ePassword = $state('');
  let eFrom = $state('');
  let eTo = $state('');
  // Discord and webhook
  let dUrl = $state('');
  let wUrl = $state('');
  let wSecret = $state('');

  const defaults: Record<ChannelKind, NotifyTopic[]> = { push: ['alerts', 'reports', 'updates'], ntfy: ['alerts', 'reports', 'updates'], email: ['reports'], discord: ['reports', 'updates'], webhook: ['alerts', 'reports', 'updates'] };

  function edit(c: Channel | null, k: ChannelKind = 'ntfy') {
    editing = c;
    kind = c?.kind ?? k;
    name = c?.name ?? t(`channels.kind.${kind}`);
    enabled = c?.enabled ?? true;
    // Problem reports reach someone: ticked on a new channel while no channel takes them yet (W-FUNC-11).
    topics = c ? [...c.topics] : [...defaults[kind], ...(list.some((x) => x.topics.includes('problems')) ? [] : (['problems'] as NotifyTopic[]))];
    lang = c?.lang ?? locale();
    nUrl = c?.ntfy?.url ?? '';
    nTopic = c?.ntfy?.topic ?? randomTopic();
    nOpenIn = c?.ntfy?.openIn ?? 'app';
    nToken = '';
    eHost = c?.email?.host ?? '';
    ePort = c?.email?.port ?? 587;
    eSecure = c?.email?.secure ?? false;
    eUser = c?.email?.user ?? '';
    ePassword = '';
    eFrom = c?.email?.from ?? '';
    eTo = c?.email?.to ?? '';
    dUrl = '';
    wUrl = c?.webhook?.url ?? '';
    wSecret = '';
    baseline = JSON.stringify(body());
    open = true;
  }
  // What the form held when opened or last saved: a change since asks before the dialog closes.
  let baseline = '';
  const dirty = () => open && JSON.stringify(body()) !== baseline;

  function body() {
    const common = { kind, name, enabled, topics, lang };
    if (kind === 'ntfy') return { ...common, ntfy: { url: nUrl, topic: nTopic, openIn: nOpenIn, ...(nToken ? { token: nToken } : {}) } };
    if (kind === 'email') return { ...common, email: { host: eHost, port: ePort, secure: eSecure, user: eUser, from: eFrom, to: eTo, ...(ePassword ? { password: ePassword } : {}) } };
    if (kind === 'discord') return { ...common, discord: dUrl ? { url: dUrl } : {} };
    if (kind === 'push') return common;
    return { ...common, webhook: { url: wUrl, ...(wSecret ? { secret: wSecret } : {}) } };
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = editing?.id ?? 'new';
    // What went out: changed while it was on its way, the form stays open with the change still
    // to save (a late answer closed it over later edits, AUDIT2 UI-25).
    const sent = JSON.stringify(body());
    try {
      if (editing) await put(`/api/channels/${editing.id}`, body());
      else editing = await post<Channel>('/api/channels', body());
      baseline = sent;
      if (JSON.stringify(body()) === sent) open = false;
      toast(t('channels.saved'));
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }

  async function test(c: Channel) {
    busy = c.id;
    try {
      await post(`/api/channels/${c.id}/test`);
      toast(t('channels.sent', { name: c.name }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = null;
    }
  }

  async function toggle(c: Channel, on: boolean, box: HTMLInputElement) {
    // Secrets stay as they are: only the switch changes.
    const b = { kind: c.kind, name: c.name, enabled: on, topics: c.topics, lang: c.lang, ...(c.ntfy ? { ntfy: { url: c.ntfy.url, topic: c.ntfy.topic, openIn: c.ntfy.openIn } } : {}), ...(c.email ? { email: { ...c.email } } : {}), ...(c.discord ? { discord: {} } : {}), ...(c.webhook ? { webhook: { url: c.webhook.url } } : {}) };
    try {
      await put(`/api/channels/${c.id}`, b);
      await load();
    } catch (err) {
      // Not saved: the switch back as it is (it stayed off, as if the channel were, AUDIT2 UI-22).
      undoCheck(box, on);
      toast(errorMessage(err), 'error');
    }
  }

  async function remove(c: Channel) {
    if (!(await ask({ text: t('common.confirmDelete', { name: c.name }), confirm: t('common.delete'), danger: true }))) return;
    // Refused: said, not a rejection nobody sees (AUDIT2 UI-29).
    try {
      await del(`/api/channels/${c.id}`);
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const where = (c: Channel) =>
    c.push ? t('channels.pushDevices', { n: c.push.devices }) : c.ntfy ? `${c.ntfy.url}/${c.ntfy.topic}` : c.email ? c.email.to : c.webhook ? c.webhook.url : 'Discord';
  const kinds: ChannelKind[] = ['push', 'ntfy', 'email', 'discord', 'webhook'];
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let choosing = $state(false);
  // The channel whose menu is open; a tap in it closes it first, then acts.
  let menuFor = $state<Channel | null>(null);
  const fromMenu = (fn: (c: Channel) => unknown) => () => {
    const c = menuFor!;
    menuFor = null;
    void fn(c);
  };
  const KIND_ICON = { push: 'phone', ntfy: 'bell', email: 'mail', discord: 'chat', webhook: 'link' } as const;
</script>

<!-- Rows like every list; the add buttons in a toolbar (the app's button rule). -->
<div class="stack" data-testid="channels">
  {#if loadError}<LoadFailed message={loadError} onretry={load} />
  {:else if !list.length}<p class="dim small">{t('channels.none')}</p>{/if}
  <div class="list" class:hidden={!list.length}>
  {#each list as c (c.id)}
    <div class="list-item chan" data-testid="channel">
      <input type="checkbox" checked={c.enabled} aria-label={t('channels.on', { name: c.name })} onchange={(e) => toggle(c, e.currentTarget.checked, e.currentTarget)} />
      <div class="main">
        <!-- The kind as a badge, unless the name already says it. -->
        <div class="title">{c.name}{#if c.name !== t(`channels.kind.${c.kind}`)} <span class="badge">{t(`channels.kind.${c.kind}`)}</span>{/if}</div>
        <div class="sub">{c.topics.map((x) => t(`channels.topic.${x}`)).join(', ') || t('channels.noTopics')} | {where(c)}</div>
      </div>
      <!-- Test, edit and delete in the row's menu: under the name on a phone they took a line of their own (report 3aa76b). -->
      <button class="icon-btn" aria-label={t('common.menuFor', { name: c.name })} title={t('common.menuFor', { name: c.name })} onclick={() => (menuFor = c)} data-testid="channel-menu"><Icon name="more" size={20} /></button>
    </div>
  {/each}
  </div>
  <!-- One button, then the kind: four side by side did not fit a phone. -->
  <button class="btn small add" onclick={() => (choosing = true)} data-testid="add-channel"><Icon name="plus" size={16} /> {t('channels.addOne')}</button>
</div>

<Dialog tour="channel-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.name ?? ''}>
  <button class="btn" disabled={busy !== null} onclick={fromMenu(test)} data-testid="channel-test">{t('channels.test')}</button>
  <button class="btn" onclick={fromMenu(edit)} data-testid="channel-edit">{t('common.edit')}</button>
  <button class="btn danger" onclick={fromMenu(remove)} data-testid="channel-remove">{t('common.delete')}</button>
</Dialog>

<Dialog tour="channel-kind" menu bind:open={choosing} title={t('channels.addOne')}>
  <div class="list">
    {#each kinds as k (k)}
      <button class="list-item" onclick={() => ((choosing = false), edit(null, k))} data-testid={`add-${k}`}>
        <Icon name={KIND_ICON[k]} />
        <span class="main"><span class="title">{t(`channels.kind.${k}`)}</span><span class="sub">{t(`channels.kindWhat.${k}`)}</span></span>
        <Icon name="chevron" size={18} />
      </button>
    {/each}
  </div>
</Dialog>

<Dialog tour="channel-form" bind:open {dirty} title={editing ? t('channels.edit', { name: editing.name }) : t('channels.add', { kind: t(`channels.kind.${kind}`) })}>
  <form id="channel-form" class="stack" onsubmit={save}>
    <!-- On or off only on its row in the list, not here as well (report e2d7d2); a new one is on. -->
    <label class="field"><span>{t('channels.name')}</span><input bind:value={name} required maxlength="60" /></label>
    <fieldset class="stack topics">
      <legend class="small dim">{t('channels.what')}</legend>
      {#each NOTIFY_TOPICS as x (x)}
        <!-- A label starts with a capital, as every other (UIB-16); in the channel's summary line the words stay lower case. -->
        <label class="check"><input type="checkbox" bind:group={topics} value={x} data-testid={`topic-${x}`} /> {capital(t(`channels.topic.${x}`))}</label>
      {/each}
    </fieldset>
    {#if kind === 'ntfy'}
      <label class="field"><span>{t('push.server')}</span><input type="url" bind:value={nUrl} required placeholder="https://ntfy.example.com" data-testid="ntfy-url" /></label>
      <p class="dim small">{t('push.serverHelp')}</p>
      <label class="field"><span>{t('push.topic')}</span><input bind:value={nTopic} required pattern={'[\\w\\-]{1,64}'} class="mono" autocapitalize="none" spellcheck="false" data-testid="ntfy-topic" /></label>
      <label class="field"><span>{t('push.token')}</span><input type="password" bind:value={nToken} autocomplete="off" placeholder={editing?.ntfy?.hasToken ? t('channels.secretSet') : t('common.optional')} /></label>
      <label class="field">
        <span>{t('push.openIn')}</span>
        <select bind:value={nOpenIn} data-testid="ntfy-open-in">
          <option value="app">{t('push.openInApp')}</option>
          <option value="browser">{t('push.openInBrowser')}</option>
        </select>
      </label>
      {#if nUrl.trim()}<p class="dim small">{t('push.subscribe', { url: `${nUrl.replace(/\/+$/, '')}/${nTopic}` })}</p>{/if}
    {:else if kind === 'email'}
      <div class="grid-addr">
        <label class="field"><span>{t('channels.smtpHost')}</span><input bind:value={eHost} required autocapitalize="none" data-testid="smtp-host" /></label>
        <label class="field"><span>{t('channels.port')}</span><input type="number" bind:value={ePort} min="1" max="65535" required data-testid="smtp-port" /></label>
      </div>
      <label class="check"><input type="checkbox" bind:checked={eSecure} /> {t('channels.tls')}</label>
      <div class="grid2">
        <label class="field"><span>{t('channels.user')}</span><input bind:value={eUser} autocomplete="off" autocapitalize="none" placeholder={t('common.optional')} /></label>
        <label class="field"><span>{t('channels.password')}</span><input type="password" bind:value={ePassword} autocomplete="off" placeholder={editing?.email?.hasPassword ? t('channels.secretSet') : t('common.optional')} /></label>
      </div>
      <label class="field"><span>{t('channels.from')}</span><input type="email" bind:value={eFrom} required data-testid="mail-from" /></label>
      <label class="field"><span>{t('channels.to')}</span><input bind:value={eTo} required placeholder="me@example.com, ..." data-testid="mail-to" /></label>
    {:else if kind === 'discord'}
      <label class="field">
        <span>{t('channels.discordUrl')}</span>
        <input type="password" bind:value={dUrl} required={!editing?.discord?.hasUrl} autocomplete="off" placeholder={editing?.discord?.hasUrl ? t('channels.secretSet') : 'https://discord.com/api/webhooks/...'} data-testid="discord-url" />
      </label>
      <p class="dim small">{t('channels.discordHelp')}</p>
    {:else if kind === 'push'}
      <p class="dim small">{t('channels.pushHelp')}</p>
    {:else}
      <label class="field"><span>{t('channels.webhookUrl')}</span><input type="url" bind:value={wUrl} required data-testid="webhook-url" /></label>
      <label class="field"><span>{t('channels.webhookSecret')}</span><input type="password" bind:value={wSecret} autocomplete="off" placeholder={editing?.webhook?.hasSecret ? t('channels.secretSet') : t('common.optional')} /></label>
      <p class="dim small">{t('channels.webhookHelp')}</p>
    {/if}
    <label class="field">
      <span>{t('channels.lang')}</span>
      <select bind:value={lang}>
        <option value="en">English</option>
        <option value="nl">Nederlands</option>
      </select>
    </label>
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (open = false)}>{t('common.cancel')}</button>
    <button class="btn primary" form="channel-form" disabled={busy !== null} data-testid="channel-save">{t('common.save')}</button>
  {/snippet}
</Dialog>

<style>
  .chan {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chan .main {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-weight: 600;
  }
  .sub {
    font-size: 0.8rem;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .hidden {
    display: none;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    gap: 2px;
  }
  legend {
    padding: 0;
    margin-bottom: 4px;
  }
</style>
