import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { applyDockerDelta, type ContainerInfo, type Host, type HostContainers } from '@burrow/shared';
import { makeApp, ORIGIN, setupAdmin } from '../helpers.js';

// The container overview (decision 19, OPS-W-03): the whole snapshot with
// an hour of history went to every viewer every 5 s, about 500 KB a message
// for 500 containers. Now the whole one once, then what changed.

const box = (i: number, state = 'running'): ContainerInfo => ({
  id: `c${String(i).padStart(63, '0')}`,
  name: `app-${i}`,
  image: 'ghcr.io/acme/app:1',
  imageId: `sha256:${'a'.repeat(64)}`,
  state: state as ContainerInfo['state'],
  health: null,
  restarts: 0,
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: null,
  exitCode: 0,
  oomKilled: false,
  createdAt: '2026-01-01T00:00:00Z',
  project: 'acme',
  service: `svc-${i}`,
  configFiles: '/srv/acme/compose.yaml',
  workingDir: '/srv/acme',
});

describe('the container overview socket', () => {
  it('sends the whole snapshot once, then only what changed, and the changes rebuild it (OPS-W-03)', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'big', address: 'big.lan', username: 'me' });
    let polls = 0;
    // 500 containers; the fourth poll stops one and the fifth removes another; the eighth never ends.
    t.docker.poll = async (hostId: number) => {
      if (++polls > 7) return new Promise<HostContainers>(() => {});
      const containers = Array.from({ length: 500 }, (_, i) => box(i, polls >= 4 && i === 7 ? 'exited' : 'running')).filter((_, i) => !(polls >= 5 && i === 9));
      const stats = Object.fromEntries(containers.filter((c) => c.state === 'running').map((c, i) => [c.id, { cpu: (i % 7) + polls / 10, memBytes: 1000 + polls, memLimitBytes: 4000 }]));
      return { hostId, hostName: 'big', containers, stats, history: {}, error: null, at: new Date(t.ctx.now() + polls).toISOString() };
    };
    (t.docker as unknown as { intervalMs: number }).intervalMs = 10;
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/docker/ws`, { headers: { origin: ORIGIN, cookie: t.cookie ?? '' } });
    const got: { size: number; m: { t: string; host?: HostContainers; d?: Parameters<typeof applyDockerDelta>[1] } }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${got.length} messages`)), 10_000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', hostIds: [h.id] })));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as (typeof got)[number]['m'];
        if (m.t === 'hosts') return;
        got.push({ size: String(raw).length, m });
        if (got.length === 7) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    ws.close();
    const server = await t.docker.recent(h.id, 60_000);
    await t.close();
    expect(got[0]!.m.t).toBe('host');
    expect(got.slice(1).every((x) => x.m.t === 'delta')).toBe(true);
    // A poll without a new sample and nothing changed: a few bytes, not the whole host again.
    const first = got[0]!.size;
    expect(got[1]!.size).toBeLessThan(first / 100);
    expect(got.slice(1).every((x) => x.size < first / 2)).toBe(true);
    // Applied in order, the changes give what the server has.
    let rebuilt = got[0]!.m.host!;
    for (const x of got.slice(1)) rebuilt = applyDockerDelta(rebuilt, x.m.d!);
    expect(rebuilt.containers.find((c) => c.name === 'app-7')?.state).toBe('exited');
    expect(rebuilt.containers.some((c) => c.name === 'app-9')).toBe(false);
    expect(rebuilt).toEqual(server);
  });
});

describe('hosts changed on another device (W-FUNC-09)', () => {
  it('a page watching containers, on any device, is told when a host is added or removed; not on a read', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/docker/ws`, { headers: { origin: ORIGIN, cookie: t.cookie ?? '' } });
    const told: string[] = [];
    ws.on('message', (raw) => told.push((JSON.parse(String(raw)) as { t: string }).t));
    await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'elsewhere', address: 'e.lan', username: 'me' });
    await expect.poll(() => told.filter((x) => x === 'hosts-changed').length).toBe(1);
    // Reads are no change.
    await t.json('GET', '/api/hosts');
    await t.json('DELETE', `/api/hosts/${h.id}`);
    await expect.poll(() => told.filter((x) => x === 'hosts-changed').length).toBe(2);
    ws.close();
    await t.close();
  });
});
