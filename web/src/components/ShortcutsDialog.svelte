<script lang="ts">
  import { t } from '../lib/i18n/index.svelte.js';
  import { onShortcutKey, shortcuts } from '../lib/shortcuts.svelte.js';
  import Dialog from './Dialog.svelte';
  import ShortcutsTable from './ShortcutsTable.svelte';

  // Every keyboard shortcut in one place (lib/shortcuts.svelte.ts); "?" opens it.
</script>

<svelte:window onkeydown={onShortcutKey} />

<Dialog tour="shortcuts" bind:open={shortcuts.open} title={t('shortcuts.title')}>
  <ShortcutsTable />
</Dialog>
