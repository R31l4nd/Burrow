import { createReadStream, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { desc, eq, lt } from 'drizzle-orm';
import type { Recording } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { z } from 'zod';
import { appSettings, recordings, terminalSessions, users } from '../db/schema.js';
import { actor, contentDisposition, HttpError, idParam, noContent, parse } from '../http.js';
import { RECORDINGS_DIR } from './recorder.js';

// Recorded terminal sessions (F3): listed and played back in Burrow by an
// admin, downloaded as asciicast, removed by hand or after the days an
// admin chose (30 by default, decision 16).

const KEEP_KEY = 'recordings.keepDays';
export const DEFAULT_KEEP_DAYS = 30;

/** How many days recordings are kept. */
export function keepDays(ctx: Ctx): number {
  const v = Number(ctx.db.select().from(appSettings).where(eq(appSettings.key, KEEP_KEY)).get()?.value);
  return Number.isInteger(v) && v >= 1 && v <= 3650 ? v : DEFAULT_KEEP_DAYS;
}

const fileOf = (ctx: Ctx, file: string) => join(ctx.config.dataDir, RECORDINGS_DIR, file);

/**
 * Recordings older than the days kept, file and row (retention.ts). One still running (not ended, its
 * session still recording) stays: its file was unlinked while being written (A3-SRV-21).
 */
export function pruneRecordings(ctx: Ctx): number {
  const recordingNow = new Set(ctx.db.select({ id: terminalSessions.id }).from(terminalSessions).where(eq(terminalSessions.recording, true)).all().map((s) => s.id));
  const old = ctx.db
    .select()
    .from(recordings)
    .where(lt(recordings.startedAt, ctx.now() - keepDays(ctx) * 86_400_000))
    .all()
    .filter((r) => r.endedAt !== null || !recordingNow.has(r.sessionId));
  for (const r of old) {
    rmSync(fileOf(ctx, r.file), { force: true });
    ctx.db.delete(recordings).where(eq(recordings.id, r.id)).run();
  }
  return old.length;
}

export function registerRecordingRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/recordings/settings', async () => ({ keepDays: keepDays(ctx) }));

  // Shorter: what is older goes at once, not an hour later. Deleting what was recorded cannot be
  // undone: a fresh step-up, as stopping a recording (audit 2026-10-30).
  app.put('/api/recordings/settings', { config: { stepUp: true } }, async (req) => {
    const { keepDays: days } = parse(z.object({ keepDays: z.number().int().min(1).max(3650) }), req.body);
    ctx.db
      .insert(appSettings)
      .values({ key: KEEP_KEY, value: String(days), updatedAt: ctx.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: String(days), updatedAt: ctx.now() } })
      .run();
    audit(ctx, actor(req), 'recordings.settings', null, { keepDays: days });
    const removed = pruneRecordings(ctx);
    return { keepDays: days, removed };
  });

  app.get('/api/recordings', async (): Promise<Recording[]> => {
    const names = new Map(ctx.db.select({ id: users.id, username: users.username }).from(users).all().map((u) => [u.id, u.username]));
    return ctx.db
      .select()
      .from(recordings)
      .orderBy(desc(recordings.startedAt))
      .all()
      .map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        hostName: r.hostName,
        title: r.title,
        user: r.userId !== null ? (names.get(r.userId) ?? null) : null,
        startedAt: new Date(r.startedAt).toISOString(),
        endedAt: r.endedAt !== null ? new Date(r.endedAt).toISOString() : null,
        // Still running: as large as written so far.
        bytes: r.endedAt !== null ? r.bytes : (() => { try { return statSync(fileOf(ctx, r.file)).size; } catch { return 0; } })(),
        truncated: r.truncated,
      }));
  });

  app.get('/api/recordings/:id/cast', async (req, reply) => {
    const r = ctx.db.select().from(recordings).where(eq(recordings.id, idParam(req))).get();
    if (!r) throw new HttpError(404, 'not_found');
    let size: number;
    try {
      size = statSync(fileOf(ctx, r.file)).size;
    } catch {
      throw new HttpError(404, 'not_found', 'The recording file is gone.');
    }
    audit(ctx, actor(req), 'recording.play', r.hostName, { recording: r.id });
    reply.header('Content-Type', 'application/x-asciicast; charset=utf-8');
    reply.header('Content-Length', String(size));
    reply.header('Content-Disposition', contentDisposition('attachment', `burrow-${r.hostName.replace(/[^\w.-]+/g, '_')}-${r.id}.cast`));
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(createReadStream(fileOf(ctx, r.file)));
  });

  app.delete('/api/recordings/:id', { config: { stepUp: true } }, async (req, reply) => {
    const r = ctx.db.select().from(recordings).where(eq(recordings.id, idParam(req))).get();
    if (!r) throw new HttpError(404, 'not_found');
    // Still being written: its session's recording is stopped first.
    if (r.endedAt === null) throw new HttpError(409, 'recording_active', 'This recording is still running: stop it in its session first.');
    rmSync(fileOf(ctx, r.file), { force: true });
    ctx.db.delete(recordings).where(eq(recordings.id, r.id)).run();
    audit(ctx, actor(req), 'recording.delete', r.hostName, { recording: r.id });
    return noContent(reply);
  });
}
