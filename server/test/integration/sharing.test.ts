import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthState, ConnectResult, Host, Invite, Recording, SharedSession, TerminalSessionInfo } from '@burrow/shared';
import { users } from '../../src/db/schema.js';
import { makeApp, openTerminal, setupAdmin, waitForText, type TestApp } from '../helpers.js';

// A terminal session shared read-only with another Burrow user, and its
// output recorded on request (F3), against the test sshd.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;
let adminCookie: string | null;
let opCookie: string | null;
let opId: number;

beforeAll(async () => {
  // Recordings go in the data volume: a folder of this test's own.
  t = await makeApp({ env: { BURROW_DATA_DIR: mkdtempSync(join(tmpdir(), 'burrow-rec-')) } });
  t.clock.now = Date.now();
  await setupAdmin(t);
  adminCookie = t.cookie;
  h = await t.json<Host>('POST', '/api/hosts', { name: 'share-host', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password', tmux: 'never' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  // An operator, finished as the setup would (its sign-in methods are another test's).
  const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
  t.cookie = null;
  const state = await t.json<AuthState>('POST', `/api/invites/${inv.url!.split('/').pop()!}/accept`, { username: 'olivia' });
  opId = state.user!.id;
  t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, opId)).run();
  opCookie = t.cookie;
  t.cookie = adminCookie;
}, 30_000);
afterAll(async () => {
  await t.close();
});

describe('a shared session (F3)', () => {
  it('watched read-only by the person it is shared with only; recorded on request; unshared ends the watching', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: h.id, tmux: 'never' });
    expect(s).toMatchObject({ sharedWith: [], recording: false });
    const own = await openTerminal(t, s.id);
    await own.waitFor((m) => m.t === 'snapshot');

    // Not shared yet: the operator sees nothing of it.
    t.cookie = opCookie;
    expect(await t.json<SharedSession[]>('GET', '/api/terminal/shared')).toEqual([]);
    const early = await openTerminal(t, s.id, { watch: true });
    expect(await early.waitFor((m) => m.t === 'exit')).toMatchObject({ reason: 'ended' });
    // Nor may an operator share or record it.
    expect((await t.request('PUT', `/api/terminal/sessions/${s.id}/share`, { userIds: [opId] })).statusCode).toBe(403);
    expect((await t.request('GET', '/api/recordings')).statusCode).toBe(403);
    t.cookie = adminCookie;

    expect(await t.json<TerminalSessionInfo>('PUT', `/api/terminal/sessions/${s.id}/share`, { userIds: [opId, opId, 9999] })).toMatchObject({ sharedWith: [opId] });
    t.cookie = opCookie;
    expect(await t.json<SharedSession[]>('GET', '/api/terminal/shared')).toEqual([{ id: s.id, hostName: 'share-host', title: null, owner: 'admin', recording: false }]);
    const watcher = await openTerminal(t, s.id, { watch: true });
    t.cookie = adminCookie;
    await watcher.waitFor((m) => m.t === 'snapshot');
    // The owner sees who watches.
    await own.waitFor((m) => m.t === 'viewers' && m.viewers.some((v) => v.watching === 'olivia'));

    // What the owner types, the watcher sees; what the watcher sends goes nowhere.
    own.send({ t: 'input', d: 'echo shared-$((40+2))\r' });
    await waitForText(watcher, 'shared-42');
    watcher.send({ t: 'input', d: 'echo from-watcher-$((1+1))\r' });
    watcher.send({ t: 'resize', cols: 40, rows: 10, active: true });
    own.send({ t: 'input', d: 'echo after-$((2+3))\r' });
    await waitForText(own, 'after-5');
    expect(own.text()).not.toContain('from-watcher-2');
    expect((await t.json<TerminalSessionInfo>('GET', `/api/terminal/sessions/${s.id}`)).cols).not.toBe(40);

    // Recording: said to every viewer; what is shown meanwhile is in the file.
    await t.json('PUT', `/api/terminal/sessions/${s.id}/recording`, { on: true });
    await watcher.waitFor((m) => m.t === 'recording' && m.on);
    own.send({ t: 'input', d: 'echo rec-$((6*7))\r' });
    await waitForText(own, 'rec-42');
    await new Promise((r) => setTimeout(r, 300));
    await t.json('PUT', `/api/terminal/sessions/${s.id}/recording`, { on: false });
    const list = await t.json<Recording[]>('GET', '/api/recordings');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: s.id, hostName: 'share-host', user: 'admin', truncated: false });
    expect(list[0]!.endedAt).not.toBeNull();
    const cast = await t.request('GET', `/api/recordings/${list[0]!.id}/cast`);
    expect(cast.statusCode).toBe(200);
    const lines = cast.body.trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: 2, width: expect.any(Number), height: expect.any(Number) });
    expect(lines.slice(1).map((l) => JSON.parse(l) as [number, string, string]).some(([, k, d]) => k === 'o' && d.includes('rec-42'))).toBe(true);
    // Typed keys are not in it as keys: only the screen.
    expect(lines.some((l) => l.includes('"i"'))).toBe(false);

    // Unshared: the watcher goes at once, and the list is empty again.
    await t.json('PUT', `/api/terminal/sessions/${s.id}/share`, { userIds: [] });
    expect(await watcher.closed).toBe(4003);
    t.cookie = opCookie;
    expect(await t.json<SharedSession[]>('GET', '/api/terminal/shared')).toEqual([]);
    t.cookie = adminCookie;

    // A recording is removed by hand.
    expect((await t.request('DELETE', `/api/recordings/${list[0]!.id}`)).statusCode).toBe(204);
    expect(await t.json<Recording[]>('GET', '/api/recordings')).toEqual([]);
    own.close();
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  }, 60_000);

  it('an operator watching stays through the minute sweep while it is shared (A3-SRV-06)', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: h.id, tmux: 'never' });
    const own = await openTerminal(t, s.id);
    await own.waitFor((m) => m.t === 'snapshot');
    await t.json('PUT', `/api/terminal/sessions/${s.id}/share`, { userIds: [opId] });
    const watcher = await openTerminal(t, s.id, { watch: true, cookie: opCookie });
    await watcher.waitFor((m) => m.t === 'snapshot');
    let code: number | null = null;
    void watcher.closed.then((c) => (code = c));
    t.sweepSockets();
    own.send({ t: 'input', d: 'echo swept-$((40+3))\r' });
    await waitForText(watcher, 'swept-43');
    expect(code).toBeNull();
    watcher.close();
    own.close();
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  }, 30_000);

  it('the stored password is not typed while the session is shared or recorded (A3-SRV-19)', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: h.id, tmux: 'never' });
    const own = await openTerminal(t, s.id);
    await own.waitFor((m) => m.t === 'snapshot');
    await t.json('PUT', `/api/terminal/sessions/${s.id}/share`, { userIds: [opId] });
    own.send({ t: 'password' });
    await own.waitFor((m) => m.t === 'notice' && m.code === 'password_refused');
    await t.json('PUT', `/api/terminal/sessions/${s.id}/share`, { userIds: [] });
    await t.json('PUT', `/api/terminal/sessions/${s.id}/recording`, { on: true });
    own.send({ t: 'password' });
    await new Promise((r) => setTimeout(r, 300));
    expect(own.messages.filter((m) => m.t === 'notice' && m.code === 'password_refused')).toHaveLength(2);
    await t.json('PUT', `/api/terminal/sessions/${s.id}/recording`, { on: false });
    own.send({ t: 'password' });
    await own.waitFor((m) => m.t === 'notice' && m.code === 'password_sent');
    own.close();
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  }, 30_000);
});
