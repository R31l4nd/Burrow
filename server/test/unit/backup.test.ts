import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBackups } from '../../src/backup.js';
import type { Notifier } from '../../src/notify/channels.js';
import { makeApp, setupAdmin } from '../helpers.js';

describe('backup status', () => {
  it('shows the last round, and tells once when backups stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-backup-'));
    const t = await makeApp();
    t.ctx.config.dataDir = dir;
    await setupAdmin(t);
    expect(await t.json('GET', '/api/backup/status')).toMatchObject({ status: null });
    const sent: { title: string }[] = [];
    let channels = 1;
    const notifier = { notify: async (n: { title: string }) => (sent.push(n), { sent: channels, failed: [] }) } as unknown as Notifier;
    const write = (s: object) => writeFileSync(join(dir, 'backup-status.json'), JSON.stringify(s));

    write({ ok: true, at: new Date(t.clock.now).toISOString(), file: 'burrow-x.tar.gz.enc', bytes: 1234, count: 3, remote: false, error: null });
    expect(await t.json('GET', '/api/backup/status')).toMatchObject({ status: { ok: true, bytes: 1234, count: 3 } });
    expect(await checkBackups(t.ctx, notifier)).toBeNull();

    // Three days later, no newer one: told once. While no channel took it,
    // it is said again the next hour (AUDIT2 MON-22: it was marked told and never came).
    t.advance(3 * 86_400_000);
    channels = 0;
    expect(await checkBackups(t.ctx, notifier)).toBeNull();
    channels = 1;
    expect(await checkBackups(t.ctx, notifier)).toMatch(/last one/);
    expect(await checkBackups(t.ctx, notifier)).toBeNull();
    // A failed round: told, with its error.
    write({ ok: false, at: new Date(t.clock.now).toISOString(), file: null, bytes: null, count: null, remote: null, error: 'disk full' });
    expect(await checkBackups(t.ctx, notifier)).toMatch(/disk full/);
    expect(sent).toHaveLength(3);
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks the backup service for one now, and offers the newest archive for download', async () => {
    // Reported (445f22): no way to make one now or to download one.
    const dir = mkdtempSync(join(tmpdir(), 'burrow-backup-'));
    const archives = mkdtempSync(join(tmpdir(), 'burrow-archives-'));
    const t = await makeApp();
    t.ctx.config.dataDir = dir;
    t.ctx.config.backupDir = archives;
    await setupAdmin(t);
    // No service has ever run: asking would wait for nothing.
    expect((await t.request('POST', '/api/backup/now')).statusCode).toBe(409);
    expect(await t.json('GET', '/api/backup/status')).toMatchObject({ requestedAt: null, download: null });
    expect((await t.request('GET', '/api/backup/download')).statusCode).toBe(404);

    writeFileSync(join(dir, 'backup-status.json'), JSON.stringify({ ok: true, at: new Date(t.clock.now).toISOString(), file: 'burrow-20261007T080000Z.tar.gz.enc', bytes: 5, count: 2, remote: false, error: null }));
    const asked = (await t.json('POST', '/api/backup/now')) as { requestedAt: string };
    expect(readFileSync(join(dir, 'backup-request'), 'utf8').trim()).toBe(asked.requestedAt);
    // Asked again before the service took it: the same request, not a second one.
    t.advance(1000);
    expect(await t.json('POST', '/api/backup/now')).toEqual(asked);
    expect(await t.json('GET', '/api/backup/status')).toMatchObject({ requestedAt: asked.requestedAt });

    writeFileSync(join(archives, 'burrow-20261006T080000Z.tar.gz.enc'), 'older');
    writeFileSync(join(archives, 'burrow-20261007T080000Z.tar.gz.enc'), 'newer');
    writeFileSync(join(archives, 'burrow-20261007T080000Z.tar.gz.enc.sha256'), 'sum');
    writeFileSync(join(archives, 'notes.txt'), 'not a backup');
    expect(await t.json('GET', '/api/backup/status')).toMatchObject({ download: { file: 'burrow-20261007T080000Z.tar.gz.enc', bytes: 5 } });
    const res = await t.request('GET', '/api/backup/download');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('newer');
    expect(res.headers['content-disposition']).toBe('attachment; filename="burrow-20261007T080000Z.tar.gz.enc"');
    expect(existsSync(join(dir, 'backup-request'))).toBe(true);
    await t.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(archives, { recursive: true, force: true });
  });
});
