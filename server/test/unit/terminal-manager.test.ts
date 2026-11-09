import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Host, ServerMessage } from '@burrow/shared';
import { recordings, terminalSessions } from '../../src/db/schema.js';
import { openSsh } from '../../src/ssh/connect.js';
import { MAX_RECORDING_BYTES, RECORDINGS_DIR } from '../../src/terminal/recorder.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// The terminal manager without a host: a stand-in SSH connection whose shell is a channel the
// test writes output into and closes. What goes over a real one: test/integration.

vi.mock('../../src/ssh/connect.js', async (original) => ({ ...(await original<typeof import('../../src/ssh/connect.js')>()), openSsh: vi.fn() }));

class Stream extends EventEmitter {
  paused = false;
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
}

class Channel extends Stream {
  readonly stderr = new Stream();
  readonly written: string[] = [];
  write(d: string): boolean {
    this.written.push(d);
    return true;
  }
  setWindow(): void {}
  close(): void {}

  /** A host printing as fast as it can: as SSH does, nothing comes while the channel is paused. */
  async flood(bytes: number): Promise<void> {
    const chunk = Buffer.from(`${'x'.repeat((1 << 20) - 2)}\r\n`);
    for (let sent = 0; sent < bytes; sent += chunk.length) {
      while (this.paused) await new Promise((r) => setTimeout(r, 5));
      this.emit('data', chunk);
    }
  }
}

let t: TestApp;
let dir: string;
let host: Host;
let adminId: number;
let channel: Channel;
const admin = () => ({ userId: adminId, username: 'admin', ip: null });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'burrow-term-'));
  t = await makeApp({ env: { BURROW_DATA_DIR: dir } });
  await setupAdmin(t);
  adminId = (await t.json<{ user: { id: number } }>('GET', '/api/auth/state')).user.id;
  host = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan', username: 'me', authMethod: 'password', password: 'x' });
  channel = new Channel();
  const client = { on: () => client, end: () => {}, shell: (_pty: unknown, cb: (err: Error | undefined, ch: Channel) => void) => cb(undefined, channel) };
  vi.mocked(openSsh).mockResolvedValue({ client } as never);
});
afterEach(async () => {
  full(false);
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every database write fails from here on, as on a full data disk. */
const full = (on: boolean) => t.ctx.db.$client.pragma(`query_only = ${on ? 'ON' : 'OFF'}`);

/** A session without tmux and one viewer on it, with what the viewer was sent (output left out). */
async function open() {
  const s = await t.terminals.create(admin(), host.id, 80, 24, undefined, undefined, 'never');
  const got: ServerMessage[] = [];
  const socket = { send: (d: string) => void (d.startsWith('{"t":"output"') || got.push(JSON.parse(d) as ServerMessage)), close: () => {}, bufferedAmount: 0 };
  const viewer = await t.terminals.attach(s.id, socket, { userAgent: null, sessionIdHash: 'h' });
  return { id: s.id, viewer, got };
}

const saidOnce = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => String(c[1] ?? c[0]).includes('could not be saved'));

describe('the data disk full while sessions run', () => {
  it('a keystroke is typed, not thrown out of the socket (the process ended, every session with it); said once', async () => {
    const { id, viewer } = await open();
    const errors = vi.spyOn(t.ctx.log, 'error');
    full(true);
    for (const key of ['l', 's']) {
      // Past the 10 s between writes of the last activity: each key writes.
      t.advance(20_000);
      expect(() => t.terminals.input(id, viewer, key)).not.toThrow();
    }
    expect(channel.written).toEqual(['l', 's']);
    expect(saidOnce(errors)).toHaveLength(1);
    // The shell ends: its row cannot go, and that is not thrown out of the SSH event either.
    expect(() => channel.emit('close', 0)).not.toThrow();
  });

  it('starts all the same when the clean-up of the last run cannot be written (it threw, and Burrow started again and again)', () => {
    t.ctx.db.insert(terminalSessions).values({ id: 'old', hostId: host.id, userId: adminId, mode: 'memory', tmuxName: null, title: null, createdAt: 0, lastActivityAt: 0, sharedWith: '[]', recording: false }).run();
    full(true);
    expect(() => t.terminals.start()).not.toThrow();
    full(false);
    // The next start that can write does it.
    t.terminals.start();
    expect(t.ctx.db.select().from(terminalSessions).all()).toEqual([]);
  });
});

describe('a host printing faster than the server parses its screen', () => {
  it('holds the host back (the channel pauses), not thrown out of the SSH event at 50 MB unparsed, which ended the process', async () => {
    const { got } = await open();
    const pause = vi.spyOn(channel, 'pause');
    await expect(channel.flood(80 << 20)).resolves.toBeUndefined();
    expect(pause).toHaveBeenCalled();
    await vi.waitFor(() => expect(channel.paused).toBe(false), { timeout: 120_000 });
    expect(got.filter((m) => m.t === 'exit')).toEqual([]);
    // 80 MB through the screen's parser: over a minute under the gate's coverage on a busy machine (2026-11-08).
  }, 180_000);
});

describe('a recording at its size limit', () => {
  it('turns the session\'s recording off, and its viewers lose the red dot', async () => {
    const { id, got } = await open();
    t.terminals.setRecording(id, true, admin());
    expect(got).toContainEqual({ t: 'recording', on: true });
    // In the write queue's order: the recording takes output from here on.
    await vi.waitFor(() => expect(t.ctx.db.select().from(recordings).all()).toHaveLength(1));
    await channel.flood(MAX_RECORDING_BYTES + (2 << 20));
    await vi.waitFor(() => expect(got).toContainEqual({ t: 'recording', on: false }), { timeout: 30_000 });
    expect(t.terminals.get(id).recording).toBe(false);
    expect(t.ctx.db.select().from(terminalSessions).where(eq(terminalSessions.id, id)).get()!.recording).toBe(false);
    expect(t.ctx.db.select().from(recordings).all()[0]).toMatchObject({ truncated: true, endedAt: expect.any(Number) });
  }, 60_000);
});

describe('what the last run left unfinished', () => {
  it('a recording it was writing is ended at start-up, at the size written: it can be removed and is pruned', async () => {
    mkdirSync(join(dir, RECORDINGS_DIR), { recursive: true });
    writeFileSync(join(dir, RECORDINGS_DIR, 'cut.cast'), 'header\nline\n');
    const startedAt = t.clock.now - 3600_000;
    const r = t.ctx.db.insert(recordings).values({ sessionId: 'gone', hostName: 'nas', title: null, userId: adminId, file: 'cut.cast', startedAt }).returning().get();
    const done = t.ctx.db.insert(recordings).values({ sessionId: 'done', hostName: 'nas', title: null, userId: adminId, file: 'done.cast', startedAt, endedAt: startedAt + 5, bytes: 7 }).returning().get();
    t.terminals.start();
    const rows = t.ctx.db.select().from(recordings).all();
    expect(rows.find((x) => x.id === r.id)).toMatchObject({ endedAt: expect.any(Number), bytes: 12 });
    expect(rows.find((x) => x.id === r.id)!.endedAt!).toBeGreaterThanOrEqual(startedAt);
    expect(rows.find((x) => x.id === done.id)).toMatchObject({ endedAt: startedAt + 5, bytes: 7 });
    expect((await t.request('DELETE', `/api/recordings/${r.id}`)).statusCode).toBe(204);
  });
});
