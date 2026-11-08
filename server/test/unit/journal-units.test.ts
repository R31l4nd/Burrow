import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// The services to choose a journal from (listed on the host: the test sshd,
// test/integration/journal.test.ts): a host that cannot be reached says so,
// never an empty list that reads as "no services".

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => {
  await t.close();
});

describe('journal units', () => {
  it('a host that cannot be reached is an error, not "no services"', async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'gone', address: '127.0.0.1', port, username: 'x', authMethod: 'password', password: 'x' });
    const r = await t.request('GET', `/api/hosts/${h.id}/journal/units`);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'host_unreachable' });
  });
});
