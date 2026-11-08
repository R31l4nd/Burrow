<script lang="ts">
  import type { AppTab } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import LoadFailed from '../components/LoadFailed.svelte';
  import { errorMessage, get } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { up } from '../lib/router.svelte.js';
  import { frameCsp } from '../lib/framecsp.js';

  // One app in a frame, full screen under a slim bar. Only apps whose
  // headers allow framing get here (and only those are in the CSP).
  let { id }: { id: number } = $props();
  // Apps changed since Burrow's page loaded: the frame needs the page's new CSP.
  if (frameCsp.stale) location.reload();

  let app = $state<AppTab | null>(null);
  let n = $state(0);

  // Failed or gone: said on the page, not an empty frame.
  let loadError = $state('');
  function load() {
    loadError = '';
    get<AppTab[]>('/api/apps')
      .then((list) => {
        app = list.find((a) => a.id === id) ?? null;
        if (!app) loadError = t('apps.notFound');
        // Changed since the list was shown (not framed now): a link to open it, pressed by the
        // person, as a popup opened from here after the wait may be blocked (AUDIT2 PAGE-19).
      })
      .catch((err: unknown) => (loadError = errorMessage(err)));
  }
  load();
</script>

<div class="app-frame">
  <header class="bar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/apps')}><Icon name="back" /></button>
    <span class="title">{app?.name ?? ''}</span>
    <button class="icon-btn" aria-label={t('apps.reload')} onclick={() => n++}><Icon name="reload" /></button>
    {#if app}<a class="icon-btn" href={app.url} target="_blank" rel="noopener noreferrer" aria-label={t('apps.newTab')}><Icon name="external" /></a>{/if}
  </header>
  {#if loadError}
    <LoadFailed message={loadError} onretry={load} heading />
  {:else if app && app.embeddable !== 'yes'}
    <div class="center-screen stack" data-testid="app-not-framed">
      <p>{t('apps.notFramed', { name: app.name })}</p>
      <a class="btn primary" href={app.url} target="_blank" rel="noopener noreferrer">{t('apps.newTab')}</a>
    </div>
  {:else if app?.embeddable === 'yes'}
    {#key n}
      <!-- Another origin: sandboxed only so it cannot navigate Burrow away. -->
      <iframe
        src={app.url}
        title={app.name}
        referrerpolicy="no-referrer"
        allow="fullscreen; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
      ></iframe>
    {/key}
  {/if}
</div>

<style>
  .app-frame {
    position: fixed;
    /* Beside the narrow rail on a computer (none on a phone). */
    inset: 0 0 0 var(--rail-w);
    display: flex;
    flex-direction: column;
    background: var(--bg);
    /* Clear of a phone's notch and gesture bar, as the other full-screen pages (AUDIT2 UX-08). */
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: #fff;
  }
</style>
