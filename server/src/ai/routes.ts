import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AI_TURNS_SENT,
  aiProvider,
  aiSettingsInput,
  assessCommand,
  commandRequest,
  effectiveConnection,
  LOG_FILTER_RANGES,
  logFilterRequest,
  maskText,
  maxRisk,
  type CommandSuggestion,
  type LogFilterSuggestion,
} from '@burrow/shared';
import { audit } from '../audit.js';
import { hostDefaults } from '../hosts/defaults.js';
import type { Ctx } from '../context.js';
import { getHost, groupMap } from '../hosts/service.js';
import { actor, HttpError, parse, requireAuth } from '../http.js';
import { ProviderError } from './providers.js';
import type { TerminalManager } from '../terminal/manager.js';
import { getAiSettings, probeProvider, providerExternal, providerFor, saveAiSettings } from './settings.js';
import { recordUsage, usageSummary } from './usage.js';

const commandSchema = z.object({
  command: z.string().describe('One shell command line, ready to run'),
  explanation: z.string().describe('One or two sentences: what it does'),
  risk: z.enum(['low', 'medium', 'high']).describe('low: reads only; medium: changes something recoverable; high: can destroy data or cut access'),
  risk_reason: z.string().describe('Empty for low risk; otherwise what could go wrong'),
});

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const filterSchema = z.object({
  query: z.string().describe('Text to look for in each line, or a regular expression when regex is true; empty for no text filter'),
  regex: z.boolean().describe('true when query is a JavaScript regular expression (matched case-insensitively)'),
  levels: z.array(z.enum(LEVELS)).describe('Log levels to show; empty for all levels'),
  stream: z.enum(['all', 'stdout', 'stderr']).describe('Which output stream; all unless the question asks'),
  range: z.enum(LOG_FILTER_RANGES).describe('tail: the latest lines; 15m, 1h, 24h: since that long ago; start: since the container started'),
  sources: z.array(z.number().int()).describe('Numbers of the sources to show, from the list; empty for all'),
  explanation: z.string().describe('One short sentence: what the filter shows'),
});

function filterPrompt(locale: 'en' | 'nl'): string {
  return [
    "You turn a question about logs into the log viewer's own filter. You do not see the logs.",
    'Use the fields you need and leave the others at their neutral value (empty query, regex false, all levels, all streams, tail, all sources).',
    'A regular expression must be short and plain: no lookbehind, no backreferences, no nested quantifiers.',
    `Write the explanation in ${locale === 'nl' ? 'Dutch' : 'English'}.`,
  ].join('\n');
}

/** A model's regular expression: kept only when it is short and compiles; otherwise its text is searched as it is. */
function safeRegex(query: string): boolean {
  if (query.length > 200 || /\(\?<[=!]|\\[1-9]|\)[*+]|[*+]\)[*+]/.test(query)) return false;
  try {
    new RegExp(query, 'i');
    return true;
  } catch {
    return false;
  }
}

function systemPrompt(locale: 'en' | 'nl'): string {
  return [
    'You turn a request into a single shell command for a Linux server administrator.',
    'Use tools that exist on the host described below. Prefer standard options that work on the stated OS.',
    'Return exactly one command line; chain with && or pipes if needed, but no scripts, no comments and no placeholders the user must fill in unless unavoidable (then use <angle brackets>).',
    'Never add sudo unless the task needs root. Never hide destructive effects.',
    'Earlier requests and commands of this conversation may come first: a request can follow up on them (change the last command, or ask why). To a question about a command, answer in the explanation and return that command (changed only if asked).',
    `Write the explanation and the risk reason in ${locale === 'nl' ? 'Dutch' : 'English'}.`,
  ].join('\n');
}

function aiError(err: unknown): never {
  if (err instanceof ProviderError) throw new HttpError(502, 'ai_failed', err.message);
  throw err;
}

/** Earlier turns as context, in few tokens: each request and command cut short, explanations left out (they are the model's own words). */
function earlier(turns: { prompt: string; command: string }[]): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
  return turns.map((x) => `Request: ${cut(x.prompt, 300)}\nCommand: ${cut(x.command, 400)}`).join('\n');
}

export function registerAiRoutes(app: FastifyInstance, ctx: Ctx, terminals: TerminalManager): void {
  app.get('/api/settings/ai', async () => getAiSettings(ctx));

  // Changing where prompts are sent, or storing an API key, needs step-up.
  app.put('/api/settings/ai', { config: { stepUp: true } }, async (req) => {
    const body = parse(aiSettingsInput, req.body);
    const s = saveAiSettings(ctx, body);
    audit(ctx, actor(req), 'settings.ai', null, {
      provider: s.provider,
      keyChanged: body.anthropic.apiKey !== undefined || body.openai.apiKey !== undefined || body.gemini?.apiKey !== undefined,
      // Addresses sent unmasked: said in the audit log (A3-SRV-20).
      unmasked: [...(s.ollama.local ? ['ollama'] : []), ...(s.openai.local ? ['openai'] : [])],
    });
    return s;
  });

  app.get('/api/settings/ai/models', async (req) => {
    const { provider } = parse(z.object({ provider: aiProvider.exclude(['none']) }), req.query);
    const p = probeProvider(ctx, provider);
    if (!p) throw new HttpError(409, 'ai_not_configured', 'Store an API key first.');
    return p.listModels().catch(aiError);
  });

  // The models of the server and key typed in the form, without saving them first (W-FUNC-07: the
  // listing saved the whole form as a side effect, and an empty model with it).
  app.post('/api/settings/ai/models', async (req) => {
    const b = parse(z.object({ provider: aiProvider.exclude(['none']), url: z.url().max(500).optional(), apiKey: z.string().min(1).max(500).optional() }), req.body);
    const p = probeProvider(ctx, b.provider, { url: b.url, apiKey: b.apiKey });
    if (!p) throw new HttpError(409, 'ai_not_configured', 'Store an API key first.');
    return p.listModels().catch(aiError);
  });

  // What the models used, for Settings -> AI (report 18efc8).
  app.get('/api/settings/ai/usage', { config: { auth: 'admin' } }, async () => usageSummary(ctx));

  /**
   * Text to command. The command is only returned, never run: the client
   * puts it on the input line for the user to read and confirm.
   */
  app.post('/api/ai/command', async (req): Promise<CommandSuggestion> => {
    const body = parse(commandRequest, req.body);
    const provider = providerFor(ctx);
    if (!provider) throw new HttpError(409, 'ai_not_configured', 'Choose an AI provider and model under Settings -> AI.');
    const host = getHost(ctx, body.hostId);
    // Asked from a terminal session: one on this host, its conversation so far along.
    // Only the asker's own session (another admin's is not theirs to read or add to, audit 2026-11-05).
    if (body.sessionId) terminals.own(body.sessionId, requireAuth(req).user.id);
    const before = body.sessionId ? terminals.aiTurns(body.sessionId) : [];
    if (body.sessionId && terminals.get(body.sessionId).hostId !== host.id) throw new HttpError(400, 'invalid_session', 'That terminal session is on another host.');
    const eff = effectiveConnection(host, groupMap(ctx), hostDefaults(ctx));
    // Context about the host, not its identity: no address or name is sent.
    const context = [
      `OS: ${host.facts?.os ?? 'unknown Linux'}`,
      `Kernel: ${host.facts?.kernel ?? 'unknown'}`,
      `Shell: ${host.facts?.shell ?? 'unknown'}`,
      `Docker available: ${host.facts ? (host.facts.hasDocker ? 'yes' : 'no') : 'unknown'}`,
      `User: ${eff.username === 'root' ? 'root' : 'regular user (sudo may be needed)'}`,
      body.cwd ? `Current directory: ${body.cwd}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const ips = providerExternal(ctx, provider.id);
    // Kept and sent again masked: what went to the model once, never more (report 411dbe).
    const prompt = maskText(body.prompt, { ips });
    const history = before.slice(-AI_TURNS_SENT);
    const out = await provider
      // The request and the folder masked as log lines are (a secret typed
      // in the question, an address in a path; AUDIT2 AI-03).
      .generate({ name: 'shell_command', schema: commandSchema, system: systemPrompt(body.locale), user: maskText(`${context}\n\n${history.length ? `Earlier in this conversation:\n${earlier(history)}\n\n` : ''}Request: ${prompt}`, { ips }), onUsage: (u) => recordUsage(ctx, 'command', `${provider.id}:${provider.model}`, u) })
      .catch(aiError);
    // One line with no control characters: a CR (or ESC) in a model's
    // answer acted as Enter once it was on the terminal's line.
    // eslint-disable-next-line no-control-regex -- control characters are what it takes out
    const command = out.command.trim().replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    const rules = assessCommand(command);
    audit(ctx, actor(req), 'ai.command', host.name, { provider: provider.id, model: provider.model });
    const suggestion: CommandSuggestion = {
      command,
      explanation: out.explanation.trim(),
      risk: maxRisk(out.risk, rules.risk),
      riskReasons: [...(out.risk !== 'low' && out.risk_reason.trim() ? [out.risk_reason.trim()] : []), ...rules.reasons],
      provider: provider.id,
      model: provider.model,
    };
    if (body.sessionId) terminals.addAiTurn(body.sessionId, { ...suggestion, at: new Date(ctx.now()).toISOString(), prompt });
    return suggestion;
  });

  /**
   * A question about logs to Burrow's own filter (N6). Only the question and
   * the names of the sources go out, masked; never a log line. The answer
   * is set on the page's filter controls, where it is seen and changed.
   */
  app.post('/api/ai/logfilter', async (req): Promise<LogFilterSuggestion> => {
    const body = parse(logFilterRequest, req.body);
    const provider = providerFor(ctx);
    if (!provider) throw new HttpError(409, 'ai_not_configured', 'Choose an AI provider and model under Settings -> AI.');
    const ips = providerExternal(ctx, provider.id);
    const list = body.sources.map((s, i) => `${i + 1}. ${maskText(s, { ips })}`).join('\n');
    const out = await provider
      .generate({ name: 'log_filter', schema: filterSchema, system: filterPrompt(body.locale), user: `Sources:\n${list || '(one)'}\n\nQuestion: ${maskText(body.prompt, { ips })}`, onUsage: (u) => recordUsage(ctx, 'filter', `${provider.id}:${provider.model}`, u) })
      .catch(aiError);
    const query = out.query.replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    audit(ctx, actor(req), 'ai.logfilter', null, { provider: provider.id, model: provider.model });
    return {
      query,
      regex: out.regex && query !== '' && safeRegex(query),
      levels: [...new Set(out.levels)],
      stream: out.stream === 'stdout' ? 'o' : out.stream === 'stderr' ? 'e' : 'all',
      range: out.range,
      // The model counts from 1, as the list it saw; out of range is dropped.
      sources: [...new Set(out.sources.map((n) => n - 1).filter((n) => n >= 0 && n < body.sources.length))],
      explanation: out.explanation.trim().slice(0, 500),
      provider: provider.id,
      model: provider.model,
    };
  });
}
