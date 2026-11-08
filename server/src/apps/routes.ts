import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appInput, type AppTab, type DiscoveredApp, type DiscoveryResult } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { apps, hosts } from '../db/schema.js';
import type { SftpPool } from '../files/pool.js';
import { listHosts } from '../hosts/service.js';
import { actor, HttpError, idParam, noContent, parse } from '../http.js';
import { exec } from '../ssh/connect.js';
import { appFromLabels, appsFromNpmConfs, appsFromSwagConfs, baseDomainOf, LIST_COMMAND, parseInspect, NPM_CONFS_COMMAND, SWAG_CONFS_COMMAND } from './discover.js';
import { type Fetcher, probeApp } from './probe.js';
import type { UptimeMonitor } from './uptime.js';

type Row = typeof apps.$inferSelect;

const toApp = (r: Row, uptime: number | null = null): AppTab => ({
  id: r.id,
  name: r.name,
  url: r.url,
  group: r.grp,
  pinned: r.pinned,
  embeddable: r.embeddable,
  hasIcon: !!r.icon,
  hostId: r.hostId,
  container: r.container,
  monitor: r.monitor,
  newTab: r.newTab,
  up: r.monitor ? r.up : null,
  checkedAt: r.checkedAt ? new Date(r.checkedAt).toISOString() : null,
  latencyMs: r.latencyMs,
  certExpiresAt: r.certExpiresAt ? new Date(r.certExpiresAt).toISOString() : null,
  downSince: r.downSince ? new Date(r.downSince).toISOString() : null,
  uptime: r.monitor ? uptime : null,
});

/**
 * The origins Burrow's page may frame: the apps that allow it. Read by the
 * CSP header on every page load, so kept in memory and refreshed on change.
 */
export class AppFrames {
  #origins: string[] | null = null;
  constructor(private readonly ctx: Ctx) {}
  origins(): string[] {
    this.#origins ??= [
      ...new Set(
        this.ctx.db
          .select({ url: apps.url })
          .from(apps)
          .where(eq(apps.embeddable, 'yes'))
          .all()
          .map((a) => new URL(a.url).origin),
      ),
    ];
    return this.#origins;
  }
  changed(): void {
    this.#origins = null;
  }
}

export function registerAppRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool, frames: AppFrames, fetcher: Fetcher = fetch, uptime: UptimeMonitor | null = null): void {
  const view = (r: Row) => toApp(r, uptime?.uptime(r.id) ?? null);
  const get = (id: number) => {
    const r = ctx.db.select().from(apps).where(eq(apps.id, id)).get();
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  };
  const checkUrlFree = (url: string, id?: number) => {
    const other = ctx.db.select({ id: apps.id }).from(apps).where(eq(apps.url, url)).get();
    if (other && other.id !== id) throw new HttpError(409, 'duplicate', 'An app with this URL exists already.');
  };
  const checkHost = (hostId: number | null | undefined) => {
    if (hostId && !ctx.db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, hostId)).get()) throw new HttpError(400, 'unknown_host');
  };

  /** Look at the app (frame allowed? icon?) and store what was found. */
  const probe = async (id: number) => {
    const r = get(id);
    const res = await probeApp(r.url, ctx.config.origin, fetcher);
    // Up or down at once, not a minute later.
    if (r.monitor) await uptime?.check(id);
    const row = ctx.db
      .update(apps)
      .set({ embeddable: res.embeddable, ...(res.icon ? { icon: res.icon.data, iconType: res.icon.type } : {}) })
      // Of the address it looked at: changed meanwhile, the newer look stands (AUDIT2 MON-18).
      .where(and(eq(apps.id, id), eq(apps.url, r.url)))
      .returning()
      .get();
    frames.changed();
    return row ? view(row) : view(r);
  };

  // Everyone signed in may see and open the apps; only admins change them.
  app.get('/api/apps', { config: { auth: 'user' } }, async () =>
    ctx.db.select().from(apps).orderBy(asc(apps.sort), asc(apps.name)).all().map(view),
  );

  app.post('/api/apps', async (req) => {
    const b = parse(appInput, req.body);
    checkUrlFree(b.url);
    checkHost(b.hostId);
    const last = ctx.db.select({ sort: apps.sort }).from(apps).orderBy(asc(apps.sort)).all().pop();
    const row = ctx.db
      .insert(apps)
      .values({
        name: b.name,
        url: b.url,
        grp: b.group || null,
        pinned: b.pinned,
        sort: (last?.sort ?? 0) + 1,
        embeddable: 'unknown',
        hostId: b.hostId ?? null,
        container: b.container ?? null,
        monitor: b.monitor,
        newTab: b.newTab,
        createdAt: ctx.now(),
      })
      .returning()
      .get();
    audit(ctx, actor(req), 'app.create', row.name, { id: row.id });
    return probe(row.id);
  });

  app.put('/api/apps/:id', async (req) => {
    const id = idParam(req);
    const b = parse(appInput, req.body);
    const old = get(id);
    checkUrlFree(b.url, id);
    checkHost(b.hostId);
    ctx.db
      .update(apps)
      .set({ name: b.name, url: b.url, grp: b.group || null, pinned: b.pinned, hostId: b.hostId ?? null, container: b.container ?? null, monitor: b.monitor, newTab: b.newTab, ...(b.monitor ? {} : { up: null, downSince: null }) })
      .where(eq(apps.id, id))
      .run();
    audit(ctx, actor(req), 'app.update', b.name, { id });
    if (old.url !== b.url) return probe(id);
    if (b.monitor && !old.monitor) await uptime?.check(id);
    return view(get(id));
  });

  app.delete('/api/apps/:id', async (req, reply) => {
    const row = ctx.db.delete(apps).where(eq(apps.id, idParam(req))).returning().get();
    if (!row) throw new HttpError(404, 'not_found');
    frames.changed();
    audit(ctx, actor(req), 'app.delete', row.name, { id: row.id });
    return noContent(reply);
  });

  app.post('/api/apps/order', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).max(500) }), req.body);
    ctx.db.transaction((tx) => ids.forEach((id, i) => tx.update(apps).set({ sort: i + 1 }).where(eq(apps.id, id)).run()));
    return ctx.db.select().from(apps).orderBy(asc(apps.sort), asc(apps.name)).all().map(view);
  });

  app.post('/api/apps/:id/check', async (req) => probe(idParam(req)));

  // The icon is stored bytes from another site: served as an image that can
  // do nothing, even when opened directly (an SVG with a script).
  app.get('/api/apps/:id/icon', { config: { auth: 'user' } }, async (req, reply) => {
    const r = get(idParam(req));
    if (!r.icon || !r.iconType) throw new HttpError(404, 'not_found');
    reply.header('Content-Type', r.iconType);
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(r.icon);
  });

  /** Web apps found in the container labels of every Docker host. */
  app.get('/api/apps/discover', async (): Promise<DiscoveryResult> => {
    const base = ctx.config.appsBaseDomain ?? baseDomainOf(ctx.config.origin);
    const known = new Set(ctx.db.select({ url: apps.url }).from(apps).all().map((a) => a.url));
    const targets = listHosts(ctx).filter((h) => h.facts?.hasDocker);
    const result: DiscoveryResult = { apps: [], errors: [] };
    await Promise.all(
      targets.map(async (h) => {
        try {
          const r = await pool.with(h.id, ({ client }) => exec(client, LIST_COMMAND, 20_000));
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `docker exited with ${r.code}`);
          const seen = new Set<string>();
          for (const c of parseInspect(r.stdout)) {
            const f = appFromLabels(c, base);
            if (f) {
              seen.add(f.url);
              result.apps.push({ ...f, hostId: h.id, hostName: h.name, added: known.has(f.url) } satisfies DiscoveredApp);
            }
          }
          // SWAG's own confs too: apps proxied by hand (swag=disable) were missing (report 6d39c6).
          const running = new Set(parseInspect(r.stdout).map((c) => c.name));
          // Not read (a timeout, the connection gone): said, not taken for "nothing proxied by hand" (failed is not empty).
          const confs = await pool
            .with(h.id, ({ client }) => exec(client, SWAG_CONFS_COMMAND, 20_000))
            .catch((err: unknown) => (result.errors.push({ hostId: h.id, hostName: h.name, message: `SWAG: ${(err as Error).message}` }), null));
          // And Nginx Proxy Manager's proxy hosts: an app where it forwards to a container that runs here.
          const npm = await pool
            .with(h.id, ({ client }) => exec(client, NPM_CONFS_COMMAND, 20_000))
            .catch((err: unknown) => (result.errors.push({ hostId: h.id, hostName: h.name, message: `Nginx Proxy Manager: ${(err as Error).message}` }), null));
          for (const f of [...(confs ? appsFromSwagConfs(confs.stdout, base) : []), ...(npm ? appsFromNpmConfs(npm.stdout) : [])]) {
            if (seen.has(f.url) || !running.has(f.container)) continue;
            seen.add(f.url);
            result.apps.push({ ...f, hostId: h.id, hostName: h.name, added: known.has(f.url) } satisfies DiscoveredApp);
          }
        } catch (err) {
          result.errors.push({ hostId: h.id, hostName: h.name, message: (err as Error).message });
        }
      }),
    );
    result.apps.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  });
}
