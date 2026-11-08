import Anthropic from '@anthropic-ai/sdk';
import type { AiUsage } from '@burrow/shared';
import { ProviderError } from './providers.js';

// Streaming plain text from a model, for answers people read as they come
// (log analysis). One function per API; each yields text pieces.

export interface TextRequest {
  system: string;
  /** The turns before (a question asked further: the logs, the answer, earlier questions). */
  earlier?: { role: 'user' | 'assistant'; content: string }[];
  user: string;
  /** Told the tokens the provider counted, at the end, when it says. */
  onUsage?: (u: AiUsage) => void;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** A stream that stops without the provider's end: the answer so far is not the answer. */
const cutShort = (who: string) => new ProviderError(`${who} ended before the answer was complete.`, true);

async function open(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      // The whole answer, the body too: a local model may first have to load
      // (Settings -> AI sets how long).
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`, true);
  }
  if (!res.ok || !res.body) throw new ProviderError(`${new URL(url).host} answered ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status >= 500);
  return res;
}

/** The lines of a streamed response body. */
export async function* bodyLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let pending = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      yield pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
    }
  }
  if (pending.trim()) yield pending;
}

/** Ollama: newline-delimited JSON, `message.content` per line. */
export async function* ollamaStream(url: string, model: string, req: TextRequest, timeoutMs = 600_000): AsyncGenerator<string> {
  const res = await open(`${trimSlash(url)}/api/chat`, {
    model,
    stream: true,
    options: { temperature: 0.2 },
    messages: [{ role: 'system', content: req.system }, ...(req.earlier ?? []), { role: 'user', content: req.user }],
  }, {}, timeoutMs);
  for await (const line of bodyLines(res.body!)) {
    if (!line.trim()) continue;
    const j = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean; prompt_eval_count?: number; eval_count?: number };
    if (j.error) throw new ProviderError(`Ollama: ${j.error}`);
    if (j.message?.content) yield j.message.content;
    // The last line says done and counts the tokens.
    if (j.done) {
      if (j.prompt_eval_count !== undefined || j.eval_count !== undefined) req.onUsage?.({ input: j.prompt_eval_count ?? 0, output: j.eval_count ?? 0 });
      return;
    }
  }
  throw cutShort('Ollama');
}

/** OpenAI-compatible: server-sent events, `choices[0].delta.content`, ended by [DONE]. */
export async function* openAiStream(url: string, model: string, apiKey: string | null, req: TextRequest, timeoutMs = 600_000): AsyncGenerator<string> {
  const body = (usage: boolean) => ({
    model,
    stream: true,
    // The last event then carries the tokens; a server that does not know
    // the option is asked again without it.
    ...(usage ? { stream_options: { include_usage: true } } : {}),
    temperature: 0.2,
    messages: [{ role: 'system', content: req.system }, ...(req.earlier ?? []), { role: 'user', content: req.user }],
  });
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  let res: Response;
  try {
    res = await open(`${trimSlash(url)}/chat/completions`, body(true), headers, timeoutMs);
  } catch (err) {
    if (!(err instanceof ProviderError) || err.retryable || !/stream_options|include_usage/i.test(err.message)) throw err;
    res = await open(`${trimSlash(url)}/chat/completions`, body(false), headers, timeoutMs);
  }
  // Ended by [DONE]; a server that leaves that out has at least said why the answer stopped.
  let finished = false;
  for await (const line of bodyLines(res.body!)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    const j = JSON.parse(data) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } | null; error?: { message?: string } | string };
    // An error can come in a stream that started with 200.
    if (j.error) throw new ProviderError(`${new URL(url).host}: ${typeof j.error === 'string' ? j.error : (j.error.message ?? 'an error in the answer')}`.slice(0, 400), true);
    if (j.usage) req.onUsage?.({ input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 });
    const piece = j.choices?.[0]?.delta?.content;
    if (piece) yield piece;
    if (j.choices?.[0]?.finish_reason) finished = true;
  }
  if (!finished) throw cutShort(new URL(url).host);
}

/** Claude, with the SDK's stream. */
export async function* anthropicStream(apiKey: string, model: string, req: TextRequest, baseURL?: string): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey, maxRetries: 1, ...(baseURL ? { baseURL } : {}) });
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 8000,
      system: req.system,
      messages: [...(req.earlier ?? []), { role: 'user', content: req.user }],
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
    const final = await stream.finalMessage();
    req.onUsage?.({ input: final.usage.input_tokens, output: final.usage.output_tokens });
    if (final.stop_reason === 'refusal') throw new ProviderError('Claude declined this request.');
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('Claude rejected the API key.');
    if (err instanceof Anthropic.RateLimitError) throw new ProviderError('Claude rate limit reached; try again shortly.', true);
    if (err instanceof Anthropic.APIConnectionError) throw new ProviderError(`Could not reach Claude: ${err.message}`, true);
    if (err instanceof Anthropic.APIError) throw new ProviderError(`Claude error ${err.status}: ${err.message}`, (err.status ?? 0) >= 500);
    throw err;
  }
}
