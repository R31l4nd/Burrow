import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Host } from '@burrow/shared';
import { deviceHosts, devices, users } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';
import { phoneSshKey } from '../sshkey.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => t.close());

describe('the last admin', () => {
  it('a deletion that is still taking keys off a host does not let the other admin be demoted (AUDIT2 AUTH-04)', async () => {
    // A host that takes the connection and never answers: the deletion waits there.
    const held: Socket[] = [];
    let reached!: () => void;
    const there = new Promise<void>((r) => (reached = r));
    const srv = createServer((s) => {
      held.push(s);
      reached();
    }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'slow', address: '127.0.0.1', port: (srv.address() as AddressInfo).port, username: 'me', authMethod: 'password', password: 'x' });
    const b = t.ctx.db.insert(users).values({ username: 'b', role: 'admin', totpConfirmed: false, incomplete: false, createdAt: t.clock.now }).returning().get();
    const d = t.ctx.db.insert(devices).values({ userId: b.id, name: 'B phone', publicKey: 'x', createdAt: t.clock.now, sshPublicKey: phoneSshKey().line }).returning().get();
    t.ctx.db.insert(deviceHosts).values({ deviceId: d.id, hostId: h.id, installedAt: t.clock.now }).run();
    const me = t.ctx.db.select().from(users).where(eq(users.username, 'admin')).get()!;
    try {
      const deleting = t.request('DELETE', `/api/users/${b.id}`);
      await there;
      // B is gone already: A is the last admin.
      const demote = await t.request('PUT', `/api/users/${me.id}`, { role: 'operator' });
      expect(demote.statusCode).toBe(409);
      for (const s of held) s.destroy();
      expect((await deleting).statusCode).toBe(204);
      expect(t.ctx.db.select().from(users).where(and(eq(users.role, 'admin'))).all().map((u) => u.username)).toEqual(['admin']);
    } finally {
      for (const s of held) s.destroy();
      srv.close();
    }
  }, 30_000);
});

describe('single sign-on links', () => {
  it('the same subject at two providers is two people, each linked (AUDIT2 AUTH-05)', async () => {
    const add = (username: string, iss: string | null) =>
      t.ctx.db.insert(users).values({ username, role: 'operator', totpConfirmed: false, incomplete: false, oidcSub: '1234', oidcIss: iss, createdAt: t.clock.now }).run();
    add('at-a', 'https://a.example');
    add('at-b', 'https://b.example');
    expect(() => add('again-at-a', 'https://a.example')).toThrow(/UNIQUE/);
    expect(t.ctx.db.select().from(users).where(eq(users.oidcSub, '1234')).all().map((u) => u.username)).toEqual(['at-a', 'at-b']);
  });
});

describe('the last way in', () => {
  it('single sign-on switched off, or linked to an earlier provider, is no way in (AUDIT2 AUTH-07)', async () => {
    const me = t.ctx.db.select().from(users).where(eq(users.username, 'admin')).get()!;
    // Linked once, at a provider that is not set up (any more).
    t.ctx.db.update(users).set({ oidcSub: 'me-at-old', oidcIss: 'https://old.example' }).where(eq(users.id, me.id)).run();
    const r = await t.request('DELETE', '/api/account/totp');
    expect(r.json()).toMatchObject({ error: 'last_login_method' });
    expect(t.ctx.db.select().from(users).where(eq(users.id, me.id)).get()!.totpConfirmed).toBe(true);
  });
});

describe('confirmed as the person first', () => {
  it('Burrow updating itself and the automatic updates settings ask for a fresh sign-in (AUDIT2 AUTH-09)', async () => {
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/system/update', {})).json()).toMatchObject({ error: 'step_up_required' });
    expect((await t.request('PUT', '/api/docker/updates/settings', {})).json()).toMatchObject({ error: 'step_up_required' });
  });
});
