import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, DockerResources, Host, PruneResult } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A host's images, volumes and networks, and cleaning up, against the test
// sshd's stand-in docker (server/test/sshd/docker): never this machine's own.

const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SSHD_PORT ?? 2299);
const A = `sha256:${'a'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const D = `sha256:${'d'.repeat(64)}`;
const OLDNET = 'f'.repeat(64);

let t: TestApp;
let h: Host;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'res', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  await t.json('POST', '/api/snippets/run', { hostIds: [h.id], command: 'rm -rf /tmp/fakedocker' });
});
afterAll(async () => {
  await t.json('POST', '/api/snippets/run', { hostIds: [h.id], command: 'rm -rf /tmp/fakedocker' }).catch(() => {});
  await t.close();
});

describe("a host's images, volumes and networks", () => {
  it('are listed with what uses them', async () => {
    const r = await t.json<DockerResources>('GET', `/api/docker/${h.id}/resources`);
    expect(r.images.map((i) => [i.tags.join(','), i.usedBy])).toEqual([
      ['postgres:17', ['burrowtest-db']],
      ['redis:8', ['burrowtest-cache']],
      ['busybox:1.36', []],
      ['', []],
    ]);
    expect(r.images[0]!.sizeBytes).toBe(438_000_000);
    expect(r.volumes).toEqual([
      { name: 'burrowtest_pgdata', driver: 'local', project: 'burrowtest', usedBy: ['burrowtest-db'] },
      { name: 'old_cache', driver: 'local', project: null, usedBy: [] },
    ]);
    expect(r.networks.filter((n) => !n.builtin).map((n) => [n.name, n.usedBy])).toEqual([
      ['burrowtest_default', ['burrowtest-db', 'burrowtest-cache']],
      ['oldnet', []],
    ]);
  });

  it('cleaning up removes what was shown as unused, and refuses what is used', async () => {
    const r = await t.json<PruneResult>('POST', `/api/docker/${h.id}/prune`, { images: [C, D, A], volumes: ['old_cache'], networks: [OLDNET] });
    expect(r.removed).toEqual({ images: [C, D], volumes: ['old_cache'], networks: [OLDNET] });
    expect(r.skipped).toEqual([{ kind: 'image', id: A, why: "in use, Burrow's own, or gone" }]);
    expect(r.freedBytes).toBe(4_260_000 + 95_500_000);
    const after = await t.json<DockerResources>('GET', `/api/docker/${h.id}/resources`);
    expect(after.images.map((i) => i.id)).not.toContain(C);
    expect(after.volumes.map((v) => v.name)).toEqual(['burrowtest_pgdata']);
    const audit = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(audit.map((a) => a.action)).toContain('docker.prune');
  });

  it('a malformed request is refused before anything runs', async () => {
    const bad = await t.request('POST', `/api/docker/${h.id}/prune`, { images: ['nope'] });
    expect(bad.statusCode).toBe(400);
  });
});
