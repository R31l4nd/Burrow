import { z } from 'zod';

// AI: provider settings and text-to-command. The provider layer is shared
// by later phases (log analysis, reports).

export const aiProvider = z.enum(['none', 'ollama', 'anthropic', 'openai', 'gemini']);
export type AiProvider = z.infer<typeof aiProvider>;

export interface AiSettings {
  provider: AiProvider;
  /** `local`: the admin says the server runs on their own network, so addresses go unmasked (A3-SRV-20). */
  ollama: { url: string; model: string; local: boolean };
  anthropic: { model: string; hasKey: boolean };
  openai: { url: string; model: string; hasKey: boolean; local: boolean };
  /** Google's Gemini API: always external, like Claude. */
  gemini: { model: string; hasKey: boolean };
  /** How long a local model (Ollama, OpenAI-compatible) may take for one analysis. */
  timeoutMinutes: number;
  /** What a million tokens cost, to show an estimate (report 18efc8); null: not shown. */
  prices: AiPrices;
}

export interface AiPrices {
  input: number | null;
  output: number | null;
  /** As written by the person, e.g. USD or EUR. */
  currency: string;
}

/** Tokens a model read and wrote, as its provider counted them. */
export interface AiUsage {
  input: number;
  output: number;
}

/** What the models used: this month and the last 30 days, per kind of use. */
export interface AiUsageSummary {
  month: AiUsage & { calls: number };
  last30: AiUsage & { calls: number };
  byKind: Record<'analysis' | 'report' | 'command' | 'filter', AiUsage & { calls: number }>;
  prices: AiPrices;
}

/** The estimated cost of some usage, or null without prices. */
export function aiCost(u: AiUsage, p: AiPrices): number | null {
  if (p.input === null && p.output === null) return null;
  return (u.input * (p.input ?? 0) + u.output * (p.output ?? 0)) / 1_000_000;
}

export const aiSettingsInput = z.object({
  provider: aiProvider,
  // `local` is said by the admin, never guessed from the address: a single-label name may be a rented box over a VPN (A3-SRV-20).
  ollama: z.object({ url: z.url().max(500), model: z.string().max(200), local: z.boolean().default(false) }),
  anthropic: z.object({
    model: z.string().max(200),
    // Write-only: undefined keeps the stored key, '' removes it.
    apiKey: z.string().max(500).optional(),
  }),
  openai: z.object({ url: z.url().max(500), model: z.string().max(200), apiKey: z.string().max(500).optional(), local: z.boolean().default(false) }),
  // Optional: a client from before Gemini sends none, and the stored one stays.
  gemini: z.object({ model: z.string().max(200), apiKey: z.string().max(500).optional() }).optional(),
  timeoutMinutes: z.number().int().min(1).max(120).default(10),
  prices: z
    .object({
      input: z.number().min(0).max(100_000).nullable(),
      output: z.number().min(0).max(100_000).nullable(),
      currency: z.string().trim().max(8).regex(/^[A-Za-z$]*$/),
    })
    .default({ input: null, output: null, currency: 'USD' }),
});
export type AiSettingsInput = z.infer<typeof aiSettingsInput>;

export const commandRequest = z.object({
  hostId: z.number().int().positive(),
  prompt: z.string().trim().min(1).max(2000),
  cwd: z.string().max(4096).nullable().optional(),
  locale: z.enum(['en', 'nl']).default('en'),
  /**
   * The terminal session asked from: its earlier questions and suggestions go along as
   * context (a follow-up: "make it recursive", "why?"), and this one is kept with them
   * (report 411dbe).
   */
  sessionId: z.string().min(1).max(64).optional(),
});

/**
 * A question about logs in plain words, turned into Burrow's own log filter
 * (N6): only the question and the names of the sources go to the model,
 * never a log line. The filter comes back to the page's own controls, where
 * it is seen and can be changed.
 */
export const logFilterRequest = z.object({
  prompt: z.string().trim().min(1).max(500),
  sources: z.array(z.string().max(300)).max(200),
  locale: z.enum(['en', 'nl']).default('en'),
});

export const LOG_FILTER_RANGES = ['tail', '15m', '1h', '24h', 'start'] as const;

export interface LogFilterSuggestion {
  /** Text or a regular expression to look for; empty for none. */
  query: string;
  regex: boolean;
  /** The levels to show; empty is all. */
  levels: ('fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace')[];
  stream: 'all' | 'o' | 'e';
  range: (typeof LOG_FILTER_RANGES)[number];
  /** The sources to show, by their index in the request; empty is all. */
  sources: number[];
  explanation: string;
  provider: AiProvider;
  model: string;
}

export type Risk = 'low' | 'medium' | 'high';

export interface CommandSuggestion {
  command: string;
  explanation: string;
  risk: Risk;
  // Why it is risky: from the model and from Burrow's own rules.
  riskReasons: string[];
  provider: AiProvider;
  model: string;
}

/**
 * A question and its suggestion, kept with the terminal session it was asked in
 * (report 411dbe): on the server, in memory, at most AI_TURNS_KEPT per session,
 * gone when the session ends. The question is kept as it went to the model,
 * masked; the suggestion as it came back (it never saw more).
 */
export interface AiTurn extends CommandSuggestion {
  at: string;
  prompt: string;
}
export const AI_TURNS_KEPT = 20;
/** How many earlier turns go along with a question: the conversation, in few tokens. */
export const AI_TURNS_SENT = 4;
