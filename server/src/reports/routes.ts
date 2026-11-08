import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, lte } from 'drizzle-orm';
import { scheduleInput, type ContainerReport, type ReportSchedule, type ReportStatus } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { reports, reportSchedules } from '../db/schema.js';
import { validTimeZone } from '../docker/updates.js';
import { actor, HttpError, idParam, noContent, parse } from '../http.js';
import type { Reports } from './generate.js';
import { parseCron } from './schedule.js';

// Reports: the list, one report with each container's trend over the
// previous reports, the schedules, and "make one now".

export function registerReportRoutes(app: FastifyInstance, ctx: Ctx, service: Reports): void {
  app.get('/api/reports', { config: { auth: 'user' } }, async () => service.list());

  app.get('/api/reports/:id', { config: { auth: 'user' } }, async (req) => {
    // In the reader's language when asked (decision 22); the channels get theirs each.
    const { lang } = parse(z.object({ lang: z.enum(['en', 'nl']).optional() }), req.query);
    const r = service.get(idParam(req), lang);
    if (!r) throw new HttpError(404, 'not_found');
    // Each container's status in up to eleven reports before this one, oldest first.
    const earlier = ctx.db
      .select({ containers: reports.containers })
      .from(reports)
      .where(and(r.scheduleId ? eq(reports.scheduleId, r.scheduleId) : lte(reports.id, r.id), lte(reports.createdAt, Date.parse(r.createdAt))))
      .orderBy(desc(reports.createdAt))
      .limit(12)
      .all()
      .reverse();
    const trend: Record<string, ReportStatus[]> = {};
    for (const e of earlier) {
      for (const c of JSON.parse(e.containers) as ContainerReport[]) (trend[`${c.hostId}:${c.container}`] ??= []).push(c.status);
    }
    return { ...r, trend };
  });

  app.get('/api/reports/schedules', { config: { auth: 'user' } }, async (): Promise<ReportSchedule[]> => service.schedules());

  const values = (req: { body: unknown }) => {
    const b = parse(scheduleInput, req.body);
    if (!validTimeZone(b.timeZone)) throw new HttpError(400, 'invalid_time_zone');
    if (b.kind === 'cron') {
      try {
        parseCron(b.cron ?? '');
      } catch (err) {
        throw new HttpError(400, 'invalid_cron', (err as Error).message);
      }
    }
    return {
      name: b.name,
      enabled: b.enabled,
      kind: b.kind,
      day: b.day,
      time: b.time,
      cron: b.kind === 'cron' ? b.cron : null,
      timeZone: b.timeZone,
      hostIds: b.hostIds ? JSON.stringify(b.hostIds) : null,
      containers: b.containers?.length ? JSON.stringify(b.containers) : null,
      channelIds: b.channelIds?.length ? JSON.stringify(b.channelIds) : null,
      selection: JSON.stringify(b.selection),
      onlyAttention: b.onlyAttention,
      ai: b.ai,
      errorsAttention: b.errorsAttention,
      warningsAttention: b.warningsAttention,
    };
  };

  app.post('/api/reports/schedules', async (req) => {
    const v = values(req);
    const row = ctx.db
      .insert(reportSchedules)
      .values({ ...v, createdAt: ctx.now() })
      .returning()
      .get();
    audit(ctx, actor(req), 'report_schedule.create', v.name);
    return service.schedules().find((s) => s.id === row.id);
  });

  app.put('/api/reports/schedules/:id', async (req) => {
    const id = idParam(req);
    const v = values(req);
    if (!ctx.db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).get()) throw new HttpError(404, 'not_found');
    ctx.db.update(reportSchedules).set(v).where(eq(reportSchedules.id, id)).run();
    audit(ctx, actor(req), 'report_schedule.update', v.name, { enabled: v.enabled });
    return service.schedules().find((s) => s.id === id);
  });

  app.delete('/api/reports/schedules/:id', async (req, reply) => {
    const id = idParam(req);
    ctx.db.delete(reportSchedules).where(eq(reportSchedules.id, id)).run();
    audit(ctx, actor(req), 'report_schedule.delete', String(id));
    return noContent(reply);
  });

  /** A report made, gone (report aafaba). */
  app.delete('/api/reports/:id', async (req, reply) => {
    const id = idParam(req);
    const r = service.get(id);
    if (!r) throw new HttpError(404, 'not_found');
    ctx.db.delete(reports).where(eq(reports.id, id)).run();
    audit(ctx, actor(req), 'report.delete', r.name, { id });
    return noContent(reply);
  });

  /** The report being made now (or just made), for its progress; null when none. */
  app.get('/api/reports/progress', { config: { auth: 'user' } }, async () => service.progress());

  /** Make the report now (it may take a minute with many containers). */
  app.post('/api/reports/schedules/:id/run', async (req) => {
    const id = idParam(req);
    audit(ctx, actor(req), 'report.run', String(id));
    try {
      const r = await service.run(id);
      return { id: r.id };
    } catch (err) {
      throw new HttpError(409, 'report_failed', (err as Error).message);
    }
  });
}
