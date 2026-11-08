import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Notice } from '@burrow/shared';
import { pushPayload } from '../../src/notify/push.js';
import { encryptPush, newVapidKeys, vapidHeader } from '../../src/notify/webpush.js';

const u = (s: string) => Buffer.from(s, 'base64url');

describe('Web Push encryption (RFC 8291)', () => {
  it('matches the example in RFC 8291, appendix A', () => {
    const body = encryptPush(
      Buffer.from('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      { asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: u('DGv6ra1nlYgDCS1FRnbzlw') },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('only the device with the private key reads it', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const body = encryptPush(Buffer.from('{"title":"disk full"}'), device.getPublicKey().toString('base64url'), auth.toString('base64url'));
    // As the device does it.
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const shared = device.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), device.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const rec = body.subarray(21 + idlen);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(rec.subarray(rec.length - 16));
    const plain = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
    expect(plain.subarray(0, -1).toString()).toBe('{"title":"disk full"}');
    expect(plain.at(-1)).toBe(2);
    expect(() => encryptPush(Buffer.from('x'), 'short', auth.toString('base64url'))).toThrow('not a push key');
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a claim for the push service, checkable with the public key', () => {
    const keys = newVapidKeys();
    const h = vapidHeader('https://push.example.net/wpush/abc', keys.privatePem, 'https://burrow.example', Date.UTC(2026, 8, 30));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(u(m[2]!).toString()) as { aud: string; exp: number; sub: string };
    expect(claims).toEqual({ aud: 'https://push.example.net', exp: Date.UTC(2026, 8, 30) / 1000 + 12 * 3600, sub: 'https://burrow.example' });
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: u(keys.publicKey).subarray(1, 33).toString('base64url'), y: u(keys.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, u(m[3]!))).toBe(true);
  });
});

describe('what a device is sent', () => {
  it('fits a push service (4096 bytes encrypted), whatever the characters', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    // Log lines in any script: three bytes a character, far over the limit.
    const n: Notice = { topic: 'alerts', title: '\u4e2d'.repeat(300), body: '\u4e2d\u6587 '.repeat(2000), page: '/alerts', priority: 4 };
    const text = pushPayload(n, 'en');
    expect(JSON.parse(text).body.length).toBeGreaterThan(100);
    const body = encryptPush(Buffer.from(text), device.getPublicKey().toString('base64url'), Buffer.alloc(16, 1).toString('base64url'));
    expect(body.length).toBeLessThanOrEqual(4096);
  });
});
