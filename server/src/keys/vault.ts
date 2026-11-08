import { eq } from 'drizzle-orm';
import ssh2, { type ParsedKey } from 'ssh2';
import type { SshKey } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { hostDefaults } from '../hosts/defaults.js';
import { hostGroups, hosts, sshKeys } from '../db/schema.js';
import { HttpError } from '../http.js';
import { fingerprintOf } from '../ssh/knownhosts.js';

// The key vault. Private keys and their passphrases are sealed with the
// master key; the public half is stored in the clear so it can be shown and
// installed without decrypting anything.

const PRIVATE_CONTEXT = 'ssh_keys.private_key';
const PASSPHRASE_CONTEXT = 'ssh_keys.passphrase';

const toSshKey = (r: typeof sshKeys.$inferSelect): SshKey => ({
  id: r.id,
  name: r.name,
  type: r.type,
  fingerprint: r.fingerprint,
  publicKey: r.publicKey,
  createdAt: new Date(r.createdAt).toISOString(),
});

const safeComment = (s: string) => s.replace(/[^\w@.:-]/g, '_').slice(0, 120);

function publicLine(parsed: ParsedKey, comment: string): string {
  const blob = parsed.getPublicSSH();
  return `${parsed.type} ${blob.toString('base64')}${comment ? ` ${safeComment(comment)}` : ''}`;
}

function assertUniqueName(ctx: Ctx, name: string) {
  if (ctx.db.select({ id: sshKeys.id }).from(sshKeys).where(eq(sshKeys.name, name)).get()) {
    throw new HttpError(409, 'name_taken', 'A key with this name already exists.');
  }
}

export function listKeys(ctx: Ctx): SshKey[] {
  return ctx.db.select().from(sshKeys).orderBy(sshKeys.name).all().map(toSshKey);
}

/**
 * ssh2's generator drops a leading zero byte of the public key in about one
 * in 200 keys, which yields a key nobody can parse. Generate until the key
 * parses, has a 32-byte public half and signs verifiably.
 */
export function generateEd25519(comment: string, attempts = 20): { pair: { private: string; public: string }; parsed: ParsedKey } {
  const probe = Buffer.from('burrow key check');
  for (let i = 0; i < attempts; i++) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', { comment });
    const parsed = ssh2.utils.parseKey(pair.private);
    if (parsed instanceof Error) continue;
    // Wire format: string "ssh-ed25519" (4+11) + string key (4+32) = 51 bytes.
    if (parsed.getPublicSSH().length !== 51) continue;
    if (!parsed.verify(probe, parsed.sign(probe))) continue;
    return { pair, parsed };
  }
  throw new Error('could not generate a valid ed25519 key');
}

export function generateKey(ctx: Ctx, name: string, comment?: string): SshKey {
  assertUniqueName(ctx, name);
  const c = safeComment(comment || `burrow-${name}`);
  const { pair, parsed } = generateEd25519(c);
  const row = ctx.db
    .insert(sshKeys)
    .values({
      name,
      type: parsed.type,
      publicKey: publicLine(parsed, c),
      fingerprint: fingerprintOf(parsed.getPublicSSH()),
      privateKeyEnc: ctx.box.seal(pair.private, PRIVATE_CONTEXT),
      passphraseEnc: null,
      createdAt: ctx.now(),
    })
    .returning()
    .get();
  return toSshKey(row);
}

export function importKey(ctx: Ctx, name: string, privateKey: string, passphrase?: string): SshKey {
  assertUniqueName(ctx, name);
  const normalized = `${privateKey.replace(/\r\n/g, '\n').trim()}\n`;
  const parsed = ssh2.utils.parseKey(normalized, passphrase || undefined);
  if (parsed instanceof Error) {
    throw new HttpError(400, 'invalid_key', /passphrase|decrypt/i.test(parsed.message) ? 'Wrong or missing passphrase.' : parsed.message);
  }
  if (!parsed.isPrivateKey()) throw new HttpError(400, 'invalid_key', 'This is a public key; paste the private key.');
  const row = ctx.db
    .insert(sshKeys)
    .values({
      name,
      type: parsed.type,
      publicKey: publicLine(parsed, parsed.comment || name),
      fingerprint: fingerprintOf(parsed.getPublicSSH()),
      privateKeyEnc: ctx.box.seal(normalized, PRIVATE_CONTEXT),
      passphraseEnc: passphrase ? ctx.box.seal(passphrase, PASSPHRASE_CONTEXT) : null,
      createdAt: ctx.now(),
    })
    .returning()
    .get();
  return toSshKey(row);
}

export function deleteKey(ctx: Ctx, id: number): SshKey {
  const existing = ctx.db.select().from(sshKeys).where(eq(sshKeys.id, id)).get();
  if (!existing) throw new HttpError(404, 'not_found');
  // Hosts reference the key by foreign key; groups only inside their JSON
  // defaults, so those are checked by hand.
  const users = [
    ...ctx.db.select({ name: hosts.name }).from(hosts).where(eq(hosts.keyId, id)).all(),
    ...ctx.db
      .select()
      .from(hostGroups)
      .all()
      .filter((g) => (JSON.parse(g.defaults) as { keyId?: number | null }).keyId === id)
      .map((g) => ({ name: `group ${g.name}` })),
    ...(hostDefaults(ctx).keyId === id ? [{ name: 'All hosts' }] : []),
  ];
  if (users.length) {
    throw new HttpError(409, 'key_in_use', `Still used by: ${users.map((u) => u.name).join(', ')}`);
  }
  ctx.db.delete(sshKeys).where(eq(sshKeys.id, id)).run();
  return toSshKey(existing);
}

export function getKey(ctx: Ctx, id: number): SshKey | null {
  const r = ctx.db.select().from(sshKeys).where(eq(sshKeys.id, id)).get();
  return r ? toSshKey(r) : null;
}

/** Decrypt a key for use in a connection. Never leaves the server. */
export function unsealKey(ctx: Ctx, id: number): { privateKey: string; passphrase?: string } | null {
  const r = ctx.db.select().from(sshKeys).where(eq(sshKeys.id, id)).get();
  if (!r) return null;
  return {
    privateKey: ctx.box.open(r.privateKeyEnc, PRIVATE_CONTEXT),
    ...(r.passphraseEnc ? { passphrase: ctx.box.open(r.passphraseEnc, PASSPHRASE_CONTEXT) } : {}),
  };
}
