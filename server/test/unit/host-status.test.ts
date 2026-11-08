import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Group, Host, HostStatus } from '@burrow/shared';
import { StatusMonitor, tcpCheck } from '../../src/hosts/status.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// The green/red dot in the host list: a TCP connect to each host's SSH port.

let t: TestApp;
let server: Server;
let open: number;
let closed: number;

/** Until the app's own check of a host just added is done (POST /api/hosts starts one, not awaited). */
async function settled(hostId: number) {
  const until = Date.now() + 5000;
  while (!t.status.all().some((s) => s.hostId === hostId) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  server = createServer((sock) => sock.end());
  open = await listen(server);
  // A port that was free a moment ago: nothing listens there now.
  const gone = createServer();
  closed = await listen(gone);
  await new Promise((r) => gone.close(r));
});
afterEach(async () => {
  t.status.stop();
  await t.close();
  await new Promise((r) => server.close(r));
});

describe('tcpCheck', () => {
  it('gives the time a connect took, or null when nothing listens or it takes too long', async () => {
    const ms = await tcpCheck('127.0.0.1', open);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(0);
    expect(await tcpCheck('127.0.0.1', closed)).toBeNull();
    // A non-routable address never answers: the timeout says unreachable.
    expect(await tcpCheck('10.255.255.1', 22, 50)).toBeNull();
  });
});

describe('StatusMonitor', () => {
  it("checks every host on the port it really connects to (the group's), and forgets deleted hosts", async () => {
    const g = await t.json<Group>('POST', '/api/groups', { name: 'G', defaults: { port: open } });
    const up = await t.json<Host>('POST', '/api/hosts', { name: 'up', address: '127.0.0.1', groupId: g.id });
    const down = await t.json<Host>('POST', '/api/hosts', { name: 'down', address: '127.0.0.1', port: closed });
    await t.status.checkAll();
    const byId = new Map(t.status.all().map((s) => [s.hostId, s]));
    expect(byId.get(up.id)).toMatchObject({ reachable: true, checkedAt: new Date(t.clock.now).toISOString() });
    expect(byId.get(up.id)!.latencyMs).not.toBeNull();
    expect(byId.get(down.id)).toMatchObject({ reachable: false, latencyMs: null });

    await t.json('DELETE', `/api/hosts/${down.id}`);
    await t.status.checkAll();
    expect(t.status.all().map((s) => s.hostId)).toEqual([up.id]);
  });

  it('runs one round at a time: a second call while one runs does nothing', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'up', address: '127.0.0.1', port: open });
    await settled(h.id);
    // A monitor of its own: adding a host checks it in the app's.
    const m = new StatusMonitor(t.ctx);
    let connects = 0;
    server.on('connection', () => connects++);
    await Promise.all([m.checkAll(), m.checkAll()]);
    expect(connects).toBe(1);
  });

  it('checks at once when started; not at all with interval 0', async () => {
    await t.json<Host>('POST', '/api/hosts', { name: 'up', address: '127.0.0.1', port: open });
    const m = new StatusMonitor(t.ctx);
    m.start(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(m.all()).toEqual([]);

    m.start(3600);
    const until = Date.now() + 5000;
    while (!m.all().length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(m.all()).toMatchObject([{ reachable: true }] as Partial<HostStatus>[]);
    m.stop();
    m.stop();
  });
});
