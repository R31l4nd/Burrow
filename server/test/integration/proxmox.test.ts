import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, GuestList, Host } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Proxmox VE guests over SSH (F5): the test sshd has stand-ins for qm and
// pct, allowed to the test user through sudo without a password, whose
// guests keep their state in a file, so a start or stop shows in the next
// list.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;
let h: Host;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'pve-node', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  // Connected once trusted: its facts (Proxmox among them) read.
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
});
afterAll(async () => {
  // Back as they were for the other tests on this sshd.
  await t.request('POST', `/api/hosts/${h.id}/guests/vm/100/start`);
  await t.request('POST', `/api/hosts/${h.id}/guests/ct/200/start`);
  await t.close();
});

describe('Proxmox guests', () => {
  it('the node is known as one, and lists its VMs and containers', async () => {
    const host = await t.json<Host>('GET', `/api/hosts/${h.id}`);
    expect(host.facts?.proxmox).toBe(true);
    const list = await t.json<GuestList>('GET', `/api/hosts/${h.id}/guests`);
    expect(list.error).toBeNull();
    expect(list.guests.map((g) => [g.kind, g.vmid, g.name])).toEqual([
      ['vm', 100, 'burrowtest-vm'],
      ['vm', 101, 'burrowtest-win'],
      ['ct', 200, 'burrowtest-ct'],
    ]);
  });

  it('a stop and a start are seen in the list, and are in the audit log', async () => {
    expect((await t.request('POST', `/api/hosts/${h.id}/guests/ct/200/stop`)).statusCode).toBe(200);
    let list = await t.json<GuestList>('GET', `/api/hosts/${h.id}/guests`);
    expect(list.guests.find((g) => g.vmid === 200)?.status).toBe('stopped');
    expect((await t.request('POST', `/api/hosts/${h.id}/guests/ct/200/start`)).statusCode).toBe(200);
    list = await t.json<GuestList>('GET', `/api/hosts/${h.id}/guests`);
    expect(list.guests.find((g) => g.vmid === 200)?.status).toBe('running');
    const audit = await t.json<{ action: string; target: string | null }[]>('GET', '/api/audit');
    expect(audit.filter((e) => e.action === 'pve.stop' || e.action === 'pve.start').length).toBeGreaterThanOrEqual(2);
  });

  it('a guest the node does not have is an error with what qm said, not a quiet success', async () => {
    const r = await t.request('POST', `/api/hosts/${h.id}/guests/vm/999/start`);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'pve_failed', message: expect.stringContaining('does not exist') });
  });

  it('where a guest is reached: a container by its static address, a VM by its agent, none without one', async () => {
    expect(await t.json('GET', `/api/hosts/${h.id}/guests/ct/200/address`)).toEqual({ address: '10.99.1.200' });
    expect(await t.json('GET', `/api/hosts/${h.id}/guests/vm/100/address`)).toEqual({ address: '10.99.1.100' });
    expect(await t.json('GET', `/api/hosts/${h.id}/guests/vm/101/address`)).toEqual({ address: null });
  });

  it('a guest number out of range or a made-up action is refused before anything runs', async () => {
    expect((await t.request('POST', `/api/hosts/${h.id}/guests/vm/1/start`)).statusCode).toBe(400);
    expect((await t.request('POST', `/api/hosts/${h.id}/guests/vm/100/destroy`)).statusCode).toBe(400);
    expect((await t.request('POST', `/api/hosts/${h.id}/guests/xx/100/start`)).statusCode).toBe(400);
  });
});
