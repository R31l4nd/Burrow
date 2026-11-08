import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AiUsage } from '@burrow/shared';
import { AnthropicProvider, OllamaProvider, OpenAiCompatibleProvider, ProviderError } from '../../src/ai/providers.js';
import { deepAvailable, isLocalUrl, probeProvider, providerExternal, streamerFor, testHooks } from '../../src/ai/settings.js';
import { anthropicStream, openAiStream } from '../../src/ai/stream.js';
import { makeApp, setupAdmin } from '../helpers.js';

// The model providers against a stand-in server that answers as each API
// does, failures included: what reaches Burrow's pages is a ProviderError
// that says what went wrong and whether trying again may help.

type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
let server: Server;
let base = '';
let handle: Handler;
const seen: { url: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ url: req.url ?? '', body });
      handle(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  seen.length = 0;
});

/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

const json = (status: number, body: unknown): Handler => (_req, res) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** Claude's error body, as the API sends it. */
const claudeError = (status: number, type: string): Handler => json(status, { type: 'error', error: { type, message: `${type} here` } });

/** Claude's streamed answer: server-sent events. */
const claudeStream = (pieces: string[], stopReason = 'end_turn'): Handler => (_req, res) => {
  res.setHeader('content-type', 'text/event-stream');
  const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const text of pieces) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 34 } });
  ev('message_stop', {});
  res.end();
};

async function all(gen: AsyncGenerator<string>): Promise<string> {
  let text = '';
  for await (const piece of gen) text += piece;
  return text;
}

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

const schema = z.object({ answer: z.string() });
const ask = { system: 's', user: 'u', schema, name: 'answer' };

describe('Claude, streamed', () => {
  it('yields the text as it comes and the tokens Claude counted', async () => {
    handle = claudeStream(['The disk ', 'is full.']);
    let usage: AiUsage | null = null;
    const text = await all(anthropicStream('sk-test', 'claude-x', { system: 's', user: 'u', onUsage: (u) => (usage = u) }, base));
    expect(text).toBe('The disk is full.');
    expect(usage).toEqual({ input: 12, output: 34 });
    expect(seen[0]).toMatchObject({ url: '/v1/messages', body: { model: 'claude-x', stream: true, system: 's' } });
  });

  it('a refusal is an error, not an answer', async () => {
    handle = claudeStream([], 'refusal');
    expect((await failure(all(anthropicStream('k', 'm', { system: 's', user: 'u' }, base)))).message).toBe('Claude declined this request.');
  });

  it('says what failed and whether trying again may help: a bad key, the rate limit, a server error, no connection', async () => {
    const stream = (url = base) => all(anthropicStream('k', 'm', { system: 's', user: 'u' }, url));
    handle = claudeError(401, 'authentication_error');
    expect(await failure(stream())).toMatchObject({ message: 'Claude rejected the API key.', retryable: false });
    handle = claudeError(429, 'rate_limit_error');
    expect(await failure(stream())).toMatchObject({ message: 'Claude rate limit reached; try again shortly.', retryable: true });
    handle = claudeError(500, 'api_error');
    expect(await failure(stream())).toMatchObject({ message: expect.stringMatching(/^Claude error 500/), retryable: true });
    handle = claudeError(400, 'invalid_request_error');
    expect(await failure(stream())).toMatchObject({ message: expect.stringMatching(/^Claude error 400/), retryable: false });
    expect(await failure(stream(await deadUrl()))).toMatchObject({ message: expect.stringMatching(/^Could not reach Claude/), retryable: true });
  }, 30_000);
});

describe('Claude, structured', () => {
  const claude = (url = base) => new AnthropicProvider('sk-test', 'claude-x', url);
  const message = (content: unknown[], stopReason = 'end_turn') =>
    json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 6 } });

  it('returns the parsed answer and the tokens', async () => {
    handle = message([{ type: 'text', text: '{"answer":"42"}' }]);
    let usage: AiUsage | null = null;
    expect(await claude().generate({ ...ask, onUsage: (u) => (usage = u) })).toEqual({ answer: '42' });
    expect(usage).toEqual({ input: 5, output: 6 });
  });

  it('a refusal, or no answer at all, is an error', async () => {
    handle = message([{ type: 'text', text: '{"answer":"no"}' }], 'refusal');
    expect((await failure(claude().generate(ask))).message).toBe('Claude declined this request.');
    handle = message([]);
    expect((await failure(claude().generate(ask))).message).toBe('Claude did not return the expected answer.');
  });

  it('turns API failures into readable ones', async () => {
    handle = claudeError(429, 'rate_limit_error');
    expect(await failure(claude().generate(ask))).toMatchObject({ retryable: true, message: expect.stringContaining('rate limit') });
    handle = claudeError(503, 'overloaded_error');
    expect(await failure(claude().generate(ask))).toMatchObject({ retryable: true, message: expect.stringMatching(/^Claude error 503/) });
    expect(await failure(claude(await deadUrl()).generate(ask))).toMatchObject({ retryable: true, message: expect.stringMatching(/^Could not reach Claude/) });
  }, 30_000);

  it('lists the models', async () => {
    handle = json(200, { data: [{ type: 'model', id: 'claude-a', display_name: 'A', created_at: '2026-01-01T00:00:00Z' }, { type: 'model', id: 'claude-b', display_name: 'B', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-a', last_id: 'claude-b' });
    expect(await claude().listModels()).toEqual(['claude-a', 'claude-b']);
  });
});

describe('OpenAI-compatible', () => {
  it('streams with usage, and asks again without it from a server that does not know stream_options', async () => {
    handle = (_req, res, body) => {
      if (body.stream_options) return json(400, { error: { message: 'Unrecognized request argument supplied: stream_options' } })(_req, res, body);
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
    };
    let usage: AiUsage | null = null;
    expect(await all(openAiStream(`${base}/v1/`, 'm', 'sk', { system: 's', user: 'u', onUsage: (u) => (usage = u) }))).toBe('ok');
    expect(seen.map((s) => [s.url, !!s.body.stream_options])).toEqual([['/v1/chat/completions', true], ['/v1/chat/completions', false]]);
    expect(usage).toEqual({ input: 3, output: 1 });
    // A string as the error in the stream.
    handle = (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"error":"quota exceeded"}\n\n');
    };
    expect(await failure(all(openAiStream(`${base}/v1`, 'm', null, { system: 's', user: 'u' })))).toMatchObject({ message: expect.stringContaining('quota exceeded'), retryable: true });
  });

  it('a refusal for another reason is not asked again; a server error may be tried again', async () => {
    handle = json(400, { error: { message: 'model not found' } });
    seen.length = 0;
    expect(await failure(all(openAiStream(`${base}/v1`, 'm', null, { system: 's', user: 'u' })))).toMatchObject({ retryable: false, message: expect.stringContaining('answered 400') });
    expect(seen).toHaveLength(1);
    handle = json(502, 'bad gateway');
    expect(await failure(all(openAiStream(`${base}/v1`, 'm', null, { system: 's', user: 'u' })))).toMatchObject({ retryable: true });
    expect(await failure(all(openAiStream(`${await deadUrl()}/v1`, 'm', null, { system: 's', user: 'u' })))).toMatchObject({ retryable: true, message: expect.stringMatching(/^Could not reach/) });
  });

  it("structured: falls back to JSON mode when the server knows no json_schema, and sends the key", async () => {
    handle = (req, res, body) => {
      if ((body.response_format as { type: string }).type === 'json_schema') return json(400, { error: { message: 'response_format json_schema unsupported' } })(req, res, body);
      json(200, { choices: [{ message: { content: '```json\n{"answer":"yes"}\n```' } }] })(req, res, body);
    };
    expect(await new OpenAiCompatibleProvider(`${base}/v1`, 'm', 'sk-secret').generate(ask)).toEqual({ answer: 'yes' });
    expect(seen.map((s) => (s.body.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);
  });

  it('structured: a server error is not answered with the older mode', async () => {
    handle = json(500, 'oops');
    expect(await failure(new OpenAiCompatibleProvider(`${base}/v1`, 'm', null).generate(ask))).toMatchObject({ retryable: true });
    expect(seen).toHaveLength(1);
  });

  it('lists the models, sorted', async () => {
    handle = json(200, { data: [{ id: 'b' }, { id: 'a' }] });
    expect(await new OpenAiCompatibleProvider(`${base}/v1`, 'm', null).listModels()).toEqual(['a', 'b']);
    handle = json(200, {});
    expect(await new OpenAiCompatibleProvider(`${base}/v1`, 'm', null).listModels()).toEqual([]);
  });
});

describe('Ollama, and answers that are not what was asked for', () => {
  it('an answer that is not JSON, or not of the shape asked for, is an error that says so', async () => {
    const ollama = new OllamaProvider(base, 'm');
    handle = json(200, { message: { content: 'Sure! Here you go.' }, done: true });
    expect((await failure(ollama.generate(ask))).message).toBe('The model did not return valid JSON.');
    handle = json(200, { message: { content: '{"answer":42}' }, done: true });
    expect((await failure(ollama.generate(ask))).message).toMatch(/did not match the expected shape/);
    handle = json(200, 'not json at all');
    expect((await failure(ollama.generate(ask))).message).toMatch(/returned something that is not JSON/);
  });

  it('a server that cannot be reached or refuses the list says so', async () => {
    expect(await failure(new OllamaProvider(await deadUrl(), 'm').listModels())).toMatchObject({ retryable: true, message: expect.stringMatching(/^Could not reach/) });
    expect(await failure(new OllamaProvider(await deadUrl(), 'm').generate(ask))).toMatchObject({ retryable: true });
    handle = json(500, {});
    expect(await failure(new OllamaProvider(base, 'm').listModels())).toMatchObject({ message: expect.stringContaining('answered 500') });
  });
});

describe('which provider answers', () => {
  it('streams from the configured one, or from Claude for a deeper look; a key is needed for Claude', async () => {
    const t = await makeApp();
    try {
      await setupAdmin(t);
      const put = (s: object) => t.json('PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-x' }, openai: { url: 'https://llm.example.com/v1', model: 'gpt-x', apiKey: 'sk-o' }, ...s });
      await put({});
      expect(streamerFor(t.ctx)).toMatchObject({ id: 'openai', model: 'gpt-x', external: true });
      expect(streamerFor(t.ctx, true)).toBeNull();
      expect(deepAvailable(t.ctx)).toBe(false);
      expect(probeProvider(t.ctx, 'anthropic')).toBeNull();
      expect(probeProvider(t.ctx, 'openai')).toMatchObject({ id: 'openai', model: 'gpt-x' });

      await put({ anthropic: { model: 'claude-x', apiKey: 'sk-a' } });
      expect(deepAvailable(t.ctx)).toBe(true);
      const deep = streamerFor(t.ctx, true)!;
      expect(deep).toMatchObject({ id: 'anthropic', model: 'claude-x', external: true });
      expect(probeProvider(t.ctx, 'anthropic')).toMatchObject({ id: 'anthropic' });
      // It streams from Claude with the stored key.
      const before = testHooks.anthropicBaseUrl;
      testHooks.anthropicBaseUrl = base;
      try {
        handle = (req, res, body) => {
          expect(req.headers['x-api-key']).toBe('sk-a');
          claudeStream(['deep'])(req, res, body);
        };
        expect(await all(streamerFor(t.ctx, true)!.stream({ system: 's', user: 'u' }))).toBe('deep');
      } finally {
        testHooks.anthropicBaseUrl = before;
      }
      await put({ provider: 'anthropic', anthropic: { model: 'claude-x' } });
      expect(deepAvailable(t.ctx)).toBe(false);
      expect(streamerFor(t.ctx)).toMatchObject({ id: 'anthropic' });
      await put({ provider: 'openai', openai: { url: 'https://llm.example.com/v1', model: '' } });
      expect(streamerFor(t.ctx)).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('addresses are masked for every server unless the admin says it runs on their own network (A3-SRV-20)', async () => {
    const t = await makeApp();
    try {
      await setupAdmin(t);
      const put = (s: object) => t.json('PUT', '/api/settings/ai', { provider: 'ollama', ollama: { url: 'http://gpu:11434', model: 'm' }, anthropic: { model: 'claude-x' }, openai: { url: 'http://llm.lan/v1', model: 'o' }, ...s });
      // A single-label or .lan name may be a rented box over a VPN: not local by its name.
      await put({});
      expect(streamerFor(t.ctx)).toMatchObject({ id: 'ollama', external: true });
      expect(providerExternal(t.ctx, 'ollama')).toBe(true);
      expect(providerExternal(t.ctx, 'openai')).toBe(true);
      expect(await t.json('GET', '/api/settings/ai')).toMatchObject({ ollama: { local: false }, openai: { local: false } });
      await put({ ollama: { url: 'http://gpu:11434', model: 'm', local: true } });
      expect(streamerFor(t.ctx)).toMatchObject({ id: 'ollama', external: false });
      expect(providerExternal(t.ctx, 'ollama')).toBe(false);
      expect(providerExternal(t.ctx, 'openai')).toBe(true);
      await put({ provider: 'openai', openai: { url: 'http://llm.lan/v1', model: 'o', local: true } });
      expect(streamerFor(t.ctx)).toMatchObject({ id: 'openai', external: false });
      expect(providerExternal(t.ctx, 'ollama')).toBe(true);
      // Claude is never local.
      expect(providerExternal(t.ctx, 'anthropic')).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("Gemini: through Google's OpenAI-compatible endpoint with its own key, kept and never sent back; its models without \"models/\"; always external", async () => {
    const t = await makeApp();
    const before = testHooks.geminiBaseUrl;
    testHooks.geminiBaseUrl = `${base}/gemini`;
    try {
      await setupAdmin(t);
      const old = { provider: 'gemini', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-x' }, openai: { url: 'https://llm.example.com/v1', model: '' } };
      const put = (gemini: object, s: object = {}) => t.json('PUT', '/api/settings/ai', { ...old, gemini, ...s });
      // No key yet: nothing to ask.
      await put({ model: 'gemini-a' });
      expect(streamerFor(t.ctx)).toBeNull();
      expect(probeProvider(t.ctx, 'gemini')).toBeNull();
      // A key, no model yet: the models can be listed, nothing answers.
      await put({ model: '', apiKey: 'AIza-test' });
      const got = await t.json('GET', '/api/settings/ai');
      expect(got).toMatchObject({ provider: 'gemini', gemini: { model: '', hasKey: true } });
      expect(JSON.stringify(got)).not.toContain('AIza-test');
      expect(streamerFor(t.ctx)).toBeNull();
      handle = (req, res, body) => {
        expect(req.headers.authorization).toBe('Bearer AIza-test');
        json(200, { object: 'list', data: [{ id: 'models/gemini-b' }, { id: 'models/gemini-a' }] })(req, res, body);
      };
      expect(await t.json('POST', '/api/settings/ai/models', { provider: 'gemini' })).toEqual(['gemini-a', 'gemini-b']);
      expect(seen.at(-1)!.url).toBe('/gemini/models');
      // A key typed and not saved is the one asked with.
      handle = (req, res, body) => {
        expect(req.headers.authorization).toBe('Bearer AIza-typed');
        json(200, { data: [{ id: 'models/gemini-c' }] })(req, res, body);
      };
      expect(await t.json('POST', '/api/settings/ai/models', { provider: 'gemini', apiKey: 'AIza-typed' })).toEqual(['gemini-c']);
      // The model chosen, the key not sent again: the stored one stays and answers.
      await put({ model: 'gemini-a' });
      expect(await t.json('GET', '/api/settings/ai')).toMatchObject({ gemini: { model: 'gemini-a', hasKey: true } });
      const streamer = streamerFor(t.ctx)!;
      expect(streamer).toMatchObject({ id: 'gemini', model: 'gemini-a', external: true });
      expect(providerExternal(t.ctx, 'gemini')).toBe(true);
      handle = (req, res) => {
        expect(req.headers.authorization).toBe('Bearer AIza-test');
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      };
      expect(await all(streamer.stream({ system: 's', user: 'u' }))).toBe('hi');
      expect(seen.at(-1)).toMatchObject({ url: '/gemini/chat/completions', body: { model: 'gemini-a' } });
      handle = json(200, { choices: [{ message: { content: '{"answer":"yes"}' } }] });
      expect(await probeProvider(t.ctx, 'gemini')!.generate(ask)).toEqual({ answer: 'yes' });
      // A client from before Gemini sends none: what is stored stays.
      await t.json('PUT', '/api/settings/ai', { ...old, provider: 'ollama', ollama: { url: 'http://ollama:11434', model: 'm' } });
      expect(await t.json('GET', '/api/settings/ai')).toMatchObject({ provider: 'ollama', gemini: { model: 'gemini-a', hasKey: true } });
      // An empty key removes it.
      await put({ model: 'gemini-a', apiKey: '' });
      expect(await t.json('GET', '/api/settings/ai')).toMatchObject({ gemini: { model: 'gemini-a', hasKey: false } });
      expect(streamerFor(t.ctx)).toBeNull();
    } finally {
      testHooks.geminiBaseUrl = before;
      await t.close();
    }
  });

  it('only a parsable URL is local', () => {
    expect(isLocalUrl('not a url')).toBe(false);
    expect(isLocalUrl('http://ollama:11434')).toBe(true);
  });
});
