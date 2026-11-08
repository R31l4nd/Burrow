import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerInfo } from '@burrow/shared';
import { Updater } from '../../src/docker/autoupdate.js';
import { stackHistory, stackRow } from '../../src/docker/stacks.js';
import { getUpdateState, setUpdateState } from '../../src/docker/updates.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A host that could not be read for a moment during or after a deploy or an
// update is not the end of it (audit 2026-11-05).

const container = (over: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: 'c1',
  name: 'web',
  image: 'nginx',
  imageId: 'sha256:aaa',
  state: 'running',
  health: null,
  restarts: 0,
  startedAt: null,
  finishedAt: null,
  exitCode: 0,
  oomKilled: false,
  createdAt: '',
  project: 'p',
  service: 'web',
  configFiles: null,
  workingDir: null,
  ...over,
});

type Ctl = { run(s: string): Promise<number>; say(l: string): void; outcome(o: unknown): void };
const checker = { list: () => [], check: async () => {} };
const opts = { settleMs: 5, healthWaitMs: 5, pollMs: 1 };

let t: TestApp;
let hostId: number;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  hostId = (await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'u', authMethod: 'password', password: 'x' })).id;
});
afterEach(async () => t.close());

describe('a deploy whose stack cannot be read afterwards', () => {
  it('is not called well, nor kept as the one deployed (it was saved as the baseline unseen)', async () => {
    const monitor = { poll: async () => ({ error: 'connect ECONNREFUSED', containers: [] }) };
    const outcomes: unknown[] = [];
    const runner = { start: (_t: unknown, _k: unknown, job: (ctl: Ctl) => Promise<number>) => ({ done: job({ run: async () => 0, say: () => {}, outcome: (o) => void outcomes.push(o) }) }) };
    const u = new Updater(t.ctx, monitor as never, runner as never, checker as never, opts);
    const target = { hostId, project: 'p', workingDir: '/srv/p', configFiles: ['/srv/p/compose.yaml'] };
    const op = u.deploy({ userId: null, username: 'burrow', ip: null }, { target, containers: [container()] }, { file: '/srv/p/compose.yaml', content: 'services: {}\n' }) as unknown as { done: Promise<number> };
    expect(await op.done).toBe(1);
    expect(outcomes).toEqual([{ kind: 'not_well', why: 'the stack cannot be read' }]);
    expect(stackRow(t.ctx, hostId, 'p')?.deployedContent ?? null).toBeNull();
    expect(getUpdateState(t.ctx).deploys ?? []).toEqual([]);
  });
});

describe('a deploy left in the middle by a restart', () => {
  it('its host down at the recovery: kept and tried again; a real failed exit forgets it', async () => {
    let lastExit: () => Promise<number | null> = async () => {
      throw new Error('connect EHOSTUNREACH');
    };
    const started: string[] = [];
    const runner = { running: () => undefined, lastExit: () => lastExit(), start: (_t: unknown, kind: string) => (started.push(kind), { done: Promise.resolve(0) }) };
    const monitor = { poll: async () => ({ error: null, containers: [container()] }) };
    setUpdateState(t.ctx, { deploys: [{ hostId, project: 'p', file: null, content: null, before: [{ ...container(), id: 'c1' }], started: t.ctx.now() }] });
    const u = new Updater(t.ctx, monitor as never, runner as never, checker as never, opts);
    await u.recover(1);
    expect(getUpdateState(t.ctx).deploys).toHaveLength(1);
    expect(started).toEqual([]);
    // The next round asks again: the exit read now, and it failed on the host.
    lastExit = async () => 1;
    await u.recover(1);
    expect(getUpdateState(t.ctx).deploys ?? []).toEqual([]);
    expect(started).toEqual([]);
  });

  it('its host down at the recovery and back later: watched then', async () => {
    let down = true;
    const started: string[] = [];
    const runner = {
      running: () => undefined,
      lastExit: async () => {
        if (down) throw new Error('connect EHOSTUNREACH');
        return 0;
      },
      start: (_t: unknown, kind: string) => (started.push(kind), { done: Promise.resolve(0) }),
    };
    const monitor = { poll: async () => ({ error: null, containers: [container()] }) };
    setUpdateState(t.ctx, { deploys: [{ hostId, project: 'p', file: null, content: null, before: [{ ...container(), id: 'c1' }], started: t.ctx.now() }] });
    const u = new Updater(t.ctx, monitor as never, runner as never, checker as never, opts);
    await u.recover(1);
    down = false;
    await u.recover(1);
    expect(started).toEqual(['up']);
  });
});

describe('updates left in the middle by a restart', () => {
  it('one whose host was deleted is forgotten (no history row for a host that is gone), and holds up none of the others', async () => {
    const monitor = { poll: async (id: number) => (id === hostId ? { error: null, containers: [container({ imageId: 'sha256:new' })] } : { error: 'no such host', containers: [] }) };
    const runner = { running: () => undefined, start: (_t: unknown, _k: unknown, job: (ctl: Ctl) => Promise<number>) => ({ done: job({ run: async () => 0, say: () => {}, outcome: () => {} }).catch(() => 1) }) };
    const old = t.ctx.now() - 2 * 86_400_000;
    const pending = (id: number, started: number) => ({ hostId: id, project: 'p', auto: true, services: ['web'], images: [{ image: 'nginx', from: null, to: null }], before: [{ name: 'web', service: 'web', image: 'nginx', imageId: 'sha256:old' }], started });
    setUpdateState(t.ctx, { pending: [pending(hostId + 100, old), pending(hostId, t.ctx.now())] });
    const u = new Updater(t.ctx, monitor as never, runner as never, checker as never, opts);
    await u.recover(1);
    await expect.poll(() => stackHistory(t.ctx, hostId, 'p')[0]?.result).toBe('updated');
    expect(stackHistory(t.ctx, hostId + 100, 'p')).toEqual([]);
    expect(getUpdateState(t.ctx).pending ?? []).toEqual([]);
  });
});
