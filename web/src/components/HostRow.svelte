<script lang="ts">
  import type { Host } from '@burrow/shared';
  import { effectiveConnection } from '@burrow/shared/effective';
  import { data } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { marks, updatesLine } from '../lib/packages.js';
  import { session } from '../lib/session.svelte.js';
  import Icon from './Icon.svelte';

  // Tap connects (or returns to the open session); long press, right click
  // or the three-dot button opens the host menu - as in Termius.
  let { host, onconnect, onmenu }: { host: Host; onconnect: (h: Host) => void; onmenu: (h: Host) => void } = $props();

  const status = $derived(data.status[host.id]);
  const pkgs = $derived(data.packages[host.id]);
  // What a tap does, in its name: an operator's opens the host's statistics, not a terminal (W-FUNC-12).
  const tapWord = $derived(session.state?.user?.role === 'admin' ? t('hosts.connect') : t('stats.open'));
  const eff = $derived(effectiveConnection(host, new Map(data.groups.map((g) => [g.id, g])), data.hostDefaults));
  const statusLabel = $derived(
    !status ? t('hosts.unknownStatus') : status.reachable ? t('hosts.reachable', { ms: status.latencyMs ?? 0 }) : t('hosts.unreachable'),
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let longPressed = false;
  function press() {
    longPressed = false;
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      navigator.vibrate?.(10);
      onmenu(host);
    }, 500);
  }
  function release() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
</script>

<div class="list-item host-row" data-testid="host-row">
  <button
    class="main tap"
    aria-label={`${host.name} - ${tapWord}`}
    onclick={() => {
      if (longPressed) return void (longPressed = false);
      onconnect(host);
    }}
    onpointerdown={press}
    onpointerup={release}
    onpointerleave={release}
    oncontextmenu={(e) => {
      e.preventDefault();
      release();
      onmenu(host);
    }}
  >
    {#if host.color}<span class="color-bar" style:background={host.color}></span>{/if}
    <span class="dot" class:up={status?.reachable} class:down={status && !status.reachable} title={statusLabel} aria-label={statusLabel}></span>
    <!-- A phone: name over address. A wide screen: columns (the text's
         parts become cells of the row's grid), the system beside them. -->
    <span class="text">
      <span class="title">{host.name}</span>
      <span class="sub addr" title={`${eff.username ? `${eff.username}@` : ''}${host.address}${eff.port !== 22 ? `:${eff.port}` : ''}`}>{eff.username ? `${eff.username}@` : ''}{host.address}{eff.port !== 22 ? `:${eff.port}` : ''}</span>
      <span class="os">{host.facts?.os ?? ''}</span>
      <!-- A phone: under the address (beside it they squeezed it to "tester@burrow-e..."). -->
      {#if host.tags.length}<span class="tags">{#each host.tags.slice(0, 2) as tag (tag)}<span class="chip">{tag}</span>{/each}</span>{/if}
    </span>
    <!-- Docker as the Containers tab's icon: a word here read like one more tag. -->
    {#if host.facts?.hasDocker}<span class="docker" role="img" title={t('hosts.hasDocker')} aria-label={t('hosts.hasDocker')}><Icon name="box" size={16} /></span>{/if}
    <!-- Package updates waiting: the count, red with security updates among them (the host's statistics say which). -->
    {#if marks(pkgs)}<span class="pkgs" class:sec={pkgs.security > 0} role="img" title={updatesLine(pkgs)} aria-label={updatesLine(pkgs)} data-testid="host-updates"><Icon name="updates" size={14} />{pkgs.total || ''}</span>{/if}
  </button>
  <button class="icon-btn" aria-label={t('hosts.menu', { name: host.name })} title={t('hosts.menu', { name: host.name })} onclick={() => onmenu(host)}>
    <Icon name="more" size={20} />
  </button>
</div>

<style>
  .pkgs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: none;
    margin-left: 6px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }
  .pkgs.sec {
    color: var(--danger);
  }
  .host-row {
    padding: 0 4px 0 0;
    gap: 0;
  }
  .tap {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 8px 12px 14px;
    min-height: 56px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-touch-callout: none;
    user-select: none;
  }
  @media (hover: hover) {
    .tap:hover {
      background: var(--bg-hover);
    }
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  /* On a phone too: one line, cut at its end. With the update count beside it the address broke
     at a hyphen and read as two names (UIA-09, 2.11.0). */
  .addr {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .docker {
    display: inline-flex;
    flex: none;
    color: var(--text-dim);
  }
  .tags {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .os {
    display: none;
  }
  /* A tablet up (720 px) too: the phone's rows stretched over 760 px left the buttons far from the names (A3-WEB-15). */
  @media (min-width: 720px) {
    .tap {
      position: relative;
      display: grid;
      grid-template-columns: 8px minmax(0, 1.2fr) minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1fr) 20px 40px;
      column-gap: 14px;
      min-height: 46px;
      padding-top: 8px;
      padding-bottom: 8px;
    }
    .text {
      display: contents;
    }
    /* One line, cut at its end: broken at a hyphen it read as two names (UIA-09). */
    .addr {
      font: 0.82rem var(--mono);
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .os {
      display: block;
      color: var(--text-dim);
      font-size: 0.88rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tap :global(.color-bar) {
      position: absolute;
      left: 0;
      top: 6px;
      bottom: 6px;
    }
    .tags {
      grid-column: 5;
      margin-top: 0;
    }
    .docker {
      grid-column: 6;
    }
    .pkgs {
      grid-column: 7;
      margin-left: 0;
    }
  }
</style>
