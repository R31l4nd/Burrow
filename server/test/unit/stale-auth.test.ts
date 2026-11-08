import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { sessions } from '../../src/db/schema.js';
import { makeApp, setupAdmin } from '../helpers.js';

// A change whose body comes slowly: the session is the one of when the body
// has arrived, not of when the request began (AUDIT2 AUTH-01).

describe('a change that arrives slowly', () => {
  it('is refused when the session was revoked while its body was still coming', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    const body = JSON.stringify({ name: 'late-host', address: '10.9.9.9', username: 'u', authMethod: 'password', password: 'x' });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/hosts', headers: { cookie: t.cookie!, origin: t.ctx.config.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      // The start of the body, then a pause in which the session is revoked (signed out elsewhere).
      req.write(body.slice(0, 10));
      setTimeout(() => {
        t.ctx.db.delete(sessions).run();
        req.end(body.slice(10));
      }, 300);
    });
    expect(status).toBe(401);
    expect((t.ctx.db.select().from((await import('../../src/db/schema.js')).hosts).all()).map((h) => h.name)).not.toContain('late-host');
    await t.close();
  });
});
