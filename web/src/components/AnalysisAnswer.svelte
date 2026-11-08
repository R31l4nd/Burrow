<script lang="ts">
  import { markdownToHtml, splitFences } from '../lib/markdown.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { data } from '../lib/data.svelte.js';
  import Icon from './Icon.svelte';
  import FixRun from './FixRun.svelte';

  // A model's answer about logs, as read in the analysis dialog and on the
  // Reports page: the same look in both. No scroll of its own: the dialog's
  // body is the one that scrolls (report 9abc2b: one scroll bar).
  // Each command in it with Copy, and (an admin, the answer about one host) Run..., as a report's
  // fixes have it: the command shown to change, its risk, nothing run before the button (report a7532e).
  let { text, testid, hostId = null }: { text: string; testid: string; hostId?: number | null } = $props();
  const parts = $derived(splitFences(text));
  const admin = $derived(session.state?.user?.role === 'admin');
  // Run... opens under its own command, in the answer: the answer is in a dialog already, and a
  // second dialog over it is a maze to get out of.
  let fixOpen = $state(false);
  let fixAt = $state(-1);
  const hostName = $derived(data.hosts.find((h) => h.id === hostId)?.name ?? '');
  function run(i: number) {
    fixAt = i;
    fixOpen = true;
  }
</script>

<!-- markdownToHtml escapes everything; the model's text is never HTML. -->
<div class="answer" data-testid={testid}>
  {#each parts as p, i (i)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {#if p.kind === 'text'}{@html markdownToHtml(p.text)}{:else}
      <div class="cmd">
        <pre><code>{p.text}</code></pre>
        <div class="cmd-acts">
          <button type="button" class="btn small" onclick={async () => (await copyText(p.text)) && toast(t('common.copied'))} data-testid="answer-copy"><Icon name="copy" size={14} /> {t('common.copy')}</button>
          {#if admin && hostId !== null}<button type="button" class="btn small" onclick={() => run(i)} data-testid="answer-run">{t('fix.open')}</button>{/if}
        </div>
        {#if hostId !== null && fixOpen && fixAt === i}
          <FixRun inline bind:open={fixOpen} fix={{ step: '', command: p.text, risk: 'low', riskReasons: [] }} {hostId} {hostName} />
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .answer {
    font-size: 0.9rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .answer :global(h3) {
    font-size: 0.95rem;
    font-weight: 700;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text);
    margin: 12px 0 4px;
  }
  .answer :global(h3:first-child) {
    margin-top: 0;
  }
  .answer :global(ul),
  .answer :global(ol) {
    margin: 4px 0;
    padding-left: 20px;
  }
  .answer :global(p) {
    margin: 4px 0;
  }
  .answer :global(code) {
    font: 0.82rem var(--mono);
    background: var(--bg-sunken);
    padding: 0 3px;
    border-radius: 3px;
  }
  .answer :global(pre) {
    background: var(--bg-sunken);
    padding: 8px;
    border-radius: 6px;
    overflow: auto;
  }
  .cmd {
    margin: 6px 0;
  }
  .cmd pre {
    margin: 0;
  }
  /* Under the command, at its right: Copy and Run..., as small as a report's Run... */
  .cmd-acts {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 4px;
  }
  .cmd-acts .btn {
    width: auto;
  }
</style>
