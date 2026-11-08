import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Group, Host, RunResult, Snippet } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Saved commands: kept per host, per group or for all, and run on several
// hosts at once (on a real host: the integration tests use this route as
// their way to run a command on the test sshd).

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => {
  await t.close();
});

const audits = async () => (await t.json<{ action: string; target: string | null; details: Record<string, unknown> | null }[]>('GET', '/api/audit')).filter((e) => e.action.startsWith('snippet.'));

describe('snippets', () => {
  it('are created, listed by name, changed and removed, each audited by name, never by command', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
    const b = await t.json<Snippet>('POST', '/api/snippets', { name: 'Disk', command: 'df -h', hostId: h.id });
    const a = await t.json<Snippet>('POST', '/api/snippets', { name: 'Backup', command: 'restic backup --password=hunter2', description: 'nightly' });
    expect(b).toEqual({ id: b.id, name: 'Disk', command: 'df -h', description: null, hostId: h.id, groupId: null });
    expect((await t.json<Snippet[]>('GET', '/api/snippets')).map((s) => s.name)).toEqual(['Backup', 'Disk']);

    const changed = await t.json<Snippet>('PUT', `/api/snippets/${a.id}`, { name: 'Backup now', command: 'restic backup', description: null });
    expect(changed).toMatchObject({ id: a.id, name: 'Backup now', command: 'restic backup', description: null });
    expect((await t.request('PUT', '/api/snippets/999', { name: 'x', command: 'y' })).statusCode).toBe(404);

    expect((await t.request('DELETE', `/api/snippets/${b.id}`)).statusCode).toBe(204);
    expect((await t.request('DELETE', `/api/snippets/${b.id}`)).statusCode).toBe(404);
    expect((await t.json<Snippet[]>('GET', '/api/snippets')).map((s) => s.id)).toEqual([a.id]);

    const log = await audits();
    expect(log.map((e) => [e.action, e.target])).toEqual(
      expect.arrayContaining([
        ['snippet.create', 'Disk'],
        ['snippet.create', 'Backup'],
        ['snippet.update', 'Backup now'],
        ['snippet.delete', 'Disk'],
      ]),
    );
    expect(JSON.stringify(log)).not.toContain('hunter2');
  });

  it('belong to one host or one group that exists, never both', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
    const g = await t.json<Group>('POST', '/api/groups', { name: 'Servers' });
    const err = async (body: object) => (await t.request('POST', '/api/snippets', { name: 'x', command: 'id', ...body })).json<{ error: string }>().error;
    expect(await err({ hostId: h.id, groupId: g.id })).toBe('invalid_scope');
    expect(await err({ hostId: 999 })).toBe('unknown_host');
    expect(await err({ groupId: 999 })).toBe('unknown_group');
    expect(await t.json<Snippet>('POST', '/api/snippets', { name: 'x', command: 'id', groupId: g.id })).toMatchObject({ groupId: g.id, hostId: null });
    const s = await t.json<Snippet>('POST', '/api/snippets', { name: 'y', command: 'id' });
    expect((await t.request('PUT', `/api/snippets/${s.id}`, { name: 'y', command: 'id', hostId: 999 })).json()).toMatchObject({ error: 'unknown_host' });
    expect((await t.request('POST', '/api/snippets', { name: ' ', command: 'id' })).statusCode).toBe(400);
  });
});

describe('running a command on several hosts', () => {
  it('needs a fresh step-up, refuses a host that does not exist, and audits the hosts, not the command', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
    expect((await t.request('POST', '/api/snippets/run', { command: 'id', hostIds: [h.id, 999] })).statusCode).toBe(404);
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/snippets/run', { command: 'id', hostIds: [h.id] })).json()).toMatchObject({ error: 'step_up_required' });
    expect(await audits()).toEqual([]);
  });

  it('a host that cannot be reached is an error of its own, once per host however often it is named', async () => {
    // A port that was free a moment ago: refused at once.
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'gone', address: '127.0.0.1', port, username: 'x' });

    const results = await t.json<RunResult[]>('POST', '/api/snippets/run', { command: 'echo secret-token', hostIds: [h.id, h.id] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ hostId: h.id, hostName: 'gone', status: 'error', exitCode: null, stdout: '' });
    expect(results[0]!.stderr).not.toBe('');
    const log = await audits();
    expect(log).toMatchObject([{ action: 'snippet.run', details: { hosts: [h.id] } }]);
    expect(JSON.stringify(log)).not.toContain('secret-token');
  });
});
