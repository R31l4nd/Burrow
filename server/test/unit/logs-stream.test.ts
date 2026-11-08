import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host, LogServerMessage } from '@burrow/shared';
import { LogStream } from '../../src/docker/logs.js';
import { openSsh } from '../../src/ssh/connect.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

vi.mock('../../src/ssh/connect.js', async (original) => ({ ...(await original<typeof import('../../src/ssh/connect.js')>()), openSsh: vi.fn() }));

let t: TestApp;
let host: Host;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  host = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: 'h.lan', username: 'me', authMethod: 'password', password: 'x' });
});
afterEach(async () => t.close());

describe('a log stream whose connection goes before its command starts', () => {
  it('says so for each source, and the process goes on (ssh2 throws "Not connected"; audit 2026-11-05)', async () => {
    const client = { on: () => client, end: () => {}, exec: () => { throw new Error('Not connected'); } };
    vi.mocked(openSsh).mockResolvedValue({ client } as never);
    const got: LogServerMessage[] = [];
    const s = new LogStream(t.ctx, [{ hostId: host.id, container: 'web' }, { hostId: host.id, container: 'db' }], { since: null, until: null, tail: 10, follow: true }, (m) => void got.push(m));
    await s.start();
    await vi.waitFor(() => expect(got).toEqual([{ t: 'error', i: 0, message: 'Not connected' }, { t: 'error', i: 1, message: 'Not connected' }]));
    s.close();
  });
});
