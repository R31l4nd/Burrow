import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import type { Host } from '@burrow/shared';
import { magicPacket, sendFromBurrow } from '../../src/hosts/wake.js';
import { makeApp, setupAdmin } from '../helpers.js';

// Wake-on-LAN chosen per host (2.11.0): Burrow itself, one host, or a host
// that is up; a MAC address of its own over the one learned.
const MAC = '0a:1b:2c:3d:4e:5f';

describe('Wake-on-LAN from Burrow itself', () => {
  it('the magic packet: six 0xff, then the address sixteen times', () => {
    expect(magicPacket(MAC).toString('hex')).toBe('ff'.repeat(6) + '0a1b2c3d4e5f'.repeat(16));
    expect(() => magicPacket('nope')).toThrow('not a MAC address');
  });

  it('is sent over UDP from Burrow', async () => {
    const s = createSocket('udp4');
    const got = new Promise<Buffer>((res) => s.once('message', (m) => res(m)));
    await new Promise<void>((res) => s.bind(0, '127.0.0.1', () => res()));
    await sendFromBurrow(MAC, '192.0.2.50', s.address().port, ['127.0.0.1']);
    expect((await got).toString('hex')).toBe(magicPacket(MAC).toString('hex'));
    s.close();
  });
});

describe('Wake-on-LAN settings of a host', () => {
  it('kept with the host, a MAC address cleaned; left out by an older client: kept as stored; a wrong one refused', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const relay = await t.json<Host>('POST', '/api/hosts', { name: 'relay', address: '192.0.2.10' });
    const nas = await t.json<Host>('POST', '/api/hosts', { name: 'nas', address: '192.0.2.50', wakeMac: '0A-1B-2C-3D-4E-5F', wakeVia: relay.id });
    expect(nas).toMatchObject({ wakeMac: MAC, wakeVia: relay.id });
    // An older client (an import, the app before 2.11.0) sends neither.
    const again = await t.json<Host>('PUT', `/api/hosts/${nas.id}`, { name: 'nas', address: '192.0.2.50' });
    expect(again).toMatchObject({ wakeMac: MAC, wakeVia: relay.id });
    expect(await t.json<Host>('PUT', `/api/hosts/${nas.id}`, { name: 'nas', address: '192.0.2.50', wakeMac: '', wakeVia: 'burrow' })).toMatchObject({ wakeMac: null, wakeVia: 'burrow' });
    expect((await t.request('PUT', `/api/hosts/${nas.id}`, { name: 'nas', address: '192.0.2.50', wakeMac: 'aa:bb' })).statusCode).toBe(400);
    // Burrow itself: no other host needed; with no address known, said so first.
    expect((await t.request('POST', `/api/hosts/${nas.id}/wake`)).json()).toMatchObject({ error: 'no_mac' });
    await t.json('PUT', `/api/hosts/${nas.id}`, { name: 'nas', address: '192.0.2.50', wakeMac: MAC, wakeVia: 'burrow' });
    expect(await t.json('POST', `/api/hosts/${nas.id}/wake`)).toEqual({ relay: 'Burrow' });
    const audit = await t.json<{ action: string; target: string | null; detail: Record<string, unknown> | null }[]>('GET', '/api/audit');
    expect(audit.find((e) => e.action === 'host.wake')).toMatchObject({ target: 'nas' });
    // One host chosen that is down: said, not another one used.
    await t.json('PUT', `/api/hosts/${nas.id}`, { name: 'nas', address: '192.0.2.50', wakeVia: relay.id });
    await t.status.checkAll();
    expect((await t.request('POST', `/api/hosts/${nas.id}/wake`)).json()).toMatchObject({ error: 'relay_down', message: "relay is not up to send the wake-up from: choose another in the host's Advanced settings." });
    await t.close();
  });
});
