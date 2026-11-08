<script lang="ts">
  import { t } from '../lib/i18n/index.svelte.js';
  import { shortcutGroups } from '../lib/shortcuts.svelte.js';

  // Every keyboard shortcut (lib/shortcuts.svelte.ts): in its dialog ("?") and in Settings.
</script>

<!-- One table, so the keys line up in one column for every group. -->
<table data-testid="shortcuts">
  {#each shortcutGroups() as g (g.title)}
    <tbody>
      <tr><th colspan="2" scope="colgroup">{t(g.title)}</th></tr>
      {#each g.items as s (s.what)}
        <tr>
          <td class="keys">{#each s.keys as k, i (k)}{#if i}<span class="dim sep">/</span>{/if}<kbd>{k}</kbd>{/each}</td>
          <td>{t(s.what)}</td>
        </tr>
      {/each}
    </tbody>
  {/each}
</table>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
  }
  /* Like the app's other group headings (h3). */
  th {
    padding: 14px 0 6px;
    text-align: left;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  tbody:first-child th {
    padding-top: 0;
  }
  td {
    padding: 3px 0;
    vertical-align: top;
  }
  td.keys {
    padding-right: 16px;
    white-space: nowrap;
    width: 1%;
  }
  .sep {
    margin: 0 4px;
  }
  /* A phone: each shortcut on two lines, its keys and then what they do at
     the dialog's full width (UIA-03: the words ran past the edge at 343 px). */
  @media (max-width: 479px) {
    table,
    tbody,
    tr,
    th,
    td {
      display: block;
    }
    td.keys {
      width: auto;
      padding: 6px 0 0;
    }
    td {
      padding: 2px 0 4px;
    }
  }
  kbd {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg-sunken);
    font: 0.8rem var(--mono);
  }
</style>
