import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hostLimitsInput, type DiskActivity, type DiskHistory, type ProcessList, type HostLimitsView, type HostSample, type HostStats, type SmartReport } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { actor, HttpError, idParam, parse } from '../http.js';
import { getHost } from './service.js';
import type { HostStatsService } from './stats.js';

// A host's numbers now, their history, and SMART. Reading is for operators
// too; reading SMART now (sudo with the stored password) is for admins.

const RANGES = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;

export function registerHostStatsRoutes(app: FastifyInstance, ctx: Ctx, stats: HostStatsService): void {
  app.get('/api/hosts/:id/stats', { config: { auth: 'user' } }, async (req): Promise<HostStats> => {
    const id = idParam(req);
    getHost(ctx, id);
    try {
      return await stats.read(id);
    } catch (err) {
      throw new HttpError(502, 'host_unreachable', (err as Error).message);
    }
  });

  app.get('/api/hosts/:id/stats/history', { config: { auth: 'user' } }, async (req): Promise<HostSample[]> => {
    const id = idParam(req);
    const { range } = parse(z.object({ range: z.enum(['day', 'week', 'month']).default('day') }), req.query);
    return stats.history(id, RANGES[range]);
  });

  // Each whole disk's reads, writes and busy time over the same periods.
  app.get('/api/hosts/:id/stats/disks', { config: { auth: 'user' } }, async (req): Promise<DiskHistory[]> => {
    const id = idParam(req);
    getHost(ctx, id);
    const { range } = parse(z.object({ range: z.enum(['day', 'week', 'month']).default('day') }), req.query);
    return stats.diskHistory(id, RANGES[range]);
  });

  // Which processes read and write now (report d4a9c0), sampled while the
  // view is open. Admins only: it runs as root through sudo with the stored
  // password and shows every process's name, container and open files -
  // also those in folders an operator may not open (ADR 15), and /proc is
  // closed to operators. An operator sees the disks' own numbers above.
  app.post('/api/hosts/:id/disks/activity', async (req): Promise<DiskActivity> => {
    const id = idParam(req);
    getHost(ctx, id);
    try {
      return await stats.activity(id);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'host_unreachable', (err as Error).message);
    }
  });

  // The processes now, busiest and largest (report 387b0e), sampled while the
  // view is open. Admins only, as the disk activity above: every process's
  // command line (a password given on one included) and container.
  app.post('/api/hosts/:id/processes', { config: { auth: 'admin' } }, async (req): Promise<ProcessList> => {
    const id = idParam(req);
    getHost(ctx, id);
    try {
      return await stats.processes(id);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'host_unreachable', (err as Error).message);
    }
  });

  app.get('/api/hosts/:id/smart', { config: { auth: 'user' } }, async (req): Promise<SmartReport | null> => stats.lastSmart(idParam(req)));
  // The kept daily checks (90 days), for the trend of each disk's counts.
  app.get('/api/hosts/:id/smart/history', { config: { auth: 'user' } }, async (req): Promise<SmartReport[]> => {
    const id = idParam(req);
    getHost(ctx, id);
    return stats.smartHistory(id);
  });

  app.post('/api/hosts/:id/smart', async (req): Promise<SmartReport> => {
    const id = idParam(req);
    const host = getHost(ctx, id);
    const r = await stats.smart(id);
    audit(ctx, actor(req), 'host.smart', host.name, { state: r.state, disks: r.disks.length });
    return r;
  });

  // When this host's numbers raise an alert: its own limits over the defaults.
  // Reading for everyone who sees the page; changing is for admins.
  const view = (id: number): HostLimitsView => {
    const t = stats.thresholdsFor(id);
    return {
      limits: { cpuCelsius: t.cpuCelsius, diskCelsius: t.diskCelsius, diskPercent: t.diskPercent },
      defaults: { cpuCelsius: stats.thresholds.cpuCelsius, diskCelsius: stats.thresholds.diskCelsius, diskPercent: stats.thresholds.diskPercent },
      own: stats.own(id),
    };
  };

  app.get('/api/hosts/:id/limits', { config: { auth: 'user' } }, async (req): Promise<HostLimitsView> => {
    const id = idParam(req);
    getHost(ctx, id);
    return view(id);
  });

  app.put('/api/hosts/:id/limits', async (req): Promise<HostLimitsView> => {
    const id = idParam(req);
    const host = getHost(ctx, id);
    const own = parse(hostLimitsInput, req.body);
    stats.setOwn(id, own);
    audit(ctx, actor(req), 'host.limits', host.name, own);
    return view(id);
  });
}
