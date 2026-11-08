<script lang="ts">
  import type { Host, Snippet } from '@burrow/shared';
  import { fillSnippet, snippetDefaults, snippetReady, snippetVariables } from '@burrow/shared/snippets';
  import SnippetFields from './SnippetFields.svelte';
  import { errorMessage, get } from '../lib/api.js';
  import { data } from '../lib/data.svelte.js';
  import { snippetsFor } from '../lib/snippetscope.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { toast } from '../lib/ui.svelte.js';

  // Pick a snippet for this host (global, the host's own, or its groups'),
  // fill in its variables, then paste it or run it.
  let { host, onuse }: { host: Host | null; onuse: (command: string, run: boolean) => void } = $props();

  let all = $state<Snippet[]>([]);
  let chosen = $state<Snippet | null>(null);
  let values = $state<Record<string, string>>({});

  get<Snippet[]>('/api/snippets')
    .then((s) => (all = s))
    .catch((err: unknown) => toast(errorMessage(err), 'error'));

  const usable = $derived(snippetsFor(all, host, data.groups));
  const vars = $derived(chosen ? snippetVariables(chosen.command) : []);
  const ready = $derived(snippetReady(vars, values));
  const command = $derived(chosen ? fillSnippet(chosen.command, values) : '');

  function pick(s: Snippet) {
    chosen = s;
    values = snippetDefaults(snippetVariables(s.command));
  }
</script>

{#if !chosen}
  {#if usable.length === 0}
    <p class="empty">{t('snippets.none')}</p>
  {:else}
    <div class="list">
      {#each usable as s (s.id)}
        <button class="list-item" onclick={() => pick(s)}>
          <span class="main">
            <span class="title">{s.name}</span>
            <span class="sub mono">{s.command}</span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
  <button class="btn" onclick={() => go('/settings/snippets')}>{t('snippets.manage')}</button>
{:else}
  <p class="mono small">{command}</p>
  <SnippetFields {vars} bind:values hostIds={host ? [host.id] : []} />
  <button class="btn primary" disabled={!ready} onclick={() => onuse(command, true)}>{t('snippets.run')}</button>
  <button class="btn" disabled={!ready} onclick={() => onuse(command, false)}>{t('snippets.paste')}</button>
  <button class="btn" onclick={() => (chosen = null)}>{t('common.back')}</button>
{/if}
