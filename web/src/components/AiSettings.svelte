<script lang="ts">
  import type { AiProvider, AiSettings, AiSettingsInput, AiUsageSummary } from '@burrow/shared';
  import { usageText } from '../lib/aiusage.js';
  import { errorMessage, get, post, put } from '../lib/api.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { toast } from '../lib/ui.svelte.js';
  import { warnUnsaved } from '../lib/unsaved.svelte.js';
  import HelpTip from './HelpTip.svelte';
  import LoadFailed from './LoadFailed.svelte';

  let s = $state<AiSettings | null>(null);
  let provider = $state<AiProvider>('none');
  let ollamaUrl = $state('');
  let ollamaModel = $state('');
  let claudeModel = $state('');
  let claudeKey = $state('');
  let openaiUrl = $state('');
  let openaiModel = $state('');
  let openaiKey = $state('');
  let geminiModel = $state('');
  let geminiKey = $state('');
  // Said by the admin, never guessed from the address: then addresses go unmasked (A3-SRV-20).
  let ollamaLocal = $state(false);
  let openaiLocal = $state(false);
  let timeoutMinutes = $state(10);
  // Per million tokens; empty: no cost shown (report 18efc8).
  let priceIn = $state<number | null>(null);
  let priceOut = $state<number | null>(null);
  let currency = $state('USD');
  let usage = $state<AiUsageSummary | null>(null);
  const loadUsage = () => get<AiUsageSummary>('/api/settings/ai/usage').then((u) => (usage = u), () => {});
  void loadUsage();
  // The provider to come back to when AI is switched on again.
  let lastOn = $state<Exclude<AiProvider, 'none'>>('ollama');
  let models = $state<string[]>([]);
  let busy = $state(false);
  // What was saved last, to tell whether the form holds changes.
  let saved = $state('');
  const snapshot = () => JSON.stringify([provider, ollamaUrl, ollamaModel, ollamaLocal, claudeModel, openaiUrl, openaiModel, openaiLocal, geminiModel, timeoutMinutes, priceIn, priceOut, currency]);
  const dirty = $derived(s !== null && (snapshot() !== saved || !!claudeKey || !!openaiKey || !!geminiKey));
  warnUnsaved(() => dirty);

  function fill(x: AiSettings) {
    s = x;
    provider = x.provider;
    if (x.provider !== 'none') lastOn = x.provider;
    ollamaUrl = x.ollama.url;
    ollamaModel = x.ollama.model;
    ollamaLocal = x.ollama.local;
    claudeModel = x.anthropic.model;
    openaiUrl = x.openai.url;
    openaiModel = x.openai.model;
    openaiLocal = x.openai.local;
    geminiModel = x.gemini.model;
    timeoutMinutes = x.timeoutMinutes;
    priceIn = x.prices.input;
    priceOut = x.prices.output;
    currency = x.prices.currency;
    claudeKey = '';
    openaiKey = '';
    geminiKey = '';
    saved = snapshot();
  }
  // Not read: said with Try again, and no form to save defaults over the stored settings (A3-WEB-01).
  let loadError = $state('');
  const loadSettings = () => {
    loadError = '';
    get<AiSettings>('/api/settings/ai').then(fill).catch((err: unknown) => (loadError = errorMessage(err)));
  };
  loadSettings();

  // An emptied number field is null, not 0 (and not "").
  const price = (v: number | null | string) => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const priceInput = () => ({ input: price(priceIn), output: price(priceOut), currency: currency.trim() || 'USD' });

  /** True when saved; a failure is said here. */
  async function save(e?: SubmitEvent): Promise<boolean> {
    e?.preventDefault();
    // A provider without a model answers nothing ("No AI provider is set up yet" after a save, W-FUNC-07).
    const model = provider === 'ollama' ? ollamaModel : provider === 'anthropic' ? claudeModel : provider === 'openai' ? openaiModel : provider === 'gemini' ? geminiModel : 'none';
    if (!model.trim()) {
      toast(t('ai.chooseModel'), 'error');
      return false;
    }
    busy = true;
    const body: AiSettingsInput = {
      provider,
      ollama: { url: ollamaUrl, model: ollamaModel, local: ollamaLocal },
      anthropic: { model: claudeModel, ...(claudeKey ? { apiKey: claudeKey } : {}) },
      openai: { url: openaiUrl, model: openaiModel, local: openaiLocal, ...(openaiKey ? { apiKey: openaiKey } : {}) },
      gemini: { model: geminiModel, ...(geminiKey ? { apiKey: geminiKey } : {}) },
      timeoutMinutes,
      prices: priceInput(),
    };
    const sent = snapshot();
    const keys = { claudeKey, openaiKey, geminiKey };
    try {
      const got = await put<AiSettings>('/api/settings/ai', body);
      // Changed while it was on its way: those changes stay (the answer
      // filled the form again and cleared a key just typed, audit WC-08).
      if (snapshot() === sent && claudeKey === keys.claudeKey && openaiKey === keys.openaiKey && geminiKey === keys.geminiKey) fill(got);
      else {
        s = got;
        saved = sent;
        if (claudeKey === keys.claudeKey) claudeKey = '';
        if (openaiKey === keys.openaiKey) openaiKey = '';
        if (geminiKey === keys.geminiKey) geminiKey = '';
      }
      toast(t('ai.saved'));
      void loadUsage();
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    } finally {
      busy = false;
    }
  }

  async function loadModels() {
    if (provider === 'none') return;
    busy = true;
    try {
      // The URL and key just typed, sent along and not saved (W-FUNC-07: the whole form was saved first,
      // an empty model with it); never the old settings' models (AUDIT2 UI-20).
      const p = provider;
      const key = p === 'gemini' ? geminiKey : claudeKey;
      const form = p === 'ollama' ? { url: ollamaUrl } : p === 'openai' ? { url: openaiUrl, ...(openaiKey ? { apiKey: openaiKey } : {}) } : key ? { apiKey: key } : {};
      const list = await post<string[]>('/api/settings/ai/models', { provider: p, ...form });
      if (provider !== p) return;
      models = list;
      if (!models.length) toast(t('ai.noModels'), 'error');
      // A list without the model shown (none yet): its first, not a select showing nothing (W-FUNC-07).
      else if (p === 'ollama' && !models.includes(ollamaModel)) ollamaModel = models[0]!;
      else if (p === 'anthropic' && !models.includes(claudeModel)) claudeModel = models[0]!;
      else if (p === 'openai' && !models.includes(openaiModel)) openaiModel = models[0]!;
      else if (p === 'gemini' && !models.includes(geminiModel)) geminiModel = models[0]!;
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }

  async function removeKey(which: 'anthropic' | 'openai' | 'gemini') {
    busy = true;
    const before = snapshot();
    const keys = { claudeKey, openaiKey, geminiKey };
    // The settings as saved, with only that key taken out: what is changed here and not saved
    // stays a change here, not saved by the way.
    const now = s;
    if (!now) return void (busy = false);
    try {
      const got = await put<AiSettings>('/api/settings/ai', {
        provider: now.provider,
        ollama: { url: now.ollama.url, model: now.ollama.model, local: now.ollama.local },
        anthropic: { model: now.anthropic.model, ...(which === 'anthropic' ? { apiKey: '' } : {}) },
        openai: { url: now.openai.url, model: now.openai.model, local: now.openai.local, ...(which === 'openai' ? { apiKey: '' } : {}) },
        gemini: { model: now.gemini.model, ...(which === 'gemini' ? { apiKey: '' } : {}) },
        timeoutMinutes: now.timeoutMinutes,
        prices: now.prices,
      });
      // Only that key goes: another one typed and not saved yet, or a change made before or
      // meanwhile, stays as it is (AUDIT2 UI-19: the form was filled again and lost them; a model
      // typed before the press went back to the saved one).
      if (snapshot() === before && before === saved && !keys.claudeKey && !keys.openaiKey && !keys.geminiKey) fill(got);
      else {
        s = got;
        if (which === 'anthropic' && claudeKey === keys.claudeKey) claudeKey = '';
        if (which === 'openai' && openaiKey === keys.openaiKey) openaiKey = '';
        if (which === 'gemini' && geminiKey === keys.geminiKey) geminiKey = '';
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
    }
  }
</script>

{#if loadError && !s}
  <LoadFailed inline message={loadError} onretry={loadSettings} />
{:else if s}
  <form class="card stack" onsubmit={save} data-unsaved>
    <!-- Off: nothing more to set. On: the provider and its fields. -->
    <div class="row">
      <label class="check">
        <input
          type="checkbox"
          checked={provider !== 'none'}
          onchange={(e) => {
            if (e.currentTarget.checked) provider = lastOn;
            else {
              if (provider !== 'none') lastOn = provider;
              provider = 'none';
            }
          }}
          data-testid="ai-enabled"
        />
        {t('ai.enabled')}
      </label>
      <HelpTip text={t('help.aiProvider')} />
    </div>
    {#if provider !== 'none'}
    <div class="field-wrap">
      <label class="field">
        <span>{t('ai.provider')}</span>
        <select bind:value={provider} onchange={() => (models = [])}>
          <option value="ollama">Ollama ({t('ai.local')})</option>
          <option value="anthropic">Claude (Anthropic API)</option>
          <option value="gemini">Gemini (Google AI)</option>
          <option value="openai">{t('ai.openai')}</option>
        </select>
      </label>
    </div>
    {/if}

    {#if provider === 'ollama'}
      <label class="field">
        <span>{t('ai.url')}</span>
        <input bind:value={ollamaUrl} inputmode="url" autocapitalize="none" spellcheck="false" />
      </label>
      <div class="row">
        <label class="check"><input type="checkbox" bind:checked={ollamaLocal} data-testid="ai-local" />{t('ai.ownNetwork')}</label>
        <HelpTip text={t('help.aiOwnNetwork')} />
      </div>
      <label class="field">
        <span>{t('ai.model')}</span>
        {#if models.length}
          <select bind:value={ollamaModel}>{#each models as m (m)}<option value={m}>{m}</option>{/each}</select>
        {:else}
          <input bind:value={ollamaModel} autocapitalize="none" spellcheck="false" placeholder="gemma4:e2b" />
        {/if}
      </label>
    {:else if provider === 'anthropic'}
      <div class="field-wrap">
        <label class="field">
          <span>{t('ai.apiKey')}</span>
          <input type="password" bind:value={claudeKey} autocomplete="off" placeholder={s.anthropic.hasKey ? t('ai.keyStored') : 'sk-ant-...'} />
        </label>
        <span class="field-help"><HelpTip text={t('help.claudeKey')} /></span>
      </div>
      {#if s.anthropic.hasKey}<button type="button" class="btn small danger" onclick={() => removeKey('anthropic')}>{t('ai.removeKey')}</button>{/if}
      <label class="field">
        <span>{t('ai.model')}</span>
        {#if models.length}
          <select bind:value={claudeModel}>{#each models as m (m)}<option value={m}>{m}</option>{/each}</select>
        {:else}
          <input bind:value={claudeModel} autocapitalize="none" spellcheck="false" />
        {/if}
      </label>
    {:else if provider === 'openai'}
      <label class="field">
        <span>{t('ai.url')}</span>
        <input bind:value={openaiUrl} inputmode="url" autocapitalize="none" spellcheck="false" />
      </label>
      <div class="row">
        <label class="check"><input type="checkbox" bind:checked={openaiLocal} data-testid="ai-local" />{t('ai.ownNetwork')}</label>
        <HelpTip text={t('help.aiOwnNetwork')} />
      </div>
      <label class="field">
        <span>{t('ai.apiKey')} ({t('common.optional')})</span>
        <input type="password" bind:value={openaiKey} autocomplete="off" placeholder={s.openai.hasKey ? t('ai.keyStored') : ''} />
      </label>
      {#if s.openai.hasKey}<button type="button" class="btn small danger" onclick={() => removeKey('openai')}>{t('ai.removeKey')}</button>{/if}
      <label class="field">
        <span>{t('ai.model')}</span>
        {#if models.length}
          <select bind:value={openaiModel}>{#each models as m (m)}<option value={m}>{m}</option>{/each}</select>
        {:else}
          <input bind:value={openaiModel} autocapitalize="none" spellcheck="false" />
        {/if}
      </label>
    {:else if provider === 'gemini'}
      <div class="field-wrap">
        <label class="field">
          <span>{t('ai.apiKey')}</span>
          <input type="password" bind:value={geminiKey} autocomplete="off" placeholder={s.gemini.hasKey ? t('ai.keyStored') : 'AIza...'} data-testid="ai-gemini-key" />
        </label>
        <span class="field-help"><HelpTip text={t('help.geminiKey')} /></span>
      </div>
      {#if s.gemini.hasKey}<button type="button" class="btn small danger" onclick={() => removeKey('gemini')} data-testid="ai-gemini-remove-key">{t('ai.removeKey')}</button>{/if}
      <label class="field">
        <span>{t('ai.model')}</span>
        {#if models.length}
          <select bind:value={geminiModel} data-testid="ai-gemini-model">{#each models as m (m)}<option value={m}>{m}</option>{/each}</select>
        {:else}
          <input bind:value={geminiModel} autocapitalize="none" spellcheck="false" placeholder={t('ai.geminiModelHint')} data-testid="ai-gemini-model" />
        {/if}
      </label>
    {/if}

    {#if provider === 'ollama' || provider === 'openai'}
      <div class="field-wrap">
        <label class="field">
          <span>{t('ai.timeout')}</span>
          <input type="number" min="1" max="120" bind:value={timeoutMinutes} required data-testid="ai-timeout" />
        </label>
        <span class="field-help"><HelpTip text={t('help.aiTimeout')} /></span>
      </div>
    {/if}
    {#if provider !== 'none'}
      <button type="button" class="btn small" disabled={busy} onclick={loadModels}>{t('ai.loadModels')}</button>
      <fieldset class="prices">
        <legend class="small">{t('ai.prices')} <HelpTip text={t('help.aiPrices')} /></legend>
        <label class="field"><span>{t('ai.priceIn')}</span><input type="number" min="0" step="any" bind:value={priceIn} data-testid="ai-price-in" /></label>
        <label class="field"><span>{t('ai.priceOut')}</span><input type="number" min="0" step="any" bind:value={priceOut} data-testid="ai-price-out" /></label>
        <label class="field"><span>{t('ai.currency')}</span><input bind:value={currency} maxlength="8" autocapitalize="characters" data-testid="ai-currency" /></label>
      </fieldset>
    {/if}
    <div class="form-end">
      {#if dirty}<span class="dim small" data-testid="ai-unsaved">{t('common.unsaved')}</span>{/if}
      <button class="btn primary" disabled={busy}>{t('common.save')}</button>
    </div>
    {#if provider === 'anthropic' || provider === 'openai' || provider === 'gemini'}<p class="help">{t('ai.privacy')}</p>{/if}
    {#if provider === 'gemini'}<p class="help" data-testid="ai-gemini-free">{t('ai.geminiFree')}</p>{/if}
  </form>
  {#if usage}
    <h3>{t('ai.usage')}</h3>
    <div class="card small usage" data-testid="ai-usage">
      {#if usage.last30.calls === 0}
        <p class="dim">{t('ai.usageNone')}</p>
      {:else}
        <!-- One line per period and kind, a rule between (report 7e91ba: six figures in one block). -->
        <ul>
          <li>{t('ai.usageMonth', { usage: usageText(usage.month, usage.prices), n: usage.month.calls })}</li>
          <li>{t('ai.usage30', { usage: usageText(usage.last30, usage.prices) })}</li>
          {#each ['analysis', 'report', 'command', 'filter'] as const as k (k)}
            {#if usage.byKind[k].calls}<li class="dim">{t(`ai.usageKind.${k}`, { usage: usageText(usage.byKind[k], usage.prices) })}</li>{/if}
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* The three prices on one line where there is room: no frame of their own. */
  .prices {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  /* A phone: the two prices side by side, the currency the whole line under them (it took half of it,
     beside empty room). */
  @media (max-width: 719px) {
    .prices {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .prices > label:last-child {
      grid-column: 1 / -1;
    }
  }
  .prices legend {
    padding: 0;
    margin-bottom: 4px;
  }
  .usage p,
  .usage ul {
    margin: 0;
  }
  .usage ul {
    padding: 0;
    list-style: none;
  }
  .usage li + li {
    border-top: 1px solid var(--border);
    margin-top: 8px;
    padding-top: 8px;
  }
</style>
