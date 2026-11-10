import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { analysisAsk, analyzeInput, fileAskInput, groupLines, maskText, MAX_FOLLOW_UPS, plural, validLogSource, renderGroups, targetLabel, type AiUsage, type Analysis, type ContainerInfo, type HostContainers, type AnalyzeInput, type FileAskInput } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { logFilesOf } from '../docker/logfiles.js';
import type { DockerMonitor } from '../docker/monitor.js';
import { getHost } from '../hosts/service.js';
import { analyses } from '../db/schema.js';
import { actor, HttpError, idParam, parse, requireAuth } from '../http.js';
import { deepAvailable, getAiSettings, streamerFor } from './settings.js';
import type { TextRequest } from './stream.js';
import { recordUsage } from './usage.js';

// "Analyse": the log lines someone is looking at, made small and safe
// (grouped, errors first, secrets masked, IP addresses too when the model is
// not local), with what Docker knows about the containers, to the language
// model. The answer streams back as text in fixed sections.

// Characters of log text the model gets: small models have small windows.
const BUDGET_LOCAL = 12_000;
// Claude's and Gemini's windows: room for more.
const BUDGET_CLAUDE = 60_000;
const budgetFor = (id: string) => (id === 'anthropic' || id === 'gemini' ? BUDGET_CLAUDE : BUDGET_LOCAL);

const SECTIONS = {
  en: ['What is happening', 'Problems (severity)', 'Likely cause', 'Fixes'],
  nl: ['Wat gebeurt er', 'Problemen (ernst)', 'Waarschijnlijke oorzaak', 'Oplossingen'],
};

export function systemPrompt(lang: 'en' | 'nl'): string {
  const s = SECTIONS[lang];
  return [
    'You analyse logs of Docker containers for the person who runs them, a homelab administrator.',
    'The logs are grouped: each group is one kind of line, with how often it occurred, its level and one example; errors and warnings come first.',
    'Values like <secret>, <email> and <ip> were masked on purpose; do not ask for them.',
    `Answer in ${lang === 'nl' ? 'Dutch' : 'English'}, in Markdown, with exactly these four sections as "## " headings: ${s.map((x) => `"${x}"`).join(', ')}.`,
    'Be concrete: name the container, quote the telling line, and give commands or settings to check or change. If the logs show nothing wrong, say so plainly and keep it short.',
    'Rate each problem as low, medium or high. Do not invent facts that the logs and the container state do not show.',
  ].join('\n');
}

/** A question asked further on an analysis: the logs and the answers before it are the turns before (report 0a86b2). */
export function followUpPrompt(lang: 'en' | 'nl'): string {
  return [
    'You analysed logs of Docker containers for the person who runs them, a homelab administrator. The logs, grouped and masked, and your analysis come first; then the person asks further.',
    'Values like <secret>, <email> and <ip> were masked on purpose; do not ask for them.',
    `Answer the last question in ${lang === 'nl' ? 'Dutch' : 'English'}, in Markdown, short and concrete, without the fixed sections of the analysis.`,
    'Do not invent facts that the logs and the container state do not show; say so when they do not tell.',
  ].join('\n');
}

/** A question about a file or the lines chosen in it (report 76bcda); the answer is read, never applied. */
export function filePrompt(lang: 'en' | 'nl'): string {
  return [
    'You help a homelab administrator with a file on one of their hosts: a configuration, a compose file, a script or code.',
    'The file, or the part of it they chose, comes with each line numbered as in the file ("12| ..."); a part may be cut where it was too long, which is said.',
    'Values like <secret>, <email> and <ip> were masked on purpose; do not ask for them.',
    `Answer the question in ${lang === 'nl' ? 'Dutch' : 'English'}, in Markdown, concrete and short: name the lines you mean by number, and give a change as a code block of the lines as they would read.`,
    'You change nothing yourself and nothing you write is applied; do not invent what the file does not show, and say so when it does not tell.',
  ].join('\n');
}

/** A question asked further on a question about a file. */
export function fileFollowUpPrompt(lang: 'en' | 'nl'): string {
  return [
    'You answered a homelab administrator about a file on one of their hosts. The file (or a part, its lines numbered), the question and your answer come first; then the person asks further.',
    'Values like <secret>, <email> and <ip> were masked on purpose; do not ask for them.',
    `Answer the last question in ${lang === 'nl' ? 'Dutch' : 'English'}, in Markdown, short and concrete; nothing you write is applied.`,
  ].join('\n');
}

/** The file's lines (masked, numbered as in the file) within the budget, and the question. */
function fileQuestion(ctx: Ctx, body: FileAskInput, opts: { ips: boolean; budget: number }): { user: string; lines: number; question: string } {
  const host = getHost(ctx, body.hostId).name;
  // Masked only as far as can be sent: a whole file through the masks took seconds (audit 2026-11-09).
  const count = body.text.split('\n').length;
  const lines = maskText(body.text.slice(0, opts.budget + 4096), opts).split('\n');
  const last = body.firstLine + count - 1;
  const total = Math.max(body.totalLines ?? last, last);
  const part = body.firstLine > 1 || last < total ? `lines ${body.firstLine}-${last} of ${total}` : `all ${plural(total, 'line', 'lines')}`;
  const out: string[] = [];
  let used = 0;
  for (const [i, l] of lines.entries()) {
    const row = `${body.firstLine + i}| ${l.slice(0, 2000)}`;
    if (used + row.length > opts.budget) {
      out.push(`(cut here: lines ${body.firstLine + i}-${last} did not fit and were not sent)`);
      break;
    }
    out.push(row);
    used += row.length + 1;
  }
  const question = maskText(body.question, opts);
  const user = [`File ${maskText(body.path, opts)} on host ${maskText(host, opts)}, ${part}:`, '', out.join('\n'), '', `Question: ${question}`].join('\n');
  return { user, lines: count, question };
}

function describe(c: ContainerInfo | undefined, name: string, host: string): string {
  if (!c) return `- ${name} on ${host}: not found now`;
  const parts = [`image ${c.image}`, `state ${c.state}`];
  if (c.health) parts.push(`health ${c.health}`);
  if (c.restarts) parts.push(plural(c.restarts, 'restart', 'restarts'));
  if (c.state === 'exited' || c.exitCode) parts.push(`exit code ${c.exitCode}`);
  if (c.oomKilled) parts.push('killed for memory (OOM)');
  if (c.startedAt) parts.push(`started ${c.startedAt}`);
  return `- ${name} on ${host}: ${parts.join(', ')}`;
}

// A question to take to Claude or ChatGPT in the person's own browser: IP
// addresses masked too (it leaves the house), and short enough for a link.
const BUDGET_HANDOFF = 5_000;

/** The model's question: what Docker knows about the containers, and the grouped, masked lines. */
/** The lines that fit in `budget` characters, and how many more there were (a hundred sources' descriptions outgrew a pasted prompt, AUDIT2 AI-07). */
function within(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget && out.length) {
      out.push(`- ... and ${lines.length - out.length} more`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out;
}

async function question(ctx: Ctx, monitor: DockerMonitor, body: AnalyzeInput, opts: { ips: boolean; budget: number }): Promise<string> {
  const context: string[] = [];
  const labels: string[] = [];
  // One look per host (several containers of one host share it), recent is fine.
  const snaps = new Map<number, Promise<HostContainers | null>>();
  for (const t of body.targets) {
    const host = getHost(ctx, t.hostId);
    if (!snaps.has(t.hostId)) snaps.set(t.hostId, monitor.recent(t.hostId).catch(() => null));
    const snap = await snaps.get(t.hostId)!;
    const label = targetLabel(t);
    if (!t.file) context.push(describe(snap?.containers.find((c) => c.name === t.container), t.container, host.name));
    else context.push(`- log file ${t.file}${t.container ? ` of ${describe(snap?.containers.find((c) => c.name === t.container), t.container, host.name).slice(2)}` : ` on ${host.name}`}`);
    labels.push(body.targets.length > 1 || new Set(body.targets.map((x) => x.hostId)).size > 1 ? `${label}@${host.name}` : label);
  }
  const { groups, total, omitted } = groupLines(
    body.lines.map((l) => ({ source: labels[l.i] ?? '?', ts: l.ts, text: l.text })),
    opts,
  );
  // All of it masked, not only the log lines: a host named by its address,
  // a secret in a file path or a label went as it was (AUDIT2 AI-03).
  return maskText(
    [
      'Containers and log files:',
      ...within(context, opts.budget / 4),
      '',
      `Logs: ${body.lines.length} lines in ${total} groups${omitted ? ` (${omitted} rare, low-level groups left out)` : ''}:`,
      renderGroups(groups) || '(no lines)',
    ].join('\n'),
    opts,
  );
}

// ---- analyses as jobs: the model's answer is written to the database as it
// comes, so a reload or a dropped connection loses nothing; each container
// keeps its finished analyses (the newest KEEP of all).

const KEEP = 300;
// A person starts at most this many analyses an hour (a Claude key costs money).
const PER_HOUR = 30;

function allowed(ctx: Ctx, userId: number): void {
  const n = ctx.db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.userId, userId), gte(analyses.createdAt, ctx.now() - 3600_000)))
    .all().length;
  if (n >= PER_HOUR) throw new HttpError(429, 'too_many_analyses', `${PER_HOUR} analyses an hour at most; try again later.`);
}

interface Job {
  text: string;
}
const jobs = new Map<number, Job>();

type Row = typeof analyses.$inferSelect;

const questionsOf = (ctx: Ctx, id: number): Row[] => ctx.db.select().from(analyses).where(eq(analyses.parentId, id)).orderBy(asc(analyses.id)).all();

function toAnalysis(ctx: Ctx, r: Row): Analysis {
  const live = jobs.get(r.id);
  const questions = r.parentId === null ? questionsOf(ctx, r.id) : [];
  return {
    id: r.id,
    kind: r.kind,
    targets: JSON.parse(r.targets) as Analysis['targets'],
    lines: r.lines,
    provider: r.provider,
    status: r.status,
    text: live ? live.text : r.text,
    error: r.error,
    createdAt: new Date(r.createdAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
    tokens: r.tokensIn !== null || r.tokensOut !== null ? { input: r.tokensIn ?? 0, output: r.tokensOut ?? 0 } : null,
    ask: r.ask,
    followUps: questions.map((q) => toAnalysis(ctx, q)),
    canAsk: r.parentId === null && r.prompt !== null && r.status === 'done' && questions.length < MAX_FOLLOW_UPS && questions.every((q) => q.status !== 'running'),
  };
}

/**
 * Starts the model on a question; returns the analysis' id at once. Kept
 * from the start: an answer that fails or takes too long is among the
 * container's analyses too, with why.
 */
async function startJob(
  ctx: Ctx,
  userId: number,
  what: Pick<Row, 'targets' | 'lines'> & Partial<Pick<Row, 'prompt' | 'parentId' | 'ask' | 'kind'>>,
  streamer: NonNullable<ReturnType<typeof streamerFor>>,
  req: Omit<TextRequest, 'onUsage'>,
): Promise<number> {
  allowed(ctx, userId);
  let usage: AiUsage | null = null;
  const gen = streamer.stream({ ...req, onUsage: (u) => (usage = u) });
  const row = ctx.db
    .insert(analyses)
    .values({ userId, ...what, provider: `${streamer.id}:${streamer.model}`, status: 'running', text: '', createdAt: ctx.now() })
    .returning()
    .get();
  const job: Job = { text: '' };
  jobs.set(row.id, job);
  const push = (piece: string) => {
    job.text += piece;
  };
  let saved = 0;
  const save = (force = false) => {
    if (!force && ctx.now() - saved < 1000) return;
    saved = ctx.now();
    ctx.db.update(analyses).set({ text: job.text }).where(eq(analyses.id, row.id)).run();
  };
  void (async () => {
    let error: string | null = null;
    try {
      for await (const piece of gen) {
        push(piece);
        save();
      }
    } catch (err) {
      error =
        (err as Error).name === 'TimeoutError' || /aborted due to timeout/.test((err as Error).message)
          ? `No complete answer within ${Math.round(streamer.timeoutMs / 60_000) || 1} min. A slow local model may get more time in Settings -> AI.`
          : (err as Error).message;
      push(`\n\nWarning: ${error}`);
    }
    const used = usage as AiUsage | null;
    ctx.db.update(analyses).set({ text: job.text, status: error ? 'failed' : 'done', error, finishedAt: ctx.now(), tokensIn: used?.input ?? null, tokensOut: used?.output ?? null }).where(eq(analyses.id, row.id)).run();
    recordUsage(ctx, 'analysis', `${streamer.id}:${streamer.model}`, used);
    jobs.delete(row.id);
    // The newest KEEP stay.
    const cut = ctx.db.select({ id: analyses.id }).from(analyses).orderBy(desc(analyses.id)).limit(1).offset(KEEP).get();
    if (cut) ctx.db.delete(analyses).where(lte(analyses.id, cut.id)).run();
  })();
  return row.id;
}

/**
 * Analyses still "running" when Burrow starts ran in the Burrow that
 * stopped: they never finish now. Said so, with what came until then,
 * instead of running for ever (audit BE-14).
 */
export function endInterrupted(ctx: Ctx): number {
  return ctx.db
    .update(analyses)
    .set({ status: 'failed', error: 'Burrow restarted while the model answered; ask again.', finishedAt: ctx.now() })
    .where(eq(analyses.status, 'running'))
    .run().changes;
}

/**
 * Whether this person may read an analysis: an admin every one; an operator their own, and others'
 * of what an operator may read itself (a container's output, a log source an admin set up). An
 * admin's analysis of any file, model answer and quoted lines included, was listed for every
 * operator (A3-SRV-11).
 */
function mayRead(ctx: Ctx, user: { id: number; role: string }, r: Row): boolean {
  if (user.role === 'admin' || r.userId === user.id) return true;
  // A file's text is the asker's own business: someone else's question about it is theirs.
  if (r.kind === 'file') return false;
  const targets = JSON.parse(r.targets) as Analysis['targets'];
  return targets.every((t) => !t.file || logFilesOf(ctx, t.hostId, t.container).some((f) => f.path === t.file));
}

/** An analysis' row: what it is about, and what went to the model (for questions asked further). */
const rowOf = (body: AnalyzeInput, prompt: string) => ({ targets: JSON.stringify(body.targets), lines: body.lines.length, prompt });

export function registerAnalyzeRoutes(app: FastifyInstance, ctx: Ctx, monitor: DockerMonitor): void {
  endInterrupted(ctx);
  /** Start an analysis; it goes on without this page (GET /api/ai/analyses/:id). */
  app.post('/api/ai/analyses', { config: { auth: 'user' } }, async (req) => {
    const body = parse(analyzeInput, req.body);
    const streamer = streamerFor(ctx, body.deep);
    if (!streamer) throw new HttpError(409, 'ai_off', body.deep ? 'No Claude API key is set.' : 'AI is switched off; choose a provider in Settings.');
    const user = await question(ctx, monitor, body, { ips: streamer.external, budget: budgetFor(streamer.id) });
    audit(ctx, actor(req), 'ai.analyze', body.targets.map((t) => targetLabel(t)).join(', '), { provider: streamer.id, lines: body.lines.length, deep: body.deep });
    return { id: await startJob(ctx, requireAuth(req).user.id, rowOf(body, user), streamer, { system: systemPrompt(body.lang), user }) };
  });

  /**
   * A question about a file, or the lines chosen in it (report 76bcda): the text the editor
   * holds, cut to the model's window and masked here. Kept as an analysis of kind "file", so it
   * goes on without the page and can be asked further; the answer is read, never applied.
   */
  app.post('/api/ai/file', { config: { auth: 'user' } }, async (req) => {
    const body = parse(fileAskInput, req.body);
    const streamer = streamerFor(ctx, body.deep);
    if (!streamer) throw new HttpError(409, 'ai_off', body.deep ? 'No Claude API key is set.' : 'AI is switched off; choose a provider in Settings.');
    const { user, lines, question } = fileQuestion(ctx, body, { ips: streamer.external, budget: budgetFor(streamer.id) });
    const target = { hostId: body.hostId, container: '', file: body.path };
    audit(ctx, actor(req), 'ai.file', body.path, { host: body.hostId, provider: streamer.id, lines, deep: body.deep });
    const id = await startJob(ctx, requireAuth(req).user.id, { targets: JSON.stringify([target]), lines, prompt: user, ask: question, kind: 'file' }, streamer, { system: filePrompt(body.lang), user });
    return { id };
  });

  /** One analysis, its answer so far. */
  app.get('/api/ai/analyses/:id', { config: { auth: 'user' } }, async (req) => {
    const r = ctx.db.select().from(analyses).where(eq(analyses.id, idParam(req))).get();
    if (!r || !mayRead(ctx, requireAuth(req).user, r)) throw new HttpError(404, 'not_found');
    return toAnalysis(ctx, r);
  });

  /**
   * A question asked further on a finished analysis (report 0a86b2): to the
   * model with the logs, its answer and the questions before, as turns. The
   * question is masked as the logs are; the answer is read, never run.
   */
  app.post('/api/ai/analyses/:id/ask', { config: { auth: 'user' } }, async (req) => {
    const body = parse(analysisAsk, req.body);
    const me = requireAuth(req).user;
    const r = ctx.db.select().from(analyses).where(eq(analyses.id, idParam(req))).get();
    if (!r || r.parentId !== null || !mayRead(ctx, me, r)) throw new HttpError(404, 'not_found');
    const before = toAnalysis(ctx, r);
    if (r.prompt === null) throw new HttpError(409, 'cannot_ask', 'This analysis was kept from before questions could be asked; analyse again to ask.');
    if (r.status === 'running') throw new HttpError(409, 'analysis_running', 'This analysis is still being written.');
    if (r.status === 'failed') throw new HttpError(409, 'cannot_ask', 'This analysis did not finish; analyse again to ask.');
    if (before.followUps.length >= MAX_FOLLOW_UPS) throw new HttpError(409, 'too_many_questions', `${MAX_FOLLOW_UPS} questions on one analysis at most; analyse again to ask more.`);
    if (!before.canAsk) throw new HttpError(409, 'question_running', 'A question is still being answered.');
    // The provider it was made with may be gone since: the one set now answers.
    const streamer = streamerFor(ctx, r.provider.startsWith('anthropic:'));
    if (!streamer) throw new HttpError(409, 'ai_off', 'AI is switched off; choose a provider in Settings.');
    // Masked again for this provider: what went to a local model kept its addresses.
    const mask = (text: string) => maskText(text, { ips: streamer.external });
    const question = mask(body.question);
    const earlier = [
      { role: 'user' as const, content: mask(r.prompt!) },
      { role: 'assistant' as const, content: mask(r.text) },
      ...before.followUps.flatMap((q) => [
        { role: 'user' as const, content: mask(q.ask ?? '') },
        { role: 'assistant' as const, content: mask(q.text) },
      ]),
    ];
    audit(ctx, actor(req), 'ai.ask', (JSON.parse(r.targets) as Analysis['targets']).map((t) => targetLabel(t)).join(', '), { provider: streamer.id, analysis: r.id });
    const system = r.kind === 'file' ? fileFollowUpPrompt(body.lang) : followUpPrompt(body.lang);
    return { id: await startJob(ctx, me.id, { targets: r.targets, lines: r.lines, parentId: r.id, ask: question, kind: r.kind }, streamer, { system, earlier, user: question }) };
  });

  /** One analysis, gone; not while it is still being written (report aafaba). */
  app.delete('/api/ai/analyses/:id', async (req, reply) => {
    const r = ctx.db.select().from(analyses).where(eq(analyses.id, idParam(req))).get();
    if (!r) throw new HttpError(404, 'not_found');
    if (r.status === 'running') throw new HttpError(409, 'analysis_running', 'This analysis is still being written.');
    ctx.db.delete(analyses).where(eq(analyses.id, r.id)).run();
    audit(ctx, actor(req), 'ai.analysis_delete', String(r.id));
    return reply.code(204).send();
  });

  /**
   * Analyses, newest first: of one container (hostId + container), of one
   * log file (+ file), of one host, or all of them (the Reports page's list).
   */
  app.get('/api/ai/analyses', { config: { auth: 'user' } }, async (req): Promise<Analysis[]> => {
    const q = parse(
      z.object({
        hostId: z.coerce.number().int().positive().optional(),
        container: z.string().max(128).optional(),
        file: z.string().max(4096).optional(),
        kind: z.enum(['logs', 'file']).default('logs'),
        limit: z.coerce.number().int().min(1).max(200).default(20),
      }).refine((q) => q.kind === 'file' || !q.file || (q.file.length <= 1100 && validLogSource('', q.file)), 'a log file or a journal'),
      req.query,
    );
    const me = requireAuth(req).user;
    return ctx.db
      .select()
      .from(analyses)
      // The questions asked further come with the analysis they ask about.
      .where(and(isNull(analyses.parentId), eq(analyses.kind, q.kind)))
      .orderBy(desc(analyses.id))
      .limit(KEEP)
      .all()
      .filter((r) => mayRead(ctx, me, r))
      .map((r) => toAnalysis(ctx, r))
      .filter((a) => a.targets.some((t) => (!q.hostId || t.hostId === q.hostId) && (q.container === undefined || t.container === q.container) && (!q.file || t.file === q.file)))
      .slice(0, q.limit);
  });

  /**
   * The same question, as text to paste into Claude or ChatGPT: the person
   * sends it from their own account (no key here, no automation of theirs).
   */
  app.post('/api/ai/analyze/prompt', { config: { auth: 'user' } }, async (req) => {
    const body = parse(analyzeInput, req.body);
    const text = `${systemPrompt(body.lang)}\n\n${await question(ctx, monitor, body, { ips: true, budget: BUDGET_HANDOFF })}`;
    audit(ctx, actor(req), 'ai.handoff', body.targets.map((t) => targetLabel(t)).join(', '), { lines: body.lines.length });
    return { text };
  });

  // The prices too, so an answer can say what it about cost (report 18efc8).
  // model: named in the dialog before anything is sent (A3-WEB-07).
  app.get('/api/ai/analyze/options', { config: { auth: 'user' } }, async () => {
    const s = streamerFor(ctx);
    return { available: s !== null, deep: deepAvailable(ctx), prices: getAiSettings(ctx).prices, model: s ? `${s.id}:${s.model}` : null };
  });
}
