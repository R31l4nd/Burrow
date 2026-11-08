<script lang="ts">
  import { inBackground } from '../lib/ui.svelte.js';
  import { untrack } from 'svelte';
  import EditorPane, { type PaneState } from '../components/EditorPane.svelte';
  import Icon from '../components/Icon.svelte';
  import { data, loadAll } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import type { TextFile } from '@burrow/shared';
  import { get } from '../lib/api.js';
  import { go, route, to, up } from '../lib/router.svelte.js';
  import { rememberBase } from '../lib/stackbase.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';
  import { android } from '../lib/android.js';
  import { phoneDir, phonePath, phoneTextSource } from '../lib/phonefiles.js';

  // One file on one host (from Files). Workspaces have the same editor in tabs.
  // Or (phone) a text file of the phone itself, in the Android app (#/edit/phone?p=...).

  let { hostId: hostProp, phone = false }: { hostId: number; phone?: boolean } = $props();
  const hostId = untrack(() => hostProp);
  const onPhone = untrack(() => phone);
  const path = untrack(() => (onPhone ? phonePath(route.query.p) : (route.query.p ?? '')));
  // Opened to read (the file's menu): not saved even where the phone would let it.
  const source = onPhone && android ? phoneTextSource(android, path, untrack(() => route.query.ro === '1')) : undefined;
  const name = path.split('/').pop() ?? path;
  // Opened from a stack: a way to review and deploy it from here.
  const stack = untrack(() => (onPhone ? null : (route.query.stack ?? null)));
  if (stack) void get<TextFile>(`/api/files/${untrack(() => hostProp)}/text?path=${encodeURIComponent(path)}`).then((f) => rememberBase(untrack(() => hostProp), path, f.content, f.hash), () => {});

  let pane: EditorPane | undefined = $state();
  let st = $state<PaneState>({ dirty: false, lang: '', lsp: false, sudo: false, errors: 0, warnings: 0, notes: 0, rev: 0 });
  const host = $derived(data.hosts.find((h) => h.id === hostId));
  if (!data.loaded) inBackground(loadAll());

  // Asked before another page or a reload loses unsaved work (Back, the
  // rail, the browser's history alike); this file's own route stays.
  warnUnsaved(() => pane?.isDirty() ?? st.dirty);

  const folder = () => (onPhone ? to('/files/phone', { p: phoneDir(path) }) : to(`/files/${hostId}`, { p: path.slice(0, path.lastIndexOf('/')) || '/' }));

  // Saved first; typed while that save was on its way: asked like any leave.
  async function toDeploy() {
    if (st.dirty && !(await pane?.save())) return;
    go(to(`/stacks/${hostId}/${encodeURIComponent(stack!)}`, { review: '1' }));
  }

  // Up: to the stack it was opened from, else to its folder in Files.
  const leave = () => up(stack ? `/stacks/${hostId}/${encodeURIComponent(stack)}` : folder());
</script>

<div class="editor-page">
  <header class="bar appbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={leave}><Icon name="back" /></button>
    <div class="title">
      <span class="name" data-testid="editor-title">{#if st.dirty}<span class="dirty-dot" role="img" aria-label={t('common.unsaved')} title={t('common.unsaved')} data-testid="dirty"></span>{/if}{name}</span>
      <span class="dim small">{onPhone ? t('phone.thisPhone') : (host?.name ?? '')} | {st.lang}{st.lsp ? ' | LSP' : ''}{st.sudo ? ' | sudo' : ''}</span>
    </div>
{#if (st.errors ?? 0) + (st.warnings ?? 0) > 0}
      <button class="probs-badge" class:bad={st.errors > 0} onclick={() => pane?.openProblems()} aria-label={t('editor.problems', { e: st.errors, w: st.warnings, i: st.notes })} title={t('editor.problems', { e: st.errors, w: st.warnings, i: st.notes })} data-testid="problems-badge">
        <Icon name="alert" size={16} />{st.errors + st.warnings}
      </button>
    {/if}
    <button class="icon-btn" aria-label={t('editor.tools')} title={t('editor.tools')} onclick={() => pane?.openTools()} data-testid="editor-menu"><Icon name="more" /></button>
    <button class="icon-btn" aria-label={t('editor.save')} title={t('editor.save')} disabled={!st.dirty} onclick={() => pane?.save()} data-testid="save"><Icon name="save" /></button>
    {#if stack}<button class="btn small primary" onclick={toDeploy} data-testid="to-deploy">{t('stack.deploy')}</button>{/if}
  </header>
  {#if onPhone && !source}
    <p class="empty">{t('phone.onlyApp')}</p>
  {:else}
    <EditorPane bind:this={pane} {hostId} {path} {source} onstate={(s) => (st = s)} ongone={() => up(folder())} />
  {/if}
</div>

<style>
  .editor-page {
    position: fixed;
    /* Beside the narrow rail on a computer (none on a phone). */
    inset: 0 0 0 var(--rail-w);
    display: flex;
    flex-direction: column;
    background: var(--bg);
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name,
  .title .small {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    font-weight: 700;
  }
  /* Buttons are full width by default: here they take only their own room,
     or the file's name gets none (it did, beside "Deploy"). */
  .bar :global(.btn) {
    width: auto;
    flex: none;
  }
</style>
