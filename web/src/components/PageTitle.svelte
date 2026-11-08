<script lang="ts">
  import HelpTip from './HelpTip.svelte';
  // A page's title with what it belongs to on a quiet line below ("docker-real
  // | stack"), instead of a pill at the far end of the top bar; its help tip
  // right beside the title.
  let { title, sub = '', tip = '' }: { title: string; sub?: string; tip?: string } = $props();
</script>

<div class="ptitle">
  <h1 {title}>{title}{#if tip} <HelpTip text={tip} />{/if}</h1>
  {#if sub}<span class="psub" data-testid="page-sub">{sub}</span>{/if}
</div>

<style>
  .ptitle {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  h1 {
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .psub {
    font-size: 0.8rem;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
