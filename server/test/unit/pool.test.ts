import { EventEmitter } from 'node:events';
import type { Client, SFTPWrapper } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../src/context.js';
import { CONNECT_MS, SftpPool } from '../../src/files/pool.js';

// The per-host SSH pool, with connections made up by the test.

class FakeClient extends EventEmitter {
  ended = 0;
  end() {
    this.ended++;
    this.emit('close');
  }
}

function pool(identity = () => 'same') {
  const clients: FakeClient[] = [];
  const sftps: EventEmitter[] = [];
  const p = new SftpPool({ now: () => Date.now() } as unknown as Ctx, {
    connect: async () => {
      const client = new FakeClient();
      clients.push(client);
      const sftp = new EventEmitter();
      sftps.push(sftp);
      return { client: client as unknown as Client, sftp: sftp as unknown as SFTPWrapper, home: '/home/x' };
    },
    identity,
  });
  return { p, clients, sftps };
}

const use = (p: SftpPool) => p.with(1, async (e) => e.client as unknown as FakeClient);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('one SSH connection per host', () => {
  it('an old idle timer does not throw out the connection that replaced it (audit BE-19)', async () => {
    const { p, clients } = pool();
    await use(p);
    // Idle: its minute runs. Half way, dropped (the host edited) and used again: a new one.
    await vi.advanceTimersByTimeAsync(30_000);
    p.drop(1);
    const second = await use(p);
    expect(clients).toHaveLength(2);
    // The first one's minute is up: the second must stay the host's connection.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await use(p)).toBe(second);
    expect(clients).toHaveLength(2);
    expect(second.ended).toBe(0);
  });

  it('its SFTP channel gone while the connection lives: the next use connects again (AUDIT2 FS-13)', async () => {
    const { p, clients, sftps } = pool();
    await use(p);
    sftps[0]!.emit('close');
    await use(p);
    expect(clients).toHaveLength(2);
    expect(clients[0]!.ended).toBe(1);
  });

  it('a failed connection is forgotten, not one made after it', async () => {
    let fail = true;
    const clients: FakeClient[] = [];
    const p = new SftpPool({ now: () => Date.now() } as unknown as Ctx, {
      connect: async () => {
        if (fail) throw new Error('refused');
        const client = new FakeClient();
        clients.push(client);
        return { client: client as unknown as Client, sftp: {} as SFTPWrapper, home: '/' };
      },
      identity: () => 'same',
    });
    await expect(use(p)).rejects.toThrow('refused');
    fail = false;
    const c = await use(p);
    expect(await use(p)).toBe(c);
    expect(clients).toHaveLength(1);
  });

  it('a changed identity (another user, key or trust) makes a new connection and ends the old one, in use or not (audit BE-18)', async () => {
    let who = 'alice with key 1';
    const { p, clients } = pool(() => who);
    const first = await use(p);
    // A long reader holds the old one.
    let release!: () => void;
    const reading = p.with(1, () => new Promise<void>((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(0);
    // The group's user changed.
    who = 'bob with key 1';
    const second = await use(p);
    expect(second).not.toBe(first);
    expect(clients).toHaveLength(2);
    expect(first.ended).toBe(1);
    release();
    await reading;
    // Unchanged since: the same new one.
    expect(await use(p)).toBe(second);
  });

  it('idle for a minute: closed, and the next use connects again', async () => {
    const { p, clients } = pool();
    const first = await use(p);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(first.ended).toBe(1);
    await use(p);
    expect(clients).toHaveLength(2);
  });

  it('a connection that does not get ready (realpath on a stale NFS home) fails in time, and the next call connects again', async () => {
    const signals: AbortSignal[] = [];
    let hang = true;
    const clients: FakeClient[] = [];
    const p = new SftpPool({ now: () => Date.now() } as unknown as Ctx, {
      connect: async (_id, signal) => {
        signals.push(signal);
        const client = new FakeClient();
        clients.push(client);
        // Hung after SSH was up: the pool's give-up must end it (the real openSftp ends its client on the signal).
        if (hang) return new Promise(() => {});
        return { client: client as unknown as Client, sftp: {} as SFTPWrapper, home: '/' };
      },
      identity: () => 'same',
    });
    let got: unknown = 'pending';
    void use(p).then(
      (c) => (got = c),
      (err: unknown) => (got = err),
    );
    await vi.advanceTimersByTimeAsync(CONNECT_MS + 1000);
    expect(got).toMatchObject({ code: 'connect_timeout' });
    expect(signals[0]!.aborted).toBe(true);
    hang = false;
    expect(await use(p)).toBe(clients[1]);
  });

  it('a connection made after the pool gave up on it is ended: nobody has it', async () => {
    const clients: FakeClient[] = [];
    let n = 0;
    const p = new SftpPool({ now: () => Date.now() } as unknown as Ctx, {
      connect: async () => {
        const client = new FakeClient();
        clients.push(client);
        if (n++ === 0) await new Promise((r) => setTimeout(r, CONNECT_MS + 10_000));
        return { client: client as unknown as Client, sftp: {} as SFTPWrapper, home: '/' };
      },
      identity: () => 'same',
    });
    const first = use(p).catch((err: Error & { code?: string }) => err.code);
    await vi.advanceTimersByTimeAsync(CONNECT_MS + 11_000);
    expect(await first).toBe('connect_timeout');
    expect(clients[0]!.ended).toBe(1);
  });
});

describe('a host that fails its connects, asked in the background (pool backoff)', () => {
  it('the background is not connected again until its wait is over (longer when the login was refused); what a person opens always tries', async () => {
    const { HttpError } = await import('../../src/http.js');
    let now = 1_000_000;
    let tries = 0;
    let fails: string | null = 'auth_failed';
    const p = new SftpPool({ now: () => Date.now() } as unknown as Ctx, {
      connect: async () => {
        tries++;
        if (fails) throw new HttpError(401, fails, 'All configured authentication methods failed');
        return { client: new FakeClient() as unknown as Client, sftp: new EventEmitter() as unknown as SFTPWrapper, home: '/home/x' };
      },
      identity: () => 'same',
      now: () => now,
      random: () => 0,
    });
    const background = () => p.with(1, async () => 'read', { background: true });
    // A refused login: tried once; asked again in the background, the same error at once, no new login.
    await expect(background()).rejects.toThrow('All configured authentication methods failed');
    await expect(background()).rejects.toThrow('All configured authentication methods failed');
    expect(tries).toBe(1);
    // A person opening the host: tried, and failing it counts too (the wait doubles).
    await expect(p.with(1, async () => 'read')).rejects.toThrow('authentication');
    expect(tries).toBe(2);
    now += 5 * 60_000;
    await expect(background()).rejects.toThrow('authentication');
    expect(tries).toBe(2);
    // Once the wait is over: tried again; it works, and the next ask goes straight through.
    now += 5 * 60_000;
    fails = null;
    await expect(background()).resolves.toBe('read');
    expect(tries).toBe(3);
    // A host that is off: a short first wait (ten seconds), not five minutes.
    p.drop(1);
    fails = 'unreachable';
    await expect(background()).rejects.toThrow();
    now += 11_000;
    await expect(background()).rejects.toThrow();
    expect(tries).toBe(5);
  });
});
