import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { AiUsage } from '@burrow/shared';

// One interface for every language model Burrow talks to. A provider takes a
// system prompt, a user message and a zod schema, and returns an object that
// matches the schema. Ollama is the default (local, nothing leaves the
// network); Claude is optional; any OpenAI-compatible server works too, and
// Gemini through Google's OpenAI-compatible endpoint.

export interface LlmRequest<T extends z.ZodType> {
  system: string;
  user: string;
  schema: T;
  // Name for the schema where the API wants one.
  name: string;
  /** Told the tokens the provider counted, when it says. */
  onUsage?: (u: AiUsage) => void;
}

export interface LlmProvider {
  readonly id: 'ollama' | 'anthropic' | 'openai' | 'gemini';
  readonly model: string;
  generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>>;
  listModels(): Promise<string[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`, true);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(`${new URL(url).host} answered ${res.status}: ${text.slice(0, 300)}`, res.status >= 500);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(`${new URL(url).host} returned something that is not JSON`);
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new ProviderError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`, true);
  }
  if (!res.ok) throw new ProviderError(`${new URL(url).host} answered ${res.status}`);
  return res.json() as Promise<unknown>;
}

/** Parse the model's text as JSON and check it against the schema. */
function parseOutput<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  // Small models sometimes wrap JSON in a code fence.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new ProviderError('The model did not return valid JSON.');
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new ProviderError(`The model's answer did not match the expected shape: ${r.error.issues[0]?.message ?? ''}`);
  return r.data;
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  constructor(
    private readonly url: string,
    readonly model: string,
  ) {}

  async generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>> {
    // Ollama constrains the output to the JSON schema in `format`. Generous
    // timeout: the first request may have to load the model.
    const res = (await postJson(
      `${trimSlash(this.url)}/api/chat`,
      {
        model: this.model,
        stream: false,
        format: z.toJSONSchema(req.schema),
        options: { temperature: 0.2 },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      {},
      200_000,
    )) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    if (res.prompt_eval_count !== undefined || res.eval_count !== undefined) req.onUsage?.({ input: res.prompt_eval_count ?? 0, output: res.eval_count ?? 0 });
    return parseOutput(req.schema, res.message?.content ?? '');
  }

  async listModels(): Promise<string[]> {
    const r = (await getJson(`${trimSlash(this.url)}/api/tags`)) as { models?: { name: string }[] };
    return (r.models ?? []).map((m) => m.name).sort();
  }
}

/** Google's OpenAI-compatible endpoint of the Gemini API: chat completions, streaming, JSON schema and the model list. */
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly url: string,
    readonly model: string,
    private readonly apiKey: string | null,
    readonly id: 'openai' | 'gemini' = 'openai',
  ) {}

  #headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>> {
    const body = (format: unknown) => ({
      model: this.model,
      temperature: 0.2,
      response_format: format,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    });
    const url = `${trimSlash(this.url)}/chat/completions`;
    let res: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      res = (await postJson(
        url,
        body({ type: 'json_schema', json_schema: { name: req.name, schema: z.toJSONSchema(req.schema), strict: true } }),
        this.#headers(),
        60_000,
      )) as typeof res;
    } catch (err) {
      // Many compatible servers know only the older JSON mode.
      if (!(err instanceof ProviderError) || err.retryable) throw err;
      res = (await postJson(url, body({ type: 'json_object' }), this.#headers(), 60_000)) as typeof res;
    }
    if (res.usage) req.onUsage?.({ input: res.usage.prompt_tokens ?? 0, output: res.usage.completion_tokens ?? 0 });
    return parseOutput(req.schema, res.choices?.[0]?.message?.content ?? '');
  }

  async listModels(): Promise<string[]> {
    const r = (await getJson(`${trimSlash(this.url)}/models`, this.#headers())) as { data?: { id: string }[] };
    // Gemini names its models "models/gemini-...": the name to ask for is the part after it.
    return (r.data ?? []).map((m) => (this.id === 'gemini' ? m.id.replace(/^models\//, '') : m.id)).sort();
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly #client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    // For tests: a local stand-in for the API.
    baseURL?: string,
  ) {
    this.#client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000, ...(baseURL ? { baseURL } : {}) });
  }

  async generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>> {
    let res;
    try {
      res = await this.#client.messages.parse({
        model: this.model,
        max_tokens: 2048,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        // A short, bounded task: low effort keeps it fast and cheap.
        output_config: { format: zodOutputFormat(req.schema), effort: 'low' },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('Claude rejected the API key.');
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError('Claude rate limit reached; try again shortly.', true);
      if (err instanceof Anthropic.APIConnectionError) throw new ProviderError(`Could not reach Claude: ${err.message}`, true);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`Claude error ${err.status}: ${err.message}`, (err.status ?? 0) >= 500);
      throw err;
    }
    req.onUsage?.({ input: res.usage.input_tokens, output: res.usage.output_tokens });
    if (res.stop_reason === 'refusal') throw new ProviderError('Claude declined this request.');
    if (res.parsed_output == null) throw new ProviderError('Claude did not return the expected answer.');
    return res.parsed_output as z.infer<T>;
  }

  async listModels(): Promise<string[]> {
    const out: string[] = [];
    for await (const m of this.#client.models.list()) out.push(m.id);
    return out;
  }
}
