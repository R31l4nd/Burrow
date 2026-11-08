<script lang="ts">
  import type { FileAccessRule, Host, UserSummary } from '@burrow/shared';
  import { errorMessage, get, put } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';

  // The folders an operator may open, per host (A3-SRV-01): an allowed and a
  // denied list, one folder a line. Nothing allowed on a host: no files there.
  let { user = $bindable(null) }: { user: UserSummary | null } = $props();

  let hosts = $state<Host[]>([]);
  let rules = $state<FileAccessRule[]>([]);
  let hostId = $state<number | null>(null);
  let allow = $state('');
  let deny = $state('');
  let saved = $state({ allow: '', deny: '' });
  let busy = $state(false);

  const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const dirty = () => allow.trim() !== saved.allow.trim() || deny.trim() !== saved.deny.trim();
  const count = (id: number) => rules.find((r) => r.hostId === id)?.allow.length ?? 0;

  function show(id: number | null) {
    const r = rules.find((x) => x.hostId === id);
    saved = { allow: (r?.allow ?? []).join('\n'), deny: (r?.deny ?? []).join('\n') };
    allow = saved.allow;
    deny = saved.deny;
  }

  $effect(() => {
    const u = user;
    if (!u) return;
    void (async () => {
      try {
        [hosts, rules] = await Promise.all([get<Host[]>('/api/hosts'), get<FileAccessRule[]>(`/api/users/${u.id}/file-access`)]);
        hostId = hosts.find((h) => h.id === hostId)?.id ?? hosts[0]?.id ?? null;
        show(hostId);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    })();
  });

  async function save() {
    if (!user || hostId === null) return;
    busy = true;
    try {
      const r = await put<FileAccessRule>(`/api/users/${user.id}/file-access/${hostId}`, { allow: lines(allow), deny: lines(deny) });
      rules = [...rules.filter((x) => x.hostId !== r.hostId), ...(r.allow.length || r.deny.length ? [r] : [])];
      show(hostId);
      toast(t('users.files.saved'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

<Dialog tour="file-access" open={user !== null} title={user && user.username.length > 16 ? t('users.files.titleShort') : t('users.files.title', { name: user?.username ?? '' })} onclose={() => (user = null)} {dirty}>
  <div class="stack">
    <!-- A long name in the title was cut; then the title says it generally and the name stands here. -->
    {#if user && user.username.length > 16}<p class="small"><strong>{t('users.files.who', { name: user.username })}</strong></p>{/if}
    <p class="dim small">{t('users.files.what')}</p>
    <label class="field">
      <span>{t('users.files.host')}</span>
      <select value={hostId} disabled={busy} data-testid="file-access-host" onchange={(e) => ((hostId = Number(e.currentTarget.value)), show(hostId))}>
        {#each hosts as h (h.id)}
          <option value={h.id}>{count(h.id) ? t('users.files.hostWith', { name: h.name, n: count(h.id) }) : h.name}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span>{t('users.files.allow')}</span>
      <textarea bind:value={allow} rows="4" spellcheck="false" autocapitalize="none" class="mono" placeholder="/srv/media" data-testid="file-access-allow"></textarea>
    </label>
    <label class="field">
      <span>{t('users.files.deny')}</span>
      <textarea bind:value={deny} rows="3" spellcheck="false" autocapitalize="none" class="mono" placeholder="/srv/media/private" data-testid="file-access-deny"></textarea>
    </label>
    <p class="dim small">{t('users.files.closed')}</p>
  </div>
  {#snippet actions()}
    <button class="btn" onclick={() => (user = null)} data-testid="file-access-cancel">{t('common.cancel')}</button>
    <button class="btn primary" disabled={busy || hostId === null || !dirty()} onclick={save} data-testid="file-access-save">{t('common.save')}</button>
  {/snippet}
</Dialog>
