import { statfsSync } from 'node:fs';
import type { Ctx } from './context.js';
import { HttpError } from './http.js';
import type { Notifier } from './notify/channels.js';

// Burrow's data disk running full (OPS-W-02). SQLite then fails every
// write with SQLITE_FULL (or an I/O error), which answered a bare
// "500 internal" everywhere, step-up included, while /healthz stayed green
// and nothing told anyone. Now: a 507 that says why, /healthz unhealthy
// below LOW_BYTES free, and one message on the channels.

/** Below this much free space on the data disk, Burrow counts as unwell. */
export const LOW_BYTES = 50 << 20;

/** A write that failed because the disk is full (or cannot be written at all). */
export function isDiskFull(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code === 'SQLITE_FULL' || code.startsWith('SQLITE_IOERR') || code === 'ENOSPC');
}

export const diskFullError = () => new HttpError(507, 'disk_full', 'Burrow cannot save anything: its data disk is full. Free space on the host where Burrow keeps its data.');

/** Free bytes on the disk that holds a folder, or null when it cannot be told. */
export function freeBytesOf(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export class DiskWatch {
  notifier: Notifier | null = null;
  /** Said on the channels already, until there is room again. */
  #told = false;
  /** When a write last failed for want of space. */
  #failedAt = -Infinity;

  constructor(
    private readonly ctx: Ctx,
    private readonly freeBytes: (dir: string) => number | null = freeBytesOf,
  ) {}

  /** Whether the data disk is (nearly) full now: under LOW_BYTES free, or a write just failed for it and no room came since. */
  check(): { full: boolean; freeBytes: number | null } {
    const free = this.freeBytes(this.ctx.config.dataDir);
    // A failed write counts for a minute: the disk can be full for SQLite (a quota, another disk) while statfs says otherwise.
    const full = (free !== null && free < LOW_BYTES) || this.ctx.now() - this.#failedAt < 60_000;
    if (full) this.#tell(free);
    else this.#told = false;
    return { full, freeBytes: free };
  }

  /** A write failed for want of space. */
  failed(): void {
    this.#failedAt = this.ctx.now();
    this.#tell(this.freeBytes(this.ctx.config.dataDir));
  }

  #tell(free: number | null): void {
    if (this.#told) return;
    this.#told = true;
    const left = free === null ? '' : ` (${Math.max(0, Math.round(free / (1 << 20)))} MB free)`;
    this.ctx.log.error(`Burrow's data disk is full${left}: writes fail until space is freed on the host (${this.ctx.config.dataDir}).`);
    // Sending writes nothing Burrow needs; a failure here is only logged.
    void this.notifier
      ?.notify({
        topic: 'alerts',
        title: `Burrow's data disk is full${left}`,
        body: 'Saving, signing in and confirming with a second factor fail until space is freed on the host where Burrow keeps its data.',
        page: '/settings?s=about',
        priority: 5,
        nl: { title: `De dataschijf van Burrow is vol${left.replace('free', 'vrij')}`, body: 'Opslaan, aanmelden en bevestigen met een tweede factor mislukken tot er ruimte vrij is op de host waar Burrow zijn data bewaart.' },
      })
      .then((r) => {
        // Nobody got it: tried again with the next check.
        if (!r.sent) this.#told = false;
      })
      .catch(() => (this.#told = false));
  }
}
