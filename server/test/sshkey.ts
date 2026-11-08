import { generateKeyPairSync } from 'node:crypto';

// A P-256 key pair like the Android app's direct-route key: the public half
// as an OpenSSH line, the private half as PEM (ssh2 can log in with it).
export function phoneSshKey(): { line: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, 0].map((_, i) => (b.length >> (24 - 8 * i)) & 255)), b]);
  const blob = Buffer.concat([str(Buffer.from('ecdsa-sha2-nistp256')), str(Buffer.from('nistp256')), str(point)]);
  return { line: `ecdsa-sha2-nistp256 ${blob.toString('base64')}`, privatePem: privateKey.export({ format: 'pem', type: 'sec1' }).toString() };
}
