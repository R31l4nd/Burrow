import { createHmac } from 'node:crypto';

// An authenticator app in the test (RFC 6238: SHA-1, 6 digits, 30 s), so a
// test types a real code into Burrow's own fields.

function base32(s: string): Buffer {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) bits += abc.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(msg).digest();
  const at = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** A code of a time step after `after` (Burrow takes each step once): waits for the next one when needed. */
export async function nextCode(secret: string, after: number | null): Promise<{ code: string; step: number }> {
  let step = Math.floor(Date.now() / 30_000);
  if (after !== null && step <= after) {
    await new Promise((r) => setTimeout(r, (after + 1) * 30_000 - Date.now() + 200));
    step = Math.floor(Date.now() / 30_000);
  }
  return { code: totpCode(secret, step), step };
}
