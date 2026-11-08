import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerInfo, Host, HostContainers } from '@burrow/shared';
import { hosts, imageChecks, stacks } from '../../src/db/schema.js';
import { setUpdateState } from '../../src/docker/updates.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// The maintenance window and versions rolled back before (W-FUNC-03): a
// version that was rolled back was put on again in every window, watched
// for 60 s and rolled back again, night after night.

let t: TestApp;
let h: Host;
const updated: string[][] = [];

const app = (image: string): ContainerInfo => ({ id: 'c1', name: 'shop-app-1', image, imageId: 'sha256:old', state: 'running', health: null, restarts: 0, startedAt: null, finishedAt: null, exitCode: 0, oomKilled: false, createdAt: '', project: 'shop', service: 'app', configFiles: '/srv/shop/compose.yaml', workingDir: '/srv/shop' });

beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'dock', address: 'dock.lan', username: 'me' });
  t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).run();
  t.ctx.db.insert(stacks).values({ hostId: h.id, project: 'shop', autoUpdate: true }).run();
  t.docker.poll = async (hostId: number): Promise<HostContainers> => ({ hostId, hostName: 'dock', containers: [app('acme/shop:1')], stats: {}, history: {}, error: null, at: new Date(t.ctx.now()).toISOString() });
  t.updates.check = async () => {};
  updated.length = 0;
  t.updater.update = async (_actor, _hostId, _project, _auto, only) => {
    updated.push(only ?? []);
    return { done: Promise.resolve(0) } as never;
  };
});
afterEach(async () => {
  await t.close();
});

const offer = (digest: string) =>
  t.ctx.db
    .insert(imageChecks)
    .values({ hostId: h.id, image: 'acme/shop:1', status: 'update', localDigest: 'sha256:here', remoteDigest: digest, checkedAt: t.ctx.now() })
    .onConflictDoUpdate({ target: [imageChecks.hostId, imageChecks.image], set: { remoteDigest: digest } })
    .run();

describe('a version rolled back before', () => {
  it('is not put on again by the window; a newer digest is, and the check says when it was rolled back (W-FUNC-03)', async () => {
    offer('sha256:bad');
    // The update to it was rolled back (stacks.test.ts sees the updater write this down).
    setUpdateState(t.ctx, { rolledBack: [{ hostId: h.id, image: 'acme/shop:1', digest: 'sha256:bad', at: t.ctx.now() }] });
    await t.updater.runWindow();
    expect(updated).toEqual([]);
    expect(t.updates.list(h.id)[0]).toMatchObject({ remoteDigest: 'sha256:bad', rolledBackAt: new Date(t.ctx.now()).toISOString() });

    // Another release in the registry: tried.
    offer('sha256:fixed');
    await t.updater.runWindow();
    expect(updated).toEqual([['app']]);
    expect(t.updates.list(h.id)[0]!.rolledBackAt).toBeNull();
  });
});

describe('"Update anyway" without release notes (decision 9)', () => {
  it('a stack remembers it was asked once', async () => {
    const base = `/api/docker/${h.id}/stacks/shop/notes`;
    expect(await t.json('GET', base)).toEqual({ waived: false });
    expect(await t.json('POST', `${base}/waive`)).toEqual({ waived: true });
    expect(await t.json('GET', base)).toEqual({ waived: true });
    expect(await t.json('GET', `/api/docker/${h.id}/stacks/other/notes`)).toEqual({ waived: false });
  });
});
