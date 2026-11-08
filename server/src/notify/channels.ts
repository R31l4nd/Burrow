import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { Channel, ChannelInput, ChannelKind, Notice, NotifyTopic } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { appSettings, channels, devices, pushSubscriptions } from '../db/schema.js';
import { HttpError, originOf, secretFor } from '../http.js';
import { ntfyRequest, pageLink } from './ntfy.js';
import { pushDeviceCount, sendPush } from './push.js';

// Notification channels. Each stores its settings as JSON with its secrets
// sealed (the ntfy token, the SMTP password, the Discord webhook address, the
// webhook's signing secret); the browser only learns whether one is set.

const SECRET = 'channels.secret';

interface NtfyConfig {
  url: string;
  topic: string;
  tokenEnc: string | null;
  openIn: 'app' | 'browser';
}
interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordEnc: string | null;
  from: string;
  to: string;
}
interface DiscordConfig {
  urlEnc: string | null;
}
interface WebhookConfig {
  url: string;
  secretEnc: string | null;
}
type Config = NtfyConfig | EmailConfig | DiscordConfig | WebhookConfig | Record<string, never>;

type Row = typeof channels.$inferSelect;

export function toChannel(r: Row, devices = 0): Channel {
  const c = JSON.parse(r.config) as Config;
  const out: Channel = { id: r.id, kind: r.kind, name: r.name, enabled: r.enabled, topics: JSON.parse(r.topics) as NotifyTopic[], lang: r.lang };
  if (r.kind === 'ntfy') {
    const n = c as NtfyConfig;
    out.ntfy = { url: n.url, topic: n.topic, hasToken: n.tokenEnc !== null, openIn: n.openIn };
  } else if (r.kind === 'email') {
    const e = c as EmailConfig;
    out.email = { host: e.host, port: e.port, secure: e.secure, user: e.user, hasPassword: e.passwordEnc !== null, from: e.from, to: e.to };
  } else if (r.kind === 'discord') out.discord = { hasUrl: (c as DiscordConfig).urlEnc !== null };
  else if (r.kind === 'push') out.push = { devices };
  else out.webhook = { url: (c as WebhookConfig).url, hasSecret: (c as WebhookConfig).secretEnc !== null };
  return out;
}

export function listChannels(ctx: Ctx): Channel[] {
  const n = pushDeviceCount(ctx);
  return ctx.db
    .select()
    .from(channels)
    .all()
    .map((r) => toChannel(r, n));
}

function row(ctx: Ctx, id: number): Row {
  const r = ctx.db.select().from(channels).where(eq(channels.id, id)).get();
  if (!r) throw new HttpError(404, 'not_found');
  return r;
}

const seal = (ctx: Ctx, cur: string | null, next: string | undefined, sameDestination = true): string | null =>
  secretFor(cur, next, sameDestination, (v) => ctx.box.seal(v, SECRET));

function config(ctx: Ctx, input: ChannelInput, cur: Config | null): Config {
  switch (input.kind) {
    case 'ntfy': {
      // Another server: the stored token does not go along unless given again (A3-SRV-07).
      const was = cur as NtfyConfig | null;
      const url = input.ntfy.url.replace(/\/+$/, '');
      return { url, topic: input.ntfy.topic, tokenEnc: seal(ctx, was?.tokenEnc ?? null, input.ntfy.token, !was || originOf(was.url) === originOf(url)), openIn: input.ntfy.openIn };
    }
    case 'email': {
      // Another mail server, or TLS turned off: the stored password is not sent there unless given again (A3-SRV-07).
      const was = cur as EmailConfig | null;
      const same = !was || (was.host.toLowerCase() === input.email.host.toLowerCase() && was.port === input.email.port && (input.email.secure || !was.secure));
      return { ...input.email, passwordEnc: seal(ctx, was?.passwordEnc ?? null, input.email.password, same), password: undefined } as EmailConfig;
    }
    case 'discord': {
      const urlEnc = seal(ctx, (cur as DiscordConfig | null)?.urlEnc ?? null, input.discord.url);
      if (!urlEnc) throw new HttpError(400, 'invalid_input', 'Enter the Discord webhook address.');
      return { urlEnc };
    }
    case 'webhook':
      return { url: input.webhook.url, secretEnc: seal(ctx, (cur as WebhookConfig | null)?.secretEnc ?? null, input.webhook.secret) };
    case 'push':
      return {};
  }
}

export function saveChannel(ctx: Ctx, input: ChannelInput, id?: number): Channel {
  const cur = id ? row(ctx, id) : null;
  if (cur && cur.kind !== input.kind) throw new HttpError(400, 'invalid_input', 'A channel keeps its kind.');
  const cfg = JSON.stringify(config(ctx, input, cur ? (JSON.parse(cur.config) as Config) : null));
  const values = { kind: input.kind, name: input.name, enabled: input.enabled, topics: JSON.stringify(input.topics), lang: input.lang, config: cfg };
  const r = cur
    ? ctx.db.update(channels).set(values).where(eq(channels.id, cur.id)).returning().get()
    : ctx.db
        .insert(channels)
        .values({ ...values, createdAt: ctx.now() })
        .returning()
        .get();
  return toChannel(r, pushDeviceCount(ctx));
}

export function deleteChannel(ctx: Ctx, id: number): Channel {
  const r = row(ctx, id);
  ctx.db.delete(channels).where(eq(channels.id, id)).run();
  return toChannel(r);
}

/**
 * Phase 9 kept one ntfy setting in app_settings; it becomes a channel for
 * alerts (once).
 */
export function migrateNtfySetting(ctx: Ctx): void {
  const old = ctx.db.select().from(appSettings).where(eq(appSettings.key, 'ntfy')).get();
  if (!old) return;
  const s = JSON.parse(old.value) as { enabled?: boolean; url?: string; topic?: string; tokenEnc?: string | null; openIn?: 'app' | 'browser'; lang?: 'en' | 'nl' };
  if (s.topic) {
    // The old token was sealed under its own context: open and seal again.
    const token = s.tokenEnc ? ctx.box.open(s.tokenEnc, 'app_settings.ntfy.token') : null;
    const cfg: NtfyConfig = {
      url: s.url ?? 'https://ntfy.sh',
      topic: s.topic,
      tokenEnc: token ? ctx.box.seal(token, SECRET) : null,
      openIn: s.openIn ?? (ctx.db.select().from(devices).all().length ? 'app' : 'browser'),
    };
    ctx.db
      .insert(channels)
      .values({ kind: 'ntfy', name: 'ntfy', enabled: s.enabled ?? false, topics: JSON.stringify(['alerts']), lang: s.lang ?? 'en', config: JSON.stringify(cfg), createdAt: ctx.now() })
      .run();
  }
  ctx.db.delete(appSettings).where(eq(appSettings.key, 'ntfy')).run();
}

// ---- sending

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SendDeps {
  fetch?: FetchFn;
  /** nodemailer transport options for tests (e.g. { jsonTransport: true }). */
  mailTransport?: object;
}

async function ok(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const COLORS: Record<number, number> = { 1: 0x8b929c, 2: 0x8b929c, 3: 0x3fb950, 4: 0xd29922, 5: 0xf85149 };

/** Sends one notice through one channel; throws with the reason when it fails. */
export async function sendTo(ctx: Ctx, r: Row, notice: Notice, deps: SendDeps = {}): Promise<void> {
  const n: Notice = r.lang === 'nl' && notice.nl ? { ...notice, ...notice.nl, actions: notice.nl.actions ?? notice.actions } : notice;
  const f = deps.fetch ?? fetch;
  const c = JSON.parse(r.config) as Config;
  const web = `${ctx.config.origin}/#${n.page}`;
  const signal = AbortSignal.timeout(15_000);
  switch (r.kind as ChannelKind) {
    case 'ntfy': {
      const s = c as NtfyConfig;
      const link = (page: string) => pageLink(ctx.config.origin, page, s.openIn);
      const { url, init } = ntfyRequest(
        { url: s.url, topic: s.topic, token: s.tokenEnc ? ctx.box.open(s.tokenEnc, SECRET) : null },
        {
          title: n.title,
          body: n.body,
          priority: n.priority,
          tags: [n.priority >= 4 ? 'rotating_light' : n.topic === 'reports' ? 'clipboard' : n.topic === 'updates' ? 'arrows_counterclockwise' : 'bell'],
          click: link(n.page),
          actions: (n.actions ?? [{ label: r.lang === 'nl' ? 'Openen' : 'Open', page: n.page }]).slice(0, 3).map((a) => ({ label: a.label, url: link(a.page) })),
        },
      );
      await ok(await f(url, { ...init, signal }), 'ntfy');
      return;
    }
    case 'email': {
      const e = c as EmailConfig;
      const transport = nodemailer.createTransport(
        (deps.mailTransport ?? {
          host: e.host,
          port: e.port,
          secure: e.secure,
          auth: e.user ? { user: e.user, pass: e.passwordEnc ? ctx.box.open(e.passwordEnc, SECRET) : '' } : undefined,
          connectionTimeout: 15_000,
        }) as Parameters<typeof nodemailer.createTransport>[0],
      );
      await transport.sendMail({
        from: e.from,
        to: e.to,
        subject: n.title,
        text: `${n.body}\n\n${web}\n`,
        html: emailHtml(n, web, r.lang),
      });
      return;
    }
    case 'discord': {
      const d = c as DiscordConfig;
      if (!d.urlEnc) throw new Error('no webhook address');
      const body = {
        username: 'Burrow',
        // Never a ping: an "@everyone" in a container's log line stays text.
        allowed_mentions: { parse: [] },
        embeds: [{ title: n.title.slice(0, 256), description: n.body.slice(0, 4000), url: web, color: COLORS[n.priority] ?? COLORS[3] }],
      };
      await ok(await f(ctx.box.open(d.urlEnc, SECRET), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }), 'Discord');
      return;
    }
    case 'push': {
      const r = await sendPush(ctx, notice, f);
      if (!r.total) throw new Error('no device has turned notifications on (Settings -> this device)');
      if (!r.ok) throw new Error(r.errors[0] ?? 'no device took it');
      return;
    }
    case 'webhook': {
      const w = c as WebhookConfig;
      const body = JSON.stringify({ topic: n.topic, title: n.title, body: n.body, url: web, priority: n.priority, data: n.data ?? null });
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Burrow' };
      if (w.secretEnc) headers['x-burrow-signature'] = `sha256=${createHmac('sha256', ctx.box.open(w.secretEnc, SECRET)).update(body).digest('hex')}`;
      await ok(await f(w.url, { method: 'POST', headers, body, signal }), 'The webhook');
      return;
    }
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain e-mail: the text as paragraphs, and a button to open Burrow. */
export function emailHtml(n: Notice, url: string, lang: 'en' | 'nl'): string {
  const paras = n.body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1f2328;line-height:1.45;max-width:640px">',
    `<h2 style="font-size:18px;margin:0 0 12px">${esc(n.title)}</h2>`,
    paras,
    `<p><a href="${esc(url)}" style="display:inline-block;background:#1a7f37;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">${lang === 'nl' ? 'Openen in Burrow' : 'Open in Burrow'}</a></p>`,
    '</body></html>',
  ].join('');
}

/** Every enabled channel for a topic gets the notice; failures are logged, not thrown. */
export class Notifier {
  /** Channels whose last send failed, by name: since when, and why (told by the self-watch through the others). */
  readonly failing = new Map<string, { error: string; since: number }>();

  constructor(
    private readonly ctx: Ctx,
    private readonly deps: SendDeps = {},
  ) {}

  /** Straight to one person's devices (their test), whatever the channels. */
  pushTo(userId: number, n: Notice): ReturnType<typeof sendPush> {
    return sendPush(this.ctx, n, this.deps.fetch ?? fetch, userId);
  }

  /** How many channels took it, and which failed. No channel for the topic: sent 0. */
  async notify(n: Notice, only?: number): Promise<{ sent: number; failed: { channel: string; error: string }[] }> {
    const rows = this.ctx.db
      .select()
      .from(channels)
      .all()
      .filter((r) => (only ? r.id === only : r.enabled && (n.topic === 'test' || (JSON.parse(r.topics) as string[]).includes(n.topic))));
    const failed: { channel: string; error: string }[] = [];
    let sent = 0;
    await Promise.all(
      rows.map(async (r) => {
        try {
          await sendTo(this.ctx, r, n, this.deps);
          sent++;
          this.failing.delete(r.name);
        } catch (err) {
          failed.push({ channel: r.name, error: (err as Error).message });
          if (!this.failing.has(r.name)) this.failing.set(r.name, { error: (err as Error).message, since: this.ctx.now() });
          this.ctx.log.warn(`notify: ${r.kind} "${r.name}" failed: ${(err as Error).message}`);
        }
      }),
    );
    return { sent, failed };
  }

  /** The language most channels for a topic use (for texts made before sending). */
  lang(topic: NotifyTopic): 'en' | 'nl' {
    const all = this.ctx.db.select().from(channels).all().filter((r) => r.enabled);
    const most = (langs: string[]) => (langs.filter((l) => l === 'nl').length > langs.length / 2 ? 'nl' : 'en');
    const forTopic = all.filter((r) => (JSON.parse(r.topics) as string[]).includes(topic)).map((r) => r.lang);
    if (forTopic.length) return most(forTopic);
    // No channel for it (a report read only in Burrow): the language of the
    // other channels, else of the phones and browsers that get push.
    if (all.length) return most(all.map((r) => r.lang));
    const devices = this.ctx.db.select({ lang: pushSubscriptions.lang }).from(pushSubscriptions).all().map((d) => d.lang);
    return devices.length ? most(devices) : 'en';
  }
}
