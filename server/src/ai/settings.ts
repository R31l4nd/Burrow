import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { AiSettings, AiSettingsInput } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { appSettings } from '../db/schema.js';
import { originOf, secretFor } from '../http.js';
import { AnthropicProvider, GEMINI_URL, OllamaProvider, OpenAiCompatibleProvider, type LlmProvider } from './providers.js';
import { anthropicStream, ollamaStream, openAiStream, type TextRequest } from './stream.js';

// AI provider settings, one JSON row in app_settings. API keys are sealed
// and never sent back to the browser; the UI only learns whether one is set.

const KEY = 'ai';
const SECRET_CONTEXT = 'app_settings.ai.api_key';

interface Stored {
  provider: AiSettings['provider'];
  ollama: { url: string; model: string; local: boolean };
  anthropic: { model: string; apiKeyEnc: string | null };
  openai: { url: string; model: string; apiKeyEnc: string | null; local: boolean };
  gemini: { model: string; apiKeyEnc: string | null };
  timeoutMinutes: number;
  prices: AiSettings['prices'];
}

// The plan's choice for Claude; editable in Settings.
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

const DEFAULTS: Stored = {
  provider: 'none',
  // Container name of Ollama on a shared Docker network; change as needed.
  ollama: { url: 'http://ollama:11434', model: '', local: false },
  anthropic: { model: DEFAULT_CLAUDE_MODEL, apiKeyEnc: null },
  openai: { url: 'http://localhost:8000/v1', model: '', apiKeyEnc: null, local: false },
  // No model named here: Google's change over time, picked from its list once a key is in.
  gemini: { model: '', apiKeyEnc: null },
  // A small model on a small machine: minutes before the first word.
  timeoutMinutes: 10,
  // Not known: no cost shown, only tokens.
  prices: { input: null, output: null, currency: 'USD' },
};

function load(ctx: Ctx): Stored {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, KEY)).get();
  if (!row) return structuredClone(DEFAULTS);
  const v = JSON.parse(row.value) as Partial<Stored>;
  return {
    provider: v.provider ?? DEFAULTS.provider,
    ollama: { ...DEFAULTS.ollama, ...v.ollama },
    anthropic: { ...DEFAULTS.anthropic, ...v.anthropic },
    openai: { ...DEFAULTS.openai, ...v.openai },
    gemini: { ...DEFAULTS.gemini, ...v.gemini },
    timeoutMinutes: v.timeoutMinutes ?? DEFAULTS.timeoutMinutes,
    prices: { ...DEFAULTS.prices, ...v.prices },
  };
}

export function getAiSettings(ctx: Ctx): AiSettings {
  const s = load(ctx);
  return {
    provider: s.provider,
    ollama: s.ollama,
    anthropic: { model: s.anthropic.model, hasKey: s.anthropic.apiKeyEnc !== null },
    openai: { url: s.openai.url, model: s.openai.model, hasKey: s.openai.apiKeyEnc !== null, local: s.openai.local },
    gemini: { model: s.gemini.model, hasKey: s.gemini.apiKeyEnc !== null },
    timeoutMinutes: s.timeoutMinutes,
    prices: s.prices,
  };
}

const sealKey = (ctx: Ctx, current: string | null, next: string | undefined, sameDestination = true): string | null =>
  secretFor(current, next, sameDestination, (v) => ctx.box.seal(v, SECRET_CONTEXT));

export function saveAiSettings(ctx: Ctx, input: AiSettingsInput): AiSettings {
  const cur = load(ctx);
  const next: Stored = {
    provider: input.provider,
    ollama: input.ollama,
    anthropic: { model: input.anthropic.model || DEFAULT_CLAUDE_MODEL, apiKeyEnc: sealKey(ctx, cur.anthropic.apiKeyEnc, input.anthropic.apiKey) },
    // Another server: the stored key is not sent there unless given again (A3-SRV-17).
    openai: { url: input.openai.url, model: input.openai.model, local: input.openai.local, apiKeyEnc: sealKey(ctx, cur.openai.apiKeyEnc, input.openai.apiKey, originOf(cur.openai.url) === originOf(input.openai.url)) },
    gemini: input.gemini ? { model: input.gemini.model, apiKeyEnc: sealKey(ctx, cur.gemini.apiKeyEnc, input.gemini.apiKey) } : cur.gemini,
    timeoutMinutes: input.timeoutMinutes,
    prices: { ...input.prices, currency: input.prices.currency || 'USD' },
  };
  const value = JSON.stringify(next);
  ctx.db
    .insert(appSettings)
    .values({ key: KEY, value, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ctx.now() } })
    .run();
  return getAiSettings(ctx);
}

/** Test hook: where the Anthropic client sends requests. */
export const testHooks: { anthropicBaseUrl?: string; geminiBaseUrl?: string; minuteMs?: number } = {};

const geminiUrl = () => testHooks.geminiBaseUrl ?? GEMINI_URL;

/**
 * Whether addresses are masked for a provider: always, unless the admin said its server runs on
 * their own network. Not judged by the address: "gpu" or "llm.lan" may be a rented box reached
 * over a VPN (A3-SRV-20). Claude is never local.
 */
export function providerExternal(ctx: Ctx, id: LlmProvider['id']): boolean {
  const s = load(ctx);
  if (id === 'ollama') return !s.ollama.local;
  if (id === 'openai') return !s.openai.local;
  // Claude and Gemini: Anthropic's and Google's servers.
  return true;
}

/** The provider to use, or null when AI is switched off or incomplete. */
export function providerFor(ctx: Ctx, which: AiSettings['provider'] = load(ctx).provider): LlmProvider | null {
  const s = load(ctx);
  switch (which) {
    case 'ollama':
      return s.ollama.model ? new OllamaProvider(s.ollama.url, s.ollama.model) : null;
    case 'anthropic':
      return s.anthropic.apiKeyEnc
        ? new AnthropicProvider(ctx.box.open(s.anthropic.apiKeyEnc, SECRET_CONTEXT), s.anthropic.model, testHooks.anthropicBaseUrl)
        : null;
    case 'openai':
      return s.openai.model
        ? new OpenAiCompatibleProvider(s.openai.url, s.openai.model, s.openai.apiKeyEnc ? ctx.box.open(s.openai.apiKeyEnc, SECRET_CONTEXT) : null)
        : null;
    case 'gemini':
      return s.gemini.apiKeyEnc && s.gemini.model ? new OpenAiCompatibleProvider(geminiUrl(), s.gemini.model, ctx.box.open(s.gemini.apiKeyEnc, SECRET_CONTEXT), 'gemini') : null;
    default:
      return null;
  }
}

/**
 * For listing models before one is chosen: the provider with an empty model. `form`: the
 * address and key typed in Settings and not saved yet (listing saved nothing, W-FUNC-07);
 * a key not typed is the stored one.
 */
export function probeProvider(ctx: Ctx, which: Exclude<AiSettings['provider'], 'none'>, form: { url?: string; apiKey?: string } = {}): LlmProvider | null {
  const s = load(ctx);
  const stored = (enc: string | null | undefined) => (enc ? ctx.box.open(enc, SECRET_CONTEXT) : null);
  if (which === 'ollama') return new OllamaProvider(form.url ?? s.ollama.url, s.ollama.model || 'x');
  // The stored key only to the server it was saved for, as saving does (A3-SRV-17): another address typed is asked without it (audit 2026-10-30).
  if (which === 'openai') {
    const url = form.url ?? s.openai.url;
    return new OpenAiCompatibleProvider(url, s.openai.model || 'x', form.apiKey ?? (originOf(url) === originOf(s.openai.url) ? stored(s.openai.apiKeyEnc) : null));
  }
  if (which === 'gemini') {
    const key = form.apiKey ?? stored(s.gemini.apiKeyEnc);
    return key ? new OpenAiCompatibleProvider(geminiUrl(), s.gemini.model || 'x', key, 'gemini') : null;
  }
  const key = form.apiKey ?? stored(s.anthropic.apiKeyEnc);
  return key ? new AnthropicProvider(key, s.anthropic.model, testHooks.anthropicBaseUrl) : null;
}

export interface TextStreamer {
  id: LlmProvider['id'];
  model: string;
  /** Not said to run on the admin's own network: IP addresses are masked too. */
  external: boolean;
  /** The time one answer may take, whole (a local model's is set in Settings). */
  timeoutMs: number;
  stream(req: TextRequest): AsyncGenerator<string>;
}

/**
 * A server that stays on this network (for OIDC over plain http): a container or single-label name,
 * localhost, a .local/.lan/.internal/.home.arpa name, or a loopback,
 * private or link-local address (parsed, not guessed from its first
 * characters: "10.public.example" is a public name, [2001:4860::8888] a
 * public address).
 */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  const kind = isIP(host);
  if (kind === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (kind === 6) return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  return !host.includes('.') || host === 'localhost' || /\.(local|lan|internal|home\.arpa)$/.test(host);
}

/** Streaming text from the configured provider, or from Claude for a deeper analysis. */
export function streamerFor(ctx: Ctx, deep = false): TextStreamer | null {
  const s = load(ctx);
  const which = deep ? 'anthropic' : s.provider;
  const minute = testHooks.minuteMs ?? 60_000;
  const local = s.timeoutMinutes * minute;
  switch (which) {
    case 'ollama':
      return s.ollama.model ? { id: 'ollama', model: s.ollama.model, external: !s.ollama.local, timeoutMs: local, stream: (r) => ollamaStream(s.ollama.url, s.ollama.model, r, local) } : null;
    case 'openai': {
      if (!s.openai.model) return null;
      const key = s.openai.apiKeyEnc ? ctx.box.open(s.openai.apiKeyEnc, SECRET_CONTEXT) : null;
      return { id: 'openai', model: s.openai.model, external: !s.openai.local, timeoutMs: local, stream: (r) => openAiStream(s.openai.url, s.openai.model, key, r, local) };
    }
    case 'gemini': {
      if (!s.gemini.apiKeyEnc || !s.gemini.model) return null;
      const key = ctx.box.open(s.gemini.apiKeyEnc, SECRET_CONTEXT);
      return { id: 'gemini', model: s.gemini.model, external: true, timeoutMs: 10 * minute, stream: (r) => openAiStream(geminiUrl(), s.gemini.model, key, r, 10 * minute) };
    }
    case 'anthropic': {
      if (!s.anthropic.apiKeyEnc) return null;
      const key = ctx.box.open(s.anthropic.apiKeyEnc, SECRET_CONTEXT);
      return { id: 'anthropic', model: s.anthropic.model, external: true, timeoutMs: 10 * minute, stream: (r) => anthropicStream(key, s.anthropic.model, r, testHooks.anthropicBaseUrl) };
    }
    default:
      return null;
  }
}

/** A deeper analysis with Claude is possible (a Claude key is set) and differs from the usual provider. */
export function deepAvailable(ctx: Ctx): boolean {
  const s = load(ctx);
  return s.anthropic.apiKeyEnc !== null && s.provider !== 'anthropic';
}
