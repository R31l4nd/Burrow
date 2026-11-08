import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Recording } from '@burrow/shared';
import { recordings } from '../../src/db/schema.js';
import { MAX_RECORDING_BYTES, Recorder, RECORDINGS_DIR } from '../../src/terminal/recorder.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Recorded terminal sessions (F3): an asciicast file per recording in the
// data volume, listed, played, downloaded and removed by an admin (pruning
// after 30 days: retention.test.ts).

let t: TestApp;
let dir: string;
let adminId: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'burrow-rec-'));
  t = await makeApp({ env: { BURROW_DATA_DIR: dir } });
  await setupAdmin(t);
  adminId = (await t.json<{ user: { id: number } }>('GET', '/api/auth/state')).user.id;
});
afterEach(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const session = (id = 'sess-1', title: string | null = 'deploy') => ({ id, hostName: 'nas box', title, userId: adminId });
const fileOf = (id: number) => join(dir, RECORDINGS_DIR, t.ctx.db.select().from(recordings).all().find((r) => r.id === id)!.file);
/** Until the write stream has put everything on disk. */
const flushed = (path: string, bytes: number) =>
  new Promise<void>((resolve, reject) => {
    const until = Date.now() + 5000;
    const poll = () => {
      if (existsSync(path) && statSync(path).size >= bytes) return resolve();
      if (Date.now() > until) return reject(new Error(`${path} not written`));
      setTimeout(poll, 10);
    };
    poll();
  });

describe('Recorder', () => {
  it('writes asciicast v2: a header, then output and size changes with the seconds since the start', async () => {
    const rec = new Recorder(t.ctx, session(), 80, 24);
    expect(rec.active).toBe(true);
    t.advance(1500);
    rec.output('hello\r\n');
    t.advance(250);
    rec.resize(120, 40);
    rec.stop();
    expect(rec.active).toBe(false);
    // Nothing after the stop, and a second stop changes nothing.
    rec.output('late');
    rec.stop();

    const row = t.ctx.db.select().from(recordings).all()[0]!;
    const path = join(dir, RECORDINGS_DIR, row.file);
    await flushed(path, row.bytes);
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual([
      { version: 2, width: 80, height: 24, timestamp: Math.floor((t.clock.now - 1750) / 1000), title: 'deploy' },
      [1.5, 'o', 'hello\r\n'],
      [1.75, 'r', '120x40'],
    ]);
    expect(row).toMatchObject({ sessionId: 'sess-1', hostName: 'nas box', endedAt: t.clock.now, truncated: false });
    expect(row.bytes).toBe(statSync(path).size);
    // Only its owner reads it: the terminal's output may hold anything.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is titled by the host when the session has no title', async () => {
    const rec = new Recorder(t.ctx, session('s2', null), 80, 24);
    rec.stop();
    const row = t.ctx.db.select().from(recordings).all()[0]!;
    await flushed(join(dir, RECORDINGS_DIR, row.file), row.bytes);
    expect(JSON.parse(readFileSync(join(dir, RECORDINGS_DIR, row.file), 'utf8').split('\n')[0]!)).toMatchObject({ title: 'nas box' });
  });

  it('stops at the size limit and says it was cut off: a runaway output does not fill the disk', async () => {
    const rec = new Recorder(t.ctx, session(), 80, 24);
    const chunk = 'x'.repeat(1 << 20);
    for (let i = 0; i < 70 && rec.active; i++) rec.output(chunk);
    expect(rec.active).toBe(false);
    const row = t.ctx.db.select().from(recordings).all()[0]!;
    expect(row.truncated).toBe(true);
    expect(row.endedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(statSync(join(dir, RECORDINGS_DIR, row.file)).size).toBeLessThanOrEqual(MAX_RECORDING_BYTES);
  });

  it('stops by itself when its file cannot be written', async () => {
    // A recording file of that name already there: opened with wx, it fails.
    const rec1 = new Recorder(t.ctx, session('same'), 80, 24);
    rec1.stop();
    await flushed(fileOf(rec1.id), 1);
    const rec2 = new Recorder(t.ctx, session('same'), 80, 24);
    const until = Date.now() + 5000;
    while (rec2.active && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(rec2.active).toBe(false);
    expect(t.ctx.db.select().from(recordings).all().find((r) => r.id === rec2.id)!.endedAt).not.toBeNull();
  });
});

describe('recordings routes', () => {
  it('lists recordings newest first with who and how large, a running one by what is written so far', async () => {
    const done = new Recorder(t.ctx, session('old'), 80, 24);
    done.output('one');
    done.stop();
    t.advance(60_000);
    const running = new Recorder(t.ctx, session('new', 'live'), 80, 24);
    running.output('two');
    await flushed(fileOf(running.id), 50);

    const list = await t.json<Recording[]>('GET', '/api/recordings');
    expect(list.map((r) => r.sessionId)).toEqual(['new', 'old']);
    expect(list[0]).toMatchObject({ id: running.id, title: 'live', user: 'admin', endedAt: null, truncated: false });
    expect(list[0]!.bytes).toBe(statSync(fileOf(running.id)).size);
    expect(list[1]).toMatchObject({ id: done.id, user: 'admin', endedAt: new Date(t.clock.now - 60_000).toISOString() });

    // A running one whose file is gone: size 0, not an error.
    unlinkSync(fileOf(running.id));
    expect((await t.json<Recording[]>('GET', '/api/recordings'))[0]!.bytes).toBe(0);
    running.stop();
  });

  it('plays a recording as an asciicast download, audited; one without its file is not found', async () => {
    const rec = new Recorder(t.ctx, session(), 80, 24);
    rec.output('hello');
    rec.stop();
    await flushed(fileOf(rec.id), t.ctx.db.select().from(recordings).get()!.bytes);

    const r = await t.request('GET', `/api/recordings/${rec.id}/cast`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/x-asciicast; charset=utf-8');
    expect(r.headers['content-disposition']).toContain(`burrow-nas_box-${rec.id}.cast`);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body.split('\n')[1]).toBe(JSON.stringify([0, 'o', 'hello']));
    const log = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(log.some((e) => e.action === 'recording.play')).toBe(true);

    expect((await t.request('GET', '/api/recordings/999/cast')).statusCode).toBe(404);
    unlinkSync(fileOf(rec.id));
    const gone = await t.request('GET', `/api/recordings/${rec.id}/cast`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: 'not_found' });
  });

  it('removes a finished recording, file and row; a running one is refused until stopped', async () => {
    const rec = new Recorder(t.ctx, session(), 80, 24);
    const path = fileOf(rec.id);
    // The file is opened in the background: there before the test goes on.
    await flushed(path, 1);
    const busy = await t.request('DELETE', `/api/recordings/${rec.id}`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'recording_active' });
    expect(existsSync(path)).toBe(true);

    rec.stop();
    expect((await t.request('DELETE', `/api/recordings/${rec.id}`)).statusCode).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect(t.ctx.db.select().from(recordings).all()).toEqual([]);
    expect((await t.request('DELETE', `/api/recordings/${rec.id}`)).statusCode).toBe(404);
  });

  it('are for admins only', async () => {
    const r = await t.request('GET', '/api/recordings', undefined, { cookie: null });
    expect(r.statusCode).toBe(401);
  });
});
