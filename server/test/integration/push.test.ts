import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Channel, PushDevice } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Burrow's own push: a device turns it on, a "push" channel sends to it, the
// push service gets it encrypted for that device only, and a device the
// service no longer knows is removed.

const device = createECDH('prime256v1');
device.generateKeys();
const auth = Buffer.alloc(16, 9);

function open(body: Buffer): unknown {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]!);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), device.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', device.computeSecret(asPublic), auth, info, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const rec = body.subarray(21 + body[20]!);
  const d = createDecipheriv('aes-128-gcm', key, nonce);
  d.setAuthTag(rec.subarray(rec.length - 16));
  const plain = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, -1).toString());
}

const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
let answer = 201;
let t: TestApp;

beforeAll(async () => {
  t = await makeApp({
    send: {
      fetch: async (url, init) => {
        sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: Buffer.from(init!.body as Uint8Array) });
        return new Response(null, { status: answer });
      },
    },
  });
  await setupAdmin(t);
});
afterAll(async () => {
  await t.close();
});

describe("Burrow's own push", () => {
  it('reaches a device, encrypted for it, in its language', async () => {
    const { publicKey } = await t.json<{ publicKey: string }>('GET', '/api/push/key');
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    // A test with no device yet says so.
    expect((await t.request('POST', '/api/push/test')).statusCode).toBe(409);

    const d = await t.json<PushDevice>('POST', '/api/push/devices', {
      kind: 'unifiedpush',
      label: 'Pixel',
      endpoint: 'https://push.example.net/up/abc',
      p256dh: device.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
      lang: 'nl',
    });
    expect(await t.json<PushDevice[]>('GET', '/api/push/devices')).toEqual([d]);

    const c = await t.json<Channel>('POST', '/api/channels', { kind: 'push', name: 'Burrow', enabled: true, topics: ['alerts'], lang: 'en' });
    expect(c.push).toEqual({ devices: 1 });
    await t.json('POST', `/api/channels/${c.id}/test`);
    const m = sent.at(-1)!;
    expect(m.url).toBe('https://push.example.net/up/abc');
    expect(m.headers['content-encoding']).toBe('aes128gcm');
    expect(m.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    // Only the device reads it: in Dutch, with the page to open.
    expect(open(m.body)).toMatchObject({ title: 'Burrow-test', page: '/settings?s=channels', topic: 'test' });
    expect(m.body.includes(Buffer.from('Burrow'))).toBe(false);
  });

  it('a device the push service no longer knows is removed', async () => {
    answer = 410;
    expect((await t.request('POST', '/api/push/test')).statusCode).toBe(502);
    expect(await t.json<PushDevice[]>('GET', '/api/push/devices')).toEqual([]);
    answer = 201;
  });
});
