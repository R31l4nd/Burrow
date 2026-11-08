import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, DiscoveryResult, Host } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// App discovery from container labels, against the test sshd and its fake
// docker CLI (server/test/sshd/docker).
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;

beforeAll(async () => {
  t = await makeApp({ env: { APPS_BASE_DOMAIN: 'example.com' }, fetch: async () => new Response('', { status: 404 }) });
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'docker-host', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') {
    await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
    // Detects Docker now that the key is trusted.
    const again = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
    expect(again, JSON.stringify(again)).toMatchObject({ status: 'ok', facts: { hasDocker: true } });
  } else {
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'ok', facts: { hasDocker: true } });
  }
});
afterAll(async () => {
  await t.close();
});

describe('app discovery', () => {
  it('finds web apps in the labels of running containers', async () => {
    const d = await t.json<DiscoveryResult>('GET', '/api/apps/discover');
    expect(d.errors).toEqual([]);
    expect(d.apps).toEqual([
      expect.objectContaining({ name: 'Radarr', url: 'https://radarr.local.example.com/', source: 'swag', hostId: h.id, container: 'radarr', added: false }),
      expect.objectContaining({ name: 'Sonarr', url: 'https://sonarr.example.com/', group: 'Media', source: 'homepage', added: false }),
    ]);
  });

  it('marks apps that were added already', async () => {
    await t.json('POST', '/api/apps', { name: 'Radarr', url: 'https://radarr.local.example.com/', hostId: h.id, container: 'radarr' });
    const d = await t.json<DiscoveryResult>('GET', '/api/apps/discover');
    expect(d.apps.find((a) => a.container === 'radarr')?.added).toBe(true);
  });
});
