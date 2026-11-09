<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../lib/i18n/index.svelte.js';
  import { bug, startReport } from '../lib/bugreport.svelte.js';
  import { keyBars } from '../lib/keyboard.svelte.js';
  import { MOD } from '../lib/shortcuts.svelte.js';
  import { ask } from '../lib/confirm.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';
  import { markOpened } from '../lib/back.js';
  import Icon from './Icon.svelte';
  import { lastPressed } from '../lib/pressed.js';

  // Native <dialog>: focus trapping, Esc to close and the backdrop come from
  // the browser. On phones it sits at the bottom like a sheet. Phones have no
  // Esc key, so there is a close button and a tap on the backdrop closes too.
  let {
    open = $bindable(false),
    title,
    tour,
    size = 'form',
    onclose,
    dirty,
    menu = false,
    children,
    actions,
  }: {
    open?: boolean;
    title: string;
    /** Its name in the tour: every dialog is looked at there (e2e/tests/workspace-tour.spec.ts). */
    tour: string;
    /** form: a column of fields or choices; wide: something to read or compare (notes, diffs, logs), as wide as the screen allows (report ac7481). */
    size?: 'form' | 'wide';
    onclose?: () => void;
    /** A form with changes not saved: X, Escape, the backdrop, another page and a reload ask first (AUDIT2 PAGE-09). Its own Cancel does not. */
    dirty?: () => boolean;
    /** A menu (things to do with one host, file, container): a popover by the button that opened it on a computer, a sheet on a phone (decision 28, UIB-08). */
    menu?: boolean;
    children: Snippet;
    actions?: Snippet;
  } = $props();

  // Closing, it stays drawn while it fades: its title as it was, not the one
  // of the state cleared on close ("Direct route: " with no name, report 693cf4).
  let keptTitle = $state('');
  $effect.pre(() => {
    if (open) keptTitle = title;
  });
  const shownTitle = $derived(open ? title : keptTitle);

  let el: HTMLDialogElement | undefined = $state();
  let bodyEl: HTMLDivElement | undefined = $state();
  let bodyScrolls = $state(false);
  $effect(() => {
    if (!bodyEl) return;
    const b = bodyEl;
    const ro = new ResizeObserver(() => (bodyScrolls = b.scrollHeight > b.clientHeight + 1));
    ro.observe(b);
    for (const c of b.children) ro.observe(c);
    return () => ro.disconnect();
  });
  // Where the press began: a text selection dragged out of a field ends on the backdrop, and that
  // click is no tap on the backdrop (it closed the dialog, A3-WEB-12).
  let downOnBackdrop = false;
  // Closed by an Escape the browser would not let be stopped, with changes: opened again and asked.
  let forced = false;

  warnUnsaved(() => open && !!dirty?.());
  async function tryClose() {
    if (dirty?.() && !(await ask({ text: t('common.unsavedClose'), confirm: t('common.closeUnsaved'), danger: true }))) return;
    el?.close();
  }

  // A menu on a computer: beside the button it came from (below it, or above when there is no room),
  // as a popover; on a phone, or opened without a button, a sheet or a dialog as any other.
  const pointerMenu = typeof window !== 'undefined' ? window.matchMedia('(min-width: 640px) and (hover: hover) and (pointer: fine)') : null;
  let anchored = $state(false);
  function placeMenu() {
    const from = lastPressed();
    anchored = !!(menu && el && pointerMenu?.matches && from?.isConnected && !el.contains(from));
    if (!anchored || !el || !from) return;
    // Its popover size now, not the sheet's it had a moment before (measured too early, it was placed off the screen).
    el.classList.add('anchored');
    el.style.left = el.style.top = '';
    const a = from.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = a.bottom + 6;
    const top = below + r.height <= window.innerHeight - 8 ? below : Math.max(8, a.top - 6 - r.height);
    const left = a.left + a.width / 2 > window.innerWidth / 2 ? a.right - r.width : a.left;
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(Math.min(Math.max(8, left), window.innerWidth - r.width - 8))}px`;
  }

  // The window narrowed to a phone's (or turned): a sheet again, not a popover at the old place.
  $effect(() => {
    const drop = () => {
      if (!anchored || !el || pointerMenu?.matches) return;
      anchored = false;
      el.style.left = el.style.top = '';
    };
    pointerMenu?.addEventListener('change', drop);
    return () => pointerMenu?.removeEventListener('change', drop);
  });

  // A menu that turns into a form (a file's Rename): a dialog as any other from then on.
  $effect(() => {
    if (menu || !anchored || !el) return;
    anchored = false;
    el.style.left = el.style.top = '';
  });

  $effect(() => {
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      markOpened(el);
      placeMenu();
      // The dialog itself gets the focus, not its close button: no focus
      // ring on the x for a dialog opened by a tap (Tab still reaches it).
      el.focus();
      // Toasts must stay above the dialog that just opened.
      window.dispatchEvent(new Event('burrow:toplayer'));
    }
    if (!open && el.open) el.close();
  });
</script>

<dialog
  bind:this={el}
  tabindex="-1"
  data-tour={tour}
  class:wide={size === 'wide'}
  class:menu
  class:anchored
  aria-label={title}
  oncancel={(e) => {
    // Escape (or Android's Back through it): asked first when there are changes.
    if (!dirty?.()) return;
    // A second Escape with no tap or key in between: Chrome lets no page stop that one (a cancel
    // that cannot be cancelled, against pages that trap the person). It closes; opened again
    // below, and asked.
    if (!e.cancelable) return void (forced = true);
    e.preventDefault();
    void tryClose();
  }}
  onclose={() => {
    // The close event comes a moment after close(): when the dialog was
    // opened again by then (the next question right after the first was
    // answered), it is not this one closing. Taken as such, it cancelled
    // that next question ("Update now?", then the release notes' warning).
    if (el?.open) return;
    if (forced && el && dirty?.()) {
      forced = false;
      el.showModal();
      markOpened(el);
      window.dispatchEvent(new Event('burrow:toplayer'));
      void tryClose();
      return;
    }
    forced = false;
    open = false;
    onclose?.();
  }}
  onpointerdown={(e) => (downOnBackdrop = e.target === el)}
  onclick={(e) => {
    // A click on the dialog element itself (not its content) is the backdrop: pressed and let go there.
    if (e.target === el && downOnBackdrop) void tryClose();
    downOnBackdrop = false;
  }}
>
  <header>
    <h2>{shownTitle}</h2>
    <!-- The report button on the page is behind an open dialog (the page is
         inert then): while armed, each dialog has its own. -->
    {#if bug.armed && !bug.open && tour !== 'bug-report'}
      <button type="button" class="icon-btn bug" data-bug-ui disabled={bug.capturing} aria-label={t('bug.here')} title={keyBars.show ? t('bug.here') : t('bug.hereKeys', { keys: `${MOD}+Shift+B` })} onclick={() => void startReport()} data-testid="dialog-bug-button">
        <Icon name="alert" size={20} />
      </button>
    {/if}
    <button type="button" class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onclick={() => void tryClose()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
    </button>
  </header>
  <!-- Reachable by keyboard when it scrolls, to scroll it (a long list of shortcuts has nothing else to focus). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
  <div class="body" tabindex={bodyScrolls ? 0 : undefined} bind:this={bodyEl}>
    {@render children()}
  </div>
  {#if actions}
    <footer class="row">{@render actions()}</footer>
  {/if}
</dialog>

<style>
  dialog:focus {
    outline: none;
  }
  /* Opening and closing: it fades in and rises a little (a phone's sheet
     from the bottom), the backdrop darkens; closed, the same back, while
     the browser keeps it drawn (open/closed stay immediate for the code). */
  dialog {
    --from: translateY(24px);
    opacity: 1;
    transform: none;
    transition:
      opacity var(--dur-2) var(--ease),
      transform var(--dur-2) var(--ease),
      overlay var(--dur-2) allow-discrete,
      display var(--dur-2) allow-discrete;
  }
  dialog:not([open]) {
    opacity: 0;
    transform: var(--from);
    transition-timing-function: var(--ease-in);
  }
  @starting-style {
    dialog[open] {
      opacity: 0;
      transform: var(--from);
    }
  }
  dialog::backdrop {
    transition:
      background-color var(--dur-2) var(--ease),
      overlay var(--dur-2) allow-discrete,
      display var(--dur-2) allow-discrete;
  }
  dialog:not([open])::backdrop {
    background-color: transparent;
  }
  @starting-style {
    dialog[open]::backdrop {
      background-color: transparent;
    }
  }
  dialog {
    width: min(100vw, 520px);
    max-height: 92dvh;
    margin: auto auto 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px 12px 0 0;
    background: var(--bg-raised);
    color: var(--text);
    box-shadow: var(--shadow);
  }
  dialog.wide {
    width: min(100vw, 1100px);
  }
  /* A column: only the body scrolls, the title, its close button and the
     footer's buttons stay in sight (UIA-01, UIB-01: the whole dialog
     scrolled, Save below the screen, the title gone). */
  /* The column's other parts on the dialog itself, not only while [open]:
     closing, it is drawn on while it fades, and without them it showed as a
     row in odd proportions for a few frames (report 693cf4). */
  dialog {
    flex-direction: column;
    overflow: hidden;
  }
  dialog[open] {
    display: flex;
  }
  header,
  footer {
    flex: none;
  }
  @media (min-width: 640px) {
    dialog {
      --from: translateY(8px) scale(0.98);
      margin: auto;
      border-radius: 10px;
    }
    dialog.wide {
      width: min(100vw - 48px, 1100px);
      max-height: 90dvh;
    }
  }
  dialog::backdrop {
    background: rgb(12 18 15 / 0.5);
  }
  /* A menu by its button on a computer: small, no darkened page behind it. */
  dialog.anchored {
    --from: translateY(-4px);
    position: fixed;
    inset: auto;
    margin: 0;
    width: min(340px, 100vw - 16px);
    max-height: min(70dvh, 560px);
    border-radius: 10px;
  }
  dialog.anchored::backdrop {
    background: transparent;
  }
  dialog.anchored header {
    padding: 6px 4px 6px 14px;
  }
  dialog.anchored header h2 {
    font-size: 0.95rem;
  }
  dialog.anchored .body {
    padding: 8px 8px 0;
    gap: 4px;
  }
  /* A menu's actions: one column of full-width rows, the words at the start (UIB-08: ragged
     buttons each of its own width). */
  dialog.menu .body > :global(.btn),
  dialog.menu .body > :global(.stack > .btn),
  dialog.menu .body > :global(a.btn) {
    width: 100%;
    justify-content: flex-start;
    text-align: left;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px 10px 18px;
    border-bottom: 1px solid var(--border-soft);
  }
  /* Two lines rather than cut: the end of a title is often its point, a
     host's or a file's name ("Onthouden commando's o...", UIA-08). */
  header h2 {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  header h2 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 16px 18px 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  /* The room under the last item as an item of its own (with the gap before it): a box that
     scrolls left its bottom padding out at the end, and a host menu's last button stood on the
     footer's line (the tour's buttonsOffLines, 2026-11-06). */
  .body::after {
    content: '';
    flex: none;
    height: 4px;
  }
  /* The body scrolls; what is in it keeps its height (a log or a list with
     its own scroll box would shrink to nothing in a bounded column). */
  .body > :global(*) {
    flex-shrink: 0;
  }
  footer {
    flex-wrap: wrap;
    padding: 12px 18px calc(12px + env(safe-area-inset-bottom));
    justify-content: flex-end;
    border-top: 1px solid var(--border-soft);
    background: var(--bg);
    border-radius: 0 0 10px 10px;
  }
  .bug {
    color: var(--danger);
  }
</style>
