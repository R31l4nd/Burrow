import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { hosts, reportSchedules } from '../../src/db/schema.js';
import { Reports } from '../../src/reports/generate.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A container's logs larger than the 4 MB a report reads (5000 long lines):
// the first 4 MB were kept, so the newest lines and the end marks went, and
// the container read as "logs could not be read" (audit 2026-11-05).

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => t.close());

describe('a report on a container with long log lines', () => {
  it('reads its newest lines and knows it was read, not "logs unread"', async () => {
    const host = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: 'h.lan', username: 'me', authMethod: 'password', password: 'x' });
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).where(eq(hosts.id, host.id)).run();
    const id = t.ctx.db.insert(reportSchedules).values({ name: 'daily', enabled: true, kind: 'daily', day: 1, time: '00:00', cron: null, timeZone: 'UTC', createdAt: t.clock.now }).returning().get().id;
    const ts = new Date(t.clock.now - 3600_000).toISOString().replace('Z', '000000Z');
    const long = 'x'.repeat(1000);
    const lines = [...Array.from({ length: 4999 }, (_, i) => `${ts} info ${i} ${long}`), `${ts} ERROR the newest line`, '@@burrow-exit 0', '@@burrow-lines 5000', ''];
    const client = {
      exec(_cmd: string, _o: unknown, cb: (e: null, ch: unknown) => void) {
        const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), end: () => {}, close: () => {} });
        cb(null, ch);
        setImmediate(() => {
          for (let i = 0; i < lines.length; i += 100) ch.emit('data', Buffer.from(lines.slice(i, i + 100).join('\n') + (i + 100 < lines.length ? '\n' : '')));
          ch.emit('close', 0);
        });
      },
    };
    const pool = { with: async (_h: number, fn: (c: { client: unknown }) => unknown) => fn({ client }) };
    const monitor = { poll: async () => ({ error: null, containers: [{ id: 'c1', name: 'web', image: 'nginx', state: 'running', health: null, restarts: 0, startedAt: null, project: null }] }) };
    const reports = new Reports(t.ctx, pool as never, monitor as never, { notify: async () => ({ sent: 0, failed: [] }), lang: () => 'en' } as never);
    const r = await reports.run(id);
    const web = r.containers.find((c) => c.container === 'web')!;
    expect(web.reasons.map((x) => x.code)).not.toContain('logs_unread');
    expect(web.errors).toBe(1);
    expect(web.linesTotal).toBe(5000);
  });
});
