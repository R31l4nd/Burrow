import { afterEach, describe, expect, it, vi } from 'vitest';
import { ollamaStream, openAiStream } from '../../src/ai/stream.js';

// A provider's streamed answer, served by a stubbed fetch.
function serve(body: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
}

async function all(gen: AsyncGenerator<string>): Promise<string> {
  let text = '';
  for await (const piece of gen) text += piece;
  return text;
}

const req = { system: 's', user: 'u' };

afterEach(() => vi.unstubAllGlobals());

describe('streamed answers (AUDIT2 AI-09)', () => {
  it('Ollama: the whole answer up to done', async () => {
    serve('{"message":{"content":"All "}}\n{"message":{"content":"fine."}}\n{"done":true,"eval_count":3}\n');
    expect(await all(ollamaStream('http://ollama', 'm', req))).toBe('All fine.');
  });

  it('Ollama: a body that ends before done is a failed answer, not a short one', async () => {
    serve('{"message":{"content":"The disk is "}}\n');
    await expect(all(ollamaStream('http://ollama', 'm', req))).rejects.toThrow(/ended before the answer was complete/);
  });

  it('OpenAI-compatible: the answer up to [DONE]', async () => {
    serve('data: {"choices":[{"delta":{"content":"All "}}]}\n\ndata: {"choices":[{"delta":{"content":"fine."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    expect(await all(openAiStream('http://llm/v1', 'm', null, req))).toBe('All fine.');
  });

  it('OpenAI-compatible: an error event in a 200 stream fails with its message', async () => {
    serve('data: {"choices":[{"delta":{"content":"The "}}]}\n\ndata: {"error":{"message":"model overloaded"}}\n\n');
    await expect(all(openAiStream('http://llm/v1', 'm', null, req))).rejects.toThrow(/model overloaded/);
  });

  it('OpenAI-compatible: a body that ends without [DONE] or a finish reason is a failed answer', async () => {
    serve('data: {"choices":[{"delta":{"content":"The disk is "}}]}\n\n');
    await expect(all(openAiStream('http://llm/v1', 'm', null, req))).rejects.toThrow(/ended before the answer was complete/);
  });

  it('OpenAI-compatible: a finish reason without [DONE] still counts as complete (servers that leave it out)', async () => {
    serve('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
    expect(await all(openAiStream('http://llm/v1', 'm', null, req))).toBe('ok');
  });
});
