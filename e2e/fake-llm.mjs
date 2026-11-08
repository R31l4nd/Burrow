// A stand-in OpenAI-compatible server for the end-to-end tests (and two tiny
// web apps for the app tabs). It answers
// every chat completion with a fixed command for the question it recognises.
import { createServer } from 'node:http';

const answers = [
  { match: /grootste mappen|largest folders/i, command: 'du -sh /data/* 2>/dev/null | sort -h | tail -5', explanation: 'Toont de vijf grootste mappen in /data.', risk: 'low' },
  // Deliberately labelled low: Burrow's own rules must raise it.
  { match: /opruimen|clean up/i, command: 'rm -rf /tmp/burrow-e2e/*', explanation: 'Leegt de map.', risk: 'low' },
  // A command with a trace on the host: whether it ran is seen there, not guessed from the screen.
  { match: /leave a mark/i, command: 'touch /tmp/burrow-ai-mark', explanation: 'Makes a marker file.', risk: 'low' },
];

const discord = [];
const pushes = [];
// Every request a model got, whole: a test asks whether a secret was in any of them (AUDIT2 TEST-19).
const asked = [];

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString('utf8');
    res.setHeader('content-type', 'application/json');
    // Two web apps for the app tabs: one that may be framed, one that may not.
    if (req.url === '/app-ok' || req.url === '/app-deny') {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/app-deny') res.setHeader('x-frame-options', 'DENY');
      return res.end(`<!doctype html><title>${req.url}</title><p id="app">${req.url.slice(1)}</p>`);
    }
    // A stand-in Discord webhook: keeps what it gets, and tells on GET.
    if (req.url === '/discord') {
      if (req.method === 'POST') {
        discord.push(JSON.parse(body));
        res.statusCode = 204;
        return res.end();
      }
      return res.end(JSON.stringify(discord));
    }
    // A stand-in push service (Burrow's own push): keeps what came, never the text (it is encrypted).
    if (req.url === '/push') {
      if (req.method === 'POST') {
        // Kept whole (base64) with its signature: the test opens and checks it (AUDIT2 TEST-21).
        pushes.push({ encoding: req.headers['content-encoding'], vapid: /^vapid t=/.test(req.headers.authorization ?? ''), bytes: raw.length, body: raw.toString('base64'), authorization: req.headers.authorization ?? '', endpoint: `http://${req.headers.host}${req.url}` });
        res.statusCode = 201;
        return res.end();
      }
      return res.end(JSON.stringify(pushes));
    }
    if (req.url?.startsWith('/llm-seen?')) {
      const q = new URL(req.url, 'http://x').searchParams.get('q') ?? '';
      return res.end(JSON.stringify({ requests: asked.length, with: asked.filter((b) => b.includes(q)).length }));
    }
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
    if (req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      return res.end('{}');
    }
    asked.push(body);
    const req2 = JSON.parse(body);
    const text = req2.messages.map((m) => m.content).join('\n');
    // The log analysis streams: a fixed answer that quotes the error it was sent.
    if (req2.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const err = /ERROR[^\n]*/.exec(text)?.[0] ?? 'no error';
      // A question asked further on an analysis (report 0a86b2): answered only with the analysis before it.
      const last = req2.messages.at(-1);
      const before = req2.messages.slice(1, -1);
      // A question about a file (report 76bcda): the first line it was sent, by its number.
      const fileLine = /a file on one of their hosts/.test(req2.messages[0].content) ? /^(\d+)\| (.*)$/m.exec(text) : null;
      const pieces = fileLine && before.length < 2
        ? [`## About the file\n`, `Line ${fileLine[1]} reads: ${fileLine[2]}\n`]
        : before.length >= 2
          ? [`Asked further: ${last.content}\n`, before.some((m) => m.role === 'assistant' && /Likely cause/.test(m.content)) && before.some((m) => m.role === 'user' && /ERROR/.test(m.content)) ? 'With the logs and the analysis before it: the line is quoted there.\n' : 'Without the analysis before it.\n']
          : ['## Likely cause\n', `The container stopped after: ${err}\n`, '## Fixes\n- Check the database.\n'];
      for (const piece of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      // Asked for (stream_options): the tokens in a last event, as OpenAI does.
      if (req2.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    // A part of a report: an explanation and fixes.
    if (/periodic report/.test(text)) {
      const content = JSON.stringify({ summary: 'The upstream keeps timing out.', fixes: [
          { step: 'Check the upstream service.', command: 'echo fixed-by-burrow', risk: 'low', risk_reason: '' },
          { step: 'Start it afresh.', command: 'docker rm -f burrowtest-upstream', risk: 'medium', risk_reason: 'removes the container' },
        ],
      });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }));
    }
    // A question about logs: a filter of Burrow's own (N6). "timeouts" from the second source, errors only.
    if (/question about logs/.test(text)) {
      const content = JSON.stringify({ query: 'timeout', regex: false, levels: ['error'], stream: 'all', range: 'tail', sources: [1], explanation: 'Errors with timeout from the first source.' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }));
    }
    // The question asked now: earlier ones of the conversation come before it (report 411dbe).
    const now = text.includes('Request: ') ? text.slice(text.lastIndexOf('Request: ')) : text;
    // A follow-up is understood only with the conversation before it.
    const followUp = /make it recursive/i.test(now) && /Earlier in this conversation:[\s\S]*Command: du -sh/.test(text) ? { command: 'du -ah /data 2>/dev/null | sort -h | tail -5', explanation: 'Now with the files in every folder below too.', risk: 'low' } : null;
    const a = followUp ?? answers.find((x) => x.match.test(now)) ?? { command: 'true', explanation: '?', risk: 'low' };
    const content = JSON.stringify({ command: a.command, explanation: a.explanation, risk: a.risk, risk_reason: '' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
}).listen(8000, '0.0.0.0');
