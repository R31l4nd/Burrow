import type { FastifyInstance } from 'fastify';
import { journalUnit, parseUnits, type JournalUnit } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { logFilesOf } from '../docker/logfiles.js';
import type { SftpPool } from '../files/pool.js';
import { getHost } from './service.js';
import { HttpError, idParam } from '../http.js';
import { exec } from '../ssh/connect.js';

// The host's systemd units, to choose whose journal to read (docker/logs.ts
// reads it, as a log source "journal:<unit>"), and which of them are kept
// for the alert rules and the reports. A host without systemd says so; an
// empty list would read as "no services".

const NO_SYSTEMD = 3;
const LIST = `command -v systemctl >/dev/null 2>&1 || exit ${NO_SYSTEMD}; systemctl list-units --type=service --all --no-legend --plain --no-pager`;

export function registerJournalRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool): void {
  app.get('/api/hosts/:id/journal/units', { config: { auth: 'user' } }, async (req): Promise<{ units: JournalUnit[]; kept: { id: number; unit: string }[] }> => {
    const hostId = idParam(req);
    getHost(ctx, hostId);
    let r;
    try {
      r = await pool.with(hostId, ({ client }) => exec(client, LIST, 20_000, 4 << 20));
    } catch (err) {
      throw new HttpError(502, 'host_unreachable', (err as Error).message);
    }
    if (r.code === NO_SYSTEMD) throw new HttpError(422, 'no_systemd', 'This host has no systemd, so no journal to read.');
    if (r.code !== 0) throw new HttpError(502, 'host_failed', (r.stderr || r.stdout).trim().split('\n').pop() || `systemctl exited with ${r.code}`);
    const kept = logFilesOf(ctx, hostId, '')
      .map((f) => ({ id: f.id, unit: journalUnit(f.path) }))
      .filter((f): f is { id: number; unit: string } => f.unit !== null);
    return { units: parseUnits(r.stdout), kept };
  });
}
