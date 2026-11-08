import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogEvent } from '@burrow/shared';
import { describe, expect, it } from 'vitest';
import { kindOf, messageOf } from '../../src/logevents.js';
import { pruneOld } from '../../src/retention.js';
import { makeApp, setupAdmin } from '../helpers.js';

describe('Burrow\'s own warnings and errors (OPS-W-13)', () => {
  it('are kept grouped by kind, with how often and when, and are still there after a restart (a deploy)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-logevents-'));
    const dbFile = join(dir, 'burrow.db');
    try {
      const t = await makeApp({ dbFile });
      await setupAdmin(t);
      t.app.log.warn('host-stats: host 7: timeout after 3000 ms');
      t.app.log.child({ job: 'x' }).warn('host-stats: host 12: timeout after 3000 ms');
      t.app.log.error({ err: new Error('SQLITE_FULL') }, 'unhandled error');
      t.app.log.warn('webhook failed for https://user:hunter2@hooks.example.com/x');
      t.app.log.info('not kept');
      const events = await t.json<LogEvent[]>('GET', '/api/system/log-events');
      expect(events).toHaveLength(3);
      expect(events.find((e) => e.kind === 'host-stats: host #: timeout after # ms')).toMatchObject({ level: 'warn', count: 2, example: 'host-stats: host 12: timeout after 3000 ms' });
      expect(events.find((e) => e.level === 'error')).toMatchObject({ kind: 'unhandled error: SQLITE_FULL', count: 1 });
      // The example is masked like what goes to a model: a password in a URL does not stay.
      expect(JSON.stringify(events)).not.toContain('hunter2');
      t.app.log.warn('host-stats: host 3: timeout after 5000 ms');
      await t.close();

      const again = await makeApp({ dbFile });
      try {
        again.cookie = t.cookie;
        const kept = await again.json<LogEvent[]>('GET', '/api/system/log-events');
        // The warning logged just before the stop is kept too (written on close).
        expect(kept.find((e) => e.kind === 'host-stats: host #: timeout after # ms')).toMatchObject({ count: 3, example: 'host-stats: host 3: timeout after 5000 ms' });
        // Admins only.
        again.cookie = null;
        expect((await again.request('GET', '/api/system/log-events')).statusCode).toBe(401);
      } finally {
        await again.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('go 30 days after a kind was last seen', async () => {
    const t = await makeApp();
    try {
      t.app.log.warn('old one');
      t.logEvents.flush();
      t.advance(29 * 86_400_000);
      t.app.log.warn('newer one');
      t.logEvents.flush();
      t.advance(2 * 86_400_000);
      pruneOld(t.ctx);
      // Read directly: the sign-in did not last the month.
      expect(t.logEvents.list().map((e) => e.kind)).toEqual(['newer one']);
    } finally {
      await t.close();
    }
  });

  it("a request a person was refused (4xx) is no problem of Burrow's and is not kept; a 5xx is", async () => {
    const t = await makeApp();
    try {
      t.app.log.warn('POST /api/terminal/sessions 403 step_up_required');
      t.app.log.warn('GET /api/files/:hostId/list 404 not_found');
      t.app.log.warn('GET /api/workspace/:hostId/files 504 host_timeout');
      expect(t.logEvents.list().map((e) => e.kind)).toEqual(['GET /api/workspace/:hostId/files # host_timeout']);
    } finally {
      await t.close();
    }
  });

  it('a kind leaves out numbers and long ids; the text is the message and its error', () => {
    expect(kindOf('container 3f2a9c81d0e4b7 on host 12 gone')).toBe('container * on host # gone');
    expect(messageOf(['plain'])).toBe('plain');
    expect(messageOf([{ err: new Error('boom') }, 'unhandled error'])).toBe('unhandled error: boom');
    expect(messageOf([new Error('alone')])).toBe('alone');
    expect(messageOf([{ code: 'X' }, 'with fields'])).toBe('with fields');
  });
});
