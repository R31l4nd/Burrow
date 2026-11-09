import { z } from 'zod';

// Request/response shapes shared by the server and the web client. The server
// validates every request body against these; the client uses the inferred
// types so both sides break at compile time when a shape changes.

export const username = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash and underscore only');

// NIST 800-63B: length over composition rules. 12 is the floor because this
// password guards shell access to every host.
export const password = z.string().min(12).max(256);
export const totpCode = z.string().trim().regex(/^\d{6}$/);
export const recoveryCode = z.string().trim().min(8).max(64);

export const tmuxMode = z.enum(['auto', 'always', 'never']);
export type TmuxMode = z.infer<typeof tmuxMode>;

export const authMethod = z.enum(['key', 'password']);
export type AuthMethod = z.infer<typeof authMethod>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const port = z.number().int().min(1).max(65535);

// Connection settings that a group can hand down to its hosts. Every field is
// nullable: null means "inherit from the parent group, or use the built-in
// default".
export const connectionDefaults = z.object({
  port: port.nullable().optional(),
  username: optionalText(64),
  authMethod: authMethod.nullable().optional(),
  keyId: z.number().int().positive().nullable().optional(),
  startupCommand: optionalText(1024),
  tmux: tmuxMode.nullable().optional(),
  term: optionalText(64),
  encoding: optionalText(32),
});
export type ConnectionDefaults = z.infer<typeof connectionDefaults>;

export const groupInput = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.number().int().positive().nullable().optional(),
  defaults: connectionDefaults.default({}),
});
export type GroupInput = z.infer<typeof groupInput>;

export const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.:_[\]-]+$/, 'hostname or IP address');

export const hostInput = connectionDefaults.extend({
  name: z.string().trim().min(1).max(80),
  address: hostname,
  groupId: z.number().int().positive().nullable().optional(),
  // Write-only: never returned by the API. Empty string clears it, undefined
  // leaves the stored value alone.
  password: z.string().max(1024).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  icon: optionalText(40),
  favorite: z.boolean().default(false),
  /** Wake-on-LAN: a MAC address of its own (empty: the one Burrow learned), and who sends the packet (null: a host that is up, nearest first). Left out: kept as stored. */
  wakeMac: z.union([z.literal(''), z.string().trim().regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, 'Not a MAC address (aa:bb:cc:dd:ee:ff).')]).nullable().optional(),
  wakeVia: z.union([z.literal('burrow'), z.number().int().positive()]).nullable().optional(),
});
export type HostInput = z.infer<typeof hostInput>;

export interface Group {
  id: number;
  name: string;
  parentId: number | null;
  defaults: ConnectionDefaults;
  sort: number;
}

export interface HostFacts {
  os: string | null;
  kernel: string | null;
  shell: string | null;
  hasTmux: boolean;
  hasDocker: boolean;
  // Absent on facts detected before phase 2.
  hasShellIntegration?: boolean;
  /** The MAC address of the default route's interface (Wake-on-LAN). */
  mac?: string | null;
  /** A Proxmox VE node (qm or pct there): its guests on its page. Absent before 1.26.0. */
  proxmox?: boolean;
  checkedAt: string;
}

export interface Host {
  id: number;
  name: string;
  address: string;
  groupId: number | null;
  port: number | null;
  username: string | null;
  authMethod: AuthMethod | null;
  keyId: number | null;
  hasPassword: boolean;
  startupCommand: string | null;
  tmux: TmuxMode | null;
  term: string | null;
  encoding: string | null;
  tags: string[];
  color: string | null;
  icon: string | null;
  favorite: boolean;
  lastUsedAt: string | null;
  facts: HostFacts | null;
  /** Wake-on-LAN: its own MAC address (null: facts.mac), and who sends the packet: a host, Burrow itself, or null (a host that is up). */
  wakeMac: string | null;
  wakeVia: number | 'burrow' | null;
}

export interface HostStatus {
  hostId: number;
  reachable: boolean;
  latencyMs: number | null;
  checkedAt: string;
}

export const keyGenerateInput = z.object({
  name: z.string().trim().min(1).max(80),
  comment: z.string().trim().max(120).optional(),
});

export const keyImportInput = z.object({
  name: z.string().trim().min(1).max(80),
  privateKey: z.string().min(1).max(20000),
  passphrase: z.string().max(1024).optional(),
});

export interface SshKey {
  id: number;
  name: string;
  type: string;
  fingerprint: string;
  publicKey: string;
  createdAt: string;
}

export interface KnownHost {
  id: number;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  addedAt: string;
}

// Result of a connection attempt. `unknown_host_key` and `host_key_mismatch`
// carry the fingerprint so the UI can show it; trust is a separate, explicit
// call.
export type ConnectResult =
  | { status: 'ok'; facts: HostFacts }
  | { status: 'unknown_host_key'; keyType: string; fingerprint: string }
  | {
      status: 'host_key_mismatch';
      keyType: string;
      fingerprint: string;
      knownFingerprint: string;
    }
  | { status: 'auth_failed'; message: string }
  | { status: 'unreachable'; message: string }
  | { status: 'error'; message: string };

export const trustInput = z.object({
  fingerprint: z.string().min(10).max(200),
});

export const installKeyInput = z.object({
  keyId: z.number().int().positive(),
  password: z.string().min(1).max(1024),
});

export const importPreviewInput = z.object({
  text: z.string().max(200_000),
});

export interface ImportCandidate {
  alias: string;
  address: string;
  port: number | null;
  username: string | null;
  identityFile: string | null;
  // Vault key whose name matches the IdentityFile basename, if any.
  matchedKeyId: number | null;
  // An existing host with the same address+port+user.
  duplicateOf: number | null;
}

export const importApplyInput = z.object({
  groupId: z.number().int().positive().nullable().optional(),
  entries: z
    .array(
      z.object({
        alias: z.string().trim().min(1).max(80),
        address: hostname,
        port: port.nullable(),
        username: z.string().trim().max(64).nullable(),
        keyId: z.number().int().positive().nullable(),
      }),
    )
    .max(500),
});

export type Role = 'admin' | 'operator';

export interface AuthState {
  setupRequired: boolean;
  user: null | {
    id: number;
    username: string;
    role: Role;
    hasPasskey: boolean;
    hasTotp: boolean;
    hasPassword: boolean;
    /** Linked to the single sign-on provider (it can confirm step-ups). */
    hasSso: boolean;
    // Set while the setup wizard has created the account but no login method
    // has been registered yet.
    incomplete: boolean;
  };
  stepUpUntil: string | null;
  // The paired Android device this session belongs to, if any: the app can
  // then confirm with a fingerprint instead of a passkey or code.
  deviceId: number | null;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface PasskeyInfo {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  username: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface ApiError {
  error: string;
  message?: string;
}

// ---- users (phase 11)

export interface UserSummary {
  id: number;
  username: string;
  role: Role;
  /** Invited, still setting up a way to sign in. */
  incomplete: boolean;
  passkeys: number;
  /** Password with an authenticator app. */
  password: boolean;
  /** Linked to the single sign-on provider. */
  sso: boolean;
  email: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface Invite {
  id: number;
  role: Role;
  createdAt: string;
  expiresAt: string;
  /** Only when just made: the link to send. */
  url: string | null;
}

export interface OidcSettings {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  /** On the sign-in button: "Sign in with ...". */
  label: string;
  /** Which claim finds the Burrow account the first time. */
  claim: 'preferred_username' | 'email';
  /** To enter at the provider. */
  redirectUri: string;
}

// Burrow updating itself (Settings -> About; server/src/selfupdate.ts).
export interface UpdateTarget {
  hostId: number;
  hostName: string;
  dir: string;
  container: string;
  service: string;
  /** Its compose project and files (from the container's labels): the update uses exactly those. */
  project?: string | null;
  configFiles?: string[];
}

export interface LastUpdate {
  state: 'running' | 'done' | 'rolledback' | 'failed';
  at: string;
  /** What happened, for the page to say in its language (absent before 1.2). */
  code?: string;
  message: string;
}

export interface UpdateCheck {
  target: UpdateTarget | null;
  running: string;
  mode: 'git' | 'image' | null;
  /** The version the folder would start (git), or null when it cannot tell (image). */
  available: string | null;
  /** Commits the checkout is behind its upstream, or null without one. */
  behind: number | null;
  subject: string | null;
  last: LastUpdate | null;
  problem: string | null;
  /** "### Breaking" items of the CHANGELOG between the running version and this one ("1.5.0: text"). */
  breaking: string[];
  /** The image Burrow's container was started with (image mode). */
  image: string | null;
  /** Its tag does not reach `available` (ghcr.io/...:2.21 for 2.22.0): the tag that does, to set in .env. */
  pinned: { image: string; next: string } | null;
}
