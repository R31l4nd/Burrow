import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hadolint } from '../../src/lint/routes.js';
import { makeApp, setupAdmin } from '../helpers.js';

// A stand-in hadolint on PATH, doing what the real one does when it fails.
let dir = '';
let path = '';
const fake = (script: string) => {
  writeFileSync(join(dir, 'hadolint'), `#!/bin/sh\ncat >/dev/null\n${script}\n`);
  chmodSync(join(dir, 'hadolint'), 0o755);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hadolint-'));
  path = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${path}`;
});
afterEach(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

describe('hadolint', () => {
  it('a finding, an exit of 1 with findings, and no findings are what they are', async () => {
    fake(`echo '[{"line":2,"column":1,"level":"warning","code":"DL3008","message":"Pin versions"}]'; exit 1`);
    expect(await hadolint('FROM debian\n')).toEqual([{ line: 2, column: 1, severity: 'warning', message: 'Pin versions', source: 'hadolint', code: 'DL3008' }]);
    fake(`echo '[]'`);
    expect(await hadolint('FROM debian\n')).toEqual([]);
  });

  it('not finishing, failing or a garbled answer is an error, not "no findings" (AUDIT2 FS-21)', async () => {
    fake('sleep 5');
    await expect(hadolint('FROM debian\n', 300)).rejects.toMatchObject({ code: 'lint_timeout' });
    fake(`echo 'hadolint: out of memory' >&2; exit 2`);
    await expect(hadolint('FROM debian\n')).rejects.toMatchObject({ code: 'lint_failed', message: 'hadolint: out of memory' });
    fake(`echo 'not json'`);
    await expect(hadolint('FROM debian\n')).rejects.toMatchObject({ code: 'lint_failed' });
  });
});

describe('POST /api/lint/dockerfile', () => {
  it("gives hadolint's findings for the text sent, and refuses what is too large", async () => {
    fake(`echo '[{"line":1,"column":0,"level":"error","code":"DL3006","message":"Always tag the version"},{"line":3,"column":2,"level":"style","code":"DL3059","message":"Merge RUNs"}]'; exit 1`);
    const t = await makeApp();
    try {
      await setupAdmin(t);
      expect(await t.json('POST', '/api/lint/dockerfile', { content: 'FROM debian\nRUN a\nRUN b\n' })).toEqual([
        { line: 1, column: 1, severity: 'error', message: 'Always tag the version', source: 'hadolint', code: 'DL3006' },
        { line: 3, column: 2, severity: 'info', message: 'Merge RUNs', source: 'hadolint', code: 'DL3059' },
      ]);
      expect((await t.request('POST', '/api/lint/dockerfile', { content: 'x'.repeat(1024 * 1024 + 1) })).statusCode).toBe(413);
    } finally {
      await t.close();
    }
  });
});

describe('POST /api/files/:hostId/compose-check', () => {
  it('a host that cannot be reached is an error, never "valid"; a path must be absolute', async () => {
    const { createServer } = await import('node:net');
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as import('node:net').AddressInfo).port;
    await new Promise((r) => s.close(r));
    const t = await makeApp();
    try {
      await setupAdmin(t);
      const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'gone', address: '127.0.0.1', port, username: 'x', authMethod: 'password', password: 'x' });
      const r = await t.request('POST', `/api/files/${h.id}/compose-check`, { path: '/srv/app/compose.yaml', content: 'services: {}\n' });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: 'unreachable' });
      expect((await t.request('POST', `/api/files/${h.id}/compose-check`, { path: 'compose.yaml', content: '' })).statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('its check file is a write like any other: in a folder whose files grant a shell, a fresh step-up first (audit 2026-11-05)', async () => {
    const t = await makeApp();
    try {
      await setupAdmin(t);
      const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'x', authMethod: 'password', password: 'x' });
      // A host whose SFTP writes nothing: what the route would write is noted.
      const written: string[] = [];
      const sftp = {
        realpath: (p: string, cb: (e: Error | null, r?: string) => void) => cb(null, p),
        writeFile: (p: string, _b: unknown, _o: unknown, cb: (e: Error | null) => void) => (written.push(p), cb(new Error('Permission denied'))),
        unlink: (_p: string, cb: (e: Error | null) => void) => cb(null),
      };
      vi.spyOn(t.files, 'with').mockImplementation((async (_id: number, fn: (c: unknown) => unknown) => fn({ sftp, client: {} })) as never);
      t.advance(16 * 60_000);
      for (const path of ['/etc/cron.d/compose.yaml', '/home/x/.config/systemd/user/compose.yaml']) {
        const r = await t.request('POST', `/api/files/${h.id}/compose-check`, { path, content: 'services: {}\n' });
        expect(r.json(), path).toMatchObject({ error: 'step_up_required' });
      }
      expect(written).toEqual([]);
      // Elsewhere no step-up is asked: the write is tried (and fails here).
      expect((await t.request('POST', `/api/files/${h.id}/compose-check`, { path: '/srv/app/compose.yaml', content: 'services: {}\n' })).json()).toMatchObject({ error: 'sftp_error' });
      expect(written).toEqual([expect.stringMatching(/^\/srv\/app\/\.burrow-check-[0-9a-f]+\.compose\.yaml$/)]);
    } finally {
      await t.close();
    }
  });
});
