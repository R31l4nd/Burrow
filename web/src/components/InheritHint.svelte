<script lang="ts">
  import { t } from '../lib/i18n/index.svelte.js';

  // "from group Servers: alice" (or "from All hosts: alice") under a field
  // that is empty on the host itself.
  let { value, from }: { value: string | number | null | undefined; from: string | 'all' | null } = $props();
</script>

{#if from && value !== null && value !== undefined && value !== ''}
  <span class="help">{from === 'all' ? t('host.inheritedAll', { value }) : t('host.inherited', { group: from, value })}</span>
{/if}
