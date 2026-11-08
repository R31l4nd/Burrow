import { EventEmitter } from 'node:events';
import type { Client, SFTPWrapper } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../src/context.js';
import { SftpPool } from '../../src/files/pool.js';

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
  const p = new SftpPool({} as Ctx, {
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
    const p = new SftpPool({} as Ctx, {
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
});
