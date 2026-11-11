<script lang="ts">
  import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, selectMatches, setSearchQuery } from '@codemirror/search';
  import { runScopeHandlers, type EditorView } from '@codemirror/view';
  import { t } from '../lib/i18n/index.svelte.js';
  import type { FindState } from '../lib/editor/find.svelte.js';
  import Icon from './Icon.svelte';

  // The editor's find and replace, in place of CodeMirror's own panel: that one took half a phone's
  // screen, a row for each field, button and box (report dccaf7). One row like the terminal's search
  // (field, count, previous, next, close) with the options as toggles beside it (a second row on a
  // phone), and replace a row of its own only when asked for, as VS Code's find widget does.
  let { view, find }: { view: EditorView; find: FindState } = $props();

  let replacing = $state(false);

  function set(change: Partial<{ search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }>) {
    const q = getSearchQuery(view.state);
    const next = new SearchQuery({ search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord, ...change });
    if (!next.eq(q)) view.dispatch({ effects: setSearchQuery.of(next) });
  }

  function keys(e: KeyboardEvent, enter: () => void, back: () => void = enter) {
    // The panel's keys from CodeMirror's keymap (Escape, F3, Ctrl+G, Ctrl+F), as in its own panel.
    if (runScopeHandlers(view, e, 'search-panel')) {
      e.preventDefault();
    } else if (e.key === 'Enter' && e.altKey) {
      // Every match selected, as VS Code's Alt+Enter.
      e.preventDefault();
      selectMatches(view);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (e.shiftKey ? back : enter)();
    }
  }

  const toggles = $derived([
    { key: 'caseSensitive', on: find.query.caseSensitive, label: t('editor.matchCase'), text: 'Aa' },
    { key: 'wholeWord', on: find.query.wholeWord, label: t('editor.wholeWord'), text: 'ab' },
    { key: 'regexp', on: find.query.regexp, label: t('editor.regex'), text: '.*' },
  ] as const);
</script>

<div class="find" role="search">
  <div class="row first">
    <input
      class="field"
      name="search"
      value={find.query.search}
      oninput={(e) => set({ search: e.currentTarget.value })}
      onkeydown={(e) => keys(e, () => findNext(view), () => findPrevious(view))}
      placeholder={t('editor.findField')}
      aria-label={t('editor.findField')}
      autocapitalize="none"
      autocomplete="off"
      spellcheck="false"
    />
    <span class="dim small count" aria-live="polite" data-testid="editor-find-count">{find.count}</span>
    <span class="opts">
      {#each toggles as o (o.key)}
        <button type="button" class="icon-btn toggle" class:on={o.on} aria-pressed={o.on} aria-label={o.label} title={o.label} onclick={() => set({ [o.key]: !o.on })}>{o.text}</button>
      {/each}
      <button type="button" class="btn small more" class:on={replacing} aria-expanded={replacing} onclick={() => (replacing = !replacing)} data-testid="editor-find-replace">{t('editor.replaceToggle')}</button>
    </span>
    <button type="button" class="icon-btn" aria-label={t('term.searchPrev')} title={t('term.searchPrev')} onclick={() => findPrevious(view)}><Icon name="arrow-up" size={18} /></button>
    <button type="button" class="icon-btn" aria-label={t('term.searchNext')} title={t('term.searchNext')} onclick={() => findNext(view)}><Icon name="arrow-down" size={18} /></button>
    <button type="button" class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onclick={() => closeSearchPanel(view)}><Icon name="close" size={18} /></button>
  </div>
  {#if replacing}
    <div class="row">
      <input
        class="field"
        name="replace"
        value={find.query.replace}
        oninput={(e) => set({ replace: e.currentTarget.value })}
        onkeydown={(e) => keys(e, () => replaceNext(view))}
        placeholder={t('ws.replaceWith')}
        aria-label={t('ws.replaceWith')}
        autocapitalize="none"
        autocomplete="off"
        spellcheck="false"
      />
      <button type="button" class="btn small" aria-label={t('editor.replaceOne')} onclick={() => replaceNext(view)}>{t('editor.replaceOneShort')}</button>
      <button type="button" class="btn small" aria-label={t('ws.replaceAll')} onclick={() => replaceAll(view)}>{t('editor.replaceAllShort')}</button>
    </div>
  {/if}
</div>

<style>
  .find {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 6px;
    font: 0.9rem var(--font);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .field {
    flex: 1 1 120px;
    min-width: 0;
    height: 36px;
    font-family: var(--mono);
  }
  /* As wide as their words, on one line, the field taking the rest: the app's
     .row > .btn shares the row out evenly, so on a computer "This one" and
     "All" each took a third, and on a phone "This one" broke over two lines. */
  .row > .btn {
    flex: none;
    white-space: nowrap;
  }
  .count {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .opts {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  /* Framed, as a button that stays pressed: plain grey letters read as a label. */
  .toggle {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font: 600 0.85rem var(--mono);
    color: var(--text-dim);
  }
  .toggle.on {
    border-color: var(--accent);
  }
  .on {
    color: var(--accent);
  }
  .toggle.on {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  /* As wide as its word: the app's .btn spans the width, so on a phone it took the options' row's rest (report 696298). */
  .more {
    margin-left: 4px;
    width: auto;
    white-space: nowrap;
  }
  /* As high as the options beside it, and so as the field: 36 px under 44 px toggles on a phone (report 703c76). */
  .opts > .btn {
    align-self: stretch;
  }
  /* A phone: the options and Replace a row of their own under the field, so the field keeps its room. */
  @media (max-width: 599px) {
    .first {
      flex-wrap: wrap;
    }
    /* The field's 120 px start counted in where the row breaks: with a count ("1 van 20") and three
       44 px buttons on a 343 px phone the close button fell to a row of its own (report 696298).
       From nothing the field still takes the rest of the row. */
    .field {
      flex-basis: 0;
    }
    .opts {
      order: 1;
      flex-basis: 100%;
    }
    .more {
      margin-left: auto;
    }
  }
</style>
