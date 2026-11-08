import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Secrets at rest (SSH private keys, host passwords, TOTP seeds, API keys)
// are sealed with AES-256-GCM. The key is derived from BURROW_SECRET with
// HKDF so any sufficiently long string works as input.
//
// Format: "v1." + base64url(iv[12] | tag[16] | ciphertext). The `context`
// string is bound as additional data, so a ciphertext copied from one column
// into another fails to open.

const VERSION = 'v1';

export class SecretBox {
  readonly #key: Buffer;
  readonly #macKey: Buffer;

  constructor(secret: string | Buffer) {
    const ikm = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
    if (ikm.length < 32) throw new Error('secret must be at least 32 bytes');
    this.#key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'burrow secretbox v1', 32));
    this.#macKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'burrow mac v1', 32));
  }

  /**
   * Deterministic keyed hash, for finding equal secrets (e.g. a repeated
   * command) without storing them in the clear. Separate key from seal().
   */
  mac(text: string, context: string): string {
    return createHmac('sha256', this.#macKey).update(context).update('\0').update(text).digest('hex');
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
  }

  open(sealed: string, context: string): string {
    const [version, body] = sealed.split('.', 2);
    if (version !== VERSION || !body) throw new Error('unsupported ciphertext format');
    const raw = Buffer.from(body, 'base64url');
    if (raw.length < 28) throw new Error('ciphertext too short');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/**
 * Resolve the master secret: BURROW_SECRET, else BURROW_SECRET_FILE, else
 * `<dataDir>/secret.key`, which is created on first start. A key file that
 * others can read is refused rather than silently used.
 */
export function loadMasterSecret(opts: {
  secret: string | undefined;
  secretFile: string | undefined;
  dataDir: string;
  onGenerated?: (path: string) => void;
}): string {
  if (opts.secret) return opts.secret;
  const file = opts.secretFile ?? join(opts.dataDir, 'secret.key');
  if (!existsSync(file)) {
    if (opts.secretFile) throw new Error(`BURROW_SECRET_FILE ${file} does not exist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${randomBytes(48).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    opts.onGenerated?.(file);
  }
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${file} must not be readable by group or others (mode ${mode.toString(8)}); run chmod 600`);
  }
  const value = readFileSync(file, 'utf8').trim();
  if (value.length < 32) throw new Error(`${file} must contain at least 32 characters`);
  return value;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return timingSafeEqual(ab, bb);
}

// Human-friendly code from an alphabet without look-alikes (no 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function humanCode(groups: number, groupLength: number): string {
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    // Rejection sampling keeps the distribution uniform.
    while (s.length < groupLength) {
      const b = randomBytes(1)[0]!;
      if (b < 256 - (256 % ALPHABET.length)) s += ALPHABET[b % ALPHABET.length];
    }
    out.push(s);
  }
  return out.join('-');
}

/** Normalise user input of a human code: case, spaces and dashes don't matter. */
export const normalizeCode = (s: string): string => s.toUpperCase().replace(/[\s-]/g, '');
