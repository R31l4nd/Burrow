import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';

// A push as the browser's push service hands it over: opened with the
// device's own keys (RFC 8291, aes128gcm), its VAPID signature checked
// against the key it names. Header and length alone proved nothing
// (AUDIT2 TEST-21).

const unb64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** The text of an aes128gcm push body, with the device's private key (JWK "d") and auth secret. */
export function openPush(body: Buffer, device: { d: string; p256dh: string; auth: string }): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(device.d));
  const uaPublic = unb64u(device.p256dh);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, unb64u(device.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  // The last record: the text, then 0x02, then padding zeros.
  const end = plain.lastIndexOf(2);
  if (end < 0) throw new Error('no record delimiter');
  return plain.subarray(0, end).toString('utf8');
}

/** The claims of a VAPID header ("vapid t=<jwt>, k=<key>") once its signature checks out with its own key; throws when it does not. */
export function vapidClaims(header: string): { aud: string; exp: number; sub: string; key: string } {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  if (!m) throw new Error(`not a VAPID header: ${header.slice(0, 40)}`);
  const [, h, c, sig, k] = m;
  const point = unb64u(k!);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(sig!))) throw new Error('VAPID signature does not verify');
  if (JSON.parse(unb64u(h!).toString()).alg !== 'ES256') throw new Error('not ES256');
  return { ...(JSON.parse(unb64u(c!).toString()) as { aud: string; exp: number; sub: string }), key: k! };
}
