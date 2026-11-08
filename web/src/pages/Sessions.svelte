<script lang="ts">
  import HelpTip from '../components/HelpTip.svelte';
  import SessionList from '../components/SessionList.svelte';
  import { t } from '../lib/i18n/index.svelte.js';
  import { go } from '../lib/router.svelte.js';

  // The Terminal tab without a session chosen: every open session, from
  // every device. A host's session starts from the host list.
</script>

<div class="page">
  <header class="topbar">
    <h1>{t('term.sessions')} <HelpTip text={t('help.sessions')} /></h1>
  </header>
  <SessionList onpick={(id) => go(`/term/${id}`)} />
  <div class="stack" style:margin-top="12px">
    <button class="btn" onclick={() => go('/hosts')}>{t('term.startFromHosts')}</button>
  </div>
</div>
