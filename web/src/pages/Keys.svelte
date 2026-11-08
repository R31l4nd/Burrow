<script lang="ts">
  import LoadFailed from '../components/LoadFailed.svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import type { SshKey } from '@burrow/shared';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import { del, errorMessage, post } from '../lib/api.js';
  import { data, loadKeys } from '../lib/data.svelte.js';
  import { relativeTime, t } from '../lib/i18n/index.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import { FormSave } from '../lib/formsave.svelte.js';

  let mode = $state<'generate' | 'import' | null>(null);
  let name = $state('');
  let comment = $state('');
  let privateKey = $state('');
  let passphrase = $state('');
  const saving = new FormSave();

  // Not read is not "no keys" (AUDIT2 PAGE-08): said, with a way to try again.
  let loadError = $state('');
  let loaded = $state(false);
  function load() {
    loadError = '';
    loadKeys().then(
      () => (loaded = true),
      (err: unknown) => (loadError = errorMessage(err)),
    );
  }
  load();

  function openForm(m: 'generate' | 'import') {
    saving.opened();
    name = '';
    comment = '';
    privateKey = '';
    passphrase = '';
    mode = m;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const generate = mode === 'generate';
    const done = await saving.run(() => (generate ? post<SshKey>('/api/keys/generate', { name, ...(comment ? { comment } : {}) }) : post<SshKey>('/api/keys/import', { name, privateKey, ...(passphrase ? { passphrase } : {}) })));
    // The secret goes with the form it was typed in; another form opened meanwhile keeps its own.
    if (done === 'saved') {
      privateKey = '';
      passphrase = '';
      mode = null;
    }
    if (done) await loadKeys();
  }

  // The key whose menu is open; a tap in it closes it first, then acts.
  let menuFor = $state<SshKey | null>(null);
  const fromMenu = (fn: (k: SshKey) => unknown) => () => {
    const k = menuFor!;
    menuFor = null;
    void fn(k);
  };

  async function copyPublic(k: SshKey) {
    if (await copyText(k.publicKey)) toast(t('common.copied'));
  }

  async function remove(k: SshKey) {
    if (!(await ask({ text: t('common.confirmDelete', { name: k.name }), confirm: t('common.delete'), danger: true }))) return;
    try {
      await del(`/api/keys/${k.id}`);
      await loadKeys();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
</script>

<!-- A part of the settings (#/settings/keys), its heading theirs: it was a page of its own, set
     out unlike them (report e34ebd). -->
<div class="stack" data-testid="keys-part">
  <!-- What to make here: plain buttons with their sign; green is for confirming. -->
  <!-- Side by side: two full rows took a quarter of a small phone's screen. -->
  <div class="row">
    <button class="btn small" onclick={() => openForm('generate')}><Icon name="plus" size={16} /> {t('keys.generate')}</button>
    <button class="btn small" onclick={() => openForm('import')}><Icon name="import" size={16} /> {t('keys.importShort')}</button>
  </div>

  {#if loadError}
    <LoadFailed message={loadError} onretry={load} />
  {:else if !loaded && data.keys.length === 0}
    <p class="dim">{t('common.loading')}</p>
  {:else if data.keys.length === 0}
    <p class="empty">{t('keys.empty')}</p>
  {:else}
    <div class="list">
      {#each data.keys as k (k.id)}
        <div class="list-item" data-testid="key-row">
          <Icon name="key" />
          <div class="main">
            <div class="title">{k.name}</div>
            <div class="sub mono">{k.fingerprint}</div>
            <div class="sub">{k.type} | {relativeTime(k.createdAt)}</div>
          </div>
          <!-- Copy and delete in the row's menu, as every row with more than one thing to do: two icons squeezed the fingerprint to three lines (report e6fc13). -->
          <button class="icon-btn" aria-label={t('common.menuFor', { name: k.name })} title={t('common.menuFor', { name: k.name })} onclick={() => (menuFor = k)} data-testid="key-menu"><Icon name="more" size={20} /></button>
        </div>
      {/each}
    </div>
  {/if}
  <!-- Under the list: above it, it pushed the keys down on a small phone. -->
  <p class="dim small">{t('keys.intro')}</p>
</div>

<Dialog tour="key-menu" menu bind:open={() => menuFor !== null, (v) => !v && (menuFor = null)} title={menuFor?.name ?? ''}>
  <button class="btn" onclick={fromMenu(copyPublic)} data-testid="key-copy">{t('keys.copyPublic')}</button>
  <button class="btn danger" onclick={fromMenu(remove)} data-testid="key-remove">{t('common.delete')}</button>
</Dialog>

<!-- Anything typed (a pasted key above all): closing asks first (AUDIT2 PAGE-09). -->
<Dialog tour="key-form" open={mode !== null} title={mode === 'generate' ? t('keys.generateTitle') : t('keys.import')} onclose={() => (mode = null)} dirty={() => !!(name || comment || privateKey || passphrase)}>
  <form id="key-form" class="stack" onsubmit={submit}>
    <label class="field">
      <span>{t('keys.name')}</span>
      <input bind:value={name} name="name" required maxlength="80" autocapitalize="none" />
    </label>
    {#if mode === 'generate'}
      <label class="field">
        <span>{t('keys.comment')} ({t('common.optional')})</span>
        <input bind:value={comment} autocapitalize="none" />
      </label>
    {:else}
      <label class="field">
        <span>{t('keys.privateKey')}</span>
        <textarea bind:value={privateKey} name="privateKey" required spellcheck="false" autocapitalize="none"></textarea>
      </label>
      <label class="field">
        <span>{t('keys.passphrase')} ({t('common.optional')})</span>
        <input type="password" bind:value={passphrase} autocomplete="off" />
      </label>
    {/if}
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (mode = null)}>{t('common.cancel')}</button>
    <button class="btn primary" form="key-form" disabled={saving.busy}>{t('common.save')}</button>
  {/snippet}
</Dialog>
