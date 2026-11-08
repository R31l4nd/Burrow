import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { recordings } from '../db/schema.js';

// A terminal session's output as it was shown, recorded on request (F3):
// an asciicast v2 file (asciinema's format: a header line, then one JSON
// line per piece of output or change of size, with the seconds since the
// start) in the data volume, kept 30 days (retention.ts). What is typed is
// not recorded, only what the screen showed; a password typed at a prompt
// does not echo, so it is not in it either.

/** A recording stops here and says so: a runaway output does not fill the disk. */
export const MAX_RECORDING_BYTES = 64 << 20;
export const RECORDINGS_DIR = 'recordings';

export class Recorder {
  readonly id: number;
  #out: WriteStream;
  #started: number;
  #bytes = 0;
  #done = false;

  constructor(
    private readonly ctx: Ctx,
    session: { id: string; hostName: string; title: string | null; userId: number | null },
    cols: number,
    rows: number,
  ) {
    const dir = join(ctx.config.dataDir, RECORDINGS_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#started = ctx.now();
    const file = `${session.id}-${this.#started}.cast`;
    this.id = Number(
      ctx.db
        .insert(recordings)
        .values({ sessionId: session.id, hostName: session.hostName, title: session.title, userId: session.userId, file, startedAt: this.#started })
        .returning({ id: recordings.id })
        .get().id,
    );
    this.#out = createWriteStream(join(dir, file), { flags: 'wx', mode: 0o600 });
    this.#out.on('error', (err) => {
      ctx.log.warn({ err, recording: this.id }, 'recording could not be written');
      this.stop();
    });
    this.#line({ version: 2, width: cols, height: rows, timestamp: Math.floor(this.#started / 1000), title: session.title ?? session.hostName });
  }

  get active(): boolean {
    return !this.#done;
  }

  #line(v: unknown): void {
    if (this.#done) return;
    const text = `${JSON.stringify(v)}\n`;
    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes > MAX_RECORDING_BYTES) {
      this.ctx.db.update(recordings).set({ truncated: true }).where(eq(recordings.id, this.id)).run();
      return this.stop();
    }
    this.#out.write(text);
  }

  /** Seconds since the start, to the millisecond. */
  #at(): number {
    return Math.max(0, this.ctx.now() - this.#started) / 1000;
  }

  output(text: string): void {
    this.#line([this.#at(), 'o', text]);
  }

  resize(cols: number, rows: number): void {
    this.#line([this.#at(), 'r', `${cols}x${rows}`]);
  }

  stop(): void {
    if (this.#done) return;
    this.#done = true;
    this.#out.end();
    this.ctx.db.update(recordings).set({ endedAt: this.ctx.now(), bytes: this.#bytes }).where(eq(recordings.id, this.id)).run();
  }
}
