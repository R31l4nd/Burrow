<script lang="ts">
  import type { DirListing, FileEntry } from '@burrow/shared';
  import { errorMessage, get } from '../../lib/api.js';
  import { t } from '../../lib/i18n/index.svelte.js';
  import { keepFresh } from '../../lib/keepfresh.js';
  import { toast } from '../../lib/ui.svelte.js';
  import { dragsFiles, droppedFiles, uploadInto } from '../../lib/uploadinto.js';
  import Icon from '../Icon.svelte';

  // The workspace's folders, opened one level at a time, with git's status
  // on files (and a dot on folders that contain changes).

  let {
    hostId,
    root,
    changes,
    current,
    onopen,
    onmenu,
    upload = false,
  }: {
    hostId: number;
    root: string;
    /** Relative path -> status letter (M, A, D, ?, R). */
    changes: Record<string, string>;
    current: string | null;
    /** A click opens a file as a preview (in the place of the one before), a double click to keep (VS Code's way, report 96a655). */
    onopen: (relPath: string, keep: boolean) => void;
    /** Right click (or a long press): the file's menu, as in Files. */
    onmenu?: (e: FileEntry) => void;
    /** Files dropped from the computer go up to the folder they land on (report 6d86aa); an admin's. */
    upload?: boolean;
  } = $props();

  let children = $state<Record<string, FileEntry[]>>({});
  let open = $state<Set<string>>(new Set(['']));
  let loading = $state<Set<string>>(new Set());
  // A folder that could not be read says why (it looked empty before).
  let failed = $state<Record<string, string>>({});

  const rel = (abs: string) => abs.slice(root.length).replace(/^\//, '');
  const isDir = (e: FileEntry) => e.type === 'dir' || (e.type === 'link' && e.targetType === 'dir');

  const sig = (list: FileEntry[] | undefined) => (list ?? []).map((e) => `${e.name}|${e.type}|${e.size}|${e.mtime}`).join('\n');

  /** quiet: read again in the background, the tree left as it is when nothing changed or the read failed. */
  async function load(relDir: string, quiet = false) {
    if (loading.has(relDir)) return;
    loading = new Set([...loading, relDir]);
    try {
      const l = await get<DirListing>(`/api/files/${hostId}/list?path=${encodeURIComponent(relDir ? `${root}/${relDir}` : root)}`);
      const next = l.entries
        .filter((e) => e.name !== '.' && e.name !== '..' && e.name !== '.git')
        .sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
      if (sig(next) !== sig(children[relDir])) children[relDir] = next;
      delete failed[relDir];
    } catch (err) {
      if (!quiet) {
        children[relDir] = [];
        failed[relDir] = errorMessage(err);
      }
    } finally {
      loading = new Set([...loading].filter((x) => x !== relDir));
    }
  }
  void load('');

  /** Folders the tree already shows are read again (after a save, a git action, or now and then by itself). */
  export function refresh(quiet = false) {
    for (const d of Object.keys(children)) if (d === '' || open.has(d)) void load(d, quiet);
  }
  // Files made elsewhere (the panel's terminal, another program) show up without a reload (report 905455).
  $effect(() => keepFresh(() => refresh(true)));

  // A drop: on a folder into it, on a file into the file's folder, elsewhere into the tree's top.
  let dropAt = $state<string | null>(null);
  const dropRel = (ev: DragEvent) => {
    const node = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-testid=tree-node]');
    if (!node) return '';
    const r = node.dataset.path ?? '';
    return node.dataset.dir ? r : r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
  };
  function onDragOver(ev: DragEvent) {
    if (!upload || !dragsFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    dropAt = dropRel(ev);
  }
  function onDragLeave(ev: DragEvent) {
    if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node | null)) dropAt = null;
  }
  function onDrop(ev: DragEvent) {
    if (!upload || !dragsFiles(ev)) return;
    ev.preventDefault();
    const r = dropRel(ev);
    dropAt = null;
    const files = droppedFiles(ev);
    if (!files.length) return;
    if (r) open = new Set([...open, r]);
    void uploadInto(hostId, r ? `${root}/${r}` : root, files, () => void load(r, true)).catch((err: unknown) => toast(errorMessage(err), 'error'));
  }

  function toggle(e: FileEntry) {
    const r = rel(e.path);
    if (!isDir(e)) return onopen(r, false);
    const n = new Set(open);
    if (n.has(r)) n.delete(r);
    else {
      n.add(r);
      if (!children[r]) void load(r);
    }
    open = n;
  }

  const dirty = (r: string) => Object.keys(changes).some((p) => p.startsWith(`${r}/`));
</script>

{#snippet level(dir: string, depth: number)}
  {#each children[dir] ?? [] as e (e.path)}
    {@const r = rel(e.path)}
    {@const st = changes[r]}
    <button
      class="node"
      class:cur={current === r}
      style:padding-left="{8 + depth * 14}px"
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={current === r}
      aria-expanded={isDir(e) ? open.has(r) : undefined}
      onclick={() => toggle(e)}
      ondblclick={() => !isDir(e) && onopen(r, true)}
      oncontextmenu={(ev) => onmenu && (ev.preventDefault(), onmenu(e))}
      class:droptarget={dropAt !== null && dropAt !== '' && dropAt === r}
      data-testid="tree-node"
      data-path={r}
      data-dir={isDir(e) ? '1' : undefined}
    >
      <span class="chev" aria-hidden="true">{#if isDir(e)}<Icon name={open.has(r) ? 'chevron-down' : 'chevron'} size={14} />{/if}</span>
      <Icon name={isDir(e) ? 'folder' : 'file'} size={16} />
      <span class="nm st-{st === '?' ? 'u' : (st ?? '').toLowerCase()}">{e.name}</span>
      {#if st}<span class="st st-{st === '?' ? 'u' : st.toLowerCase()}" title={t(`ws.status.${st === '?' ? 'u' : st.toLowerCase()}` as 'ws.status.m')}>{st === '?' ? 'U' : st}</span>
      {:else if isDir(e) && dirty(r)}<span class="dot" aria-hidden="true"></span>{/if}
    </button>
    {#if isDir(e) && open.has(r)}
      {#if loading.has(r) && !children[r]}<p role="none" class="dim small" style:padding-left="{30 + depth * 14}px">...</p>{/if}
      {#if failed[r]}<p role="none" class="small bad" style:padding-left="{30 + depth * 14}px" data-testid="tree-error">{failed[r]}</p>{/if}
      {@render level(r, depth + 1)}
    {/if}
  {/each}
{/snippet}

<div class="tree" class:dropping={dropAt === ''} role="tree" aria-label={t('ws.files')} tabindex="-1" ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop}>
  {@render level('', 0)}
  {#if loading.has('') && !children['']}<p role="none" class="dim small pad">{t('common.loading')}</p>{/if}
  {#if failed['']}<p role="none" class="small bad pad" data-testid="tree-error">{failed['']}</p>{/if}
</div>

<style>
  .tree {
    font-size: 0.9rem;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 34px;
    padding-right: 8px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  /* A finger's room on a touch screen (AUDIT2 UX-04). */
  @media (pointer: coarse) {
    .node {
      min-height: 40px;
    }
  }
  @media (hover: hover) {
    .node:hover {
      background: var(--bg-hover);
    }
  }
  .node.cur {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .chev {
    width: 10px;
    color: var(--text-dim);
    flex: none;
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    flex: none;
    font: 700 0.75rem var(--mono);
  }
  .st-m {
    color: var(--warn);
  }
  .st-a,
  .st-u {
    color: var(--ok);
  }
  .st-d {
    color: var(--danger);
  }
  .st-r {
    color: var(--focus);
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
  }
  .pad {
    padding: 8px;
  }
  .bad {
    color: var(--danger);
    margin: 2px 0;
    padding-right: 8px;
    overflow-wrap: anywhere;
  }
  /* Files dragged from the computer: where they would land (report 6d86aa), as in Files. */
  .tree.dropping {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .node.droptarget {
    background: color-mix(in srgb, var(--accent) 14%, var(--bg-raised));
    box-shadow: inset 3px 0 0 var(--accent);
  }
</style>
