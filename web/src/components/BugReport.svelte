<script lang="ts">
  import { untrack } from 'svelte';
  import { bug, bugContext, sendReport, setArmed, startReport } from '../lib/bugreport.svelte.js';
  import { keyBars } from '../lib/keyboard.svelte.js';
  import { MOD } from '../lib/shortcuts.svelte.js';
  import { withoutText } from '../lib/inputlog.js';
  import { errorMessage } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import HelpTip from './HelpTip.svelte';

  // The report button (while armed from Settings) and the form it opens:
  // what went wrong, the screen as it was, pictures to add, and what else
  // goes along (shown, so nothing is sent unseen).

  let text = $state('');
  let withShot = $state(true);
  // A terminal's input goes along without what was typed, unless asked.
  let withTyped = $state(false);
  // Likewise what files, terminals and logs showed: covered in the picture unless asked (report 50a6f6).
  let withPrivate = $state(false);
  const picture = $derived(withPrivate ? bug.shotFull : bug.shot);
  let pictures = $state<string[]>([]);
  // The screenshot as a small picture beside the others, larger on a tap: shown whole it took most
  // of a phone's screen, the form around it out of sight (report 04436d).
  let shotBig = $state(false);
  let busy = $state(false);
  const ctx = $derived(bug.open ? bugContext() : null);

  // Each report starts without what was typed: the yes is for one report, however the
  // one before was closed (X, Escape, the backdrop kept it, AUDIT2 UI-23).
  $effect(() => {
    if (bug.open) untrack(() => ((withTyped = false), (withPrivate = false)));
  });

  function reset() {
    text = '';
    withShot = true;
    withTyped = false;
    withPrivate = false;
    shotBig = false;
    pictures = [];
  }

  async function addPictures(e: Event & { currentTarget: HTMLInputElement }) {
    // The input itself, now: after an await the event no longer has it.
    const input = e.currentTarget;
    await addFiles([...(input.files ?? [])]);
    input.value = '';
  }

  // Pasted (a screenshot of your own, Ctrl+V) or dropped on the form: pictures as from Add a picture.
  // Text pasted into the box stays text.
  function pasted(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  }
  function dropped(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  }

  async function addFiles(chosen: File[]) {
    const files = chosen.slice(0, 3 - pictures.length);
    for (const f of files) {
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
        toast(t('bug.onlyPictures'), 'error');
        continue;
      }
      if (f.size > 6 << 20) {
        toast(t('bug.tooBig', { name: f.name }), 'error');
        continue;
      }
      pictures = [...pictures, await new Promise<string>((r) => {
        const fr = new FileReader();
        fr.onload = () => r(String(fr.result));
        fr.readAsDataURL(f);
      })];
    }
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    try {
      const recording = bug.recording && (withTyped ? bug.recording : withoutText(bug.recording));
      await sendReport({ text, screenshot: withShot ? picture : null, attachments: pictures, recording }, withShot && picture ? { covered: bug.hidden, shown: withPrivate } : null);
      toast(t('bug.sent'));
      // The red button stays for the next report, until turned off.
      bug.open = false;
      bug.shot = bug.shotFull = null;
      bug.recording = null;
      reset();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

{#if bug.armed && !bug.open}
  <div class="bugbar" data-bug-ui>
    <button class="bugbtn" disabled={bug.capturing} aria-label={t('bug.here')} title={keyBars.show ? t('bug.here') : t('bug.hereKeys', { keys: `${MOD}+Shift+B` })} onclick={() => void startReport()} data-testid="bug-button">
      <Icon name="alert" size={22} />
    </button>
    <!-- Changed your mind: the button goes away without a report. -->
    <button class="bugoff" aria-label={t('bug.disarm')} title={t('bug.disarm')} onclick={() => (setArmed(false), (bug.shot = bug.shotFull = null))} data-testid="bug-disarm">
      <Icon name="close" size={16} />
    </button>
  </div>
{/if}

<div data-bug-ui>
  <Dialog tour="bug-report" size="wide" bind:open={bug.open} title={t('bug.title')}>
    <!-- Ctrl+Enter sends; a picture pasted or dropped joins the others. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keys, a paste and a drop from any of its fields, the text box first) -->
    <form
      id="bug-form"
      class="stack"
      onsubmit={send}
      onkeydown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), text.trim() && !busy && e.currentTarget.requestSubmit())}
      onpaste={pasted}
      ondragover={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
      ondrop={dropped}
      data-testid="bug-form"
    >
      <label class="field">
        <span>{t('bug.what')}</span>
        <textarea bind:value={text} rows="4" required maxlength="10000" placeholder={t('bug.whatHint')} data-testid="bug-text"></textarea>
      </label>
      {#if bug.shot}
        <label class="check"><input type="checkbox" bind:checked={withShot} /> {t('bug.withShot')}</label>
        {#if withShot && bug.hidden}
          <div class="row">
            <label class="check"><input type="checkbox" bind:checked={withPrivate} data-testid="bug-private" /> {t('bug.withPrivate')}</label>
            <HelpTip text={t('help.bugPrivate')} />
          </div>
        {/if}
      {/if}
      <div class="pics">
        {#if bug.shot && withShot}
          <button type="button" class="shotbtn" class:big={shotBig} aria-expanded={shotBig} aria-label={t(shotBig ? 'bug.shotSmaller' : 'bug.shotLarger')} title={t(shotBig ? 'bug.shotSmaller' : 'bug.shotLarger')} onclick={() => (shotBig = !shotBig)} data-testid="bug-shot-zoom"
            ><img class="shot" src={picture} alt={t('bug.shotAlt')} data-testid="bug-shot" /></button
          >
        {/if}
        {#each pictures as p, i (i)}
          <span class="pic"
            ><img src={p} alt={t('bug.pictureAlt', { n: i + 1 })} /><button type="button" class="icon-btn" aria-label={t('bug.removePicture', { n: i + 1 })} onclick={() => (pictures = pictures.filter((_, j) => j !== i))}
              ><Icon name="close" size={16} /></button
            ></span
          >
        {/each}
        {#if pictures.length < 3}
          <label class="btn small add">{t('bug.addPicture')}<input type="file" accept="image/png,image/jpeg,image/webp" multiple onchange={addPictures} /></label>
        {/if}
      </div>
      {#if bug.recording}
        <div class="row">
          <label class="check"><input type="checkbox" bind:checked={withTyped} data-testid="bug-typed" /> {t('bug.withTyped')}</label>
          <HelpTip text={t('help.bugRecording', { n: bug.recording.entries.length })} />
        </div>
      {/if}
      <details class="small">
        <summary>{t('bug.alsoSent')}</summary>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolling box: keyboard users scroll it once it has focus) -->
        <pre tabindex="0" data-testid="bug-context">{JSON.stringify(ctx, null, 2)}</pre>
      </details>
      <p class="dim small">{t('bug.where')}</p>
    </form>
    <!-- In the footer, in sight however long the form (UIA-02: Send was below the picture). -->
    {#snippet actions()}
      <button type="button" class="btn" onclick={() => ((bug.open = false), reset())}>{t('common.cancel')}</button>
      <button class="btn primary" form="bug-form" disabled={busy || !text.trim()} data-testid="bug-send">{t('bug.send')}</button>
    {/snippet}
  </Dialog>
</div>

<style>
  .bugbar {
    position: fixed;
    left: 12px;
    bottom: calc(var(--nav-h) + 16px + env(safe-area-inset-bottom));
    z-index: 40;
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .bugoff {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-dim);
    box-shadow: var(--shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .bugbtn {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 2px solid var(--danger);
    background: var(--bg-raised);
    color: var(--danger);
    box-shadow: var(--shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  textarea {
    width: 100%;
    font: inherit;
  }
  .shotbtn {
    display: inline-flex;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: none;
    overflow: hidden;
    cursor: zoom-in;
  }
  /* The screen, the pictures and Add a picture: like tiles, 72 px square on one line (report
     05a818: a phone's screen a sliver beside square pictures, the button off their line). */
  .shot {
    display: block;
    width: 70px;
    height: 70px;
    object-fit: cover;
    object-position: top;
  }
  .shotbtn.big {
    flex-basis: 100%;
    cursor: zoom-out;
  }
  .big .shot {
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 60dvh;
    object-fit: contain;
  }
  .pics {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .pic {
    position: relative;
    display: inline-flex;
  }
  .pic img {
    width: 72px;
    height: 72px;
    object-fit: cover;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .pic .icon-btn {
    position: absolute;
    top: -8px;
    right: -8px;
    background: var(--bg-raised);
  }
  .add {
    width: auto;
    min-height: 72px;
    /* The rest of the pictures' line, the whole of it where a large screenshot left none beside it;
       its words over two lines rather than off the tiles' line on a narrow phone (report 05a818). */
    flex: 1 0 104px;
    white-space: normal;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .add input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  pre {
    max-height: 30dvh;
    overflow: auto;
    font: 0.72rem/1.35 var(--mono);
    background: var(--bg-sunken);
    padding: 8px;
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
