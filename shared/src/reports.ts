import type { AiUsage, Risk } from './ai.js';
import { DEFAULT_SELECTION, logSelection, type LogSelection } from './logselect.js';
import { MAX_SOURCE_SUBJECT } from './logfiles.js';
import { plural } from './plural.js';
import { z } from 'zod';

// Phase 10: notification channels (ntfy, e-mail, Discord, a webhook, and
// Burrow's own push to browsers and the Android app) and scheduled reports
// on the containers.

// ---- channels

export type ChannelKind = 'ntfy' | 'email' | 'discord' | 'webhook' | 'push';
export type NotifyTopic = 'alerts' | 'reports' | 'updates' | 'problems';
export const NOTIFY_TOPICS: NotifyTopic[] = ['alerts', 'reports', 'updates', 'problems'];

/** A channel as the browser sees it: secrets only as "set" or not. */
export interface Channel {
  id: number;
  kind: ChannelKind;
  name: string;
  enabled: boolean;
  topics: NotifyTopic[];
  /** Language of the messages. */
  lang: 'en' | 'nl';
  ntfy?: { url: string; topic: string; hasToken: boolean; openIn: 'app' | 'browser' };
  email?: { host: string; port: number; secure: boolean; user: string; hasPassword: boolean; from: string; to: string };
  discord?: { hasUrl: boolean };
  webhook?: { url: string; hasSecret: boolean };
  /** Burrow's own push: how many devices have it on. */
  push?: { devices: number };
}

const topics = z.array(z.enum(NOTIFY_TOPICS as [NotifyTopic, ...NotifyTopic[]])).max(NOTIFY_TOPICS.length);
const base = {
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean(),
  topics,
  lang: z.enum(['en', 'nl']).default('en'),
};
/** Secrets: undefined keeps the stored one, '' removes it. */
const secret = z.string().max(500).optional();

export const channelInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ntfy'),
    ...base,
    ntfy: z.object({
      url: z.url().max(300),
      topic: z
        .string()
        .trim()
        .regex(/^[\w-]{1,64}$/, 'Letters, digits, - and _ only.'),
      token: secret,
      openIn: z.enum(['app', 'browser']),
    }),
  }),
  z.object({
    kind: z.literal('email'),
    ...base,
    email: z.object({
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      /** TLS from the start (465); otherwise STARTTLS when offered. */
      secure: z.boolean(),
      user: z.string().max(200).default(''),
      password: secret,
      from: z.email().max(200),
      to: z.string().trim().min(3).max(1000),
    }),
  }),
  z.object({
    kind: z.literal('discord'),
    ...base,
    discord: z.object({
      /** https://discord.com/api/webhooks/...; a secret, never shown again. */
      url: z.url().max(500).optional().or(z.literal('')),
    }),
  }),
  z.object({
    kind: z.literal('webhook'),
    ...base,
    webhook: z.object({
      url: z.url().max(500),
      /** Signs the body: X-Burrow-Signature: sha256=<hmac>. */
      secret,
    }),
  }),
  // To every device that turned on notifications (Settings -> this device).
  z.object({ kind: z.literal('push'), ...base }),
]);

// ---- Burrow's own push: devices

/** A device that gets Burrow's push messages: a browser (Web Push) or the Android app (UnifiedPush). */
export interface PushDevice {
  id: number;
  kind: 'webpush' | 'unifiedpush';
  label: string;
  createdAt: string;
  lastOkAt: string | null;
}

export const pushDeviceInput = z.object({
  kind: z.enum(['webpush', 'unifiedpush']),
  label: z.string().trim().min(1).max(80),
  // http too: a self-hosted ntfy on the home network is a push service.
  // What goes there is encrypted for the device and nothing else.
  endpoint: z.url({ protocol: /^https?$/ }).max(1000),
  /** The device's P-256 public key and its auth secret, base64url (RFC 8291). */
  p256dh: z.string().regex(/^[\w-]{86,88}$/),
  auth: z.string().regex(/^[\w-]{21,24}$/),
  lang: z.enum(['en', 'nl']).default('en'),
});
export type PushDeviceInput = z.infer<typeof pushDeviceInput>;
export type ChannelInput = z.infer<typeof channelInput>;

/** One message, before each channel shapes it. */
export interface Notice {
  topic: NotifyTopic | 'test';
  title: string;
  /** Plain text, a few lines. */
  body: string;
  /** A page of Burrow: "/reports/12". */
  page: string;
  /** 1 (low) ... 5 (urgent). */
  priority: number;
  /** Extra buttons (ntfy): a label and a page. */
  actions?: { label: string; page: string }[];
  /** For the webhook: the structured thing behind it. */
  data?: unknown;
  /** The same in Dutch, for channels set to Dutch. */
  nl?: { title: string; body: string; actions?: { label: string; page: string }[] };
}

// ---- reports

export type ReportStatus = 'ok' | 'attention' | 'problem';

export type ScheduleKind = 'weekly' | 'daily' | 'cron';

/** A report being made: how far it is, and how long the last one took. */
export interface ReportProgress {
  scheduleId: number;
  name: string;
  /** Reading the containers' logs, the AI explaining, sending; then done or failed. */
  phase: 'reading' | 'explaining' | 'sending' | 'done' | 'failed';
  done: number;
  total: number;
  startedAt: string;
  /** How long this schedule's last report took; null the first time. */
  expectedMs: number | null;
  reportId: number | null;
  error: string | null;
}

export interface ReportSchedule {
  id: number;
  name: string;
  enabled: boolean;
  kind: ScheduleKind;
  /** weekly: 0 (Sunday) ... 6. */
  day: number;
  /** weekly/daily: "HH:MM". */
  time: string;
  cron: string | null;
  timeZone: string;
  /** null: every Docker host. */
  hostIds: number[] | null;
  /** null: every container; else container names (and stack names). */
  containers: string[] | null;
  /** null: every channel that has reports on; else these channels. */
  channelIds: number[] | null;
  /** Which log lines of which containers are read (a default rule and exceptions). */
  selection: LogSelection;
  /** Sent only when a container needs a look (kept in the list either way). */
  onlyAttention: boolean;
  /** The language model's explanations for the containers that need a look. */
  ai: boolean;
  /** From how many errors, or warnings, in the period a container needs a look. */
  errorsAttention: number;
  warningsAttention: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export const scheduleInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    kind: z.enum(['weekly', 'daily', 'cron']),
    day: z.number().int().min(0).max(6).default(1),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('08:00'),
    cron: z.string().trim().max(100).nullable().default(null),
    timeZone: z.string().min(1).max(64),
    hostIds: z.array(z.number().int().positive()).max(100).nullable().default(null),
    // Containers, stacks and log files (as their subject).
    containers: z.array(z.string().max(MAX_SOURCE_SUBJECT)).max(500).nullable().default(null),
    // null: every channel that takes reports; a list: those. An empty list
    // is refused, not taken for "all" (audit WP-06).
    channelIds: z.array(z.number().int().positive()).min(1, 'Choose at least one channel, or all of them.').max(50).nullable().default(null),
    selection: logSelection.default(DEFAULT_SELECTION),
    onlyAttention: z.boolean().default(false),
    ai: z.boolean().default(true),
    errorsAttention: z.number().int().min(1).max(100_000).default(10),
    warningsAttention: z.number().int().min(1).max(1_000_000).default(100),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'cron' && !s.cron) ctx.addIssue({ code: 'custom', message: 'Enter a cron expression.', path: ['cron'] });
  });

export type Trend = 'new' | 'recurring' | 'resolved';

export interface ReportProblem {
  /** A template of the log line, the same across reports ("<n> errors ..."). */
  key: string;
  title: string;
  count: number;
  trend: Exclude<Trend, 'resolved'>;
}

/** Why a container got its status; the page and the messages word it. */
export type ReportReason =
  | { code: 'crashes'; n: number }
  | { code: 'oom'; n: number }
  | { code: 'unhealthy' }
  | { code: 'unhealthy_events'; n: number }
  | { code: 'exited'; n: number }
  | { code: 'errors'; n: number }
  | { code: 'warnings'; n: number }
  | { code: 'restarts'; n: number }
  /** Its logs (or a log file) could not be read: no errors seen is not no errors. */
  | { code: 'logs_unread'; what: string };

export function reasonText(r: ReportReason, lang: 'en' | 'nl'): string {
  const nl = lang === 'nl';
  switch (r.code) {
    case 'crashes':
      return nl ? `${r.n}x gecrasht` : `crashed ${r.n}x`;
    case 'oom':
      return nl ? `${r.n}x geheugen op` : `out of memory ${r.n}x`;
    case 'unhealthy':
      return nl ? 'nu unhealthy' : 'unhealthy now';
    case 'unhealthy_events':
      return nl ? `${r.n}x unhealthy geweest` : `unhealthy ${r.n}x`;
    case 'exited':
      return nl ? `gestopt met code ${r.n}` : `exited with code ${r.n}`;
    case 'errors':
      return nl ? plural(r.n, 'fout', 'fouten') : plural(r.n, 'error', 'errors');
    case 'warnings':
      return nl ? plural(r.n, 'waarschuwing', 'waarschuwingen') : plural(r.n, 'warning', 'warnings');
    case 'restarts':
      return nl ? `${r.n}x herstart` : `restarted ${r.n}x`;
    case 'logs_unread':
      return nl ? `logs niet te lezen (${r.what})` : `logs could not be read (${r.what})`;
  }
}

export interface ContainerReport {
  hostId: number;
  hostName: string;
  container: string;
  project: string | null;
  image: string;
  status: ReportStatus;
  /** What made the status. */
  reasons: ReportReason[];
  /** Lines read (the last 5000 at most) and lines in the period. */
  linesRead: number;
  linesTotal: number;
  errors: number;
  warnings: number;
  crashes: number;
  restarts: number;
  state: string;
  health: string | null;
  problems: ReportProblem[];
  /** Problems of the previous report that did not occur this time. */
  resolved: string[];
  /** From the model, when it was asked. */
  summary: string | null;
  /** Steps from the model; reports before 1.3.0 stored plain text. */
  fixes: (string | ReportFix)[];
  /** Its log files read with it (paths in the container); reports before 1.25.0 have none. */
  files?: string[];
}

/** A step to fix a container, with the one command that does it, if any. */
export interface ReportFix {
  step: string;
  /** A shell command for the container's host, or null. Never run by itself. */
  command: string | null;
  /** The model's label, raised by Burrow's own rules (see assessCommand). */
  risk: Risk;
  riskReasons: string[];
}

/** A stored fix as a ReportFix, old plain-text ones included. */
export const fixOf = (x: string | ReportFix): ReportFix => (typeof x === 'string' ? { step: x, command: null, risk: 'low', riskReasons: [] } : x);

export interface Report {
  id: number;
  scheduleId: number | null;
  name: string;
  createdAt: string;
  from: string;
  to: string;
  status: ReportStatus;
  counts: { ok: number; attention: number; problem: number };
  /** A few sentences on the whole, in `lang`. */
  summary: string;
  lang: 'en' | 'nl';
  containers: ContainerReport[];
  /** Model used, or null when AI is off. */
  model: string | null;
  /** What the model used for the explanations, as its provider counted it; null when not counted. */
  tokens?: AiUsage | null;
  /** Hosts that could not be read: their containers are not in it (a problem, never "all fine"). */
  unreachable?: { hostId: number; hostName: string; error: string }[];
  /** Hosts with package updates waiting at their last check; reports before 2.11.0 have none. */
  updates?: { hostId: number; hostName: string; total: number; security: number; reboot: boolean }[];
}

export type ReportListItem = Omit<Report, 'containers'>;
