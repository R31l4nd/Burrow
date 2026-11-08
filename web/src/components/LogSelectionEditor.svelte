<script lang="ts">
  import { LEVEL_PICKS, type LevelPick, type LogRule, type LogSelection } from '@burrow/shared';
  import Icon from './Icon.svelte';
  import { data } from '../lib/data.svelte.js';
  import { t } from '../lib/i18n/index.svelte.js';

  // Which log lines are read: one rule for everything, and exceptions for a
  // host, a stack or a container (the most specific one counts). Simple to
  // start with (one line), as detailed as needed.

  let { value = $bindable(), stacks = [], containers = [] }: { value: LogSelection; stacks?: string[]; containers?: string[] } = $props();

  const dockerHosts = $derived(data.hosts.filter((h) => h.facts?.hasDocker));
  type Kind = 'host' | 'stack' | 'container';
  // A name not typed yet ("") still makes it a stack or container rule.
  const kindOf = (r: LogRule): Kind => (r.target?.container != null ? 'container' : r.target?.project != null ? 'stack' : 'host');

  function toggleLevel(r: LogRule, l: LevelPick) {
    const on = r.levels.includes(l);
    // At least one level: the last one cannot be switched off.
    if (on && r.levels.length === 1) return;
    r.levels = on ? r.levels.filter((x) => x !== l) : [...r.levels, l];
  }
  function add() {
    value.rules = [...value.rules, { target: { hostId: dockerHosts[0]?.id ?? null, project: null, container: null }, window: { ...value.rules[0]!.window }, levels: [...value.rules[0]!.levels], skip: false }];
  }
  function setKind(r: LogRule, k: Kind) {
    r.target = { hostId: k === 'host' ? (dockerHosts[0]?.id ?? null) : null, project: k === 'stack' ? (stacks[0] ?? '') : null, container: k === 'container' ? (containers[0] ?? '') : null };
  }
  const levelLabel = (l: LevelPick) => (l === 'none' ? t('logs.noLevel') : t(`logs.level.${l}`));
</script>

{#snippet ruleBody(r: LogRule)}
  <!-- Side by side only with the number beside it: alone, the choice gets the whole width. -->
  <div class:grid2={r.window.kind === 'lines' || r.window.kind === 'hours'}>
    <label class="field">
      <span>{t('logsel.window')}</span>
      <select bind:value={r.window.kind} data-testid="logsel-window">
        <option value="since_last">{t('logsel.window.since_last')}</option>
        <option value="lines">{t('logsel.window.linesPick')}</option>
        <option value="hours">{t('logsel.window.hoursPick')}</option>
        <option value="since_start">{t('logsel.window.since_start')}</option>
      </select>
    </label>
    {#if r.window.kind === 'lines' || r.window.kind === 'hours'}
      <label class="field">
        <span>{r.window.kind === 'lines' ? t('logsel.lines') : t('logsel.hours')}</span>
        <input type="number" min="1" max="100000" bind:value={r.window.n} required data-testid="logsel-n" />
      </label>
    {/if}
  </div>
  <div class="chips" role="group" aria-label={t('logsel.levels')}>
    {#each LEVEL_PICKS as l (l)}
      <button type="button" class="chip" class:off={!r.levels.includes(l)} aria-pressed={r.levels.includes(l)} onclick={() => toggleLevel(r, l)} data-testid="logsel-level">{levelLabel(l)}</button>
    {/each}
  </div>
{/snippet}

<div class="stack" data-testid="logsel">
  <div class="card stack rule">
    <strong class="small">{t('logsel.default')}</strong>
    <label class="check"><input type="checkbox" bind:checked={value.rules[0]!.skip} data-testid="logsel-only-below" /> {t('logsel.onlyBelow')}</label>
    {#if !value.rules[0]!.skip}{@render ruleBody(value.rules[0]!)}{/if}
  </div>
  {#each value.rules.slice(1) as r, i (i)}
    <div class="card stack rule" data-testid="logsel-rule">
      <div class="row head">
        <select value={kindOf(r)} onchange={(e) => setKind(r, e.currentTarget.value as Kind)} aria-label={t('logsel.for')} data-testid="logsel-kind">
          <option value="host">{t('logsel.kind.host')}</option>
          <option value="stack">{t('logsel.kind.stack')}</option>
          <option value="container">{t('logsel.kind.container')}</option>
        </select>
        <button type="button" class="icon-btn" aria-label={t('common.delete')} title={t('common.delete')} onclick={() => (value.rules = value.rules.filter((x) => x !== r))} data-testid="logsel-remove"><Icon name="trash" size={18} /></button>
      </div>
      {#if kindOf(r) === 'host'}
        <select bind:value={r.target!.hostId} aria-label={t('logsel.kind.host')} data-testid="logsel-host">
          {#each dockerHosts as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
        </select>
      {:else}
        <!-- The same name can be on several hosts: which one, or all of them. -->
        <div class="grid2">
          {#if kindOf(r) === 'stack'}
            <input bind:value={r.target!.project} list="logsel-stacks" required autocapitalize="none" spellcheck="false" aria-label={t('logsel.kind.stack')} data-testid="logsel-name" />
          {:else}
            <input bind:value={r.target!.container} list="logsel-containers" required autocapitalize="none" spellcheck="false" aria-label={t('logsel.kind.container')} data-testid="logsel-name" />
          {/if}
          <select bind:value={r.target!.hostId} aria-label={t('logsel.onHost')} data-testid="logsel-on-host">
            <option value={null}>{t('logsel.anyHost')}</option>
            {#each dockerHosts as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
          </select>
        </div>
      {/if}
      <label class="check"><input type="checkbox" bind:checked={r.skip} data-testid="logsel-skip" /> {t('logsel.skip')}</label>
      {#if !r.skip}{@render ruleBody(r)}{/if}
    </div>
  {/each}
  <button type="button" class="btn small" onclick={add} data-testid="logsel-add"><Icon name="plus" size={16} /> {t('logsel.add')}</button>
  <datalist id="logsel-stacks">{#each stacks as s (s)}<option value={s}></option>{/each}</datalist>
  <datalist id="logsel-containers">{#each containers as c (c)}<option value={c}></option>{/each}</datalist>
</div>

<style>
  .rule {
    padding: 12px;
  }
  .head select {
    flex: 1;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text);
    font: 600 0.8rem var(--font);
    cursor: pointer;
  }
  /* Off: struck through and plain, still readable (no fading). */
  .chip.off {
    color: var(--text-dim);
    background: transparent;
    border-style: dashed;
    text-decoration: line-through;
  }
  .chip[aria-pressed='true'] {
    border-color: var(--accent);
  }
</style>
