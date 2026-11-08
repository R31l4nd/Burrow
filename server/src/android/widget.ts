import { count, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sameWidget, type WidgetHost, type WidgetSummary } from '@burrow/shared';
import { readUpTo } from '../alerts/routes.js';
import type { Ctx } from '../context.js';
import { alerts, devices, hosts, pushSubscriptions, users } from '../db/schema.js';
import { parseDeviceKey, verifyDeviceSignature } from '../auth/devices.js';
import type { PackageChecks } from '../hosts/packages.js';
import type { StatusMonitor } from '../hosts/status.js';
import { HttpError, idParam, parse, requireAuth } from '../http.js';
import type { FetchFn } from '../notify/channels.js';
import { sendWidgetData, setWidgetPush } from '../notify/push.js';

// The Android app's widget (2.11.0): a few counts for the home screen, and
// each host on a line of its own (2.13.0). The app asks for them (at home, or
// through its tunnel for a moment), or gets them by push when it asked for
// that: sent when they change, checked once a minute, only to devices that
// want them.

/** The most hosts on the widget's lines: a home screen shows a dozen at most, and a push carries 4 kB. */
const WIDGET_HOSTS = 20;
const RANK: Record<WidgetHost['state'], number> = { down: 0, unknown: 1, up: 2 };

export function widgetSummary(ctx: Ctx, status: StatusMonitor, packages: PackageChecks, userId: number): WidgetSummary {
  const all = ctx.db.select({ id: hosts.id, name: hosts.name }).from(hosts).all();
  const ids = new Set(all.map((h) => h.id));
  const seen = status.all().filter((s) => ids.has(s.hostId));
  const pk = packages.all().filter((p) => ids.has(p.hostId) && p.state === 'ok');
  const list = all
    .map((h): WidgetHost => {
      const s = seen.find((x) => x.hostId === h.id);
      const p = pk.find((x) => x.hostId === h.id);
      return { id: h.id, name: h.name.slice(0, 40), state: !s ? 'unknown' : s.reachable ? 'up' : 'down', updates: p?.total ?? 0, security: p?.security ?? 0 };
    })
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name))
    .slice(0, WIDGET_HOSTS);
  return {
    at: new Date(ctx.now()).toISOString(),
    hosts: { total: ids.size, up: seen.filter((s) => s.reachable).length, down: seen.filter((s) => !s.reachable).length },
    alerts: ctx.db.select({ n: count() }).from(alerts).where(gt(alerts.updatedAt, readUpTo(ctx, userId))).get()?.n ?? 0,
    updates: { hosts: pk.filter((p) => p.total > 0).length, security: pk.reduce((n, p) => n + p.security, 0) },
    list,
  };
}

export class WidgetPusher {
  #timer: NodeJS.Timeout | null = null;
  /** What each person's devices got last. */
  readonly #sent = new Map<number, WidgetSummary>();

  constructor(
    private readonly ctx: Ctx,
    private readonly status: StatusMonitor,
    private readonly packages: PackageChecks,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  start(): void {
    this.#timer = setInterval(() => void this.tick(), 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** To each person with a device that asked: their numbers, when they changed. */
  async tick(): Promise<void> {
    const people = new Set(this.ctx.db.select({ userId: pushSubscriptions.userId, widget: pushSubscriptions.widget }).from(pushSubscriptions).all().filter((r) => r.widget).map((r) => r.userId));
    for (const userId of people) {
      const now = widgetSummary(this.ctx, this.status, this.packages, userId);
      if (sameWidget(this.#sent.get(userId) ?? null, now)) continue;
      const r = await sendWidgetData(this.ctx, userId, now, this.fetchFn).catch(() => null);
      // Sent to at least one: kept, else tried again next minute.
      if (r && r.ok > 0) this.#sent.set(userId, now);
    }
  }

  /** A device turned it on: it gets the numbers at the next check, changed or not. */
  forget(userId: number): void {
    this.#sent.delete(userId);
  }
}

/** What the widget's key signs: its phone, the moment, and which Burrow (a signature for another Burrow is of no use here). */
export const widgetMessage = (origin: string, deviceId: number, ts: number) => ['burrow-widget', origin, String(deviceId), String(ts)].join('\n');

const WIDGET_SKEW_MS = 5 * 60_000;

export function registerWidgetRoutes(app: FastifyInstance, c: Ctx, status: StatusMonitor, packages: PackageChecks, pusher: WidgetPusher): void {
  app.get('/api/widget', { config: { auth: 'user' } }, async (req): Promise<WidgetSummary> => widgetSummary(c, status, packages, requireAuth(req).user.id));

  // The phone's widget from the background, its sign-in expired (seven days unused): signed with the
  // widget's own key, "<deviceId>.<ms>.<signature>". The counts and nothing else; each moment once.
  const lastTs = new Map<number, number>();
  app.get('/api/widget/device', { config: { auth: 'public' } }, async (req): Promise<WidgetSummary> => {
    const m = /^(\d+)\.(\d+)\.([A-Za-z0-9+/=]{20,200})$/.exec(String(req.headers['x-burrow-widget'] ?? ''));
    if (!m) throw new HttpError(401, 'unauthenticated');
    const deviceId = Number(m[1]);
    const ts = Number(m[2]);
    const device = c.db.select().from(devices).where(eq(devices.id, deviceId)).get();
    const fresh = Math.abs(c.now() - ts) <= WIDGET_SKEW_MS && ts > (lastTs.get(deviceId) ?? 0);
    if (!device?.widgetKey || !fresh || !verifyDeviceSignature(device.widgetKey, widgetMessage(c.config.origin, deviceId, ts), m[3]!)) throw new HttpError(401, 'unauthenticated');
    lastTs.set(deviceId, ts);
    const user = c.db.select({ id: users.id }).from(users).where(eq(users.id, device.userId)).get();
    if (!user) throw new HttpError(401, 'unauthenticated');
    return widgetSummary(c, status, packages, user.id);
  });

  // This phone's widget key, from the phone itself (signed in with its device key).
  app.put('/api/account/devices/:id/widget-key', { config: { auth: 'user' } }, async (req) => {
    const id = idParam(req);
    const a = requireAuth(req);
    if (a.session.deviceId !== id) throw new HttpError(403, 'wrong_device');
    const { publicKey } = parse(z.object({ publicKey: z.string().max(500) }), req.body);
    parseDeviceKey(publicKey);
    c.db.update(devices).set({ widgetKey: publicKey }).where(eq(devices.id, id)).run();
    return { ok: true };
  });

  // This device's push address (turned on for notifications first) carries the widget's numbers, or no longer.
  app.put('/api/widget/push', { config: { auth: 'user' } }, async (req) => {
    const { endpoint, on } = parse(z.object({ endpoint: z.string().url().max(2048), on: z.boolean() }), req.body);
    const userId = requireAuth(req).user.id;
    if (!setWidgetPush(c, userId, endpoint, on)) throw new HttpError(404, 'no_push_device', 'Turn on notifications on this phone first: the widget gets its numbers the same way.');
    if (on) pusher.forget(userId);
    return { on };
  });
}
