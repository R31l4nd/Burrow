import { eq } from 'drizzle-orm';
import type { Notice, PushDevice, PushDeviceInput } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { appSettings, pushSubscriptions, users } from '../db/schema.js';
import { HttpError } from '../http.js';
import type { FetchFn } from './channels.js';
import { encryptPush, newVapidKeys, vapidHeader } from './webpush.js';

// Burrow's own push: devices that turned notifications on (a browser through
// its push service, the Android app through UnifiedPush) and sending to them.
// What goes out is encrypted for each device; the push service only carries it.

const VAPID_KEY = 'vapid';
const SEALED = 'push.vapid';

/** The server's VAPID key pair, made the first time it is needed. */
function vapid(ctx: Ctx): { privatePem: string; publicKey: string } {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, VAPID_KEY)).get();
  if (row) {
    const v = JSON.parse(row.value) as { privateEnc: string; publicKey: string };
    return { privatePem: ctx.box.open(v.privateEnc, SEALED), publicKey: v.publicKey };
  }
  const keys = newVapidKeys();
  const value = JSON.stringify({ privateEnc: ctx.box.seal(keys.privatePem, SEALED), publicKey: keys.publicKey });
  ctx.db.insert(appSettings).values({ key: VAPID_KEY, value, updatedAt: ctx.now() }).onConflictDoNothing().run();
  return vapid(ctx);
}

/** What a browser needs to subscribe (applicationServerKey). */
export const vapidPublicKey = (ctx: Ctx): string => vapid(ctx).publicKey;

type Row = typeof pushSubscriptions.$inferSelect;
const toDevice = (r: Row): PushDevice => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  createdAt: new Date(r.createdAt).toISOString(),
  lastOkAt: r.lastOkAt ? new Date(r.lastOkAt).toISOString() : null,
});

export function listPushDevices(ctx: Ctx, userId: number): PushDevice[] {
  return ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all().map(toDevice);
}

export const pushDeviceCount = (ctx: Ctx): number => ctx.db.select().from(pushSubscriptions).all().length;

/** Devices one person may have: a push address is whatever a device gives, so not without end (AUDIT BE-08). */
export const MAX_PUSH_DEVICES = 20;

/** A device turns notifications on (again): one row per push address. */
export function addPushDevice(ctx: Ctx, userId: number, input: PushDeviceInput): PushDevice {
  const own = ctx.db.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
  if (own.length >= MAX_PUSH_DEVICES && !own.some((r) => r.endpoint === input.endpoint)) {
    throw new HttpError(409, 'too_many_devices', `At most ${MAX_PUSH_DEVICES} devices get notifications; remove one first.`);
  }
  const values = { userId, kind: input.kind, label: input.label, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, lang: input.lang };
  // Only one's own row is updated: a push address another person turned on stays theirs. It moved
  // to whoever sent it, and its owner silently got no alerts any more (A3-SRV-10).
  const r = ctx.db
    .insert(pushSubscriptions)
    .values({ ...values, createdAt: ctx.now() })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values, setWhere: eq(pushSubscriptions.userId, userId) })
    .returning()
    .get();
  if (!r) throw new HttpError(409, 'device_taken', 'Another person gets notifications on this device; they turn theirs off first.');
  return toDevice(r);
}

export function removePushDevice(ctx: Ctx, userId: number, id: number): PushDevice {
  const r = ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id)).get();
  if (!r || r.userId !== userId) throw new HttpError(404, 'not_found');
  ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
  return toDevice(r);
}

// A push service takes 4096 bytes, encrypted: 3993 of text at most (RFC
// 8291). Counted in bytes, not characters: a log line in another script
// takes three bytes a character.
const MAX_BYTES = 3800;

/** What the device shows: its own language, the page to open on a tap. */
export function pushPayload(n: Notice, lang: 'en' | 'nl'): string {
  const m = lang === 'nl' && n.nl ? { ...n, ...n.nl } : n;
  const text = (title: string, body: string) => JSON.stringify({ title, body, page: m.page, priority: m.priority, topic: m.topic });
  const title = [...m.title].slice(0, 200).join('');
  let body = [...m.body].slice(0, 1500);
  // Shorter until it fits, by whole characters (never half of one).
  while (body.length && Buffer.byteLength(text(title, body.join(''))) > MAX_BYTES) body = body.slice(0, Math.floor(body.length * 0.9));
  return text(title, body.join(''));
}

/** Topics for admins' eyes only. */
const ADMIN_ONLY = new Set<Notice['topic']>(['problems']);

/**
 * To every device (or only `userId`'s): how many took it, and why the others
 * did not. A device the push service no longer knows (404, 410) is removed.
 */
export async function sendPush(ctx: Ctx, n: Notice, f: FetchFn = fetch, userId?: number): Promise<{ total: number; ok: number; errors: string[] }> {
  // What only admins may read (a problem report's words) goes to their
  // devices only, as they are now (AUDIT2 MON-06: an operator's phone got it).
  const admins = ADMIN_ONLY.has(n.topic) ? new Set(ctx.db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all().map((u) => u.id)) : null;
  const rows = ctx.db
    .select()
    .from(pushSubscriptions)
    .all()
    .filter((r) => (userId === undefined || r.userId === userId) && (!admins || admins.has(r.userId)));
  return sendTo(ctx, rows, (r) => pushPayload(n, r.lang), n.priority >= 4 ? 'high' : 'normal', f);
}

/**
 * The same, with what each device gets made for it: encrypted, posted, a
 * device the push service no longer knows (404, 410) removed.
 */
async function sendTo(ctx: Ctx, rows: Row[], payload: (r: Row) => string, urgency: 'high' | 'normal' | 'low', f: FetchFn): Promise<{ total: number; ok: number; errors: string[] }> {
  if (!rows.length) return { total: 0, ok: 0, errors: [] };
  const v = vapid(ctx);
  const errors: string[] = [];
  let ok = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        const body = encryptPush(Buffer.from(payload(r)), r.p256dh, r.auth);
        const res = await f(r.endpoint, {
          method: 'POST',
          headers: {
            authorization: vapidHeader(r.endpoint, v.privatePem, ctx.config.origin),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: '86400',
            urgency,
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(15_000),
          // A push service answers where it is; a redirect would take the POST
          // to an address nobody gave (AUDIT BE-08).
          redirect: 'manual',
        });
        if (res.status === 404 || res.status === 410) {
          ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, r.id)).run();
          throw new Error(`${r.label}: no longer subscribed, removed`);
        }
        if (!res.ok) throw new Error(`${r.label}: the push service answered ${res.status}`);
        ctx.db.update(pushSubscriptions).set({ lastOkAt: ctx.now() }).where(eq(pushSubscriptions.id, r.id)).run();
        ok++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }),
  );
  return { total: rows.length, ok, errors };
}

/**
 * Data for the Android app's widget (2.11.0), not a notification: to a
 * person's devices that asked for it, quietly (urgency low, kept an hour).
 */
export async function sendWidgetData(ctx: Ctx, userId: number, data: unknown, f: FetchFn = fetch): Promise<{ total: number; ok: number; errors: string[] }> {
  const rows = ctx.db
    .select()
    .from(pushSubscriptions)
    .all()
    .filter((r) => r.userId === userId && r.widget);
  return sendTo(ctx, rows, () => JSON.stringify({ widget: data }), 'low', f);
}

/** A device of this person asks for the widget's data by push, or no longer. */
export function setWidgetPush(ctx: Ctx, userId: number, endpoint: string, on: boolean): boolean {
  const r = ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get();
  if (!r || r.userId !== userId) return false;
  ctx.db.update(pushSubscriptions).set({ widget: on }).where(eq(pushSubscriptions.id, r.id)).run();
  return true;
}
