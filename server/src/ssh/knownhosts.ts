import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { KnownHost } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { knownHosts } from '../db/schema.js';

// Trust on first use. The first connection to host:port shows the key's
// fingerprint and stops; only an explicit trust stores it. After that any
// different key, including one of another type, is a hard block until an
// admin deletes the stored entry.

/** Key type from an SSH wire-format public key blob (first length-prefixed string). */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const len = blob.readUInt32BE(0);
  if (len > 64 || 4 + len > blob.length) return 'unknown';
  return blob.subarray(4, 4 + len).toString('ascii');
}

/** OpenSSH-style fingerprint: SHA256:<base64 without padding>. */
export const fingerprintOf = (blob: Buffer): string =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

export type HostKeyVerdict =
  | { kind: 'trusted' }
  | { kind: 'unknown'; keyType: string; fingerprint: string }
  | { kind: 'mismatch'; keyType: string; fingerprint: string; knownFingerprint: string };

export function judgeHostKey(ctx: Ctx, host: string, port: number, blob: Buffer): HostKeyVerdict {
  const keyType = keyTypeOf(blob);
  const fingerprint = fingerprintOf(blob);
  const rows = storedKeys(ctx, host, port);
  if (rows.length === 0) return { kind: 'unknown', keyType, fingerprint };
  const same = rows.find((r) => r.keyType === keyType);
  if (same && same.keyB64 === blob.toString('base64')) return { kind: 'trusted' };
  return { kind: 'mismatch', keyType, fingerprint, knownFingerprint: (same ?? rows[0]!).fingerprint };
}

export function storedKeys(ctx: Ctx, host: string, port: number) {
  return ctx.db
    .select()
    .from(knownHosts)
    .where(and(eq(knownHosts.host, host.toLowerCase()), eq(knownHosts.port, port)))
    .all();
}

export function trustHostKey(ctx: Ctx, host: string, port: number, blob: Buffer): KnownHost {
  const row = ctx.db
    .insert(knownHosts)
    .values({
      host: host.toLowerCase(),
      port,
      keyType: keyTypeOf(blob),
      keyB64: blob.toString('base64'),
      fingerprint: fingerprintOf(blob),
      addedAt: ctx.now(),
    })
    .returning()
    .get();
  return toKnownHost(row);
}

export const toKnownHost = (r: typeof knownHosts.$inferSelect): KnownHost => ({
  id: r.id,
  host: r.host,
  port: r.port,
  keyType: r.keyType,
  fingerprint: r.fingerprint,
  addedAt: new Date(r.addedAt).toISOString(),
});

export const listKnownHosts = (ctx: Ctx): KnownHost[] =>
  ctx.db.select().from(knownHosts).orderBy(knownHosts.host, knownHosts.port).all().map(toKnownHost);

/** Host-key algorithms to offer first so the server presents the key we already trust. */
export function preferredHostKeyAlgorithms(types: string[]): string[] {
  const out: string[] = [];
  for (const t of types) {
    if (t === 'ssh-rsa') out.push('rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa');
    else out.push(t);
  }
  return out;
}
