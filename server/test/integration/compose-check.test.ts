import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, Host } from '@burrow/shared';
import { exec } from '../../src/ssh/connect.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Unsaved compose text checked with the host's own `docker compose config`
// (the sshd with the real docker CLI): written beside the real file, checked
// there, removed. It starts nothing: config only reads the file.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DOCKER_SSHD_PORT ?? 2297);
const DIR = `/tmp/burrow-compose-check-${process.pid}`;

let t: TestApp;
let h: Host;
const sh = (cmd: string) => t.files.with(h.id, ({ client }) => exec(client, cmd, 30_000));

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'docker-real', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: process.env.DOCKER_SSHD_PASSWORD ?? 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  // An .env beside it: the check resolves it as compose would for the real file.
  await sh(`rm -rf ${DIR} && mkdir -p ${DIR} && printf 'TAG=1.27\\n' > ${DIR}/.env`);
});
afterAll(async () => {
  await sh(`rm -rf ${DIR}`);
  await t.close();
});

const check = (content: string, path = `${DIR}/compose.yaml`) => t.request('POST', `/api/files/${h.id}/compose-check`, { path, content });
const leftovers = async () => (await sh(`ls -A ${DIR}`)).stdout.split('\n').filter((f) => f.startsWith('.burrow-check-'));

describe('compose check', () => {
  it('a valid file is fine, with its .env resolved; nothing is left beside it', async () => {
    const r = await check('services:\n  web:\n    image: nginx:${TAG}\n');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, diagnostics: [] });
    expect(await leftovers()).toEqual([]);
  });

  it("an error is placed on the line it is about, named by the real file, not the check's", async () => {
    const r = await check('services:\n  web:\n    image: nginx\n    imagee: typo\n');
    expect(r.statusCode).toBe(200);
    const body = r.json<{ ok: boolean; diagnostics: { line: number; message: string; source: string }[] }>();
    expect(body.ok).toBe(false);
    expect(body.diagnostics.length).toBeGreaterThan(0);
    const d = body.diagnostics.find((x) => x.message.includes('imagee'))!;
    expect(d).toMatchObject({ line: 4, source: 'docker compose' });
    expect(JSON.stringify(body)).not.toContain('.burrow-check-');
    expect(await leftovers()).toEqual([]);
  });

  it('a folder it cannot write to is said, not taken for a valid file', async () => {
    const r = await check('services: {}\n', '/compose.yaml');
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'sftp_error', message: expect.stringContaining('Could not write a check file in /') });
  });

  it('a host that does not exist, or a relative path, is refused', async () => {
    expect((await t.request('POST', '/api/files/999/compose-check', { path: `${DIR}/compose.yaml`, content: '' })).statusCode).toBe(404);
    expect((await t.request('POST', `/api/files/${h.id}/compose-check`, { path: 'relative.yaml', content: '' })).statusCode).toBe(400);
  });
});
