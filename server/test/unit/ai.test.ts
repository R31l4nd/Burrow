import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiSettings, Analysis, CommandSuggestion, LogFilterSuggestion } from '@burrow/shared';
import { testHooks } from '../../src/ai/settings.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A stand-in for Ollama, an OpenAI-compatible server and the Claude API. It
// records requests and answers with whatever the test put in `reply`.

interface Recorded {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let base = '';
const requests: Recorded[] = [];
const COMMAND = {
  command: 'du -sh /data/* | sort -h | tail -5',
  explanation: 'Shows the five largest folders in /data.',
  risk: 'low',
  risk_reason: '',
};
let reply: Record<string, unknown> = COMMAND;
let status = 200;
// Before the answer, as a slow local model would.
let delayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => void new Promise((r) => setTimeout(r, delayMs)).then(() => {
      if (res.destroyed) return;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (status !== 200) {
        res.statusCode = status;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      const text = JSON.stringify(reply);
      if (req.url === '/api/chat') return res.end(JSON.stringify({ message: { role: 'assistant', content: text }, done: true, prompt_eval_count: 120, eval_count: 30 }));
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma4:e2b' }, { name: 'llama3.2:3b' }] }));
      if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 50, completion_tokens: 7 } }));
      if (req.url?.startsWith('/v1/messages')) {
        return res.end(
          JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  testHooks.anthropicBaseUrl = base;
});
afterAll(() => {
  server.close();
});

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  requests.length = 0;
  status = 200;
  reply = COMMAND;
  await t.json('POST', '/api/hosts', { name: 'nas', address: '192.168.1.99', username: 'alice' });
});
afterEach(async () => {
  await t.close();
});

const settings = (patch: Partial<Record<string, unknown>>) => ({
  provider: 'none',
  ollama: { url: base, model: '' },
  anthropic: { model: 'claude-sonnet-5' },
  openai: { url: `${base}/v1`, model: '' },
  ...patch,
});

describe('AI settings', () => {
  it('starts switched off and refuses to answer until configured', async () => {
    expect((await t.json<AiSettings>('GET', '/api/settings/ai')).provider).toBe('none');
    const r = await t.request('POST', '/api/ai/command', { hostId: 1, prompt: 'largest folders' });
    expect(r.json()).toMatchObject({ error: 'ai_not_configured' });
  });

  it('never returns a stored API key and keeps it when the field is left out', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'anthropic', anthropic: { model: 'claude-sonnet-5', apiKey: 'sk-ant-secret-key' } }));
    const s = await t.json<AiSettings>('GET', '/api/settings/ai');
    expect(s.anthropic.hasKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain('sk-ant-secret');
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'anthropic' }));
    expect((await t.json<AiSettings>('GET', '/api/settings/ai')).anthropic.hasKey).toBe(true);
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'anthropic', anthropic: { model: 'claude-sonnet-5', apiKey: '' } }));
    expect((await t.json<AiSettings>('GET', '/api/settings/ai')).anthropic.hasKey).toBe(false);
  });

  it('lists Ollama models', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama' }));
    expect(await t.json('GET', '/api/settings/ai/models?provider=ollama')).toEqual(['gemma4:e2b', 'llama3.2:3b']);
  });

  it('sends the stored key only to the server it was saved for, also when listing the models of another address typed (audit 2026-10-30, A3-SRV-17)', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'openai', openai: { url: `${base}/v1`, model: 'm', apiKey: 'sk-stored-secret' } }));
    // Another server, typed in the form: asked without the stored key.
    const heard: IncomingMessage['headers'][] = [];
    const other = createServer((req, res) => (heard.push(req.headers), res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({ data: [] }))));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      await t.request('POST', '/api/settings/ai/models', { provider: 'openai', url: `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1` });
      expect(heard.length).toBeGreaterThan(0);
      expect(heard.map((h) => h.authorization ?? '').join()).not.toContain('sk-stored-secret');
    } finally {
      other.close();
    }
    // Its own server: the stored key, as before.
    requests.length = 0;
    await t.request('POST', '/api/settings/ai/models', { provider: 'openai', url: `${base}/v1` });
    expect(requests.find((x) => x.path.endsWith('/models'))?.headers.authorization).toBe('Bearer sk-stored-secret');
  });

  it('lists the models of the address typed, without saving it (W-FUNC-07)', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: 'http://elsewhere.invalid:11434', model: 'old' } }));
    expect(await t.json('POST', '/api/settings/ai/models', { provider: 'ollama', url: base })).toEqual(['gemma4:e2b', 'llama3.2:3b']);
    expect((await t.json<AiSettings>('GET', '/api/settings/ai')).ollama).toMatchObject({ url: 'http://elsewhere.invalid:11434', model: 'old' });
  });
});

describe('text to command', () => {
  it('asks Ollama with a JSON schema and host context, but no host identity', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    const r = await t.json<CommandSuggestion>('POST', '/api/ai/command', { hostId: 1, prompt: 'grootste mappen in /data', locale: 'nl' });
    expect(r).toMatchObject({ command: 'du -sh /data/* | sort -h | tail -5', risk: 'low', provider: 'ollama', model: 'gemma4:e2b' });
    const sent = requests.find((x) => x.path === '/api/chat')!;
    expect(sent.body.format).toMatchObject({ type: 'object', required: expect.arrayContaining(['command', 'risk']) });
    const text = JSON.stringify(sent.body.messages);
    expect(text).toContain('grootste mappen in /data');
    expect(text).toContain('Dutch');
    expect(text).not.toContain('192.168.1.99');
    expect(text).not.toContain('nas');
  });

  it('raises a label the model got wrong, never lowers it', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'openai', openai: { url: `${base}/v1`, model: 'local' } }));
    reply = { command: 'rm -rf /data/tmp/*', explanation: 'Clears the temp folder.', risk: 'low', risk_reason: '' };
    const r = await t.json<CommandSuggestion>('POST', '/api/ai/command', { hostId: 1, prompt: 'clear temp' });
    expect(r.risk).toBe('high');
    expect(r.riskReasons.join(' ')).toMatch(/rm/);
    const sent = requests.find((x) => x.path === '/v1/chat/completions')!;
    expect(sent.body.response_format).toMatchObject({ type: 'json_schema' });
  });

  it("a command never carries a control character: a CR in the model's answer acted as Enter", async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'openai', openai: { url: `${base}/v1`, model: 'local' } }));
    reply = { command: 'echo harmless\r echo unexpected\x1b[2J', explanation: '', risk: 'low', risk_reason: '' };
    const r = await t.json<CommandSuggestion>('POST', '/api/ai/command', { hostId: 1, prompt: 'x' });
    expect(r.command).toBe('echo harmless  echo unexpected [2J');
  });

  it('uses Claude through the SDK with structured output and low effort', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'anthropic', anthropic: { model: 'claude-sonnet-5', apiKey: 'sk-ant-test' } }));
    reply = { command: 'docker ps --format "{{.Names}}"', explanation: 'Lists container names.', risk: 'low', risk_reason: '' };
    const r = await t.json<CommandSuggestion>('POST', '/api/ai/command', { hostId: 1, prompt: 'container names' });
    expect(r).toMatchObject({ command: 'docker ps --format "{{.Names}}"', provider: 'anthropic', model: 'claude-sonnet-5' });
    const sent = requests.find((x) => x.path.startsWith('/v1/messages'))!;
    expect(sent.headers['x-api-key']).toBe('sk-ant-test');
    expect(sent.body).toMatchObject({ model: 'claude-sonnet-5', output_config: { effort: 'low', format: { type: 'json_schema' } } });
  });

  it('turns a provider failure into a readable error', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'anthropic', anthropic: { model: 'claude-sonnet-5', apiKey: 'bad' } }));
    status = 401;
    const r = await t.request('POST', '/api/ai/command', { hostId: 1, prompt: 'x' });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'ai_failed', message: 'Claude rejected the API key.' });
  });

  it('the request and the folder are masked before they go: a secret in them does not (AUDIT2 AI-03)', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    await t.json('POST', '/api/ai/command', { hostId: 1, prompt: 'log in with password=hunter2 and list files', cwd: '/srv/token=abc123def/app' });
    const sent = JSON.stringify(requests.at(-1)!.body);
    expect(sent).not.toContain('hunter2');
    expect(sent).not.toContain('abc123def');
    expect(sent).toContain('list files');
  });

  it('records who asked, not what', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    await t.json('POST', '/api/ai/command', { hostId: 1, prompt: 'show my secret plans' });
    const audit = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(audit.some((e) => e.action === 'ai.command')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('secret plans');
  });
});

describe('a question about logs to a filter (N6)', () => {
  const ask = (prompt: string, sources = ['web', 'db']) => t.json<LogFilterSuggestion>('POST', '/api/ai/logfilter', { prompt, sources, locale: 'nl' });

  it("becomes the viewer's own filter: the question and the source names go out, no log line", async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    reply = { query: 'timeout', regex: false, levels: ['error', 'error'], stream: 'stderr', range: '1h', sources: [2], explanation: 'Fouten met timeout van db.' };
    const r = await ask('timeouts in de database het afgelopen uur');
    expect(r).toEqual({ query: 'timeout', regex: false, levels: ['error'], stream: 'e', range: '1h', sources: [1], explanation: 'Fouten met timeout van db.', provider: 'ollama', model: 'gemma4:e2b' });
    const sent = requests.find((x) => x.path === '/api/chat')!;
    expect(sent.body.format).toMatchObject({ type: 'object', required: expect.arrayContaining(['query', 'levels', 'range', 'sources']) });
    const text = JSON.stringify(sent.body.messages);
    expect(text).toContain('timeouts in de database');
    expect(text).toContain('2. db');
    expect(text).toContain('Dutch');
  });

  it('a source number it made up is dropped; a regular expression that does not compile or could run away is searched as text', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    reply = { query: '(a+)+$', regex: true, levels: [], stream: 'all', range: 'tail', sources: [0, 3, 1], explanation: '' };
    expect(await ask('x')).toMatchObject({ query: '(a+)+$', regex: false, sources: [0] });
    reply = { query: 'unclosed(', regex: true, levels: [], stream: 'all', range: 'tail', sources: [], explanation: '' };
    expect(await ask('x')).toMatchObject({ regex: false });
    reply = { query: 'GET /api/\\w+ 5\\d\\d', regex: true, levels: [], stream: 'all', range: 'tail', sources: [], explanation: '' };
    expect(await ask('x')).toMatchObject({ regex: true });
  });

  it('a secret in the question or a source name is masked before it goes', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    reply = { query: '', regex: false, levels: [], stream: 'all', range: 'tail', sources: [], explanation: '' };
    await ask('lines with password=hunter2', ['app token=abc123def']);
    const sent = JSON.stringify(requests.at(-1)!.body);
    expect(sent).not.toContain('hunter2');
    expect(sent).not.toContain('abc123def');
  });

  it('without a model: said, nothing sent', async () => {
    const r = await t.request('POST', '/api/ai/logfilter', { prompt: 'errors', sources: [] });
    expect(r.json()).toMatchObject({ error: 'ai_not_configured' });
    expect(requests).toHaveLength(0);
  });
});

describe('the question to take elsewhere', () => {
  it('is made and masked here, IP addresses too, without a model set up', async () => {
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan', username: 'me' });
    const lines = [
      { i: 0, ts: '2026-09-28T10:00:00Z', text: 'ERROR cannot reach db at 192.168.1.20:5432 password=hunter2' },
      { i: 0, ts: '2026-09-28T10:00:01Z', text: 'ERROR cannot reach db at 192.168.1.20:5432 password=hunter2' },
    ];
    const { text } = await t.json<{ text: string }>('POST', '/api/ai/analyze/prompt', { targets: [{ hostId: h.id, container: 'web' }], lines, lang: 'nl' });
    // As many containers as the log view shows: 100 (it refused more than 20).
    const many = Array.from({ length: 100 }, (_, i) => ({ hostId: h.id, container: `c${i}` }));
    const wide = await t.request('POST', '/api/ai/analyze/prompt', { targets: many, lines: [{ i: 99, ts: null, text: 'ERROR x' }], lang: 'en' });
    expect(wide.statusCode).toBe(200);
    expect(text).toContain('Answer in Dutch');
    expect(text).toContain('cannot reach db');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('192.168.1.20');
    expect(text.length).toBeLessThan(8000);
  });

  it('what is said about the logs is masked too: a host named by its address, a secret in a file path (AUDIT2 AI-03)', async () => {
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: '192.168.5.5', address: '192.168.5.5', username: 'me' });
    const { text } = await t.json<{ text: string }>('POST', '/api/ai/analyze/prompt', {
      targets: [{ hostId: h.id, container: '', file: '/srv/sync/password=hunter2/app.log' }],
      lines: [{ i: 0, ts: null, text: 'ERROR disk full' }],
      lang: 'en',
    });
    expect(text).toContain('disk full');
    expect(text).not.toContain('192.168.5.5');
    expect(text).not.toContain('hunter2');
  });

  it('a log file beside a container: named by its file, with its container or host', async () => {
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan', username: 'me' });
    const { text } = await t.json<{ text: string }>('POST', '/api/ai/analyze/prompt', {
      targets: [
        { hostId: h.id, container: 'web', file: '/app/logs/app.log' },
        { hostId: h.id, container: '', file: '/var/log/syslog' },
      ],
      lines: [
        { i: 0, ts: null, text: 'ERROR cannot write cache' },
        { i: 1, ts: null, text: 'kernel: oom-killer' },
      ],
      lang: 'en',
    });
    expect(text).toContain('- log file /app/logs/app.log of web on');
    expect(text).toContain('- log file /var/log/syslog on');
    expect(text).toContain('app.log (web)');
    expect(text).toContain('cannot write cache');
    // Neither a container nor a file: refused, as is a path that is not one.
    for (const bad of [{ hostId: h.id, container: '' }, { hostId: h.id, container: '', file: 'relative.log' }]) {
      expect((await t.request('POST', '/api/ai/analyze/prompt', { targets: [bad], lines: [], lang: 'en' })).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('analyses as jobs', () => {
  it('go on without the page, are kept, and are listed per container', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    const hosts = await t.json<{ id: number }[]>('GET', '/api/hosts');
    const hostId = hosts[0]!.id;
    const body = { targets: [{ hostId, container: 'web' }], lines: [{ i: 0, ts: null, text: 'ERROR boom' }], lang: 'en' };
    const { id } = await t.json<{ id: number }>('POST', '/api/ai/analyses', body);
    // Nobody follows it: it finishes by itself, and is in the database.
    let a = await t.json<{ status: string; text: string; provider: string }>('GET', `/api/ai/analyses/${id}`);
    for (let n = 0; a.status === 'running' && n < 50; n++) {
      await new Promise((r) => setTimeout(r, 50));
      a = await t.json('GET', `/api/ai/analyses/${id}`);
    }
    expect(a).toMatchObject({ status: 'done', provider: 'ollama:gemma4:e2b' });
    expect(a.text).toContain(JSON.stringify(reply).slice(0, 20));
    const list = await t.json<{ id: number }[]>('GET', `/api/ai/analyses?hostId=${hostId}&container=web`);
    expect(list.map((x) => x.id)).toEqual([id]);
    expect(await t.json('GET', `/api/ai/analyses?hostId=${hostId}&container=db`)).toEqual([]);
    // Of a log file of web: none (the analysis was of its output).
    expect(await t.json('GET', `/api/ai/analyses?hostId=${hostId}&container=web&file=${encodeURIComponent('/app/logs/app.log')}`)).toEqual([]);
  });

  it('can be asked further: each question with the thread before it, masked, kept with the analysis and listed with it (report 0a86b2)', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    const hosts = await t.json<{ id: number }[]>('GET', '/api/hosts');
    const hostId = hosts[0]!.id;
    const done = async (id: number) => {
      let a = await t.json<Analysis>('GET', `/api/ai/analyses/${id}`);
      for (let n = 0; (a.status === 'running' || a.followUps.some((f) => f.status === 'running')) && n < 50; n++) {
        await new Promise((r) => setTimeout(r, 50));
        a = await t.json('GET', `/api/ai/analyses/${id}`);
      }
      return a;
    };
    const { id } = await t.json<{ id: number }>('POST', '/api/ai/analyses', { targets: [{ hostId, container: 'web' }], lines: [{ i: 0, ts: null, text: 'ERROR bad indentation at 290:16' }], lang: 'nl' });
    const first = await done(id);
    expect(first).toMatchObject({ status: 'done', canAsk: true, followUps: [] });

    reply = { answer: 'Line 290: two spaces too few.' };
    requests.length = 0;
    const q1 = await t.json<{ id: number }>('POST', `/api/ai/analyses/${id}/ask`, { question: 'Which line? My token=hunter2 is set.', lang: 'nl' });
    let a = await done(id);
    expect(a.followUps).toEqual([expect.objectContaining({ id: q1.id, status: 'done', ask: expect.stringContaining('Which line?'), text: expect.stringContaining('two spaces too few') })]);
    // The model got the logs and its own answer before the question; the secret never went.
    const sent = requests.find((r) => r.path === '/api/chat')!.body.messages as { role: string; content: string }[];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[0]!.content).toContain('Dutch');
    expect(sent[1]!.content).toContain('bad indentation at 290:16');
    expect(sent[2]!.content).toBe(first.text);
    expect(sent[3]!.content).toContain('Which line?');
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    expect(a.followUps[0]!.ask).not.toContain('hunter2');

    // A second question: the first one and its answer go along.
    requests.length = 0;
    await t.json('POST', `/api/ai/analyses/${id}/ask`, { question: 'And how do I check it?', lang: 'nl' });
    a = await done(id);
    expect(a.followUps.map((f) => f.ask)).toEqual([a.followUps[0]!.ask, 'And how do I check it?']);
    const again = requests.find((r) => r.path === '/api/chat')!.body.messages as { role: string; content: string }[];
    expect(again.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(again[4]!.content).toBe(a.followUps[0]!.text);

    // Listed as one analysis, with its questions; not each question on its own.
    const list = await t.json<Analysis[]>('GET', `/api/ai/analyses?hostId=${hostId}&container=web`);
    expect(list.map((x) => x.id)).toEqual([id]);
    expect(list[0]!.followUps).toHaveLength(2);
    // Not a question of a question, not an empty one, not one no one may read.
    expect((await t.request('POST', `/api/ai/analyses/${q1.id}/ask`, { question: 'x', lang: 'en' })).statusCode).toBe(404);
    expect((await t.request('POST', `/api/ai/analyses/${id}/ask`, { question: '  ', lang: 'en' })).statusCode).toBe(400);
    expect((await t.request('POST', '/api/ai/analyses/999999/ask', { question: 'x', lang: 'en' })).statusCode).toBe(404);
    // Removed with its questions.
    expect((await t.request('DELETE', `/api/ai/analyses/${id}`)).statusCode).toBe(204);
    expect((await t.request('GET', `/api/ai/analyses/${q1.id}`)).statusCode).toBe(404);
  });

  it('a question about a file or its selection: masked, numbered lines, asked further with the file prompt, never among the logs analyses (report 76bcda)', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    const hosts = await t.json<{ id: number }[]>('GET', '/api/hosts');
    const hostId = hosts[0]!.id;
    const done = async (id: number) => {
      let a = await t.json<Analysis>('GET', `/api/ai/analyses/${id}`);
      for (let n = 0; (a.status === 'running' || a.followUps.some((f) => f.status === 'running')) && n < 50; n++) {
        await new Promise((r) => setTimeout(r, 50));
        a = await t.json('GET', `/api/ai/analyses/${id}`);
      }
      return a;
    };
    reply = { answer: 'Line 3 sets the port.' };
    const text = 'services:\n  web:\n    ports: ["8080:80"]\n    environment:\n      DB_PASSWORD: hunter2\n      PEER: 192.168.1.20';
    // Lines 3 to 5 chosen: those go, numbered as in the file; the secret and (to a model elsewhere) the address do not.
    const { id } = await t.json<{ id: number }>('POST', '/api/ai/file', { hostId, path: '/srv/app/compose.yaml', text: text.split('\n').slice(2, 5).join('\n'), firstLine: 3, totalLines: 6, question: 'What does this do?', lang: 'nl' });
    const a = await done(id);
    expect(a).toMatchObject({ status: 'done', kind: 'file', canAsk: true, lines: 3, targets: [{ hostId, container: '', file: '/srv/app/compose.yaml' }] });
    let sent = requests.find((r) => r.path === '/api/chat')!.body.messages as { role: string; content: string }[];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user']);
    expect(sent[0]!.content).toMatch(/file/);
    expect(sent[0]!.content).toContain('Dutch');
    expect(sent[1]!.content).toContain('/srv/app/compose.yaml');
    expect(sent[1]!.content).toContain('lines 3-5 of 6');
    expect(sent[1]!.content).toContain('3| ');
    expect(sent[1]!.content).toContain('What does this do?');
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    expect(JSON.stringify(sent)).not.toContain('192.168.1.20');
    expect(sent[1]!.content).not.toContain('PEER: 192');

    // Asked further: with the file prompt, not the logs one.
    requests.length = 0;
    await t.json('POST', `/api/ai/analyses/${id}/ask`, { question: 'And the port?', lang: 'en' });
    const b = await done(id);
    expect(b.followUps).toHaveLength(1);
    sent = requests.find((r) => r.path === '/api/chat')!.body.messages as { role: string; content: string }[];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[0]!.content).toMatch(/file/);
    expect(sent[0]!.content).not.toMatch(/logs/i);

    // Listed for that file, not among the analyses of logs (the Reports page's list).
    expect((await t.json<Analysis[]>('GET', '/api/ai/analyses')).map((x) => x.id)).not.toContain(id);
    expect((await t.json<Analysis[]>('GET', `/api/ai/analyses?kind=file&hostId=${hostId}&file=${encodeURIComponent('/srv/app/compose.yaml')}`)).map((x) => x.id)).toEqual([id]);
    expect(await t.json('GET', `/api/ai/analyses?kind=file&hostId=${hostId}&file=${encodeURIComponent('/srv/other.yaml')}`)).toEqual([]);

    // A whole file too big for the model: cut, and said so.
    requests.length = 0;
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`).join('\n');
    await done((await t.json<{ id: number }>('POST', '/api/ai/file', { hostId, path: '/srv/big.txt', text: big, firstLine: 1, totalLines: 3000, question: 'Summary?', lang: 'en' })).id);
    const cut = (requests.find((r) => r.path === '/api/chat')!.body.messages as { content: string }[])[1]!.content;
    expect(cut.length).toBeLessThan(14_000);
    expect(cut).toMatch(/cut/);
    // Not a relative path, not without a question, not an unknown host.
    expect((await t.request('POST', '/api/ai/file', { hostId, path: 'compose.yaml', text, question: 'x' })).statusCode).toBe(400);
    expect((await t.request('POST', '/api/ai/file', { hostId, path: '/a', text, question: ' ' })).statusCode).toBe(400);
    expect((await t.request('POST', '/api/ai/file', { hostId: 9999, path: '/a', text, question: 'x' })).statusCode).toBe(404);
  });

  it('an analysis kept from before follow-up questions, or one still being written, cannot be asked further', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    const { analyses } = await import('../../src/db/schema.js');
    const me = t.ctx.db.select().from((await import('../../src/db/schema.js')).users).get()!;
    const old = t.ctx.db.insert(analyses).values({ userId: me.id, targets: '[]', lines: 0, provider: 'x', status: 'done', text: 'an answer', createdAt: t.clock.now }).returning().get();
    expect(await t.json<Analysis>('GET', `/api/ai/analyses/${old.id}`)).toMatchObject({ canAsk: false, followUps: [] });
    const r = await t.request('POST', `/api/ai/analyses/${old.id}/ask`, { question: 'why?', lang: 'en' });
    expect(r.statusCode).toBe(409);
    const running = t.ctx.db.insert(analyses).values({ userId: me.id, targets: '[]', lines: 0, provider: 'x', status: 'running', text: '', prompt: 'logs', createdAt: t.clock.now }).returning().get();
    expect((await t.request('POST', `/api/ai/analyses/${running.id}/ask`, { question: 'why?', lang: 'en' })).statusCode).toBe(409);
  });

  it('keeps one that takes too long, with why, among the container\'s', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' }, timeoutMinutes: 1 }));
    // A "minute" of 100 ms here; the model answers after 400.
    testHooks.minuteMs = 100;
    delayMs = 400;
    try {
      const hosts = await t.json<{ id: number }[]>('GET', '/api/hosts');
      const hostId = hosts[0]!.id;
      // Started at once: the id before any word of the model.
      const { id } = await t.json<{ id: number }>('POST', '/api/ai/analyses', { targets: [{ hostId, container: 'web' }], lines: [{ i: 0, ts: null, text: 'x'.repeat(20_000) }], lang: 'en' });
      let a = await t.json<{ status: string; error: string | null }>('GET', `/api/ai/analyses/${id}`);
      for (let n = 0; a.status === 'running' && n < 40; n++) {
        await new Promise((r) => setTimeout(r, 50));
        a = await t.json('GET', `/api/ai/analyses/${id}`);
      }
      expect(a.status).toBe('failed');
      expect(a.error).toContain('Settings -> AI');
      const list = await t.json<{ id: number; status: string }[]>('GET', `/api/ai/analyses?hostId=${hostId}&container=web`);
      expect(list.map((x) => x.id)).toContain(id);
    } finally {
      testHooks.minuteMs = undefined;
      delayMs = 0;
    }
  });

  it('starts at most thirty an hour for one person', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' } }));
    const { analyses } = await import('../../src/db/schema.js');
    const me = t.ctx.db.select().from((await import('../../src/db/schema.js')).users).get()!;
    for (let i = 0; i < 30; i++) t.ctx.db.insert(analyses).values({ userId: me.id, targets: '[]', lines: 0, provider: 'x', status: 'done', text: '', createdAt: t.clock.now }).run();
    const hosts = await t.json<{ id: number }[]>('GET', '/api/hosts');
    const r = await t.request('POST', '/api/ai/analyses', { targets: [{ hostId: hosts[0]!.id, container: 'web' }], lines: [], lang: 'en' });
    expect(r.statusCode).toBe(429);
  });

  it('one still running when Burrow stopped ends as failed, with why, when it starts again (audit BE-14)', async () => {
    const { analyses } = await import('../../src/db/schema.js');
    const { endInterrupted } = await import('../../src/ai/analyze.js');
    const me = t.ctx.db.select().from((await import('../../src/db/schema.js')).users).get()!;
    const row = t.ctx.db.insert(analyses).values({ userId: me.id, targets: '[]', lines: 0, provider: 'x', status: 'running', text: 'half an answer', createdAt: t.clock.now }).returning().get();
    expect(endInterrupted(t.ctx)).toBeGreaterThanOrEqual(1);
    const a = await t.json<{ status: string; error: string | null; text: string }>('GET', `/api/ai/analyses/${row.id}`);
    expect(a).toMatchObject({ status: 'failed', text: 'half an answer' });
    expect(a.error).toMatch(/restarted/);
  });

  it('count the tokens the provider says, per analysis and in the usage, with a cost when prices are set (report 18efc8)', async () => {
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'ollama', ollama: { url: base, model: 'gemma4:e2b' }, prices: { input: 3, output: 15, currency: 'EUR' } }));
    const hosts = await t.json<{ id: number }[]>('GET', '/api/hosts');
    const { id } = await t.json<{ id: number }>('POST', '/api/ai/analyses', { targets: [{ hostId: hosts[0]!.id, container: 'web' }], lines: [{ i: 0, ts: null, text: 'ERROR boom' }], lang: 'en' });
    let a = await t.json<{ status: string; tokens: { input: number; output: number } | null }>('GET', `/api/ai/analyses/${id}`);
    for (let n = 0; a.status === 'running' && n < 50; n++) {
      await new Promise((r) => setTimeout(r, 50));
      a = await t.json('GET', `/api/ai/analyses/${id}`);
    }
    expect(a.tokens).toEqual({ input: 120, output: 30 });
    // A command through an OpenAI-compatible server is counted too, as a command.
    await t.json('PUT', '/api/settings/ai', settings({ provider: 'openai', openai: { url: `${base}/v1`, model: 'm' }, prices: { input: 3, output: 15, currency: 'EUR' } }));
    await t.json('POST', '/api/ai/command', { hostId: hosts[0]!.id, prompt: 'largest folders' });
    const u = await t.json<{ month: { input: number; output: number; calls: number }; byKind: Record<string, { input: number; calls: number }>; prices: { currency: string } }>('GET', '/api/settings/ai/usage');
    expect(u.month).toEqual({ input: 170, output: 37, calls: 2 });
    expect(u.byKind.analysis).toMatchObject({ input: 120, calls: 1 });
    expect(u.byKind.command).toMatchObject({ input: 50, calls: 1 });
    expect(u.prices.currency).toBe('EUR');
    const { aiCost } = await import('@burrow/shared');
    expect(aiCost(u.month, { input: 3, output: 15, currency: 'EUR' })).toBeCloseTo((170 * 3 + 37 * 15) / 1e6, 10);
    expect(aiCost(u.month, { input: null, output: null, currency: 'EUR' })).toBeNull();
  });

  it('refuses to start without a model, and says why', async () => {
    const hosts = await t.json<{ id: number }[]>('GET', '/api/hosts');
    const r = await t.request('POST', '/api/ai/analyses', { targets: [{ hostId: hosts[0]!.id, container: 'web' }], lines: [], lang: 'en' });
    expect(r.statusCode).toBe(409);
  });
});
