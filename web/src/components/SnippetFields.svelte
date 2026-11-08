<script lang="ts">
  import type { HostContainers } from '@burrow/shared';
  import type { SnippetVariable } from '@burrow/shared/snippets';
  import { get } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';

  // A snippet's variables to fill in: a list for {{name=a|b}}, the running
  // containers of the chosen hosts offered for {{container}}, a free field
  // for the rest (lib: shared/src/snippets.ts).
  let { vars, values = $bindable(), hostIds }: { vars: SnippetVariable[]; values: Record<string, string>; hostIds: number[] } = $props();

  let containers = $state<string[]>([]);
  const wantsContainers = $derived(vars.some((v) => v.name === 'container' && !v.choices.length));
  $effect(() => {
    const ids = [...hostIds];
    if (!wantsContainers || !ids.length) {
      containers = [];
      return;
    }
    let live = true;
    Promise.allSettled(ids.slice(0, 10).map((id) => get<HostContainers>(`/api/docker/${id}/containers`))).then((rs) => {
      if (!live) return;
      const names = new Set<string>();
      for (const r of rs) if (r.status === 'fulfilled') for (const c of r.value.containers) if (c.state === 'running') names.add(c.name);
      containers = [...names].sort((a, b) => a.localeCompare(b));
    });
    return () => (live = false);
  });
  const listId = `snippet-containers-${Math.random().toString(36).slice(2, 8)}`;
</script>

{#each vars as v (v.name)}
  <label class="field">
    <span>{v.optional ? `${v.name} (${t('common.optional')})` : v.name}</span>
    {#if v.choices.length}
      <select bind:value={values[v.name]} data-testid="snippet-var">
        {#each v.choices as c (c)}<option value={c}>{c}</option>{/each}
      </select>
    {:else}
      <input bind:value={values[v.name]} list={v.name === 'container' && containers.length ? listId : undefined} autocapitalize="none" spellcheck="false" data-testid="snippet-var" />
    {/if}
  </label>
{/each}
{#if containers.length}
  <datalist id={listId}>{#each containers as c (c)}<option value={c}></option>{/each}</datalist>
{/if}
