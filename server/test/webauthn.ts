import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// A software passkey for the server's tests: what a phone's authenticator
// does in a WebAuthn ceremony (an ES256 key, "none" attestation, user
// verification), without a browser. The e2e tests use Chrome's virtual
// authenticator instead (e2e/tests/passkey.ts).

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** The bits of CBOR (RFC 8949) a WebAuthn attestation needs: integers, byte and text strings, maps. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: ${typeof v}`);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface CeremonyOptions {
  /** The origin the browser says it ran on; the server's by default. */
  origin?: string;
  /** Whether the person was verified (fingerprint, PIN). */
  verified?: boolean;
  /** Sign with another key than the one registered (a forged assertion). */
  forge?: boolean;
  /** Use this signature counter instead of the next one (a cloned key goes backwards). */
  counter?: number;
}

export class SoftPasskey {
  readonly id = randomBytes(16);
  readonly #key: KeyObject;
  readonly #pub: KeyObject;
  counter = 0;
  userHandle: string | null = null;

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    this.#pub = publicKey;
  }

  get credentialId(): string {
    return b64url(this.id);
  }

  #clientData(type: string, challenge: string, o: CeremonyOptions) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
  }

  #flags(o: CeremonyOptions, extra = 0) {
    return Buffer.from([UP | (o.verified === false ? 0 : UV) | extra]);
  }

  #count(o: CeremonyOptions) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(o.counter ?? this.counter);
    return b;
  }

  /** navigator.credentials.create(), as the JSON the browser posts. */
  create(options: { challenge: string; user: { id: string } }, o: CeremonyOptions = {}) {
    this.userHandle = options.user.id;
    const jwk = this.#pub.export({ format: 'jwk' });
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha256(this.rpId), this.#flags(o, AT), this.#count(o), Buffer.alloc(16), idLen, this.id, cose]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(this.#clientData('webauthn.create', options.challenge, o)), attestationObject: b64url(attestationObject), transports: ['internal'] },
    };
  }

  /** navigator.credentials.get(), as the JSON the browser posts. */
  get(options: { challenge: string }, o: CeremonyOptions = {}) {
    if (o.counter === undefined) this.counter++;
    const clientData = this.#clientData('webauthn.get', options.challenge, o);
    const authData = Buffer.concat([sha256(this.rpId), this.#flags(o), this.#count(o)]);
    const key = o.forge ? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey : this.#key;
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), key);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature), ...(this.userHandle ? { userHandle: this.userHandle } : {}) },
    };
  }
}
