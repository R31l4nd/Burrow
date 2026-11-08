import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bugReportInput, HANDLED_CALL, type BugReportDetail, type BugReportInput, type BugReportSummary } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { actor, contentDisposition, HttpError, parse, requireAuth } from '../http.js';
import { tarGz } from './tar.js';
import type { Notifier } from '../notify/channels.js';

// Problem reports: each one a folder in the data directory
// (bugreports/<time>-<id>/) with report.md, context.json and the pictures.
// Admins read them in Burrow (Settings -> Problem reports), download one,
// or open a GitHub issue filled in from it, after reading it themselves:
// nothing is sent anywhere by Burrow. `make bugs` reads the folder too.

// Limits: a person sends at most PER_HOUR an hour (an admin, going over the
// screens one by one, ADMIN_PER_HOUR: ten stopped a round of findings), and
// the folder keeps the newest KEEP reports within MAX_BYTES (the disk is not filled).
const PER_HOUR = 10;
const ADMIN_PER_HOUR = 60;
const KEEP = 200;
const MAX_BYTES = 500 * 1024 * 1024;

function dirBytes(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) n += statSync(join(dir, f)).size;
  return n;
}

/** Oldest out until the newest KEEP fit in MAX_BYTES. Folder names sort by time. */
function prune(root: string): void {
  let dirs: string[];
  try {
    dirs = readdirSync(root).sort();
  } catch {
    return;
  }
  const sizes = dirs.map((d) => {
    try {
      return dirBytes(join(root, d));
    } catch {
      return 0;
    }
  });
  let total = sizes.reduce((a, b) => a + b, 0);
  let i = 0;
  while (i < dirs.length && (dirs.length - i > KEEP || total > MAX_BYTES)) {
    rmSync(join(root, dirs[i]!), { recursive: true, force: true });
    total -= sizes[i]!;
    i++;
  }
}

const SERVER_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
const MAGIC: Record<string, number[]> = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };

/** A data URL's bytes, if they are the picture they say they are. */
function picture(url: string): { ext: string; bytes: Buffer } {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(url);
  if (!m) throw new HttpError(400, 'invalid_image');
  const ext = m[1]!;
  const bytes = Buffer.from(m[2]!, 'base64');
  if (!MAGIC[ext]!.every((b, i) => bytes[i] === b)) throw new HttpError(400, 'invalid_image', 'That is not the picture it says it is.');
  return { ext: ext === 'jpeg' ? 'jpg' : ext, bytes };
}

export function reportMarkdown(b: BugReportInput, meta: { id: string; at: string; role: string; files: string[] }): string {
  const c = b.context;
  return [
    `# Problem report ${meta.id}`,
    '',
    `Reported ${meta.at} by an ${meta.role}, on ${c.page}${c.dialog ? `, in the dialog "${c.dialog}"` : ''}.`,
    '',
    '## What happened',
    '',
    b.text,
    '',
    '## Where',
    '',
    `- Web app ${c.appVersion}, server ${SERVER_VERSION}${c.android ? `, Android app ${c.androidApp ?? '(unknown)'}` : ', in a browser'}`,
    `- ${c.userAgent}`,
    `- Screen ${c.viewport.width}x${c.viewport.height} at ${c.viewport.dpr}x, ${c.locale}, theme ${c.theme}${c.timeZone ? `, time zone ${c.timeZone}` : ''}${c.online ? '' : ', offline'}`,
    '',
    '## Errors in the page',
    '',
    ...(c.errors.length ? c.errors.map((e) => `- ${e}`) : ['None.']),
    '',
    '## Failed requests',
    '',
    ...(c.failedCalls.length ? c.failedCalls.map((f) => `- ${f.at} ${f.method} ${f.path} -> ${f.status} ${f.code}${f.handled ? HANDLED_CALL : ''}`) : ['None.']),
    '',
    // On a terminal page: typing and the suggestions, without the text.
    ...(c.terminal
      ? [
          '## Terminal',
          '',
          `- ${c.terminal.compose ? 'text box' : 'typed straight in'}, ${c.terminal.buffer} screen, integration ${c.terminal.integration ? 'on' : 'off'}, at a prompt: ${c.terminal.atPrompt ? 'yes' : 'no'}, prompt known: ${c.terminal.promptKnown ? 'yes' : 'no'}`,
          `- cursor line ${c.terminal.cursorLineLength} characters, input found: ${c.terminal.inputFound ? `yes (${c.terminal.inputLength})` : 'no'}, suggestions ${c.terminal.suggestions}, looked ${c.terminal.completeRuns} times`,
          `- keyboard: ${c.terminal.keys.join(', ') || 'nothing yet'}`,
          '',
        ]
      : []),
    // What the keyboard and the fingers did: beside it, to read or replay.
    ...(b.recording
      ? ['## Input', '', `- ${b.recording.entries.length} events in the last 30 seconds, ${b.recording.withText ? 'with the text' : 'without the text'} (recording.json; make replay ID=${meta.id})`, '']
      : []),
    '## Pictures',
    '',
    // Whether the screenshot covers what files, terminals and logs showed, or shows it on purpose.
    ...(meta.files.length ? meta.files.map((f) => `- ${f}${f.startsWith('screenshot.') && c.shot ? (c.shot.shown ? ` (files, terminals and logs as they were: ticked by the person, ${c.shot.covered} ${c.shot.covered === 1 ? 'part' : 'parts'})` : c.shot.covered ? ` (${c.shot.covered} ${c.shot.covered === 1 ? 'part' : 'parts'} with files, terminals or logs covered)` : '') : ''}`) : ['None.']),
    '',
  ].join('\n');
}

export function registerBugReportRoutes(app: FastifyInstance, ctx: Ctx, notifier?: Notifier): void {
  const sent = new Map<number, number[]>();
  app.post('/api/bugreports', { config: { auth: 'user' }, bodyLimit: 40 << 20 }, async (req) => {
    const b = parse(bugReportInput, req.body);
    const { user } = requireAuth(req);
    const hourAgo = ctx.now() - 3600_000;
    const recent = (sent.get(user.id) ?? []).filter((t) => t > hourAgo);
    const max = user.role === 'admin' ? ADMIN_PER_HOUR : PER_HOUR;
    if (recent.length >= max) throw new HttpError(429, 'too_many_reports', `${max} reports an hour at most; thank you, try again later.`);
    sent.set(user.id, [...recent, ctx.now()]);
    const at = new Date(ctx.now()).toISOString();
    const id = `${at.slice(0, 19).replace(/[:T]/g, '-')}-${randomBytes(3).toString('hex')}`;
    const pictures = [...(b.screenshot ? [{ name: 'screenshot', url: b.screenshot }] : []), ...b.attachments.map((url, i) => ({ name: `picture-${i + 1}`, url }))].map((p) => ({
      name: p.name,
      ...picture(p.url),
    }));
    const dir = join(ctx.config.dataDir, 'bugreports', id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = pictures.map((p) => `${p.name}.${p.ext}`);
    pictures.forEach((p, i) => writeFileSync(join(dir, files[i]!), p.bytes, { mode: 0o600 }));
    writeFileSync(join(dir, 'context.json'), `${JSON.stringify({ id, at, role: user.role, serverVersion: SERVER_VERSION, text: b.text, ...b.context }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(dir, 'report.md'), reportMarkdown(b, { id, at, role: user.role, files }), { mode: 0o600 });
    if (b.recording) writeFileSync(join(dir, 'recording.json'), `${JSON.stringify(b.recording, null, 2)}\n`, { mode: 0o600 });
    prune(join(ctx.config.dataDir, 'bugreports'));
    audit(ctx, actor(req), 'bugreport.create', id);
    ctx.log.info({ id }, `problem report ${id} saved`);
    // The admins hear of it (channels for problem reports); not waited for.
    if (notifier) {
      const nl = notifier.lang('problems') === 'nl';
      void notifier
        .notify({
          topic: 'problems',
          title: nl ? `Probleemmelding van ${user.username}` : `Problem report from ${user.username}`,
          body: b.text.split('\n')[0]!.slice(0, 200),
          page: '/settings/report',
          priority: 3,
          data: { id, page: b.context.page },
        })
        .catch(() => {});
    }
    return { id };
  });

  const root = () => join(ctx.config.dataDir, 'bugreports');
  /** A report's folder, by an id of the form Burrow gives (nothing else reaches the disk). */
  const folder = (raw: unknown): string => {
    const id = String(raw);
    if (!REPORT_ID.test(id)) throw new HttpError(404, 'not_found');
    const dir = join(root(), id);
    if (!existsSync(join(dir, 'context.json'))) throw new HttpError(404, 'not_found');
    return dir;
  };

  app.get('/api/bugreports', { config: { auth: 'admin' } }, async (): Promise<BugReportSummary[]> => {
    let ids: string[];
    try {
      ids = readdirSync(root()).filter((d) => REPORT_ID.test(d));
    } catch {
      return [];
    }
    return ids
      .sort()
      .reverse()
      .flatMap((id) => {
        try {
          const r = readReport(join(root(), id));
          return [{ id, at: r.at, role: r.role, page: r.context.page, text: r.text.slice(0, 300), pictures: r.pictures.length, recording: r.recording !== null, status: r.status, closedAt: r.closedAt }];
        } catch {
          return [];
        }
      });
  });

  app.get('/api/bugreports/:id', { config: { auth: 'admin' } }, async (req) => readReport(folder((req.params as { id: string }).id)));

  // A picture of a report, as the image it was checked to be when sent.
  app.get('/api/bugreports/:id/pictures/:name', { config: { auth: 'admin' } }, async (req, reply) => {
    const p = req.params as { id: string; name: string };
    const dir = folder(p.id);
    const m = PICTURE.exec(p.name);
    if (!m || !existsSync(join(dir, p.name))) throw new HttpError(404, 'not_found');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.type(m[2] === 'jpg' ? 'image/jpeg' : `image/${m[2]}`);
    return readFileSync(join(dir, p.name));
  });

  // The whole folder, to keep or to attach by hand.
  app.get('/api/bugreports/:id/archive', { config: { auth: 'admin' } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const dir = folder(id);
    const files = readdirSync(dir)
      .filter((f) => statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => ({ name: `${id}/${f}`, data: readFileSync(join(dir, f)) }));
    reply.header('Content-Disposition', contentDisposition('attachment', `burrow-problem-${id}.tar.gz`));
    reply.header('Cache-Control', 'private, no-store');
    reply.type('application/gzip');
    return tarGz(files, ctx.now());
  });

  // Solved (or open again): kept beside the report, with when and by whom.
  app.put('/api/bugreports/:id/status', { config: { auth: 'admin' } }, async (req) => {
    const id = (req.params as { id: string }).id;
    const dir = folder(id);
    const { status } = parse(z.object({ status: z.enum(['open', 'closed']) }), req.body);
    const { user } = requireAuth(req);
    const state = status === 'closed' ? { status, closedAt: new Date(ctx.now()).toISOString(), closedBy: user.username } : { status, closedAt: null, closedBy: null };
    writeFileSync(join(dir, 'status.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    audit(ctx, actor(req), status === 'closed' ? 'bugreport.close' : 'bugreport.reopen', id);
    return readReport(dir);
  });

  app.delete('/api/bugreports/:id', { config: { auth: 'admin' } }, async (req) => {
    const id = (req.params as { id: string }).id;
    rmSync(folder(id), { recursive: true, force: true });
    audit(ctx, actor(req), 'bugreport.delete', id);
    return { ok: true };
  });
}

const REPORT_ID = /^\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d-[0-9a-f]{6}$/;

/** Problem reports not closed yet: a count beside "Report a problem" and on Settings for admins (W-FUNC-11). */
export function openReportCount(ctx: Ctx): number {
  const root = join(ctx.config.dataDir, 'bugreports');
  let ids: string[];
  try {
    ids = readdirSync(root).filter((d) => REPORT_ID.test(d));
  } catch {
    return 0;
  }
  return ids.filter((id) => {
    try {
      return (JSON.parse(readFileSync(join(root, id, 'status.json'), 'utf8')) as { status?: string }).status !== 'closed';
    } catch {
      // Never marked: open (when the report itself is there).
      return existsSync(join(root, id, 'context.json'));
    }
  }).length;
}
const PICTURE = /^(screenshot|picture-[1-3])\.(png|jpg|webp)$/;

/** A report as saved; one from before 1.8.0 has its text only in report.md. */
function readReport(dir: string): BugReportDetail {
  const raw = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')) as Record<string, unknown> & { id: string; at: string; role: string; serverVersion?: string; text?: string };
  const { id, at, role, serverVersion, text, ...context } = raw;
  const fromMd = () => {
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    const m = /## What happened\n\n([\s\S]*?)\n\n## Where/.exec(md);
    return m ? m[1]! : '';
  };
  let recording: BugReportDetail['recording'] = null;
  if (existsSync(join(dir, 'recording.json'))) {
    const r = JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8')) as { entries?: unknown[]; withText?: boolean };
    recording = { entries: r.entries?.length ?? 0, withText: !!r.withText };
  }
  let state: { status?: string; closedAt?: string | null; closedBy?: string | null } = {};
  try {
    state = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as typeof state;
  } catch {
    // Never marked: open.
  }
  return {
    id,
    at,
    role,
    status: state.status === 'closed' ? 'closed' : 'open',
    closedAt: state.status === 'closed' ? (state.closedAt ?? null) : null,
    closedBy: state.status === 'closed' ? (state.closedBy ?? null) : null,
    serverVersion: serverVersion ?? '',
    text: text ?? fromMd(),
    context: context as unknown as BugReportDetail['context'],
    pictures: readdirSync(dir).filter((f) => PICTURE.test(f)).sort(),
    recording,
  };
}
