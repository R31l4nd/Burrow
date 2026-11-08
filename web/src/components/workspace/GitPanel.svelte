<script lang="ts">
  import LoadFailed from '../LoadFailed.svelte';
  import { session } from '../../lib/session.svelte.js';
  import { editorSetup } from '../../lib/editor/setup.js';
  import { EditorView } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { unifiedMergeView } from '@codemirror/merge';
  import { burrowEditorTheme, editorLabel } from '../../lib/editor/theme.js';
  import type { GitFile, GitStatus, TextFile, Workspace } from '@burrow/shared';
  import { ApiFailure, errorMessage, get, post, put } from '../../lib/api.js';
  import { t } from '../../lib/i18n/index.svelte.js';
  import { toast } from '../../lib/ui.svelte.js';
  import { ask } from '../../lib/confirm.svelte.js';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  // Basic git, run on the host: what changed, the diff, stage and unstage,
  // commit, pull and push. When git does not know who commits on that host,
  // a name and e-mail are asked once and kept with the workspace.

  let {
    workspace,
    root: rootProp = null,
    status,
    error = '',
    onchanged,
    onopen,
  }: {
    workspace: Workspace;
    /** The folder whose repository this is (one of the workspace's; its root by default). */
    root?: string | null;
    status: GitStatus | null;
    /** The status could not be read: said, not "no repository" (AUDIT2 PAGE-08). */
    error?: string;
    /** Status changed (after stage, commit, pull): read it again. */
    onchanged: () => void;
    onopen: (relPath: string) => void;
  } = $props();
  const root = $derived(rootProp ?? workspace.root);

  let message = $state('');
  let busy = $state(false);
  let diffFor = $state<(GitFile & { side: 'index' | 'worktree' }) | null>(null);
  let diffEl: HTMLDivElement | undefined = $state();
  let diffError = $state('');
  let identityOpen = $state(false);
  let idName = $state('');
  let idEmail = $state('');
  let retry: (() => Promise<void>) | null = null;

  const q = (p: string) => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`;
  const staged = $derived((status?.files ?? []).filter((f) => f.index !== ' ' && f.index !== '?'));
  const unstaged = $derived((status?.files ?? []).filter((f) => f.worktree !== ' ' || f.index === '?'));

  async function act(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'git_identity') {
        idName = workspace.gitName ?? '';
        idEmail = workspace.gitEmail ?? '';
        retry = fn;
        identityOpen = true;
      } else toast(errorMessage(err), 'error');
    } finally {
      busy = false;
      onchanged();
    }
  }

  const stage = (paths: string[]) => act(() => post(`/api/workspace/${workspace.hostId}/git/stage`, { root: root, paths }));
  // A rename is two names in the index: both back (AUDIT2 FS-06).
  const namesOf = (f: GitFile) => (f.oldPath ? [f.path, f.oldPath] : [f.path]);
  // Thrown away (VS Code's Discard Changes): asked first, it cannot be undone.
  async function discard(paths: string[]) {
    const text = paths.length === 1 ? t('ws.discardAsk', { name: paths[0]! }) : t('ws.discardAllAsk', { n: paths.length });
    if (!(await ask({ text, confirm: t('ws.discard'), danger: true }))) return;
    await act(() => post(`/api/workspace/${workspace.hostId}/git/discard`, { root, paths }));
  }

  // Another branch: the list asked for when the branch is tapped.
  let branchesOpen = $state(false);
  let branches = $state<{ current: string | null; branches: string[] } | null>(null);
  async function openBranches() {
    branches = null;
    branchesOpen = true;
    try {
      branches = await get(`/api/workspace/${workspace.hostId}/git/branches?root=${encodeURIComponent(root)}`);
    } catch (err) {
      branchesOpen = false;
      toast(errorMessage(err), 'error');
    }
  }
  async function checkout(branch: string) {
    branchesOpen = false;
    await act(() => post(`/api/workspace/${workspace.hostId}/git/checkout`, { root, branch }));
  }

  const unstage = (paths: string[]) => act(() => post(`/api/workspace/${workspace.hostId}/git/unstage`, { root: root, paths }));

  const commit = () =>
    act(async () => {
      await post(`/api/workspace/${workspace.hostId}/git/commit`, { root: root, message });
      message = '';
      toast(t('ws.committed'));
    });

  const sync = (op: 'pull' | 'push') =>
    act(async () => {
      const r = await post<{ output: string }>(`/api/workspace/${workspace.hostId}/git/${op}`, { root: root });
      toast(r.output.split('\n').pop() || t(op === 'pull' ? 'ws.pulled' : 'ws.pushed'));
    });

  async function saveIdentity(e: SubmitEvent) {
    e.preventDefault();
    const w = await put<Workspace>(`/api/workspaces/${workspace.id}`, { gitName: idName, gitEmail: idEmail });
    workspace.gitName = w.gitName;
    workspace.gitEmail = w.gitEmail;
    identityOpen = false;
    if (retry) await act(retry);
    retry = null;
  }

  // The diff of a staged change: the last commit against the index (what a
  // commit writes); of an unstaged one: the index against the disk.
  $effect(() => {
    if (!diffEl || !diffFor) return;
    const f = diffFor;
    const staged = f.side === 'index';
    const host = diffEl;
    let v: EditorView | null = null;
    let gone = false;
    diffError = '';
    void (async () => {
      // A side that could not be read is said, not shown as empty: that read as the whole file
      // deleted or new (AUDIT2 UI-12). Only a deleted or new file has an empty side.
      let head: { exists: boolean; content: string };
      let now: string;
      const version = (rev: 'HEAD' | 'index') => get<{ exists: boolean; content: string }>(`/api/workspace/${workspace.hostId}/git/head?${q(f.path)}&rev=${rev}`);
      try {
        if (staged) {
          head = f.index === 'A' ? { exists: false, content: '' } : await version('HEAD');
          now = f.index === 'D' ? '' : (await version('index')).content;
        } else {
          head = f.index === '?' ? { exists: false, content: '' } : await version('index');
          now = f.worktree === 'D' ? '' : (await get<TextFile>(`/api/files/${workspace.hostId}/text?path=${encodeURIComponent(`${root}/${f.path}`)}`)).content;
        }
      } catch (err) {
        if (!gone) diffError = errorMessage(err);
        return;
      }
      if (gone) return;
      v = new EditorView({
        parent: host,
        state: EditorState.create({ doc: now, extensions: [editorSetup(), burrowEditorTheme, editorLabel(f.path), EditorView.editable.of(false), EditorView.lineWrapping, unifiedMergeView({ original: head.content, mergeControls: false })] }),
      });
    })();
    return () => {
      gone = true;
      v?.destroy();
    };
  });

  const letter = (f: GitFile, side: 'index' | 'worktree') => (f.index === '?' ? 'U' : f[side]);
  const admin = $derived(session.state?.user?.role === 'admin');
</script>

{#if error}
  <div class="pad"><LoadFailed message={error} onretry={onchanged} /></div>
{:else if !status}
  <p class="dim small pad">{t('common.loading')}</p>
{:else if !status.repo}
  <p class="dim small pad">{t('ws.noRepo')}</p>
{:else}
  <div class="head">
    {#if admin}
      <button class="branch linkish" title={t('ws.branches')} onclick={openBranches} data-testid="git-branch"><Icon name="link" size={14} /> {status.branch ?? '?'}</button>
    {:else}
      <span class="branch" data-testid="git-branch"><Icon name="link" size={14} /> {status.branch ?? '?'}</span>
    {/if}
    {#if status.upstream}<span class="dim small" title={t('ws.aheadBehind', { ahead: status.ahead, behind: status.behind })}><Icon name="arrow-up" size={12} />{status.ahead} <Icon name="arrow-down" size={12} />{status.behind}</span>{/if}
    <span class="spacer"></span>
    {#if admin}
      <button class="icon-btn" title={t('ws.pull')} aria-label={t('ws.pull')} disabled={busy} onclick={() => sync('pull')}><Icon name="download" size={16} /></button>
      <button class="icon-btn" title={t('ws.push')} aria-label={t('ws.push')} disabled={busy} onclick={() => sync('push')}><Icon name="upload" size={16} /></button>
    {/if}
    <button class="icon-btn" title={t('apps.reload')} aria-label={t('apps.reload')} disabled={busy} onclick={onchanged}><Icon name="reload" size={16} /></button>
  </div>

  {#if admin}
  <form
    class="commit stack"
    onsubmit={(e) => {
      e.preventDefault();
      void commit();
    }}
  >
    <textarea bind:value={message} rows="2" placeholder={t('ws.commitMessage')} aria-label={t('ws.commitMessage')} data-testid="commit-message"></textarea>
    <button class="btn small primary" disabled={busy || !message.trim() || !staged.length} data-testid="commit">{t('ws.commit', { n: staged.length })}</button>
  </form>
  {/if}

  {#each [{ title: t('ws.staged'), list: staged, side: 'index' as const }, { title: t('ws.changes'), list: unstaged, side: 'worktree' as const }] as sec (sec.title)}
    {#if sec.list.length}
      <div class="sec">
        <span>{sec.title} ({sec.list.length})</span>
        {#if !admin}
          <span></span>
        {:else if sec.side === 'worktree'}
          <span class="secbtns">
            <button class="icon-btn" aria-label={t('ws.discardAll')} title={t('ws.discardAll')} disabled={busy} onclick={() => discard(sec.list.map((f) => f.path))} data-testid="git-discard-all"><Icon name="undo" size={16} /></button>
            <button class="btn small" disabled={busy} onclick={() => stage(sec.list.map((f) => f.path))}>{t('ws.stageAll')}</button>
          </span>
        {:else}
          <button class="btn small" disabled={busy} onclick={() => unstage(sec.list.flatMap(namesOf))}>{t('ws.unstageAll')}</button>
        {/if}
      </div>
      {#each sec.list as f (sec.side + f.path)}
        <div class="gfile" data-testid="git-file">
          <button class="gname" onclick={() => (diffFor = { ...f, side: sec.side })} title={t('ws.diff')}>
            <span class="st st-{letter(f, sec.side).toLowerCase()}">{letter(f, sec.side)}</span>
            <span class="p">{f.path}</span>
          </button>
          {#if !admin}
            <span></span>
          {:else if sec.side === 'worktree'}
            <span class="secbtns">
              <button class="icon-btn" aria-label={t('ws.discardOne', { name: f.path })} title={t('ws.discard')} disabled={busy} onclick={() => discard([f.path])} data-testid="git-discard"><Icon name="undo" size={16} /></button>
              <button class="icon-btn" aria-label={t('ws.stage')} title={t('ws.stage')} disabled={busy} onclick={() => stage([f.path])}><Icon name="plus" size={16} /></button>
            </span>
          {:else}
            <button class="icon-btn" aria-label={t('ws.unstage')} title={t('ws.unstage')} disabled={busy} onclick={() => unstage(namesOf(f))}><Icon name="minus" size={16} /></button>
          {/if}
        </div>
      {/each}
    {/if}
  {/each}
  {#if !status.files.length}<p class="dim small pad">{t('ws.clean')}</p>{/if}
{/if}

<Dialog tour="git-diff" size="wide" open={diffFor !== null} title={diffFor?.path ?? ''} onclose={() => (diffFor = null)}>
  {#if diffError}<p class="alert error small" data-testid="git-diff-error">{diffError}</p>{/if}
  <div class="diff" bind:this={diffEl} data-testid="git-diff" data-private></div>
  {#snippet actions()}
    <button class="btn" onclick={() => (diffFor && onopen(diffFor.path), (diffFor = null))}>{t('ws.openFile')}</button>
    <button class="btn" onclick={() => (diffFor = null)}>{t('common.close')}</button>
  {/snippet}
</Dialog>

<Dialog tour="git-branches" menu bind:open={branchesOpen} title={t('ws.branches')}>
  <div class="stack" data-testid="git-branches">
    {#if !branches}
      <p class="dim small">{t('common.loading')}</p>
    {:else}
      {#each branches.branches as b (b)}
        <button class="btn" disabled={b === branches.current} aria-current={b === branches.current ? 'true' : undefined} onclick={() => checkout(b)} data-testid="git-branch-item">{b}</button>
      {/each}
      <p class="dim small">{t('ws.branchesHelp')}</p>
    {/if}
  </div>
</Dialog>

<Dialog tour="git-identity" bind:open={identityOpen} dirty={() => idName !== (workspace.gitName ?? '') || idEmail !== (workspace.gitEmail ?? '')} title={t('ws.identity')}>
  <form id="git-id" class="stack" onsubmit={saveIdentity}>
    <p class="small dim">{t('ws.identityHelp')}</p>
    <label class="field"><span>{t('ws.identityName')}</span><input bind:value={idName} required autocomplete="name" /></label>
    <label class="field"><span>{t('ws.identityEmail')}</span><input bind:value={idEmail} type="email" required autocomplete="email" /></label>
  </form>
  {#snippet actions()}
    <button class="btn" onclick={() => (identityOpen = false)}>{t('common.cancel')}</button>
    <button class="btn primary" form="git-id">{t('common.save')}</button>
  {/snippet}
</Dialog>

<style>
  .pad {
    padding: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
  }
  .secbtns {
    display: inline-flex;
    gap: 4px;
  }
  .linkish {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .branch {
    font-weight: 700;
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }
  .commit {
    padding: 0 8px 8px;
  }
  .commit textarea {
    min-height: 56px;
    font-family: var(--font);
  }
  .sec {
    display: flex;
    justify-content: space-between;
    padding: 8px 8px 4px;
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .link {
    font-size: 0.8rem;
    text-transform: none;
  }
  .gfile {
    display: flex;
    align-items: center;
  }
  .gname {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 8px;
    border: 0;
    background: none;
    color: var(--text);
    font: 0.85rem var(--font);
    text-align: left;
    cursor: pointer;
  }
  @media (hover: hover) {
    .gname:hover {
      background: var(--bg-hover);
    }
  }
  .p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    flex: none;
    font: 700 0.75rem var(--mono);
    width: 1em;
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
  .diff {
    max-height: 60dvh;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    min-height: 80px;
  }
</style>
