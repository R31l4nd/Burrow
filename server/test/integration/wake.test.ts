import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, Host, RunResult } from '@burrow/shared';
import { hosts } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Wake-on-LAN: a host that is up (the test sshd) sends the magic packet for
// a sleeping one; a listener on the relay's port 9 catches what it sent.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);
const MAC = '0a:1b:2c:3d:4e:5f';

let t: TestApp;
let relay: Host;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  relay = await t.json<Host>('POST', '/api/hosts', { name: 'relay', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${relay.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${relay.id}/trust`, { fingerprint: r.fingerprint });
});
afterAll(async () => {
  await t.close();
});

const sh = async (command: string) => (await t.json<RunResult[]>('POST', '/api/snippets/run', { command, hostIds: [relay.id] }))[0]!;

describe('Wake-on-LAN', () => {
  it('sends the magic packet from a host that is up', async () => {
    const sleeper = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: '192.0.2.50', username: 'me' });
    // Without a known MAC address: said so.
    expect((await t.request('POST', `/api/hosts/${sleeper.id}/wake`, { relayId: relay.id })).json()).toMatchObject({ error: 'no_mac' });
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ os: null, kernel: null, shell: null, hasTmux: false, hasDocker: false, mac: MAC, checkedAt: new Date().toISOString() }) }).where(eq(hosts.id, sleeper.id)).run();
    // A listener on the relay (port 9 needs root: sudo with the test password).
    const listen = `use IO::Socket::INET; my $s=IO::Socket::INET->new(LocalPort=>9,Proto=>"udp",ReuseAddr=>1) or die $!; $s->recv(my $p,200); open(my $f,">","/tmp/wol.hex"); print $f unpack("H*",$p);`;
    await sh(`rm -f /tmp/wol.hex; echo burrow-test-password | sudo -S sh -c 'timeout 20 perl -e '\\''${listen}'\\'' </dev/null >/dev/null 2>&1 &' 2>/dev/null; sleep 1`);
    const r = await t.json<{ relay: string }>('POST', `/api/hosts/${sleeper.id}/wake`, { relayId: relay.id });
    expect(r.relay).toBe('relay');
    let got = '';
    for (let i = 0; i < 20 && !got; i++) {
      got = (await sh('cat /tmp/wol.hex 2>/dev/null')).stdout.trim();
      if (!got) await new Promise((res) => setTimeout(res, 250));
    }
    expect(got).toBe('ff'.repeat(6) + MAC.replace(/:/g, '').repeat(16));
  });
});

// Not Wake-on-LAN, but the same throwaway host: sshd allows 10 channels on
// one connection, and a host's pooled connection is shared by everything.
describe('a shared connection', () => {
  it('runs more commands at once than sshd has channels, by waiting for one', async () => {
    const { exec } = await import('../../src/ssh/connect.js');
    const runs = await t.files.with(relay.id, ({ client }) => Promise.all(Array.from({ length: 14 }, (_, i) => exec(client, `sleep 1; echo run-${i}`, 30_000))));
    expect(runs.map((r) => r.stdout.trim())).toEqual(Array.from({ length: 14 }, (_, i) => `run-${i}`));
  }, 60_000);
});
