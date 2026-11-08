import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import { HttpError } from '../http.js';

// Long file operations (copy between hosts, archives) run in the background:
// a big folder over a phone connection would outlast any HTTP request and
// the proxy's timeout. The client polls the job for progress.

export interface JobView {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'failed';
  bytes: number;
  message: string | null;
  error: string | null;
  startedAt: string;
  /** What it does now, when it has steps (a copy between hosts: copying, then checking). */
  phase: 'copying' | 'checking' | null;
  /** Files whose sha256 matched on both hosts after a copy between them. */
  verified: number | null;
  /** Not checked, and on which side the tool was missing. */
  unverified: 'source' | 'destination' | null;
  /** Items left out because their name was taken at the destination (asked to skip them). */
  skipped: number | null;
  /** Why it failed, for a message in the reader's language (error stays the English one), and what about. */
  errorCode: string | null;
  errorDetail: string | null;
}

interface Job extends JobView {
  userId: number;
  finishedAt: number | null;
}

// Finished jobs are kept this long for the client to read.
const KEEP_MS = 60 * 60_000;

export class Jobs {
  readonly #jobs = new Map<string, Job>();

  constructor(private readonly ctx: Ctx) {}

  start(userId: number, kind: string, work: (job: Job) => Promise<void>): JobView {
    this.#prune();
    const job: Job = {
      id: randomBytes(9).toString('base64url'),
      kind,
      status: 'running',
      bytes: 0,
      message: null,
      error: null,
      startedAt: new Date(this.ctx.now()).toISOString(),
      phase: null,
      verified: null,
      unverified: null,
      skipped: null,
      errorCode: null,
      errorDetail: null,
      userId,
      finishedAt: null,
    };
    this.#jobs.set(job.id, job);
    work(job)
      .then(() => {
        job.status = 'done';
      })
      .catch((err: unknown) => {
        job.status = 'failed';
        job.error = err instanceof HttpError || err instanceof Error ? err.message : String(err);
        job.errorCode = err instanceof HttpError ? err.code : null;
        job.errorDetail = err instanceof HttpError && typeof (err as { detail?: unknown }).detail === 'string' ? (err as unknown as { detail: string }).detail : null;
        this.ctx.log.info({ err, kind }, 'file job failed');
      })
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return this.#view(job);
  }

  get(userId: number, id: string): JobView {
    const job = this.#jobs.get(id);
    if (!job || job.userId !== userId) throw new HttpError(404, 'not_found');
    return this.#view(job);
  }

  #view(j: Job): JobView {
    return { id: j.id, kind: j.kind, status: j.status, bytes: j.bytes, message: j.message, error: j.error, startedAt: j.startedAt, phase: j.phase, verified: j.verified, unverified: j.unverified, skipped: j.skipped, errorCode: j.errorCode, errorDetail: j.errorDetail };
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, j] of this.#jobs) if (j.finishedAt && now - j.finishedAt > KEEP_MS) this.#jobs.delete(id);
  }
}
