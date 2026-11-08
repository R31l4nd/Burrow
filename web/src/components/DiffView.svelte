<script lang="ts">
  import { editorSetup } from '../lib/editor/setup.js';
  import { EditorView } from '@codemirror/view';
  import { EditorState, Text } from '@codemirror/state';
  import { Chunk, getChunks, MergeView, unifiedMergeView } from '@codemirror/merge';
  import { burrowEditorTheme, editorLabel } from '../lib/editor/theme.js';
  import { chunkAt, diffSummary, markPlaces } from '../lib/editor/diffinfo.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import Icon from './Icon.svelte';

  // Two texts compared, read only, so the differences are seen at once (user, 2026-10-23, VS Code as
  // the reference): side by side where there is room (the older left), one column with the older
  // lines above the newer ones on a phone; how much differs and where, the previous and next
  // difference (F7, Shift+F7) with the first one in view at the start, a mark along the edge for each,
  // and the unchanged stretches folded until asked for.
  let { original, modified, label, names = null }: { original: string; modified: string; label: string; names?: [string, string] | null } = $props();

  let wrap = $state<HTMLDivElement | null>(null);
  let el = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  const side = $derived(width >= 760);
  let showAll = $state(false);
  let index = $state(-1);
  let target: EditorView | null = null;
  let chunks = $state<readonly Chunk[]>([]);

  const docA = $derived(Text.of(original.split('\n')));
  const docB = $derived(Text.of(modified.split('\n')));
  // From the texts themselves, so the count is there before the view is.
  const summary = $derived(diffSummary(Chunk.build(docA, docB), docA, docB));
  const places = $derived(markPlaces(chunks, docB));

  $effect(() => {
    if (!wrap) return;
    const ro = new ResizeObserver(() => (width = wrap?.clientWidth ?? 0));
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!el || !width) return;
    const base = [editorSetup(), burrowEditorTheme, EditorView.editable.of(false), EditorView.lineWrapping];
    const collapse = showAll ? undefined : { margin: 3, minSize: 6 };
    let destroy: () => void;
    // Kept in a local first: read back from the state, it made this effect depend on what it writes.
    let found: readonly Chunk[];
    if (side) {
      const mv = new MergeView({
        parent: el,
        a: { doc: original, extensions: [...base, editorLabel(names?.[0] ?? t('diff.before'))] },
        b: { doc: modified, extensions: [...base, editorLabel(names?.[1] ?? label)] },
        gutter: true,
        highlightChanges: true,
        ...(collapse ? { collapseUnchanged: collapse } : {}),
      });
      target = mv.b;
      found = mv.chunks;
      destroy = () => mv.destroy();
    } else {
      const v = new EditorView({
        parent: el,
        state: EditorState.create({ doc: modified, extensions: [...base, editorLabel(label), unifiedMergeView({ original, mergeControls: false, ...(collapse ? { collapseUnchanged: collapse } : {}) })] }),
      });
      target = v;
      found = getChunks(v.state)?.chunks ?? [];
      destroy = () => v.destroy();
    }
    chunks = found;
    index = -1;
    // The first difference in view at the start: no scrolling through what is the same.
    if (found.length) requestAnimationFrame(() => go(0));
    return () => {
      target = null;
      destroy();
    };
  });

  function go(i: number) {
    const v = target;
    const c = chunks[i];
    if (!v || !c) return;
    index = i;
    const pos = Math.min(c.fromB, v.state.doc.length);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  }
  const step = (by: number) => {
    if (!chunks.length) return;
    const at = index >= 0 ? index : chunkAt(chunks, target?.state.selection.main.head ?? 0);
    go(Math.max(0, Math.min(chunks.length - 1, at + by)));
  };
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'F7') return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  }
</script>

<div class="diffwrap" bind:this={wrap}>
  <div class="diffbar">
    {#if summary.places}
      <span class="small" data-testid="diff-summary"><b class="add">+{summary.added}</b> <b class="del">-{summary.removed}</b> {t('diff.places', { n: summary.places })}{#if index >= 0}{` | ${t('diff.at', { i: index + 1, n: chunks.length })}`}{/if}</span>
    {:else}
      <span class="small">{t('diff.same')}</span>
    {/if}
    <span class="spacer"></span>
    {#if summary.places}
      <label class="check small"><input type="checkbox" bind:checked={showAll} data-testid="diff-all" />{t('diff.showAll')}</label>
      <button class="icon-btn" aria-label={t('diff.prev')} title={t('diff.prev')} disabled={index <= 0} onclick={() => step(-1)} data-testid="diff-prev"><Icon name="chevron-up" size={18} /></button>
      <button class="icon-btn" aria-label={t('diff.next')} title={t('diff.next')} disabled={index >= chunks.length - 1} onclick={() => step(1)} data-testid="diff-next"><Icon name="chevron-down" size={18} /></button>
    {/if}
  </div>
  {#if side}<div class="names small dim"><span>{names?.[0] ?? t('diff.before')}</span><span>{names?.[1] ?? t('diff.after')}</span></div>{/if}
  <div class="diffbody">
    <!-- Scrolled by keyboard too (focusable), F7 and Shift+F7 inside it as in VS Code. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="diff" role="region" aria-label={label} tabindex="0" onkeydown={onKey} bind:this={el} data-testid="diff" data-private></div>
    <!-- Where along the file each difference is, as beside a scrollbar; a tap goes there (the buttons above do the same by keyboard). -->
    <div class="marks" aria-hidden="true">
      {#each places as p, i (i)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <span class="mark" class:on={i === index} style:top="{p * 100}%" onclick={() => go(i)} data-testid="diff-mark"></span>
      {/each}
    </div>
  </div>
</div>

<style>
  .diffwrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .diffbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--danger);
  }
  .names {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding-right: 14px;
  }
  .names > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .diffbody {
    position: relative;
    min-width: 0;
  }
  .diff {
    max-height: 55dvh;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    min-height: 60px;
    margin-right: 14px;
  }
  .marks {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 10px;
    border-radius: 3px;
    background: var(--bg-sunken);
  }
  .mark {
    position: absolute;
    left: 1px;
    right: 1px;
    height: 4px;
    border-radius: 2px;
    background: var(--accent);
    cursor: pointer;
  }
  .mark.on {
    background: var(--text);
  }
</style>
