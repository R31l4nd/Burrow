<script lang="ts">
  import { inBackground } from '../lib/ui.svelte.js';
  import { parseTargetList } from '../lib/logtargets.js';
  import { targetLabel } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import LogView from '../components/LogView.svelte';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { up } from '../lib/router.svelte.js';

  // Merged logs of several containers, also from several hosts: a whole
  // stack in one timeline; log files too ("3::%2Fvar%2Flog%2Fsyslog").
  // #/logs?t=1:web,2:db[&at=<timestamp>]
  let {
    targets,
    at,
    atLine = null,
    analyze = false,
  }: { targets: string; at: string | null; atLine?: { i: number; h: string } | null; analyze?: boolean } = $props();

  if (!data.loaded) inBackground(loadAll());
  // A time in the address that is not one (edited, cut off): the latest lines, said so (AUDIT2 PAGE-34).
  const readable = (v: string) => {
    const d = Date.parse(v);
    return Number.isFinite(d) && Math.abs(d) < 8.64e15 - 1e6;
  };
  const when = $derived(at && readable(at) ? at : null);
  const list = $derived(parseTargetList(targets));
  // A host's own logs (its journals, its files) belong to Hosts; a container's to Containers.
  const hostLogs = $derived(list.length > 0 && list.every((x) => !x.container));
  const multiHost = $derived(new Set(list.map((x) => x.hostId)).size > 1);
  const sources = $derived(
    list.map((x) => ({ ...x, label: multiHost ? `${targetLabel(x)}@${data.hosts.find((h) => h.id === x.hostId)?.name ?? x.hostId}` : targetLabel(x) })),
  );
</script>

<div class="detail">
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up(hostLogs ? '/hosts' : '/containers')}><Icon name="back" /></button>
    <!-- The containers' names ("web, worker"); cut off with ... when long. -->
    <!-- The containers shown; with none chosen, the page's own name (an empty heading says nothing). -->
    <h1 class="name" title={sources.map((s) => s.label).join(', ')}>{sources.length ? sources.map((s) => s.label).join(', ') : t('containers.logs')}</h1>
  </header>
  {#if at && !when}
    <p class="alert warn small" data-testid="logs-bad-time">{t('logs.badTime')}</p>
  {/if}
  {#if list.length}
    {#key targets + (when ?? '')}
      <LogView {sources} at={when} atLine={when ? atLine : null} {analyze} />
    {/key}
  {:else}
    <!-- Nothing chosen: where to choose (UIB-10: a dead end at every size). -->
    <div class="empty stack nothing" data-testid="logs-none">
      <p>{t('logs.none')}</p>
      <p class="small">{t('logs.noneHow')}</p>
      <div class="row">
        <a class="btn" href="#/containers" data-testid="logs-to-containers">{t('nav.containers')}</a>
        <a class="btn" href="#/hosts">{t('nav.hosts')}</a>
      </div>
    </div>
  {/if}
</div>

<style>
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .detail {
    position: fixed;
    inset: 0 0 calc(var(--nav-h) + env(safe-area-inset-bottom)) var(--rail-w);
    display: flex;
    flex-direction: column;
    padding: 0 12px 8px;
  }
  /* A computer: the same edges and bar as the other pages (it sat 16 px further left than a container's page). */
  @media (min-width: 900px) {
    .detail {
      padding: 0 28px 16px;
    }
    .detail > .topbar {
      margin: 0 -28px 8px;
      padding: 0 28px;
      min-height: 64px;
    }
  }
  .nothing .row {
    justify-content: center;
  }
</style>
