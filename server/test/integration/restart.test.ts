import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { recordings } from '../../src/db/schema.js';
import { makeApp, type TestApp } from '../helpers.js';

// Burrow started again on the database and data folder of a run that
// ended mid-way (a crash, a kill, the data disk full at a recording's
// stop): what that run had open is closed at the start, instead of showing
// as running for good (2026-11-07 audit: a recording could not be removed).

const dir = mkdtempSync(join(tmpdir(), 'burrow-restart-'));
const env = { BURROW_DATA_DIR: dir };
let t: TestApp | null = null;

afterAll(async () => {
  await t?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Burrow started again after a run that ended mid-way', () => {
  it('a recording left open is ended as of its file, at the size written; one without a file at its start', async () => {
    const first = await makeApp({ env, dbFile: join(dir, 'burrow.db') });
    const started = first.clock.now;
    first.ctx.db.insert(recordings).values([
      { sessionId: 's1', hostName: 'web', file: 'cut-off.cast', startedAt: started },
      { sessionId: 's2', hostName: 'web', file: 'never-written.cast', startedAt: started },
    ]).run();
    mkdirSync(join(dir, 'recordings'), { recursive: true });
    writeFileSync(join(dir, 'recordings', 'cut-off.cast'), 'x'.repeat(1234));
    const lastWrite = new Date(started + 90_000);
    utimesSync(join(dir, 'recordings', 'cut-off.cast'), lastWrite, lastWrite);
    await first.close();

    t = await makeApp({ env, dbFile: join(dir, 'burrow.db') });
    // As src/index.ts starts it.
    t.terminals.start();
    const cut = t.ctx.db.select().from(recordings).where(eq(recordings.file, 'cut-off.cast')).get()!;
    expect(cut).toMatchObject({ endedAt: started + 90_000, bytes: 1234 });
    const none = t.ctx.db.select().from(recordings).where(eq(recordings.file, 'never-written.cast')).get()!;
    expect(none).toMatchObject({ endedAt: started, bytes: 0 });
    // Ended, so an admin can remove it.
    expect(t.ctx.db.select().from(recordings).all().every((r) => r.endedAt !== null)).toBe(true);
  });
});
