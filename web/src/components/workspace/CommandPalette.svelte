<script lang="ts">
  import { findCommands, usedNow, type Command } from '../../lib/commands.js';
  import { t } from '../../lib/i18n/index.svelte.js';
  import Dialog from '../Dialog.svelte';

  // F1 or Ctrl+Shift+P in a workspace: every command of the workspace and of
  // the file in front, by a few letters of its name (lib/commands.ts).

  let { open = $bindable(false), commands }: { open?: boolean; commands: () => Command[] } = $props();

  const RECENT_KEY = 'burrow.ws.commands';
  const readRecent = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  };

  let query = $state('');
  let selected = $state(0);
  let input: HTMLInputElement | undefined = $state();
  // Read when it opens: what the file in front can do now.
  let list = $state<Command[]>([]);
  let recent = $state<string[]>([]);
  $effect(() => {
    if (!open) return;
    query = '';
    selected = 0;
    list = commands();
    recent = readRecent();
    setTimeout(() => input?.focus(), 30);
  });
  const results = $derived(findCommands(list, query, recent).slice(0, 50));

  function run(c: Command | undefined) {
    if (!c) return;
    open = false;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(usedNow(readRecent(), c.id)));
    } catch {
      // No storage: no order of last used.
    }
    // After the dialog is gone: a command may open one of its own.
    setTimeout(c.run, 0);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') selected = Math.min(selected + 1, results.length - 1);
    else if (e.key === 'ArrowUp') selected = Math.max(selected - 1, 0);
    else if (e.key === 'Enter') run(results[selected]);
    // Closed at once: a search field's Escape only empties it first.
    else if (e.key === 'Escape') open = false;
    else return;
    e.preventDefault();
  }
</script>

<Dialog tour="command-palette" bind:open title={t('ws.commands')}>
  <input
    bind:this={input}
    bind:value={query}
    type="search"
    placeholder={t('ws.commandsPlaceholder')}
    aria-label={t('ws.commandsPlaceholder')}
    autocapitalize="none"
    spellcheck="false"
    onkeydown={onKey}
    oninput={() => (selected = 0)}
    data-testid="command-palette"
  />
  <div class="list cmds">
    {#each results as c, i (c.id)}
      <button class="list-item" class:sel={i === selected} onclick={() => run(c)} data-testid="command">
        <span class="main"><span class="title">{c.title}</span></span>
        {#if c.keys}<kbd class="dim small">{c.keys}</kbd>{/if}
      </button>
    {/each}
    {#if !results.length}<p class="dim small">{t('ws.noCommands')}</p>{/if}
  </div>
</Dialog>

<style>
  .cmds {
    margin-top: 8px;
    max-height: 50dvh;
    overflow: auto;
  }
  .sel {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  kbd {
    font-family: inherit;
    white-space: nowrap;
  }
</style>
