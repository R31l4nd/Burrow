import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Client, SFTPWrapper } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host, Invite } from '@burrow/shared';
import { fileAccess, users } from '../../src/db/schema.js';
import { FileAccessGuard } from '../../src/files/access.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// What an operator may open (A3-SRV-01), decided against a host of the
// test's own: its links (realpath), which folders hold a Burrow database
// (stat of burrow.db) and what `find` says lies below a folder. The same
// on the test sshd: test/integration/file-access.test.ts.

let t: TestApp;
let host: Host;
let operator: FastifyRequest;

/** The host: links and their targets, files that exist, and how `find` answers. */
const fake = {
  links: new Map<string, string>(),
  files: new Set<string>(),
  find: ((): { out: string } | Error => ({ out: '' })) as () => { out: string } | Error,
};
const sftp = {
  realpath: (p: string, cb: (err: Error | null, real?: string) => void) => cb(null, fake.links.get(p) ?? p),
  stat: (p: string, cb: (err: Error | null) => void) => cb(fake.files.has(p) ? null : Object.assign(new Error('No such file'), { code: 2 })),
} as unknown as SFTPWrapper;
const client = {
  exec: (_cmd: string, _opts: unknown, cb: (err: Error | null, ch?: unknown) => void) => {
    const r = fake.find();
    if (r instanceof Error) return cb(r);
    // Answered once open: exec keeps the channel's stdin open while the command runs (it ends it on the host at a time-out).
    const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), end: () => {}, close: () => {} });
    cb(null, ch);
    setImmediate(() => (ch.emit('data', Buffer.from(r.out)), ch.emit('close', 0)));
  },
} as unknown as Client;
const conn = { sftp, client };

beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  host = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
  const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
  const admin = t.cookie;
  t.cookie = null;
  await t.json('POST', `/api/invites/${inv.url!.split('/').pop()!}/accept`, { username: 'olivia' });
  t.cookie = admin;
  const user = t.ctx.db.select().from(users).where(eq(users.username, 'olivia')).get()!;
  t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, user.id)).run();
  operator = { auth: { user: { ...user, incomplete: false }, session: { stepUpAt: null } } } as unknown as FastifyRequest;
  t.ctx.db.insert(fileAccess).values({ userId: user.id, hostId: host.id, allow: JSON.stringify(['/srv', '/media']), deny: JSON.stringify(['/srv/private']), updatedAt: t.clock.now }).run();
  fake.links.clear();
  fake.files.clear();
  fake.find = () => ({ out: '' });
});
afterEach(async () => {
  await t.close();
});

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }));

describe('search results for an operator', () => {
  it("leave out Burrow's data folders below the root, found by their database", async () => {
    const guard = new FileAccessGuard(t.ctx);
    fake.find = () => ({ out: '/srv/burrow/data/burrow.db\n' });
    const found = ['/srv/app/compose.yaml', '/srv/burrow/data/recordings/1.cast', '/srv/private/notes.txt', '/srv/app/.ssh/id_ed25519'];
    expect(await guard.filter(operator, host.id, conn, '/srv', found)).toEqual(['/srv/app/compose.yaml']);
  });

  it("are refused when where Burrow's data lies below the root could not be looked for: never shown unfiltered", async () => {
    const guard = new FileAccessGuard(t.ctx);
    fake.find = () => new Error('Not connected');
    const found = ['/srv/app/compose.yaml', '/srv/burrow/data/recordings/1.cast'];
    const r = await refusal(guard.filter(operator, host.id, conn, '/srv', found));
    expect(r).toEqual({ status: 502, code: 'host_failed' });
  });
});

describe('what is remembered of the host, five minutes at most', () => {
  it('a granted folder that is a link: judged by its target as it is now, not as it was', async () => {
    const guard = new FileAccessGuard(t.ctx);
    fake.links.set('/media', '/mnt/disk1');
    fake.links.set('/mnt/disk1/film.mkv', '/mnt/disk1/film.mkv');
    expect(await guard.check(operator, host.id, conn, '/mnt/disk1/film.mkv')).toBe('/mnt/disk1/film.mkv');
    // The link now points elsewhere: the old target is no longer granted, once the five minutes are over.
    fake.links.set('/media', '/mnt/disk2');
    t.advance(5 * 60_000);
    expect(await refusal(guard.check(operator, host.id, conn, '/mnt/disk1/film.mkv'))).toEqual({ status: 403, code: 'no_file_access' });
    expect(await guard.check(operator, host.id, conn, '/mnt/disk2/film.mkv')).toBe('/mnt/disk2/film.mkv');
  });

  it("a folder that became Burrow's data folder is closed once it is looked at again", async () => {
    const guard = new FileAccessGuard(t.ctx);
    expect(await guard.check(operator, host.id, conn, '/srv/newdata/recordings/1.cast')).toBe('/srv/newdata/recordings/1.cast');
    fake.files.add('/srv/newdata/burrow.db');
    t.advance(5 * 60_000);
    expect(await refusal(guard.check(operator, host.id, conn, '/srv/newdata/recordings/1.cast'))).toEqual({ status: 403, code: 'no_file_access' });
  });

  it("Burrow's own compose folder is closed on the host it runs on, also when granted, and only there", async () => {
    const other = await t.json<Host>('POST', '/api/hosts', { name: 'other', address: 'other.lan' });
    const user = (operator.auth as { user: { id: number } }).user;
    t.ctx.db.insert(fileAccess).values({ userId: user.id, hostId: other.id, allow: JSON.stringify(['/srv']), deny: '[]', updatedAt: t.clock.now }).run();
    let asked = 0;
    const guard = new FileAccessGuard(t.ctx, async () => (asked++, { found: [{ hostId: host.id, dir: '/srv/burrow' }], unreadable: [] }));
    expect(await refusal(guard.check(operator, host.id, conn, '/srv/burrow/.env'))).toEqual({ status: 403, code: 'no_file_access' });
    expect(await guard.filter(operator, host.id, conn, '/srv', ['/srv/burrow/compose.yaml', '/srv/app/x'], false)).toEqual(['/srv/app/x']);
    expect(await guard.check(operator, other.id, conn, '/srv/burrow/.env')).toBe('/srv/burrow/.env');
    // Asked once for those five minutes.
    expect(asked).toBe(1);
  });

  it("where it is not known whether Burrow's own folder is (its containers there could not be read): refused, and asked again soon", async () => {
    const other = await t.json<Host>('POST', '/api/hosts', { name: 'other', address: 'other.lan' });
    const user = (operator.auth as { user: { id: number } }).user;
    t.ctx.db.insert(fileAccess).values({ userId: user.id, hostId: other.id, allow: JSON.stringify(['/srv']), deny: '[]', updatedAt: t.clock.now }).run();
    let answer: { found: { hostId: number; dir: string }[]; unreadable: number[] } = { found: [], unreadable: [host.id] };
    let asked = 0;
    const guard = new FileAccessGuard(t.ctx, async () => (asked++, answer));
    const r = await refusal(guard.check(operator, host.id, conn, '/srv/burrow/.env'));
    expect(r).toEqual({ status: 503, code: 'own_folder_unknown' });
    expect(await refusal(guard.filter(operator, host.id, conn, '/srv', ['/srv/app/x'], false))).toEqual({ status: 503, code: 'own_folder_unknown' });
    // Another host, whose containers were read: certain that it is not there.
    expect(await guard.check(operator, other.id, conn, '/srv/burrow/.env')).toBe('/srv/burrow/.env');
    // Not kept as "no own folder" for five minutes: asked again after a few seconds, and the real answer counts.
    answer = { found: [{ hostId: host.id, dir: '/srv/burrow' }], unreadable: [] };
    t.advance(15_000);
    expect(await refusal(guard.check(operator, host.id, conn, '/srv/burrow/.env'))).toEqual({ status: 403, code: 'no_file_access' });
    expect(await guard.check(operator, host.id, conn, '/srv/app/x')).toBe('/srv/app/x');
    expect(asked).toBe(2);
    // The look itself failing: unknown everywhere, refused.
    const broken = new FileAccessGuard(t.ctx, async () => {
      throw new Error('database is locked');
    });
    expect(await refusal(broken.check(operator, other.id, conn, '/srv/app/x'))).toEqual({ status: 503, code: 'own_folder_unknown' });
  });

  it('every Burrow found on the host has its compose folder closed, also when which one is this one is not known', async () => {
    const guard = new FileAccessGuard(t.ctx, async () => ({ found: [{ hostId: host.id, dir: '/srv/burrow' }, { hostId: host.id, dir: '/srv/burrow-test' }], unreadable: [] }));
    expect(await refusal(guard.check(operator, host.id, conn, '/srv/burrow/.env'))).toEqual({ status: 403, code: 'no_file_access' });
    expect(await refusal(guard.check(operator, host.id, conn, '/srv/burrow-test/secrets/x'))).toEqual({ status: 403, code: 'no_file_access' });
    expect(await guard.filter(operator, host.id, conn, '/srv', ['/srv/burrow/compose.yaml', '/srv/burrow-test/.env', '/srv/app/x'], false)).toEqual(['/srv/app/x']);
    expect(await guard.check(operator, host.id, conn, '/srv/app/x')).toBe('/srv/app/x');
  });
});
