<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { shownAt, stepFrom } from '../lib/gallery.js';
  import type { FileEntry } from '@burrow/shared';
  import { openKind, rawUrl } from '../lib/files.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { errorMessage } from '../lib/api.js';

  // Full-screen viewer: images as a gallery (swipe or arrow keys), video and
  // audio streamed with HTTP ranges so seeking works without downloading.
  // The phone's own pictures (srcOf) come from the Android app as a blob,
  // made here and let go again; nothing of them goes to Burrow.
  let {
    hostId,
    items,
    index,
    onclose,
    srcOf,
  }: { hostId: number; items: FileEntry[]; index: number | null; onclose: () => void; srcOf?: (e: FileEntry) => Promise<string> } = $props();

  // The one shown, followed by its path: the list may be read again meanwhile (Files reads its folder
  // every ten seconds), and an index then pointed at another picture, or past the end (lib/gallery.ts).
  let shown = $state<FileEntry | null>(null);
  $effect.pre(() => {
    const i = index;
    shown = i === null ? null : (untrack(() => items[Math.max(0, i)]) ?? null);
  });
  const current = $derived(shownAt(items, shown?.path ?? null));
  // Gone from the folder meanwhile: still shown, until closed or stepped on from.
  const item = $derived(index === null ? null : (items[current] ?? shown));
  const kind = $derived(item ? openKind(item.name) : null);

  // A picture of the phone: read for the one shown, its blob let go when another is shown or the viewer closes.
  let made = $state<{ path: string; url: string } | null>(null);
  let madeError = $state('');
  $effect(() => {
    const it = item;
    if (!it || !srcOf) return;
    let gone = false;
    let url: string | null = null;
    made = null;
    madeError = '';
    srcOf(it).then(
      (u) => {
        if (gone) return URL.revokeObjectURL(u);
        url = u;
        made = { path: it.path, url: u };
      },
      (err: unknown) => {
        if (!gone) madeError = errorMessage(err);
      },
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  });
  const src = $derived(item ? (srcOf ? (made?.path === item.path ? made.url : null) : rawUrl(hostId, item.path)) : null);

  function step(d: number) {
    if (items.length > 1 || (current < 0 && items.length)) shown = stepFrom(items, shown?.path ?? null, d) ?? shown;
  }

  let startX = 0;
  // Arrows step through the pictures, but not while a video or audio player has the keys
  // (they seek there, AUDIT2 UI-26). Escape is the dialog's own.
  function onKey(e: KeyboardEvent) {
    if (index === null || e.target instanceof HTMLMediaElement) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  }
  // A real modal: the focus inside it and back where it was after, the page behind out of
  // reach (a div that only said aria-modal did neither, AUDIT2 UI-26).
  function modal(el: HTMLDialogElement) {
    el.showModal();
    window.dispatchEvent(new Event('burrow:toplayer'));
    return { destroy: () => el.open && el.close() };
  }
</script>

{#if item}
  <dialog class="viewer" aria-label={item.name} use:modal onkeydown={onKey} oncancel={(e) => (e.preventDefault(), onclose())}>
    <header>
      <span class="name">{item.name}{items.length > 1 && current >= 0 ? ` | ${current + 1}/${items.length}` : ''}</span>
      {#if !srcOf}<a class="icon-btn" href={rawUrl(hostId, item.path, true)} download={item.name} aria-label={t('files.download')}><Icon name="download" /></a>{/if}
      <button class="icon-btn" aria-label={t('common.close')} onclick={onclose}><Icon name="close" /></button>
    </header>
    <div
      class="stage"
      role="presentation"
      ontouchstart={(e) => (startX = e.touches[0]!.clientX)}
      ontouchend={(e) => {
        const dx = e.changedTouches[0]!.clientX - startX;
        if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
      }}
    >
      {#if madeError}
        <p class="alert error" data-testid="viewer-error">{madeError}</p>
      {:else if !src}
        <p class="dim" aria-live="polite">{t('common.loading')}</p>
      {:else if kind === 'image'}
        <img {src} alt={item.name} data-testid="viewer-image" />
      {:else if kind === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video {src} controls autoplay playsinline></video>
      {:else if kind === 'audio'}
        <audio {src} controls autoplay></audio>
      {/if}
    </div>
    {#if items.length > 1}
      <nav class="arrows">
        <button class="icon-btn" aria-label={t('files.previous')} onclick={() => step(-1)}><Icon name="chevron-left" /></button>
        <button class="icon-btn" aria-label={t('files.next')} onclick={() => step(1)}><Icon name="chevron" /></button>
      </nav>
    {/if}
  </dialog>
{/if}

<style>
  .viewer {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    border: 0;
    padding: 0;
    z-index: 40;
    background: #000;
    color: #fff;
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top);
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
  }
  header .icon-btn {
    color: #fff;
    text-decoration: none;
    font-size: 1.3rem;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9rem;
  }
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  img,
  video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  audio {
    width: min(90vw, 480px);
  }
  .arrows {
    position: absolute;
    inset: 50% 0 auto;
    display: flex;
    justify-content: space-between;
    pointer-events: none;
  }
  .arrows .icon-btn {
    pointer-events: auto;
    color: #fff;
    font-size: 2rem;
    background: rgb(0 0 0 / 0.3);
  }
</style>
