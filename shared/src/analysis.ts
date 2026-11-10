import { plural } from './plural.js';
import { z } from 'zod';
import { MAX_SOURCE_SUBJECT, parseTarget, targetLabel, validLogSource } from './logfiles.js';
import { CONTAINER_NAME, detectLevel, parseJsonLine, type LogLevel } from './docker.js';

// Phase 9: log analysis with a language model, and log alerts.
//
// Before logs go to a model they are made small and safe: secrets are
// masked (always; IP addresses too when the model is not local), repeated
// lines are grouped into templates with counts (in the spirit of Drain),
// and errors and warnings come first.

// ---- masking

// Names ending in KEY too (SECRET_KEY, ENCRYPTION_KEY, TS_AUTHKEY), a WPA psk and a pw that is
// no part of a word (DB_PW, not stepwise): they went as they were (audit 2026-11).
const SECRET_KEY = String.raw`(?:pass(?:word|wd|phrase)?|pwd|(?<![a-z])pw|psk|(?:secret|encryption|enc|master|signing|jwt|app|auth|client|license)[_-]?key|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credentials?|session(?:id)?|cookie)`;
// More after the secret word (DB_PASSWORD_ROOT, API_TOKEN_2, secret_key_base), not a path to it
// (DB_PASSWORD_FILE): those went as they were (audit 2026-11-09).
const SECRET_NAME = String.raw`${SECRET_KEY}(?:[_-](?!(?:file|path|dir)\b)[a-z0-9]+){0,2}`;

// A private key's markers: PEM and OpenSSH, and PGP's KEY BLOCK (audit 2026-11).
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

const MASKS: [RegExp, string][] = [
  // A private key in a log (PEM or OpenSSH): everything between its markers.
  [new RegExp(String.raw`${KEY_BEGIN.source}[\s\S]*?(?:${KEY_END.source}|$)`, 'g'), '<private key>'],
  // Headers whose whole value is secret, every part of it: a Digest's
  // parameters (username, response...), each cookie. Only the first word
  // went (AUDIT2 AI-01).
  [/\b((?:proxy-)?authorization\s*:\s*[A-Za-z-]+\s+)[\w-]+=(?:"[^"]*"|[^\s,"]+)(?:,\s*[\w-]+=(?:"[^"]*"|[^\s,"]+))*/gi, '$1<secret>'],
  [/\b((?:set-)?cookie\s*:\s*)[^=;\s]+=[^;\s]*(?:;\s*[^=;\s]+=[^;\s]*)*/gi, '$1<secret>'],
  // A secret-looking key with a quoted value: all of it, spaces too, also
  // with escaped quotes (JSON inside a string). Only its first word went.
  [new RegExp(String.raw`(${SECRET_NAME}(?:\\?["'])?\s*[:=]\s*)(\\?)(["'])(?:(?!\2\3).)*\2\3`, 'gi'), '$1$2$3<secret>$2$3'],
  // An Authorization header of any scheme (Token, ApiKey, Digest...): its value.
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:[A-Za-z-]+\s+)?)[^\s"',;}]{6,}/gi, '$1<secret>'],
  // JSON Web Tokens.
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '<jwt>'],
  // Authorization headers.
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 <secret>'],
  // key=value / key: value / "key":"value" for secret-looking keys.
  // Short ones too (pwd=ab), and after an escaped quote (\"password\":).
  [new RegExp(String.raw`(${SECRET_NAME}(?:\\?["'])?\s*(?:[:=]|%3[dD])\s*(?:\\?["'])?)(?!<secret>)([^\s"',;&}\\]+)`, 'gi'), '$1<secret>'],
  // Passwords in SQL (a statement log), in config files of words and values (redis, keepalived,
  // .netrc), and in XML: they went as they were (audit 2026-11-09).
  [/\b(PASSWORD|IDENTIFIED\s+BY)(\s*\(?\s*)'[^'\n]*'/gi, "$1$2'<secret>'"],
  [/^(\s*(?:requirepass|masterauth|auth_pass)\s+)(?!<secret>)\S+/gim, '$1<secret>'],
  [/\b(AUTH\s+)(?!<secret>)\S+/g, '$1<secret>'],
  [/(\blogin\s+\S+\s+password\s+)(?!<secret>)\S+/gi, '$1<secret>'],
  [/(<(password|passwd|secret|token|api[_-]?key)>)[^<]*(<\/\2>)/gi, '$1<secret>$3'],
  [/(\bkey\s*=\s*"[^"]*(?:password|passwd|secret|token|api[_-]?key|connectionstring)[^"]*"\s+value\s*=\s*")[^"]*"/gi, '$1<secret>"'],
  // Credentials in URLs: scheme://user:password@host, the user empty too (redis://:pw@host, A3-SRV-05).
  // The password up to the @ before the host, a / or @ in it too (mongodb://u:p@ss@db); not a port
  // before a path (host:443/@scope/pkg), audit 2026-11.
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/@]*:)(?!\d+\/)\S{0,300}?@(?=[^\s@/?#]*(?:[/?#\s]|$))/gi, '$1<secret>@'],
  // A secret as a command line option's next word (--password X, --token=X) and mysql's -pX (A3-SRV-05).
  // With a prefix too (--http-password, --db-password).
  [/((?:^|\s)--?(?:[a-z]+-)*(?:password|passwd|pass|passphrase|token|secret|api[_-]?key)(?:=|\s+))(?!<secret>)(?!-)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi, '$1<secret>'],
  [/(\b(?:mysql|mariadb|mysqldump|mariadb-dump|mysqladmin)\b[^\n]{0,300}?\s-p)(?!<secret>)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1<secret>'],
  // A password as a tool's short option (audit 2026-11): curl -u user:pw (the user kept), sshpass -p pw,
  // a registry login's -p pw, and htpasswd -b's last word.
  [/(\bcurl\b[^\n]{0,300}?\s(?:-u|--user)(?:=|\s*)[^\s:"']*:)(?!<secret>)[^\s"']+/g, '$1<secret>'],
  [/(\bsshpass\b[^\n]{0,300}?\s-p\s*)(?!<secret>)[^\s"']+/g, '$1<secret>'],
  [/(\b(?:docker|podman|buildah|skopeo|nerdctl|helm)\b[^\n]{0,300}?\blogin\b[^\n]{0,300}?\s-p(?:=|\s+))(?!<secret>)[^\s"']+/g, '$1<secret>'],
  [/(\bhtpasswd(?=[^\n;&|]{0,100}?\s-[a-zA-Z]*b)(?:\s+[^\s;&|]+){1,8}?\s+)(?!<secret>)[^\s"';&|]+(?=\s*(?:$|[;&|]))/gm, '$1<secret>'],
  // A query parameter that carries a signature or key (Azure SAS sig=, S3 and GCS signatures, key=, code=).
  [/([?&](?:sig|signature|key|code|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&\s"'#]+/gi, '$1<secret>'],
  // Webhook addresses whose path is the secret: Discord, Home Assistant, Slack.
  [/(\/api\/webhooks?\/)[^\s?#"'<>]+/gi, '$1<secret>'],
  [/(\bhooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s?#"'<>]+/gi, '$1<secret>'],
  // Well-known key formats.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '<secret>'],
  [/\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '<secret>'],
  [/\bwhsec_[A-Za-z0-9+/=]{20,}/g, '<secret>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<secret>'],
  [/\bglpat-[\w-]{20,}/g, '<secret>'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '<secret>'],
  [/\bAIza[\w-]{35}(?![\w-])/g, '<secret>'],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, '<secret>'],
  [/\btk_[a-z0-9]{24,}\b/g, '<secret>'],
  // A Telegram bot token: the bot's number, a colon, 35 characters.
  [/\b\d{8,10}:[\w-]{35}(?![\w-])/g, '<secret>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<secret>'],
  // AWS access keys of every kind: long-lived, temporary (ASIA), group, user and role ids.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g, '<secret>'],
  [/\bxox[abpr]-[\w-]{10,}\b/g, '<secret>'],
  [/\bxapp-[\w-]{10,}\b/g, '<secret>'],
  // An e-mail address with a password after it (user@example.com:pw): the password too.
  [/(\b[\w.+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}):(?!\d+\b)(?!\/)[^\s@]+/g, '$1:<secret>'],
  // E-mail addresses: a name ending in letters, so a login at an address (debian@10.0.0.20) is not one.
  [/\b[\w.+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, '<email>'],
  // Long random-looking strings (hex or base64 of 32+ characters).
  [/\b[A-Fa-f0-9]{40,}\b/g, '<hex>'],
  [/(?<![\w/])[A-Za-z0-9+/]{40,}={0,2}(?![\w/])/g, '<secret>'],
];

/**
 * A token of no known shape: 32 or more of [A-Za-z0-9_-] with letters and digits mixed and few
 * separators (a UUID has four; a long name of words has more), A3-SRV-05.
 */
const GENERIC_TOKEN = /(?<![\w-])[\w-]{32,}(?![\w-])/g;
const looksRandom = (m: string) => /\d/.test(m) && /[A-Za-z]/.test(m) && (m.match(/[-_]/g)?.length ?? 0) <= 3 && !m.startsWith('<');

const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
// Anything of hex groups and colons; isIpv6 then decides. The short forms
// (2001:db8::1, ::1) were missed, and a time (12:30:45) was taken for one.
const IPV6_LIKE = /(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;

/** Eight groups, or fewer around one "::". */
export function isIpv6(s: string): boolean {
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = (x: string) => (x ? x.split(':') : []);
  const all = halves.flatMap(groups);
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return halves.length === 2 ? all.length <= 7 : all.length === 8;
}

export function maskText(text: string, opts: { ips: boolean }): string {
  let s = text;
  for (const [re, to] of MASKS) s = s.replace(re, to);
  s = s.replace(GENERIC_TOKEN, (m) => (looksRandom(m) ? '<secret>' : m));
  if (opts.ips) s = s.replace(IPV4, '<ip>').replace(IPV6_LIKE, (m) => (isIpv6(m) ? '<ip>' : m));
  return s;
}

// ---- templates

/** A line with its variable parts replaced: "took 35 ms" and "took 12 ms" become one template. */
export function template(text: string): string {
  return text
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, '<time>')
    .replace(/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(IPV4, '<ip>')
    .replace(/"[^"]{0,200}"/g, '"<*>"')
    .replace(/(?<![\w<])[-+]?\d+(?:\.\d+)?(?![\w>])/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A JSON line's template is that of its message (msg, message, ...): the
 * template of the whole line would make every string "<*>", and lines that
 * say different things one group.
 */
function lineTemplate(masked: string): string {
  const j = parseJsonLine(masked);
  for (const k of ['msg', 'message', '@m', '@mt', 'log', 'text']) {
    const v = j?.[k];
    if (typeof v === 'string' && v.trim()) return template(v);
  }
  return template(masked);
}

export interface LogGroup {
  template: string;
  /** One real line of the group, masked. */
  sample: string;
  count: number;
  level: LogLevel | null;
  first: string | null;
  last: string | null;
  source: string;
}

export interface AnalysisLine {
  source: string;
  ts: string | null;
  text: string;
}

const RANK: Record<string, number> = { fatal: 0, error: 1, warn: 2, info: 4, debug: 5, trace: 6 };
const rank = (l: LogLevel | null) => (l ? RANK[l]! : 3);

/**
 * Drain's step: two templates of the same length that share most of their
 * words (and the first one) are one kind of line; the words that differ
 * become <*>. "user alice logged in" and "user bob logged in" merge.
 */
export function mergeTemplate(a: string, b: string, similarity = 0.7): string | null {
  const ta = a.split(' ');
  const tb = b.split(' ');
  if (ta.length !== tb.length || ta.length < 3 || ta[0] !== tb[0]) return null;
  let same = 0;
  for (let i = 0; i < ta.length; i++) if (ta[i] === tb[i]) same++;
  if (same / ta.length < similarity) return null;
  return ta.map((w, i) => (w === tb[i] ? w : '<*>')).join(' ');
}

/**
 * Groups lines into templates per source (similar lines merged), errors and
 * warnings first, then by how often they occur; cut to a character budget.
 */
export function groupLines(lines: AnalysisLine[], opts: { ips: boolean; budget: number }): { groups: LogGroup[]; total: number; omitted: number } {
  const m = new Map<string, LogGroup>();
  // The groups so far to merge similar lines into, by source, level, length
  // and first word (mergeTemplate merges no others), as Drain's tree does;
  // the newest MAX_PEERS of each, so many distinct lines stay a bounded
  // amount of work (AUDIT2 AI-05: every group against every other).
  const peersOf = new Map<string, LogGroup[]>();
  // A private key over several lines, per source (sources come interleaved):
  // every line from its BEGIN to its END. Masked a line at a time, a short
  // last line of the key went through (AUDIT2 AI-02).
  const inKey = new Set<string>();
  for (const l of lines) {
    const begins = KEY_BEGIN.test(l.text);
    const ends = KEY_END.test(l.text);
    const hidden = inKey.has(l.source) || begins;
    if (begins && !ends) inKey.add(l.source);
    if (ends) inKey.delete(l.source);
    const masked = hidden ? '<private key>' : maskText(l.text, opts);
    const tpl = lineTemplate(masked);
    const level = detectLevel(l.text);
    // The level is part of what a group is: an error never hides in a group of info lines.
    const key = `${l.source}\u0000${level}\u0000${tpl}`;
    let g = m.get(key);
    const words = tpl.split(' ');
    const bucket = `${l.source}\u0000${level}\u0000${words.length}\u0000${words[0]}`;
    if (!g) {
      const peers = peersOf.get(bucket) ?? [];
      for (let i = peers.length - 1; i >= 0; i--) {
        const p = peers[i]!;
        const merged = mergeTemplate(p.template, tpl);
        if (!merged) continue;
        g = p;
        if (merged !== p.template) p.template = merged;
        m.set(key, p);
        break;
      }
    }
    if (!g) {
      g = { template: tpl, sample: [...masked.slice(0, 1000)].slice(0, 500).join(''), count: 0, level, first: l.ts, last: l.ts, source: l.source };
      m.set(key, g);
      const peers = peersOf.get(bucket) ?? [];
      peers.push(g);
      if (peers.length > MAX_PEERS) peers.shift();
      peersOf.set(bucket, peers);
    }
    g.count++;
    g.last = l.ts ?? g.last;
  }
  const distinct = [...new Set(m.values())];
  const sorted = distinct.sort((a, b) => rank(a.level) - rank(b.level) || b.count - a.count);
  const groups: LogGroup[] = [];
  // The budget is the text the model reads (renderGroups), names and times included (AUDIT2 AI-07).
  let used = 0;
  for (const g of sorted) {
    const cost = renderGroup(g).length + (groups.length ? 1 : 0);
    if (used + cost <= opts.budget) {
      groups.push(g);
      used += cost;
    } else if (!groups.length) {
      // Too big even alone: the most important group, cut to fit, rather than nothing at all.
      const cut = fitGroup(g, opts.budget);
      if (cut) {
        groups.push(cut);
        used += renderGroup(cut).length;
      }
    }
  }
  return { groups, total: distinct.length, omitted: distinct.length - groups.length };
}

/** How many groups of one source, level, length and first word a new line is compared with. */
const MAX_PEERS = 64;

/** A group cut to `budget` characters as rendered: its sample and pattern shortened; null when not even its heading fits. */
function fitGroup(g: LogGroup, budget: number): LogGroup | null {
  const bare = { ...g, sample: '', template: '' };
  const room = budget - renderGroup(bare).length;
  if (room < 0) return null;
  return { ...g, sample: g.sample.slice(0, room), template: '' };
}

function renderGroup(g: LogGroup): string {
  const when = g.first && g.last && g.first !== g.last ? `${g.first} ... ${g.last}` : (g.first ?? '');
  // A merged group: its pattern too, so the model sees what varies.
  const pattern = g.template.includes('<*>') ? `\n  pattern: ${g.template}` : '';
  return `[${g.source}] ${g.count}x ${g.level ?? '-'} ${when}\n  ${g.sample}${pattern}`;
}

/** The groups as the text the model reads. */
export function renderGroups(groups: LogGroup[]): string {
  return groups.map(renderGroup).join('\n');
}

// ---- analysis API

export const MAX_ANALYZE_TARGETS = 100;

export const analyzeInput = z.object({
  targets: z
    .array(
      z
        .object({ hostId: z.number().int().positive(), container: z.string().max(128), file: z.string().max(1100).nullable().optional() })
        // A container's output, a container's log file, a log file on the
        // host, or a unit's journal: the same sources the log view reads.
        .refine((t) => (t.file ? validLogSource(t.container, t.file) : t.container.length > 0), 'a container, a log file or a journal'),
    )
    .min(1)
    // As many as the log view shows at once (server/src/docker/logs.ts).
    .max(MAX_ANALYZE_TARGETS),
  lines: z
    .array(z.object({ i: z.number().int().min(0).max(MAX_ANALYZE_TARGETS - 1), ts: z.string().max(64).nullable(), text: z.string().transform((s) => s.slice(0, 8000)) }))
    .max(20_000),
  /** Claude instead of the configured provider ("Deeper analysis"). */
  deep: z.boolean().default(false),
  /** The language of the answer. */
  lang: z.enum(['en', 'nl']).default('en'),
});
export type AnalyzeInput = z.infer<typeof analyzeInput>;

/** An AI analysis, kept on the server: it goes on when the page reloads. */
export interface Analysis {
  id: number;
  /** Of logs, or a question about a file or a part of it (report 76bcda). */
  kind: 'logs' | 'file';
  targets: { hostId: number; container: string; file?: string | null }[];
  lines: number;
  /** "ollama:gemma4" and the like. */
  provider: string;
  status: 'running' | 'done' | 'failed';
  /** The answer so far (Markdown). */
  text: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** As the provider counted them; null when it did not say. */
  tokens: { input: number; output: number } | null;
  /** The question as sent (masked): of one asked further, and of a question about a file; null on an analysis of logs. */
  ask: string | null;
  /** The questions asked on it, oldest first, each with its answer (report 0a86b2). */
  followUps: Analysis[];
  /** Whether a question may be asked now: done, kept with what was sent, nothing still being answered, room for one more. */
  canAsk: boolean;
}

/** Questions on one analysis, at most: each one sends the whole thread again. */
export const MAX_FOLLOW_UPS = 10;

/** A question asked further on an analysis (report 0a86b2). */
export const analysisAsk = z.object({
  question: z.string().trim().min(1).max(2000),
  lang: z.enum(['en', 'nl']).default('en'),
});

/**
 * A question about a file on a host, or the lines chosen in it (report 76bcda): the text as the
 * editor holds it (unsaved changes too), from its line firstLine on. The server cuts it to what
 * the model takes and masks it before it goes.
 */
/**
 * The most of the editor's text sent with a question about a file: more than any model is given
 * (server/src/ai/analyze.ts), and well under a request's 1 MB. The editor opens files up to 5 MB,
 * and the whole of one went and was refused as too large (audit 2026-11-09).
 */
export const FILE_ASK_MAX_CHARS = 200_000;

/** The text cut to FILE_ASK_MAX_CHARS at a line's end; the server says the lines after it were not sent. */
export function fileAskText(text: string): string {
  if (text.length <= FILE_ASK_MAX_CHARS) return text;
  const end = text.lastIndexOf('\n', FILE_ASK_MAX_CHARS);
  return text.slice(0, end > 0 ? end : FILE_ASK_MAX_CHARS);
}

export const fileAskInput = z.object({
  hostId: z.number().int().positive(),
  path: z.string().min(2).max(4096).startsWith('/'),
  text: z.string().max(2_000_000),
  firstLine: z.number().int().min(1).default(1),
  totalLines: z.number().int().min(0).optional(),
  question: z.string().trim().min(1).max(2000),
  deep: z.boolean().default(false),
  lang: z.enum(['en', 'nl']).default('en'),
});
export type FileAskInput = z.infer<typeof fileAskInput>;

// ---- alerts

/** Container events, and (phase 11) host events: a full disk, SMART trouble, heat. */
export type AlertEvent = 'crash' | 'oom' | 'unhealthy' | 'restart_loop' | 'disk_full' | 'smart' | 'hot' | 'busy' | 'updates' | 'scheduled' | 'unreachable';
export const ALERT_EVENTS: AlertEvent[] = ['crash', 'oom', 'unhealthy', 'restart_loop', 'disk_full', 'smart', 'hot', 'busy', 'updates', 'scheduled', 'unreachable'];
export const HOST_EVENTS: AlertEvent[] = ['disk_full', 'smart', 'hot', 'busy', 'updates', 'scheduled', 'unreachable'];

/** Host alerts carry their subject as "@disk /data", "@smart /dev/sda", "@temperature". */
export const isHostSubject = (container: string) => container.startsWith('@');

/**
 * What an alert can be about, and so what can be muted: a container, a
 * host's own subject ("@disk /data"), or a log file, a container's
 * ("web:%2Fapp%2Fa.log") or the host's (":%2Fvar%2Flog%2Fsyslog"). Files
 * could not be muted at all (audit BE-25).
 */
export function isAlertSubject(s: string): boolean {
  if (CONTAINER_NAME.test(s)) return true;
  if (/^@[\w ./:-]{1,120}$/.test(s)) return true;
  if (!s.includes(':') || s.length > MAX_SOURCE_SUBJECT) return false;
  return !!parseTarget(`0:${s}`)?.file;
}

/** A mute of `muted` silences `subject`: the same, or a log file of that container. */
export function muteCovers(muted: string, subject: string): boolean {
  if (muted === subject) return true;
  const i = subject.indexOf(':');
  return i > 0 && !isHostSubject(subject) && subject.slice(0, i) === muted;
}

const HOST_SUBJECTS: Record<string, { en: string; nl: string }> = {
  temperature: { en: 'Temperature', nl: 'Temperatuur' },
  disk: { en: 'Disk', nl: 'Schijf' },
  smart: { en: 'Disk health', nl: 'Schijfgezondheid' },
  reachable: { en: 'Reachable', nl: 'Bereikbaar' },
};

/** What an alert is about, for people: a container's name, or "Disk /data" for "@disk /data". */
export function subjectLabel(container: string, lang: 'en' | 'nl' = 'en'): string {
  // A log file: "web:%2Fapp%2Fa.log" (a container's) or ":%2Fvar%2Flog%2Fsyslog" (the host's).
  if (container.includes(':')) {
    const t = parseTarget(`0:${container}`);
    return t ? targetLabel(t) : container;
  }
  if (!isHostSubject(container)) return container;
  const [kind = '', ...rest] = container.slice(1).split(' ');
  const word = HOST_SUBJECTS[kind]?.[lang] ?? kind;
  return [word, ...rest].join(' ');
}

export type AlertKind = 'event' | 'pattern' | 'rate';

export interface AlertRule {
  id: number;
  name: string;
  kind: AlertKind;
  /** null: every host / container / stack. */
  hostId: number | null;
  container: string | null;
  project: string | null;
  /** event: which Docker events. */
  events: AlertEvent[];
  /** pattern: a regular expression on log lines. */
  pattern: string | null;
  /** rate: more than `threshold` error lines within `windowMinutes`. */
  threshold: number | null;
  windowMinutes: number | null;
  enabled: boolean;
  /** The built-in rule for crashes, OOM and unhealthy containers. */
  builtin: boolean;
  /**
   * Hosts where this log rule sees only some of the containers it covers:
   * Burrow follows at most 60 a host (OPS-W-09). Absent when it sees all.
   */
  partial?: { hostId: number; hostName: string; following: number; total: number }[];
}

export const alertRuleInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['event', 'pattern', 'rate']),
    hostId: z.number().int().positive().nullable(),
    // A container, or a log file of one ("web:<encoded path>").
    container: z.string().max(MAX_SOURCE_SUBJECT).nullable(),
    project: z.string().max(128).nullable(),
    events: z.array(z.enum(ALERT_EVENTS as [AlertEvent, ...AlertEvent[]])).default([]),
    pattern: z.string().max(500).nullable().default(null),
    threshold: z.number().int().min(1).max(10_000).nullable().default(null),
    windowMinutes: z.number().int().min(1).max(1440).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.kind === 'event' && !r.events.length) ctx.addIssue({ code: 'custom', message: 'Pick at least one event.', path: ['events'] });
    if (r.kind === 'pattern') {
      try {
        new RegExp(r.pattern ?? '');
        if (!r.pattern) throw new Error('empty');
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Not a valid regular expression.', path: ['pattern'] });
      }
    }
    if (r.kind === 'rate' && (!r.threshold || !r.windowMinutes)) ctx.addIssue({ code: 'custom', message: 'Set a number and a window.', path: ['threshold'] });
  });

const DISK_WORDS_NL: Record<string, string> = {
  'reallocated sector': 'verplaatste sector',
  'reallocated sectors': 'verplaatste sectoren',
  'pending sector': 'wachtende sector',
  'pending sectors': 'wachtende sectoren',
  'uncorrectable error': 'onherstelbare fout',
  'uncorrectable errors': 'onherstelbare fouten',
  'unreadable sector': 'onleesbare sector',
  'unreadable sectors': 'onleesbare sectoren',
  'command timeout': 'time-out',
  'command timeouts': 'time-outs',
  'media error': 'mediafout',
  'media errors': 'mediafouten',
};

/**
 * Alert titles are stored in English ("exited with code 1"); this gives them
 * in the reader's language, for the page and for the push.
 */
export function alertTitle(title: string, lang: 'en' | 'nl'): string {
  if (lang === 'en') return title;
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^exited with code (.+)$/, (m) => `gestopt met code ${m[1]}`],
    [/^killed: out of memory$/, () => 'gestopt: geheugen op'],
    [/^turned unhealthy$/, () => 'unhealthy geworden'],
    [/^stopped (\d+) times in 5 minutes$/, (m) => `${m[1]} keer gestopt in 5 minuten`],
    [/^log matches "(.*)"$/, (m) => `log past bij "${m[1]}"`],
    [/^(\d+) errors? in (\d+) min$/, (m) => `${plural(Number(m[1]), 'fout', 'fouten')} in ${m[2]} min`],
    [/^disk (\d+)% full$/, (m) => `schijf ${m[1]}% vol`],
    [/^SMART says the disk is failing$/, () => 'SMART meldt dat de schijf faalt'],
    [/^(\d+) reallocated sectors? \(was (\d+)\)$/, (m) => `${plural(Number(m[1]), 'verplaatste sector', 'verplaatste sectoren')} (was ${m[2]})`],
    [/^(\d+) pending sectors? \(was (\d+)\)$/, (m) => `${plural(Number(m[1]), 'wachtende sector', 'wachtende sectoren')} (was ${m[2]})`],
    [/^(\d+) media errors? \(was (\d+)\)$/, (m) => `${plural(Number(m[1]), 'mediafout', 'mediafouten')} (was ${m[2]})`],
    [/^(\d+) uncorrectable errors? \(was (\d+)\)$/, (m) => `${plural(Number(m[1]), 'onherstelbare fout', 'onherstelbare fouten')} (was ${m[2]})`],
    [/^(\d+) unreadable sectors? \(was (\d+)\)$/, (m) => `${plural(Number(m[1]), 'onleesbare sector', 'onleesbare sectoren')} (was ${m[2]})`],
    [/^the disk reports a critical warning$/, () => 'de schijf meldt een kritieke waarschuwing'],
    [/^the disk is judged failing$/, () => 'de schijf wordt als stervend beoordeeld'],
    [/^getting worse: (\d+) (.+?) \(was (\d+)\)$/, (m) => `slechter: ${m[1]} ${DISK_WORDS_NL[m[2]!] ?? m[2]} (was ${m[3]})`],
    [/^worn out: (\d+)% used$/, (m) => `versleten: ${m[1]}% gebruikt, aan vervanging toe`],
    [/^worn: (\d+)% used$/, (m) => `versleten: ${m[1]}% gebruikt`],
    [/^disk at (.+) C$/, (m) => `schijf op ${m[1]} C`],
    [/^CPU at (\d+)% for (\d+) minutes$/, (m) => `CPU op ${m[1]}% gedurende ${m[2]} minuten`],
    [/^memory (\d+)% full for (\d+) minutes$/, (m) => `geheugen ${m[1]}% vol gedurende ${m[2]} minuten`],
    [/^"(.+)" failed with exit code (\d+)$/, (m) => `"${m[1]}" mislukt met exitcode ${m[2]}`],
    [/^"(.+)" timed out after (\d+) min$/, (m) => `"${m[1]}" afgebroken na ${m[2]} min`],
    [/^"(.+)" could not run: (.+)$/, (m) => `"${m[1]}" kon niet draaien: ${m[2]}`],
    [/^(\d+) security updates? waiting(: .+)?$/, (m) => `${plural(Number(m[1]), 'beveiligingsupdate', 'beveiligingsupdates')} klaar${m[2] ?? ''}`],
    [/^not reachable: (.+)$/, (m) => `niet bereikbaar: ${m[1]}`],
    [/^reachable again after (\d+) minutes?$/, (m) => `weer bereikbaar na ${m[1]} ${m[1] === '1' ? 'minuut' : 'minuten'}`],
    [/^(.+) at (.+) C$/, (m) => `${m[1]} op ${m[2]} C`],
  ];
  for (const [re, to] of rules) {
    const m = re.exec(title);
    if (m) return to(m);
  }
  return title;
}

export interface Alert {
  id: number;
  ruleId: number | null;
  ruleName: string;
  hostId: number;
  hostName: string;
  container: string;
  /** What happened, in a few words: "exited with code 1", "OOM killed". */
  title: string;
  detail: string | null;
  /** Docker timestamp of the moment, for the link to the logs. */
  at: string;
  /** Events bundled into this one. */
  count: number;
  read: boolean;
  /** Sent to the push channel (or why not). */
  pushed: 'yes' | 'no' | 'failed' | 'muted';
}

export interface AlertMute {
  hostId: number;
  container: string;
  until: string | null;
}
