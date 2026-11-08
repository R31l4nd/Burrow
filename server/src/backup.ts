import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { appSettings } from './db/schema.js';
import { actor, contentDisposition, HttpError } from './http.js';
import type { Notifier } from './notify/channels.js';

// The backups' state, as the backup service writes it after each round
// (scripts/backup/backup.sh -> <data>/backup-status.json): shown in
// Settings, and a message on the channels when the last good one is more
// than STALE_MS old or the last round failed. Once per state.

export interface BackupStatus {
  ok: boolean;
  at: string;
  file: string | null;
  bytes: number | null;
  count: number | null;
  remote: boolean | null;
  error: string | null;
}

export const STALE_MS = 2 * 86_400_000;
const TOLD_KEY = 'backup.told';

export function readBackupStatus(ctx: Ctx): BackupStatus | null {
  try {
    return JSON.parse(readFileSync(join(ctx.config.dataDir, 'backup-status.json'), 'utf8')) as BackupStatus;
  } catch {
    return null;
  }
}

/**
 * A message when backups stopped working (called every hour). Returns what
 * was told, if anything. Marked as told only once a channel took it: with
 * none set up, or all failing, it is tried again the next hour (AUDIT2 MON-22).
 */
export async function checkBackups(ctx: Ctx, notifier: Notifier | null): Promise<string | null> {
  const s = readBackupStatus(ctx);
  if (!s) return null;
  const stale = ctx.now() - Date.parse(s.at) > STALE_MS;
  const problem = !s.ok ? `failed: ${s.error ?? 'unknown error'}` : stale ? `the last one is from ${s.at}` : null;
  const key = problem ? `${s.at} ${s.ok}` : null;
  const told = ctx.db.select().from(appSettings).where(eq(appSettings.key, TOLD_KEY)).get()?.value ?? null;
  if (!problem || key === told || !notifier) return null;
  const nl = !s.ok ? `mislukt: ${s.error ?? 'onbekende fout'}` : `de laatste is van ${s.at}`;
  const r = await notifier.notify({
    topic: 'alerts',
    title: `Burrow backups: ${problem}`,
    body: 'Settings -> Backups says more.',
    page: '/settings?s=backups',
    priority: 4,
    nl: { title: `Burrow-back-ups: ${nl}`, body: 'Instellingen -> Back-ups zegt meer.' },
    data: { backup: s },
  });
  if (!r.sent) return null;
  ctx.db
    .insert(appSettings)
    .values({ key: TOLD_KEY, value: key!, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: key!, updatedAt: ctx.now() } })
    .run();
  return problem;
}

// A backup now (report 445f22): Burrow cannot make one itself (the backup
// service holds the key, Burrow does not), so it leaves a request in the
// data volume that the service looks for every few seconds; the service
// removes it when it starts the round.
const REQUEST = 'backup-request';

function requestedAt(ctx: Ctx): string | null {
  try {
    return readFileSync(join(ctx.config.dataDir, REQUEST), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The newest archive in the backup service's folder (mounted read-only), if it is there. */
function newestBackup(ctx: Ctx): { file: string; bytes: number } | null {
  let names: string[];
  try {
    names = readdirSync(ctx.config.backupDir).filter((n) => /^burrow-\d{8}T\d{6}Z(?:-\d+)?\.tar\.gz\.enc$/.test(n));
  } catch {
    return null;
  }
  const file = names.sort().at(-1);
  return file ? { file, bytes: statSync(join(ctx.config.backupDir, file)).size } : null;
}

export function registerBackupRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/backup/status', async () => ({ status: readBackupStatus(ctx), staleAfterMs: STALE_MS, requestedAt: requestedAt(ctx), download: newestBackup(ctx) }));

  app.post('/api/backup/now', async (req) => {
    // Without the service nothing would ever take the request.
    if (!readBackupStatus(ctx)) throw new HttpError(409, 'no_backup_service', 'The backup service has never run here (COMPOSE_PROFILES=backup in .env).');
    const at = requestedAt(ctx) ?? new Date(ctx.now()).toISOString();
    writeFileSync(join(ctx.config.dataDir, REQUEST), `${at}\n`, { mode: 0o600 });
    audit(ctx, actor(req), 'backup.request', null);
    return { requestedAt: at };
  });

  // Encrypted with the backup key, which Burrow does not hold: of use only
  // with that key (scripts/backup/verify.sh, restore.sh).
  app.get('/api/backup/download', async (req, reply) => {
    const b = newestBackup(ctx);
    if (!b) throw new HttpError(404, 'not_found', `No backup in ${ctx.config.backupDir} (is the backups folder mounted into Burrow?).`);
    const path = join(ctx.config.backupDir, b.file);
    if (!existsSync(path)) throw new HttpError(404, 'not_found');
    audit(ctx, actor(req), 'backup.download', b.file);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition('attachment', b.file));
    reply.header('Content-Length', b.bytes);
    return reply.send(createReadStream(path));
  });
}
