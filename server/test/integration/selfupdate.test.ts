import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectResult, Host, HostContainers, UpdateCheck } from '@burrow/shared';
import { selfContainerId } from '../../src/docker/stacks.js';
import { exec } from '../../src/ssh/connect.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Burrow updating itself, through its routes, on the test sshd: the check
// reads a real git checkout there, and the update starts detached, one at a
// time. The update script itself (with a stand-in docker that can be told
// to be healthy) is tested in test/unit/selfupdate.test.ts; here it is
// stopped once it is seen to run, so it never waits out its health checks.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);
const DIR = `/tmp/burrow-selfupdate-${process.pid}`;

let t: TestApp;
let h: Host;
let dir = DIR;
let hostGone = false;
const sh = (cmd: string) => t.files.with(h.id, ({ client }) => exec(client, cmd, 30_000));

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'burrow-home', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
  // A checkout of Burrow 9.9.9 whose changelog has something to do before updating.
  const changelog = '# Changelog\n\n## [9.9.9] - 2026-10-01\n\n### Breaking\n\n- Rename BURROW_PORT to PORT\n  in your .env.\n\n### Fixed\n\n- Not this.\n\n## [2.0.0] - 2026-09-01\n\n### Breaking\n\n- Already running.\n';
  const out = await sh(
    [
      'rm -rf "$HOME/.burrow-update.json" "$HOME/.burrow-update.lock"',
      `rm -rf ${DIR} && mkdir -p ${DIR}/server && cd ${DIR}`,
      `printf '{\\n  "name": "@burrow/server",\\n  "version": "9.9.9"\\n}\\n' > server/package.json`,
      `printf '%s' '${changelog}' > CHANGELOG.md`,
      'git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm "release 9.9.9" && echo ok',
    ].join('\n'),
  );
  expect(out.stdout).toContain('ok');
  // Burrow's own container, as the docker monitor would see it there.
  const me = selfContainerId();
  vi.spyOn(t.docker, 'recent').mockImplementation(async (hostId) => ({
    hostId,
    at: new Date(t.clock.now).toISOString(),
    error: null,
    containers: hostId === h.id ? [{ id: me ?? 'c0ffee', name: 'burrow', service: 'burrow', project: 'burrow', workingDir: dir, configFiles: `${dir}/compose.yaml, ${dir}/compose.override.yaml` }] : [],
  }) as unknown as HostContainers);
});
/** Nothing of these tests left on the sshd for the others. */
async function cleanUp() {
  await stopUpdate();
  await sh(`rm -rf ${DIR} "$HOME/.burrow-update.json"`);
}

afterAll(async () => {
  // The last test removed the host after cleaning up; otherwise here.
  if (!hostGone) await cleanUp();
  vi.restoreAllMocks();
  await t.close();
});

/** The detached update, stopped with everything it started (its own process group). */
async function stopUpdate() {
  await sh('l="$HOME/.burrow-update.lock"; p=$(cat "$l/pid" 2>/dev/null); [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null; rm -rf "$l"; true');
}

describe('self-update routes', () => {
  it("finds Burrow's own container and tells what its folder would bring, the breaking changes since the running version among it", async () => {
    const check = await t.json<UpdateCheck>('GET', '/api/system/update');
    expect(check.target).toEqual({ hostId: h.id, hostName: 'burrow-home', dir: DIR, container: 'burrow', service: 'burrow', project: 'burrow', configFiles: [`${DIR}/compose.yaml`, `${DIR}/compose.override.yaml`] });
    expect(check).toMatchObject({ mode: 'git', available: '9.9.9', subject: 'release 9.9.9', behind: null, problem: null, last: null });
    expect(check.breaking).toEqual(['9.9.9: Rename BURROW_PORT to PORT in your .env.']);
  });

  it('starts the update detached and audited; a second one while it runs is refused (AUDIT2 DO-16)', async () => {
    const r = await t.request('POST', '/api/system/update');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ started: true, from: expect.any(String) });
    // It runs: its state says so, read back by the next check.
    let check = await t.json<UpdateCheck>('GET', '/api/system/update');
    for (let i = 0; i < 50 && check.last?.state !== 'running'; i++) check = await t.json<UpdateCheck>('GET', '/api/system/update');
    expect(check.last).toMatchObject({ state: 'running', code: 'running' });

    const again = await t.request('POST', '/api/system/update');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'update_running' });

    const audit = await t.json<{ action: string; target: string | null; details: Record<string, unknown> }[]>('GET', '/api/audit');
    const entries = audit.filter((e) => e.action === 'burrow.update');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ target: 'burrow-home', details: { to: '9.9.9', dir: DIR } });
    await stopUpdate();
  });

  it('a folder that is no longer there fails at once, without taking the lock (AUDIT2 DO-17)', async () => {
    dir = `${DIR}-gone`;
    try {
      const r = await t.request('POST', '/api/system/update');
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'not_found', message: expect.stringContaining(`${DIR}-gone`) });
      expect((await sh('[ -e "$HOME/.burrow-update.lock" ] && echo held || echo free')).stdout.trim()).toBe('free');
    } finally {
      dir = DIR;
    }
  });

  it('without its own container on any host: says so, and updates nothing', async () => {
    await cleanUp();
    await t.json('DELETE', `/api/hosts/${h.id}`);
    hostGone = true;
    const check = await t.json<UpdateCheck>('GET', '/api/system/update');
    expect(check).toMatchObject({ target: null, problem: 'not_found', mode: null });
    const r = await t.request('POST', '/api/system/update');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'not_found' });
  });
});
