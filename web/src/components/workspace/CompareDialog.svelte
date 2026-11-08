<script lang="ts">
  import Fuse from 'fuse.js';
  import type { TextFile } from '@burrow/shared';
  import { ApiFailure, errorMessage, get } from '../../lib/api.js';
  import { t } from '../../lib/i18n/index.svelte.js';
  import type { FileLabel } from '../../lib/tablabels.js';
  import Dialog from '../Dialog.svelte';
  import DiffView from '../DiffView.svelte';

  // A workspace's file against another (report 9d710d): an open file, or any
  // file of the workspace's folders found by name. Read only, the two paths
  // named. An open file is compared as it is in its tab (what is typed
  // too, and a file opened through sudo without reading it again); a file
  // only root may read says so, with the way to open it through sudo.

  let {
    open = $bindable(false),
    hostId,
    roots,
    path,
    openFiles,
    label,
    textOf,
    onopentab,
  }: {
    open?: boolean;
    hostId: number;
    /** The workspace's folders: the other file can be in any of them. */
    roots: string[];
    /** This file (absolute). */
    path: string | null;
    /** The files open in tabs (absolute). */
    openFiles: string[];
    label: (path: string) => FileLabel;
    /** The text of an open file as its tab has it; null when the tab could not read it. */
    textOf: (path: string) => string | null;
    /** Open a file in a tab (to read it through sudo there). */
    onopentab: (path: string) => void;
  } = $props();

  let other = $state<string | null>(null);
  let query = $state('');
  let files = $state<string[]>([]);
  let listError = $state('');
  let loaded = $state(false);
  let result = $state<{ a: string; b: string } | null>(null);
  let readError = $state<{ path: string; message: string; rootOnly: boolean } | null>(null);
  let reading = $state(false);

  const others = $derived(openFiles.filter((p) => p !== path));
  const fuse = $derived(new Fuse(files, { threshold: 0.4, ignoreLocation: true }));
  const found = $derived((query.trim() ? fuse.search(query.trim(), { limit: 30 }).map((r) => r.item) : files.slice(0, 30)).filter((p) => p !== path));

  // Each opening starts afresh and lists the folders' files once; a list for an opening before is dropped.
  let opening = 0;
  $effect(() => {
    if (!open) {
      opening++;
      return;
    }
    const mine = ++opening;
    other = null;
    result = null;
    readError = null;
    query = '';
    files = [];
    loaded = false;
    listError = '';
    Promise.all(roots.map((r) => get<{ files: string[] }>(`/api/workspace/${hostId}/files?root=${encodeURIComponent(r)}`).then((x) => x.files.map((f) => `${r === '/' ? '' : r}/${f}`)))).then(
      (lists) => {
        if (mine !== opening) return;
        files = [...new Set(lists.flat())];
        loaded = true;
      },
      (err: unknown) => {
        if (mine === opening) listError = errorMessage(err);
      },
    );
  });

  async function read(p: string): Promise<string> {
    const inTab = openFiles.includes(p) ? textOf(p) : null;
    if (inTab !== null) return inTab;
    return (await get<TextFile>(`/api/files/${hostId}/text?path=${encodeURIComponent(p)}`, ['permission_denied'])).content;
  }

  async function pick(p: string) {
    if (!path) return;
    other = p;
    result = null;
    readError = null;
    reading = true;
    const mine = opening;
    for (const which of [path, p]) {
      try {
        const text = await read(which);
        if (mine !== opening || other !== p) return;
        result = which === path ? { a: text, b: '' } : { a: result!.a, b: text };
      } catch (err) {
        if (mine !== opening || other !== p) return;
        readError = { path: which, message: errorMessage(err), rootOnly: err instanceof ApiFailure && err.code === 'permission_denied' };
        result = null;
        break;
      }
    }
    reading = false;
  }

  function back() {
    other = null;
    result = null;
    readError = null;
  }

  const named = (p: string) => {
    const l = label(p);
    return l.dir ? `${l.name} (${l.dir})` : l.name;
  };
</script>

<Dialog tour="ws-compare" size="wide" bind:open title={path ? t('ws.compareTitle', { name: named(path) }) : ''}>
  {#if path && other}
    <dl class="pair small" data-testid="compare-pair">
      <dt>{t('ws.compareThis')}</dt>
      <dd class="mono">{path}</dd>
      <dt>{t('ws.compareOther')}</dt>
      <dd class="mono">{other}</dd>
    </dl>
    <button class="btn small back" onclick={back} data-testid="compare-back">{t('ws.compareAnother')}</button>
    {#if reading}<p class="dim small">{t('common.loading')}</p>{/if}
    {#if readError}
      <div class="alert error stack" data-testid="compare-error">
        <span>{readError.path}: {readError.message}</span>
        {#if readError.rootOnly}
          <span class="small">{t('ws.compareRootOnly')}</span>
          <button class="btn small" onclick={() => readError && ((open = false), onopentab(readError.path))} data-testid="compare-open-tab">{t('ws.compareOpenTab')}</button>
        {/if}
      </div>
    {:else if result && !reading}
      {#if result.a === result.b}<p class="small" data-testid="compare-same">{t('files.compareSame')}</p>
      {:else}<p class="dim small">{t('ws.compareHelp')}</p><DiffView original={result.b} modified={result.a} label={t('files.compareLabel', { a: path, b: other })} names={[other ?? '', path ?? '']} />{/if}
    {/if}
  {:else if path}
    {#if others.length}
      <h3 class="small head">{t('ws.openFiles')}</h3>
      <div class="list">
        {#each others as p (p)}
          {@const l = label(p)}
          <button class="list-item" onclick={() => pick(p)} data-testid="compare-tab">
            <span class="main"><span class="title">{l.name}{#if l.dir}<span class="dim small"> {l.dir}</span>{/if}</span><span class="sub">{p}</span></span>
          </button>
        {/each}
      </div>
    {/if}
    <h3 class="small head">{t('ws.compareFind')}</h3>
    <input type="search" bind:value={query} placeholder={t('ws.quickOpenPlaceholder')} aria-label={t('ws.compareFind')} autocapitalize="none" spellcheck="false" data-testid="compare-find" />
    <div class="list found">
      {#each found as p (p)}
        <button class="list-item" onclick={() => pick(p)} data-testid="compare-file">
          <span class="main"><span class="title">{p.split('/').pop()}</span><span class="sub">{p}</span></span>
        </button>
      {/each}
      {#if listError}<p class="alert error small">{listError}</p>
      {:else if !loaded}<p class="dim small">{t('common.loading')}</p>
      {:else if !found.length}<p class="dim small">{t('ws.noFiles')}</p>{/if}
    </div>
  {/if}
</Dialog>

<style>
  .head {
    margin: 4px 0;
    color: var(--text-dim);
  }
  .found {
    margin-top: 6px;
    max-height: 40dvh;
    overflow: auto;
  }
  .pair {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0 0 8px;
  }
  .back {
    margin-bottom: 8px;
  }
  .pair dt {
    color: var(--text-dim);
  }
  .pair dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
