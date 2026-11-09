import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandTimeout, endsOnTimeout, exec, execChannel, STUCK_AFTER_MS, STUCK_LIMIT } from '../../src/ssh/connect.js';

// A command on a host that did not end in time went on there: exec closed
// its channel only, sshd kept the session while it ran (a hung dockerd, a
// stale NFS mount), and the ten a connection gets filled up (audit 2026-11-05).

/** The command as sshd runs it: sh -c in a session of its own (setsid), stdin a pipe that is the channel's. */
function onHost(command: string) {
  const p = spawn('sh', ['-c', command], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
  return { p, exited, out: () => out };
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'late'>((r) => setTimeout(() => r('late'), ms))]);

describe('a command that ends on the host with its channel (endsOnTimeout)', () => {
  it('ends, with what it started, when the channel stops waiting for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-exec-'));
    const h = onHost(endsOnTimeout(`sleep 30 & sleep 30; echo late > ${dir}/late`));
    await new Promise((r) => setTimeout(r, 200));
    expect(await within(h.exited, 100)).toBe('late');
    // exec's time-out: the channel's stdin ends.
    h.p.stdin.end();
    expect(await within(h.exited, 3000)).not.toBe('late');
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(`${dir}/late`)).toBe(false);
  });

  it('reads an empty stdin as before, keeps its exit code and output, and leaves what it started in the background running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-exec-'));
    const h = onHost(endsOnTimeout(`cat; echo read; (sleep 1; echo alive > ${dir}/alive) >/dev/null 2>&1 & exit 7`));
    expect(await within(h.exited, 3000)).toBe(7);
    expect(h.out()).toBe('read\n');
    // sshd ends the channel's stdin once the command ended: the watcher finds it gone and ends nothing.
    h.p.stdin.end();
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(`${dir}/alive`)).toBe(true);
  });
});

/** A connection whose channels never answer, unless told: what exec sends, and what it does to each channel. */
function fakeClient() {
  const channels: (EventEmitter & { stderr: EventEmitter; command: string; ended: number; closed: number; end: (s?: string) => void; close: () => void })[] = [];
  const client = Object.assign(new EventEmitter(), {
    ended: 0,
    end() {
      client.ended++;
    },
    exec(command: string, _o: unknown, cb: (e: Error | null, ch: unknown) => void) {
      const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), command, ended: 0, closed: 0 }) as (typeof channels)[number];
      ch.end = () => void ch.ended++;
      ch.close = () => void ch.closed++;
      channels.push(ch);
      cb(null, ch);
    },
  });
  return { client, channels };
}

describe('exec', () => {
  afterEach(() => vi.useRealTimers());

  it('runs a command without input so that it can be ended on the host, and ends it there when its time is up', async () => {
    vi.useFakeTimers();
    const { client, channels } = fakeClient();
    const r = exec(client as never, 'docker ps', 1000);
    await vi.advanceTimersByTimeAsync(0);
    const ch = channels[0]!;
    expect(ch.command).toBe(endsOnTimeout('docker ps'));
    // The channel's stdin stays open while the command runs: its end is what ends the command.
    expect(ch.ended).toBe(0);
    const caught = r.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await caught).toBeInstanceOf(CommandTimeout);
    expect(ch.ended).toBe(1);
    expect(ch.closed).toBe(1);
  });

  it('given input, the command as it is, its stdin ended after the input', async () => {
    const { client, channels } = fakeClient();
    void exec(client as never, 'sudo -S true', 1000, 1 << 20, 'pw\n').catch(() => {});
    await Promise.resolve();
    expect(channels[0]!.command).toBe('sudo -S true');
    expect(channels[0]!.ended).toBe(1);
    channels[0]!.emit('close', 0);
  });

  it('ends a connection on which timed-out commands stay stuck (a process in D state holds its session for good)', async () => {
    vi.useFakeTimers();
    const { client, channels } = fakeClient();
    for (let i = 0; i < STUCK_LIMIT; i++) {
      const r = exec(client as never, 'ls /mnt/nfs', 1000).catch(() => null);
      await vi.advanceTimersByTimeAsync(1000);
      await r;
    }
    // One that did close in time (ended on the host) is not stuck.
    channels[0]!.emit('close', null);
    await vi.advanceTimersByTimeAsync(STUCK_AFTER_MS);
    expect(client.ended).toBe(0);
    const r = exec(client as never, 'ls /mnt/nfs', 1000).catch(() => null);
    await vi.advanceTimersByTimeAsync(1000 + STUCK_AFTER_MS);
    await r;
    expect(client.ended).toBe(1);
  });

  it('keepEnd: a log larger than read keeps its first line and its newest lines, not its oldest', async () => {
    const { client, channels } = fakeClient();
    const r = exec(client as never, 'tail -n 5000 log', 1000, 100, undefined, { keepEnd: true });
    await Promise.resolve();
    const ch = channels[0]!;
    ch.emit('data', Buffer.from('@@zone +0100\n'));
    for (let i = 0; i < 50; i++) ch.emit('data', Buffer.from(`line ${i}\n`));
    ch.emit('close', 0);
    const got = await r;
    expect(got.truncated).toBe(true);
    expect(got.head).toBe('@@zone +0100');
    const lines = got.stdout.split('\n').filter(Boolean);
    expect(lines.at(-1)).toBe('line 49');
    expect(lines[0]).toMatch(/^line \d+$/);
    expect(got.stdout.length).toBeLessThanOrEqual(100);
  });
});

describe('execChannel', () => {
  it('a connection gone while it waits for a free channel is an error, not a crash (ssh2 throws "Not connected")', async () => {
    let calls = 0;
    const client = {
      exec(_c: string, _o: unknown, cb: (e: Error | null) => void) {
        if (calls++ === 0) return cb(new Error('(SSH) Channel open failure: open failed'));
        throw new Error('Not connected');
      },
    };
    await expect(within(execChannel(client as never, 'true'), 2000)).rejects.toThrow('Not connected');
    const first = { exec: () => { throw new Error('Not connected'); } };
    await expect(execChannel(first as never, 'true')).rejects.toThrow('Not connected');
  });

  it('a connection that never answers the channel request ends in time; a channel that comes after is closed, not leaked', async () => {
    let late: ((e: Error | null, ch?: unknown) => void) | null = null;
    const client = { exec: (_c: string, _o: unknown, cb: (e: Error | null, ch?: unknown) => void) => void (late = cb) };
    // Waits at most its own wait, and a few seconds for the answer to the last request.
    const r = await within(execChannel(client as never, 'true', {}, 300).catch((e: Error) => e.message), 6000);
    expect(r).toMatch(/no channel within/i);
    const closed = vi.fn();
    late!(null, { close: closed });
    expect(closed).toHaveBeenCalled();
  });
});
