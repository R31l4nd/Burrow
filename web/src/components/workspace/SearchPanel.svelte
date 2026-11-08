<script lang="ts">
  import { ask } from '../../lib/confirm.svelte.js';
  import Icon from '../Icon.svelte';
  import { session } from '../../lib/session.svelte.js';
  import type { ReplaceResult, SearchMatch, SearchResult } from '@burrow/shared';
  import { errorMessage, post } from '../../lib/api.js';
  import { t } from '../../lib/i18n/index.svelte.js';
  import { toast } from '../../lib/ui.svelte.js';

  // Search (and replace) in every file of the workspace, on the host with
  // ripgrep or grep. Results by file; a line opens the file there.

  let {
    hostId,
    root,
    onopen,
    onreplaced,
  }: {
    hostId: number;
    root: string;
    onopen: (relPath: string, line: number, col: number) => void;
    /** Files that were changed by a replace (open tabs reload them). */
    onreplaced: (paths: string[]) => void;
  } = $props();

  let query = $state('');
  let regex = $state(false);
  let caseSensitive = $state(false);
  let showReplace = $state(false);
  let replacement = $state('');
  let result = $state<SearchResult | null>(null);
  /** What `result` was searched with: Replace All uses exactly that. */
  let searched = $state<{ query: string; regex: boolean; caseSensitive: boolean; root: string } | null>(null);
  // Changed after the search: the results no longer say what a replace would hit.
  const shown = $derived(searched && searched.query === query && searched.regex === regex && searched.caseSensitive === caseSensitive && searched.root === root ? result : null);
  let busy = $state(false);
  let error = $state('');

  const byFile = $derived.by(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const x of shown?.matches ?? []) {
      if (!m.has(x.path)) m.set(x.path, []);
      m.get(x.path)!.push(x);
    }
    return [...m.entries()];
  });

  async function search(e?: SubmitEvent) {
    e?.preventDefault();
    if (!query) return;
    busy = true;
    error = '';
    const params = { root, query, regex, caseSensitive };
    try {
      result = await post<SearchResult>(`/api/workspace/${hostId}/search`, params);
      searched = params;
    } catch (err) {
      error = errorMessage(err);
      result = null;
      searched = null;
    } finally {
      busy = false;
    }
  }

  async function replace() {
    const files = byFile.map(([p]) => p);
    const params = searched;
    const by = replacement;
    if (!params || !files.length || !(await ask({ text: t('ws.replaceConfirm', { n: shown?.matches.length ?? 0, files: files.length, with: by }), confirm: t('ws.replaceAll'), danger: true }))) return;
    busy = true;
    try {
      const r = await post<ReplaceResult[]>(`/api/workspace/${hostId}/replace`, { ...params, replacement: by, paths: files });
      const changed = r.filter((x) => x.count > 0);
      const failed = r.filter((x) => x.error);
      toast(t('ws.replaced', { n: changed.reduce((a, x) => a + x.count, 0), files: changed.length }), failed.length ? 'error' : 'info');
      for (const f of failed) toast(`${f.path}: ${f.error}`, 'error');
      onreplaced(changed.map((x) => x.path));
      await search();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  /** The match itself, marked in its line (grep gives no column: then the first one). */
  function parts(m: SearchMatch): [string, string, string] {
    const text = m.text;
    let re: RegExp;
    try {
      re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
    } catch {
      return [text, '', ''];
    }
    for (const from of [Math.max(0, m.col - 1), 0]) {
      const hit = re.exec(text.slice(from));
      if (hit && hit[0]) {
        const i = from + hit.index;
        return [text.slice(0, i), hit[0], text.slice(i + hit[0].length)];
      }
    }
    return [text, '', ''];
  }
  const admin = $derived(session.state?.user?.role === 'admin');
</script>

<form class="sform stack" onsubmit={search}>
  <div class="row">
    <input type="search" bind:value={query} placeholder={t('ws.searchPlaceholder')} aria-label={t('ws.searchPlaceholder')} autocapitalize="none" spellcheck="false" data-testid="ws-search" />
    <button type="button" class="tog" class:on={caseSensitive} aria-pressed={caseSensitive} title={t('ws.caseSensitive')} aria-label={t('ws.caseSensitive')} onclick={() => (caseSensitive = !caseSensitive)}>Aa</button>
    <button type="button" class="tog" class:on={regex} aria-pressed={regex} title={t('logs.regex')} aria-label={t('logs.regex')} onclick={() => (regex = !regex)}>.*</button>
    <button type="button" class="tog" class:hidden={!admin} class:on={showReplace} aria-pressed={showReplace} title={t('ws.replace')} aria-label={t('ws.replace')} onclick={() => (showReplace = !showReplace)}><Icon name="swap" size={16} /></button>
  </div>
  {#if showReplace}
    <div class="row">
      <input bind:value={replacement} placeholder={t('ws.replaceWith')} aria-label={t('ws.replaceWith')} autocapitalize="none" spellcheck="false" data-testid="ws-replace" />
      <button type="button" class="btn small" disabled={busy || !byFile.length} onclick={replace} data-testid="ws-replace-all">{t('ws.replaceAll')}</button>
    </div>
  {/if}
  <button class="btn small" disabled={busy || !query}>{t('ws.search')}</button>
</form>

{#if error}<p class="alert error small">{error}</p>{/if}
{#if shown}
  <p class="dim small">{t('ws.found', { n: shown.matches.length, files: byFile.length })}{shown.truncated ? ` | ${t('ws.truncated')}` : ''} | {shown.tool}</p>
  <div class="results" data-testid="ws-results">
    {#each byFile as [path, ms] (path)}
      <div class="file">{path}</div>
      {#each ms as m (m.line + ':' + m.col)}
        {@const [a, b, c] = parts(m)}
        <button class="hit" onclick={() => onopen(path, m.line, m.col)}>
          <span class="ln">{m.line}</span>
          <span class="tx">{a}<mark>{b}</mark>{c}</span>
        </button>
      {/each}
    {/each}
  </div>
{/if}

<style>
  .hidden {
    display: none;
  }
  .sform {
    padding: 8px;
  }
  /* Aa, .* and Replace as high as the field (report eb4f8a: the global .row centres them). */
  .row {
    display: flex;
    align-items: stretch;
    gap: 4px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .tog {
    flex: none;
    min-width: 40px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
    color: var(--text-dim);
    font: 600 0.85rem var(--mono);
    cursor: pointer;
  }
  .tog.on {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .results {
    font-size: 0.85rem;
  }
  .file {
    padding: 6px 8px 2px;
    font-weight: 700;
    word-break: break-all;
  }
  .hit {
    display: flex;
    gap: 8px;
    width: 100%;
    padding: 3px 8px 3px 16px;
    border: 0;
    background: none;
    color: var(--text);
    font: 0.8rem var(--mono);
    text-align: left;
    cursor: pointer;
  }
  @media (hover: hover) {
    .hit:hover {
      background: var(--bg-hover);
    }
  }
  .ln {
    flex: none;
    color: var(--text-dim);
    min-width: 2.5em;
    text-align: right;
  }
  .tx {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: color-mix(in srgb, var(--warn) 45%, transparent);
    color: inherit;
  }
  p {
    padding: 0 8px;
  }
</style>
