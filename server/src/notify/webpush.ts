import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';

// Web Push without a library: the message encrypted for one device (RFC
// 8291, "aes128gcm" from RFC 8188) and the server's signed claim who sends
// it (VAPID, RFC 8292). The same for a browser (its push service) and for
// the Android app through UnifiedPush: both hand Burrow an address, a public
// key and a secret, and only that device can read what goes there.

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

/** For tests: the server's one-off key pair and the salt, else random. */
export interface EncryptFixed {
  asPrivate: Buffer;
  salt: Buffer;
}

/** The body for one push message: header (salt, record size, the server's one-off key) and the encrypted record. */
export function encryptPush(plaintext: Buffer, uaPublicB64: string, authB64: string, fixed?: EncryptFixed): Buffer {
  const uaPublic = unb64u(uaPublicB64);
  const auth = unb64u(authB64);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error('not a push key (p256dh 65 bytes, auth 16)');
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);
  // RFC 8291 section 3.4: the device's secret mixed in, then RFC 8188's keys.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  // One record, the last: the text, then the delimiter 0x02.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, record]);
}

/** The server's VAPID key pair: the private key as PEM (kept sealed), the public key as the browser wants it. */
export function newVapidKeys(): { privatePem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: vapidPublicKey(privateKey) };
}

/** The uncompressed public point (65 bytes), base64url: applicationServerKey for a browser. */
export function vapidPublicKey(privateKey: KeyObject | string): string {
  const jwk = createPublicKey(typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey).export({ format: 'jwk' });
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)]));
}

/** "vapid t=..., k=...": a signed claim for the push service at `endpoint`, valid 12 hours. */
export function vapidHeader(endpoint: string, privatePem: string, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const part = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(privatePem), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapidPublicKey(privatePem)}`;
}
