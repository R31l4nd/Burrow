import { z } from 'zod';

// A problem report for the developer: what the person says, a picture of the
// screen, and the context a developer asks for first. Never page content,
// request bodies or secrets: only where, what device, and what failed.

const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** After a failed request the page answered itself (an editor offering sudo for a file only root may read). */
export const HANDLED_CALL = ' (handled: the page said so and offered what to do)';

export const bugContext = z.object({
  /** The route, without its query (it can hold paths the person browses). */
  page: z.string().max(300),
  /** The dialog that was open on the page, by its tour name. */
  dialog: z.string().max(80).nullable().default(null),
  appVersion: z.string().max(40),
  /** The Android app's own version (its WireGuard, its downloads), when sent from it. */
  androidApp: z.string().max(40).nullable().optional(),
  userAgent: z.string().max(400),
  viewport: z.object({ width: z.number().int().min(0).max(20000), height: z.number().int().min(0).max(20000), dpr: z.number().min(0).max(10) }),
  locale: z.string().max(10),
  theme: z.string().max(20),
  /** The device's time zone and the offset now ("Europe/Amsterdam +02:00"): times shown come from it. */
  timeZone: z.string().max(80).optional(),
  android: z.boolean(),
  online: z.boolean(),
  /**
   * The screenshot sent: how many parts (files, terminals, logs) it covers, and whether the person
   * ticked to send them as they were. Read beside the picture: covered or shown on purpose.
   */
  shot: z.object({ covered: z.number().int().min(0).max(1000), shown: z.boolean() }).nullable().optional(),
  /** The last errors in the page (message and where), newest last. */
  errors: z.array(z.string().max(500)).max(30),
  /** The last API calls that failed: method, path, status, error code. */
  failedCalls: z.array(z.object({ method: z.string().max(10), path: z.string().max(300), status: z.number().int(), code: z.string().max(80), at: z.string().max(40), handled: z.boolean().optional() })).max(30),
  /**
   * On a terminal page: how typing and the suggestions went, without what
   * was typed (yes or no, lengths, counts, and the keyboard's last events).
   */
  terminal: z
    .object({
      compose: z.boolean(),
      buffer: z.enum(['normal', 'alternate']),
      integration: z.boolean(),
      atPrompt: z.boolean(),
      promptKnown: z.boolean(),
      cursorLineLength: z.number().int().min(0).max(100_000),
      inputFound: z.boolean(),
      inputLength: z.number().int().min(0).max(100_000),
      suggestions: z.number().int().min(0).max(1000),
      completeRuns: z.number().int().min(0),
      /** The keyboard's last events on the terminal: type and inputType or keyCode, no text. */
      keys: z.array(z.string().max(60)).max(40),
    })
    .nullable()
    .default(null),
});
export type BugContext = z.infer<typeof bugContext>;

/**
 * The last half minute of input on a terminal (web/src/lib/inputlog.ts):
 * keys, the keyboard's edits, touches and what went to the session. Its text
 * only when the person ticked the box; else lengths.
 */
export const inputRecording = z.object({
  version: z.literal(1),
  withText: z.boolean(),
  viewport: z.object({ width: z.number().int().min(0).max(20000), height: z.number().int().min(0).max(20000) }),
  terminal: z.object({ compose: z.boolean(), mode: z.string().max(20).nullable(), cols: z.number().int().min(0).max(1000), rows: z.number().int().min(0).max(1000) }).nullable(),
  entries: z
    .array(
      z.object({
        t: z.number().int().min(0),
        e: z.string().max(30),
        keyCode: z.number().int().optional(),
        key: z.string().max(40).optional(),
        inputType: z.string().max(40).optional(),
        composing: z.boolean().optional(),
        text: z.string().max(4000).optional(),
        len: z.number().int().min(0).optional(),
        value: z.string().max(4000).optional(),
        textLength: z.number().int().min(0).optional(),
        points: z.array(z.tuple([z.number(), z.number()])).max(10).optional(),
        n: z.number().int().optional(),
      }),
    )
    .max(3000),
});
export type InputRecording = z.infer<typeof inputRecording>;

/** The longest a screenshot may be, as a data URL (the client shrinks one to fit). */
export const SCREENSHOT_MAX_CHARS = 12 << 20;

export const bugReportInput = z.object({
  text: z.string().trim().min(1).max(10_000),
  /** The screen when the report was started, as a data URL. */
  screenshot: z.string().max(SCREENSHOT_MAX_CHARS).regex(IMAGE).nullable(),
  /** Pictures the person adds. */
  attachments: z.array(z.string().max(8 << 20).regex(IMAGE)).max(3),
  context: bugContext,
  /** On a terminal page: the input of the last half minute. */
  recording: inputRecording.nullable().default(null),
});
export type BugReportInput = z.infer<typeof bugReportInput>;

/** Where Burrow's source lives (its issues, its releases). */
export const PROJECT_URL = 'https://github.com/R31l4nd/Burrow';

/**
 * Whether this build knows its public repository: a fork that still has the
 * placeholder offers no "Report on GitHub", which led to a page that does
 * not exist (W-FUNC-15). Spelled in parts, so scripts/check-public.sh does
 * not find it here.
 */
export const projectPublished = (url: string = PROJECT_URL): boolean => !url.includes(['OWNER', 'burrow'].join('/'));

/** A problem report as the admin reads it in Burrow (GET /api/bugreports/:id). */
export interface BugReportDetail {
  id: string;
  at: string;
  role: string;
  serverVersion: string;
  text: string;
  context: BugContext;
  pictures: string[];
  recording: { entries: number; withText: boolean } | null;
  /** Open until an admin marks it solved (and back). */
  status: BugReportStatus;
  closedAt: string | null;
  closedBy: string | null;
}

export type BugReportStatus = 'open' | 'closed';

/** One line of the admin's list of problem reports. */
export interface BugReportSummary {
  id: string;
  at: string;
  role: string;
  page: string;
  text: string;
  pictures: number;
  recording: boolean;
  status: BugReportStatus;
  closedAt: string | null;
}

// GitHub's own limit on an address is about 8 KB: the whole address, as
// sent (encoded), is kept under it (AUDIT2 AI-14).
const ISSUE_BODY_MAX = 6000;
const ISSUE_URL_MAX = 8000;

/** The first `n` characters, never half of one (an emoji's two halves; AUDIT2 AI-08). */
export const firstChars = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length > n ? cps.slice(0, n).join('') : s;
};

/**
 * A new GitHub issue filled in from a report (the bug_report form's fields),
 * for the admin to read and send. What could be private stays out: the
 * pictures and the input recording are attached by hand, if at all.
 */
export function issueUrl(r: BugReportDetail, repo = PROJECT_URL): string {
  const c = r.context;
  const where = [
    `Burrow ${r.serverVersion} (web app ${c.appVersion})${c.android ? `, Android app ${c.androidApp ?? 'unknown'}` : ', browser'}`,
    c.userAgent,
    `Screen ${c.viewport.width}x${c.viewport.height} at ${c.viewport.dpr}x, ${c.locale}, theme ${c.theme}`,
  ].join('\n');
  const details = [
    `Page: ${c.page}${c.dialog ? `, dialog "${c.dialog}"` : ''}`,
    '',
    'Errors in the page:',
    ...(c.errors.length ? c.errors.map((e) => `- ${e}`) : ['- none']),
    '',
    'Failed requests:',
    ...(c.failedCalls.length ? c.failedCalls.map((f) => `- ${f.method} ${f.path} -> ${f.status} ${f.code}${f.handled ? HANDLED_CALL : ''}`) : ['- none']),
    ...(c.terminal
      ? ['', `Terminal: ${c.terminal.compose ? 'text box' : 'typed straight in'}, ${c.terminal.buffer} screen, integration ${c.terminal.integration ? 'on' : 'off'}, keys: ${c.terminal.keys.join(', ') || 'none'}`]
      : []),
  ].join('\n');
  const cut = (s: string, n: number) => ([...s].length > n ? `${firstChars(s, n - 20)}\n[... cut short]` : s);
  const title = firstChars(r.text.split('\n')[0]!.trim(), 80);
  const url = (n: number) => {
    const q: [string, string][] = [
      ['template', 'bug_report.yml'],
      ['title', `Problem: ${title}`],
      ['what', cut(r.text, n)],
      ['where', where],
      ['details', cut(details, n)],
    ];
    return `${repo}/issues/new?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  };
  // Text that grows when encoded (another script, punctuation) is cut further.
  let n = ISSUE_BODY_MAX / 2;
  let out = url(n);
  while (out.length > ISSUE_URL_MAX && n > 100) out = url((n = Math.floor(n * 0.8)));
  return out;
}
