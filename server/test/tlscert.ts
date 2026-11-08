import { generateKeyPairSync, sign } from 'node:crypto';

// A self-signed certificate made in the test itself (EC P-256), valid until
// a given day: the test image has no openssl. DER by hand: SEQUENCE, INTEGER,
// OID, UTCTime and the rest of what a certificate needs.

const len = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const oid = (bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const utc = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};

const ECDSA_SHA256 = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
const name = (cn: string) => seq(tlv(0x31, seq(oid([0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from(cn)))));

/** PEM key and certificate for `cn`, valid from a day ago until `notAfter`. */
export function selfSigned(notAfter: Date, cn = 'burrow-test'): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([1])),
    ECDSA_SHA256,
    name(cn),
    seq(utc(new Date(Date.now() - 86_400_000)), utc(notAfter)),
    name(cn),
    spki,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = (label: string, b: Buffer) => `-----BEGIN ${label}-----\n${b.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END ${label}-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: pem('CERTIFICATE', der) };
}
