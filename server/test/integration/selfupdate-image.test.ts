import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectResult, Host, HostContainers, UpdateCheck } from '@burrow/shared';
import { selfContainerId } from '../../src/docker/stacks.js';
import { exec } from '../../src/ssh/connect.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// An install on the prebuilt images (2026-11-08): its folder on the host is
// no checkout, so the check over SSH says "mode image" and nothing more.
// What is newer comes from Burrow's releases on GitHub (the call caught here).
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);
const DIR = `/tmp/burrow-image-${process.pid}`;

let t: TestApp;
let h: Host;
const asked: string[] = [];
const releases = [
  { tag_name: 'v99.0.0', name: 'Burrow 99.0.0', body: '### Breaking\n\n- The app has a new id.\n', prerelease: false },
  { tag_name: 'v2.0.0', name: 'Burrow 2.0.0', body: '### Fixed\n\n- Old.\n', prerelease: false },
];

const sh = (cmd: string) => t.files.with(h.id, ({ client }) => exec(client, cmd, 30_000));

beforeAll(async () => {
  t = await makeApp({
    fetch: (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(releases), { status: 200 });
    }) as typeof fetch,
  });
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'burrow-images', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
  // A folder as a release's files leave it: compose.yaml and .env, no .git.
  expect((await sh(`rm -rf ${DIR} && mkdir -p ${DIR} && touch ${DIR}/compose.yaml ${DIR}/.env && echo ok`)).stdout).toContain('ok');
  const me = selfContainerId();
  vi.spyOn(t.docker, 'recent').mockImplementation(async (hostId) => ({
    hostId,
    at: new Date(t.clock.now).toISOString(),
    error: null,
    containers: hostId === h.id ? [{ id: me ?? 'c0ffee', name: 'burrow', service: 'burrow', project: 'burrow', workingDir: DIR, configFiles: `${DIR}/compose.yaml` }] : [],
  }) as unknown as HostContainers);
});

afterAll(async () => {
  await sh(`rm -rf ${DIR}`).catch(() => {});
  vi.restoreAllMocks();
  await t.close();
});

describe('an install on the prebuilt images, as it runs', () => {
  it("is told the newest release on GitHub and its breaking changes, where a checkout's check tells nothing", async () => {
    const c = await t.json<UpdateCheck>('GET', '/api/system/update');
    expect(c).toMatchObject({ mode: 'image', available: '99.0.0', subject: 'Burrow 99.0.0', breaking: ['99.0.0: The app has a new id.'], problem: null });
    expect(asked).toEqual(['https://api.github.com/repos/R31l4nd/Burrow/releases?per_page=100']);
  });
});
