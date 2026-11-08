<script lang="ts">
  import Fuse from 'fuse.js';
  import { errorMessage, get } from '../../lib/api.js';
  import { t } from '../../lib/i18n/index.svelte.js';
  import Dialog from '../Dialog.svelte';

  // Ctrl+P: go to any file of the workspace by typing a few letters of its
  // name or path, in every folder of it (it searched the one chosen for Git
  // and search only). "name:12" goes to line 12, as in VS Code.

  let { open = $bindable(false), hostId, roots, onopen }: { open?: boolean; hostId: number; roots: string[]; onopen: (fullPath: string, line?: number) => void } = $props();

  // Each file by its path from its folder; the other folders' by their name first.
  interface Item {
    full: string;
    shown: string;
  }
  let files = $state<Item[]>([]);
  let loaded = $state(false);
  let partial = $state<string | null>(null);
  let query = $state('');
  let selected = $state(0);
  let input: HTMLInputElement | undefined = $state();
  // Enter before the list arrived (typed fast): done once it is there.
  let pendingEnter = false;

  // Each opening reads its own folder's list; a list that comes after the dialog closed,
  // or for a folder chosen before, is dropped, and with it an Enter still waiting (AUDIT2 UI-14).
  let opening = 0;
  let loadError = $state('');
  $effect(() => {
    if (!open) {
      opening++;
      pendingEnter = false;
      return;
    }
    const mine = ++opening;
    query = '';
    selected = 0;
    setTimeout(() => input?.focus(), 30);
    files = [];
    loaded = false;
    loadError = '';
    pendingEnter = false;
    partial = null;
    Promise.all(
      roots.map((root, n) =>
        get<{ files: string[]; truncated?: boolean; slow?: boolean }>(`/api/workspace/${hostId}/files?root=${encodeURIComponent(root)}`).then((r) => ({
          ...r,
          items: r.files.map((f) => ({ full: `${root.replace(/\/+$/, '')}/${f}`, shown: n === 0 ? f : `${root.split('/').pop() || root}/${f}` })),
        })),
      ),
    ).then(
      (all) => {
        if (mine !== opening) return;
        files = all.flatMap((r) => r.items);
        // Not every file (a huge folder): said, so a name not found is not taken for "not there".
        partial = all.some((r) => r.slow) ? t('ws.partialSlow') : all.some((r) => r.truncated) ? t('ws.partialMany', { n: files.length }) : null;
        loaded = true;
        if (pendingEnter) queueMicrotask(() => pick(results[0]));
      },
      (err: unknown) => {
        if (mine === opening) loadError = errorMessage(err);
      },
    );
  });

  // "compose.yaml:12": the file, then line 12.
  const asked = $derived.by(() => {
    const m = /^(.*?):(\d+)$/.exec(query.trim());
    return m ? { name: m[1]!, line: Number(m[2]) } : { name: query.trim(), line: undefined };
  });
  const fuse = $derived(new Fuse(files, { keys: ['shown'], threshold: 0.4, ignoreLocation: true }));
  const results = $derived(asked.name ? fuse.search(asked.name, { limit: 50 }).map((r) => r.item) : files.slice(0, 50));

  function pick(p: Item | undefined) {
    if (!p) return;
    open = false;
    onopen(p.full, asked.line);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') selected = Math.min(selected + 1, results.length - 1);
    else if (e.key === 'ArrowUp') selected = Math.max(selected - 1, 0);
    else if (e.key === 'Enter') {
      if (loaded) pick(results[selected]);
      else pendingEnter = true;
    }
    else return;
    e.preventDefault();
  }
</script>

<Dialog tour="quick-open" bind:open title={t('ws.quickOpen')}>
  <input
    bind:this={input}
    bind:value={query}
    type="search"
    placeholder={t('ws.quickOpenPlaceholder')}
    aria-label={t('ws.quickOpenPlaceholder')}
    autocapitalize="none"
    spellcheck="false"
    onkeydown={onKey}
    oninput={() => (selected = 0)}
    data-testid="quick-open"
  />
  <div class="list qo">
    {#each results as p, i (p.full)}
      <button class="list-item" class:sel={i === selected} onclick={() => pick(p)}>
        <span class="main"><span class="title">{p.shown.split('/').pop()}</span><span class="sub">{p.shown}</span></span>
      </button>
    {/each}
    {#if loadError}<p class="alert error small">{loadError}</p>
    {:else if loaded && !results.length}<p class="dim small">{t('ws.noFiles')}</p>{/if}
  </div>
  {#if partial}<p class="dim small" data-testid="quick-open-partial">{partial}</p>{/if}
</Dialog>

<style>
  .qo {
    margin-top: 8px;
    max-height: 50dvh;
    overflow: auto;
  }
  .sel {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  /* The dim path line stays readable on the tinted, chosen row. */
  .sel :global(.sub) {
    color: var(--text);
  }
</style>
