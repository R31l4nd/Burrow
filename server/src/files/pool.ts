import { createHash } from 'node:crypto';
import type { Client, SFTPWrapper } from 'ssh2';
import type { Ctx } from '../context.js';
import { resolveTarget } from '../hosts/service.js';
import { HttpError } from '../http.js';
import { openSsh } from '../ssh/connect.js';
import { storedKeys } from '../ssh/knownhosts.js';

// One SSH connection with an SFTP channel per host, shared by all file
// operations and closed after a minute without use. Independent of terminal
// sessions: browsing files needs no open shell.

const IDLE_MS = 60_000;

interface Opened {
  client: Client;
  sftp: SFTPWrapper;
  home: string;
}

interface Entry extends Opened {
  timer: NodeJS.Timeout | null;
  users: number;
  /** Its SFTP channel died: ended once nobody uses it. */
  dead?: boolean;
}

interface Slot {
  entry: Promise<Entry>;
  /** What it was made with (see identityOf). */
  identity: string;
}

async function openSftp(ctx: Ctx, hostId: number): Promise<Opened> {
  const conn = await openSsh(ctx, resolveTarget(ctx, hostId));
  if (!('client' in conn)) {
    throw new HttpError(conn.status === 'auth_failed' ? 401 : 502, conn.status, 'message' in conn ? conn.message : `host key: ${conn.status}`);
  }
  const client = conn.client;
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s)))).catch((err: Error) => {
    client.end();
    throw new HttpError(502, 'sftp_unavailable', `SFTP is not available on this host: ${err.message}`);
  });
  const home = await new Promise<string>((resolve) => sftp.realpath('.', (err, p) => resolve(err ? '/' : p)));
  return { client, sftp, home };
}

/**
 * Who, where, how and with which trusted host keys a connection to the host
 * is made now. A change anywhere (the host, its group or the defaults, a key
 * installed, a password removed, a trusted key deleted) makes a new one:
 * the old connection went on with the old identity (audit BE-18).
 */
function identityOf(ctx: Ctx, hostId: number): string {
  const t = resolveTarget(ctx, hostId);
  const keys = storedKeys(ctx, t.host, t.port)
    .map((k) => k.keyB64)
    .sort();
  return createHash('sha256').update(JSON.stringify([t, keys])).digest('hex');
}

export class SftpPool {
  readonly #conns = new Map<number, Slot>();
  readonly #connect: (hostId: number) => Promise<Opened>;
  readonly #identity: (hostId: number) => string;

  constructor(ctx: Ctx, deps: { connect?: (hostId: number) => Promise<Opened>; identity?: (hostId: number) => string } = {}) {
    this.#connect = deps.connect ?? ((id) => openSftp(ctx, id));
    this.#identity = deps.identity ?? ((id) => identityOf(ctx, id));
  }

  /** Forget the slot only while it is still this one: a replacement stays (audit BE-19). */
  #forget(hostId: number, slot: Slot): void {
    if (this.#conns.get(hostId) === slot) this.#conns.delete(hostId);
  }

  #open(hostId: number, identity: string): Slot {
    const slot: Slot = { identity, entry: null as unknown as Promise<Entry> };
    slot.entry = this.#connect(hostId).then((o) => {
      const entry: Entry = { ...o, timer: null, users: 0 };
      // A dropped connection is forgotten, so the next call opens a new one.
      const gone = () => {
        if (entry.timer) clearTimeout(entry.timer);
        this.#forget(hostId, slot);
      };
      o.client.on('close', gone);
      o.client.on('error', gone);
      // The SFTP channel alone can die while SSH lives: then this entry is no use either
      // (it stayed cached and failed every file call, AUDIT2 FS-13). Ended once nobody uses it.
      const sftpGone = () => {
        gone();
        entry.dead = true;
        if (entry.users === 0) o.client.end();
      };
      o.sftp.on?.('close', sftpGone);
      o.sftp.on?.('error', sftpGone);
      return entry;
    });
    slot.entry.catch(() => this.#forget(hostId, slot));
    this.#conns.set(hostId, slot);
    return slot;
  }

  /** Run `fn` with the host's connection; keeps it open while in use. */
  async with<T>(hostId: number, fn: (e: { client: Client; sftp: SFTPWrapper; home: string }) => Promise<T>): Promise<T> {
    const identity = this.#identity(hostId);
    let slot = this.#conns.get(hostId);
    if (slot && slot.identity !== identity) {
      // Made with what no longer holds.
      this.#retire(hostId, slot);
      slot = undefined;
    }
    slot ??= this.#open(hostId, identity);
    const e = await slot.entry;
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.users++;
    try {
      return await fn(e);
    } finally {
      e.users--;
      if (e.users === 0 && e.dead) e.client.end();
      else if (e.users === 0 && this.#conns.get(hostId) === slot) {
        e.timer = setTimeout(() => {
          this.#forget(hostId, slot);
          e.client.end();
        }, IDLE_MS);
        e.timer.unref();
      }
    }
  }

  /**
   * Out of the pool and ended, in use or not: a long reader (a log or alert
   * stream) would otherwise keep the old identity for hours. Its owner
   * connects again, with what holds now.
   */
  #retire(hostId: number, slot: Slot): void {
    this.#forget(hostId, slot);
    void slot.entry
      .then((e) => {
        if (e.timer) clearTimeout(e.timer);
        e.timer = null;
        e.client.end();
      })
      .catch(() => {});
  }

  /** Forget a host's connection (host edited or deleted). */
  drop(hostId: number): void {
    const slot = this.#conns.get(hostId);
    if (slot) this.#retire(hostId, slot);
  }

  closeAll(): void {
    for (const id of [...this.#conns.keys()]) this.drop(id);
  }
}
