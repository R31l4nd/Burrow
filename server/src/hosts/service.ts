import { eq, inArray } from 'drizzle-orm';
import {
  effectiveConnection,
  type ConnectionDefaults,
  type Group,
  type GroupInput,
  type Host,
  type HostFacts,
  type HostInput,
} from '@burrow/shared';
import { hostDefaults } from './defaults.js';
import type { Ctx } from '../context.js';
import { commandSchedules, hostGroups, hosts, hostTags, reportSchedules, sshKeys, uploads } from '../db/schema.js';
import { HttpError } from '../http.js';
import { unsealKey } from '../keys/vault.js';
import { forgetLimits } from './limits.js';
import type { SshTarget } from '../ssh/connect.js';

const PASSWORD_CONTEXT = 'hosts.password';

type HostRow = typeof hosts.$inferSelect;

// ------------------------------------------------------------------ groups

const toGroup = (r: typeof hostGroups.$inferSelect): Group => ({
  id: r.id,
  name: r.name,
  parentId: r.parentId,
  defaults: JSON.parse(r.defaults) as ConnectionDefaults,
  sort: r.sort,
});

/** Names as people read them: xl-2 before xl-19, "alpha" beside "Alpha" (SQLite ordered bytes, A3-WEB-11). */
const NAME_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byOrder = <T extends { sort: number; name: string }>(a: T, b: T) => a.sort - b.sort || NAME_ORDER.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export const listGroups = (ctx: Ctx): Group[] => ctx.db.select().from(hostGroups).all().sort(byOrder).map(toGroup);

export const groupMap = (ctx: Ctx): Map<number, Group> => new Map(listGroups(ctx).map((g) => [g.id, g]));

export function assertKeyExists(ctx: Ctx, keyId: number | null | undefined) {
  if (keyId == null) return;
  if (!ctx.db.select({ id: sshKeys.id }).from(sshKeys).where(eq(sshKeys.id, keyId)).get()) {
    throw new HttpError(400, 'unknown_key');
  }
}

function assertGroupExists(ctx: Ctx, groupId: number | null | undefined) {
  if (groupId == null) return;
  if (!ctx.db.select({ id: hostGroups.id }).from(hostGroups).where(eq(hostGroups.id, groupId)).get()) {
    throw new HttpError(400, 'unknown_group');
  }
}

export function createGroup(ctx: Ctx, input: GroupInput): Group {
  assertGroupExists(ctx, input.parentId);
  assertKeyExists(ctx, input.defaults.keyId);
  const row = ctx.db
    .insert(hostGroups)
    .values({ name: input.name, parentId: input.parentId ?? null, defaults: JSON.stringify(input.defaults), sort: 0 })
    .returning()
    .get();
  return toGroup(row);
}

export function updateGroup(ctx: Ctx, id: number, input: GroupInput): Group {
  const groups = groupMap(ctx);
  if (!groups.has(id)) throw new HttpError(404, 'not_found');
  assertGroupExists(ctx, input.parentId);
  assertKeyExists(ctx, input.defaults.keyId);
  // Refuse to make a group its own ancestor.
  for (let p = input.parentId ?? null; p !== null; p = groups.get(p)?.parentId ?? null) {
    if (p === id) throw new HttpError(400, 'group_cycle', 'A group cannot be inside itself.');
  }
  const row = ctx.db
    .update(hostGroups)
    .set({ name: input.name, parentId: input.parentId ?? null, defaults: JSON.stringify(input.defaults) })
    .where(eq(hostGroups.id, id))
    .returning()
    .get()!;
  return toGroup(row);
}

/** Delete a group; its hosts and subgroups move up to its parent. */
export function deleteGroup(ctx: Ctx, id: number): Group {
  const g = groupMap(ctx).get(id);
  if (!g) throw new HttpError(404, 'not_found');
  ctx.db.transaction((tx) => {
    tx.update(hosts).set({ groupId: g.parentId }).where(eq(hosts.groupId, id)).run();
    tx.update(hostGroups).set({ parentId: g.parentId }).where(eq(hostGroups.parentId, id)).run();
    tx.delete(hostGroups).where(eq(hostGroups.id, id)).run();
  });
  return g;
}

// ------------------------------------------------------------------ hosts

function tagsByHost(ctx: Ctx, ids?: number[]): Map<number, string[]> {
  const rows = ids
    ? ids.length
      ? ctx.db.select().from(hostTags).where(inArray(hostTags.hostId, ids)).all()
      : []
    : ctx.db.select().from(hostTags).all();
  const m = new Map<number, string[]>();
  for (const r of rows) m.set(r.hostId, [...(m.get(r.hostId) ?? []), r.tag]);
  for (const v of m.values()) v.sort();
  return m;
}

const toHost = (r: HostRow, tags: string[]): Host => ({
  id: r.id,
  name: r.name,
  address: r.address,
  groupId: r.groupId,
  port: r.port,
  username: r.username,
  authMethod: r.authMethod,
  keyId: r.keyId,
  hasPassword: r.passwordEnc !== null,
  startupCommand: r.startupCommand,
  tmux: r.tmux,
  term: r.term,
  encoding: r.encoding,
  tags,
  color: r.color,
  icon: r.icon,
  favorite: r.favorite,
  lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
  facts: r.facts ? (JSON.parse(r.facts) as HostFacts) : null,
  wakeMac: r.wakeMac,
  wakeVia: r.wakeVia === 'burrow' ? 'burrow' : r.wakeVia ? Number(r.wakeVia) : null,
});

export function listHosts(ctx: Ctx): Host[] {
  const tags = tagsByHost(ctx);
  return ctx.db
    .select()
    .from(hosts)
    .all()
    .sort(byOrder)
    .map((r) => toHost(r, tags.get(r.id) ?? []));
}

function hostRow(ctx: Ctx, id: number): HostRow {
  const r = ctx.db.select().from(hosts).where(eq(hosts.id, id)).get();
  if (!r) throw new HttpError(404, 'not_found');
  return r;
}

export function getHost(ctx: Ctx, id: number): Host {
  return toHost(hostRow(ctx, id), tagsByHost(ctx, [id]).get(id) ?? []);
}

const normalizeTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

function hostValues(ctx: Ctx, input: HostInput) {
  assertGroupExists(ctx, input.groupId);
  assertKeyExists(ctx, input.keyId);
  return {
    name: input.name,
    address: input.address,
    groupId: input.groupId ?? null,
    port: input.port ?? null,
    username: input.username || null,
    authMethod: input.authMethod ?? null,
    keyId: input.keyId ?? null,
    startupCommand: input.startupCommand || null,
    tmux: input.tmux ?? null,
    term: input.term || null,
    encoding: input.encoding || null,
    color: input.color ?? null,
    icon: input.icon || null,
    favorite: input.favorite,
    // Left out (an older client, an import): kept as stored.
    ...(input.wakeMac !== undefined ? { wakeMac: input.wakeMac ? input.wakeMac.toLowerCase().replace(/-/g, ':') : null } : {}),
    ...(input.wakeVia !== undefined ? { wakeVia: input.wakeVia === null ? null : String(input.wakeVia) } : {}),
  };
}

function writeTags(ctx: Ctx, hostId: number, tags: string[]) {
  ctx.db.delete(hostTags).where(eq(hostTags.hostId, hostId)).run();
  for (const tag of normalizeTags(tags)) ctx.db.insert(hostTags).values({ hostId, tag }).run();
}

const sealPassword = (ctx: Ctx, pw: string | undefined): string | null | undefined =>
  pw === undefined ? undefined : pw === '' ? null : ctx.box.seal(pw, PASSWORD_CONTEXT);

export function createHost(ctx: Ctx, input: HostInput): Host {
  const now = ctx.now();
  const id = ctx.db.transaction((tx) => {
    const row = tx
      .insert(hosts)
      .values({
        ...hostValues(ctx, input),
        passwordEnc: sealPassword(ctx, input.password) ?? null,
        sort: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: hosts.id })
      .get();
    writeTags(ctx, row.id, input.tags);
    return row.id;
  });
  return getHost(ctx, id);
}

export function updateHost(ctx: Ctx, id: number, input: HostInput): Host {
  const existing = hostRow(ctx, id);
  const pw = sealPassword(ctx, input.password);
  // A changed address invalidates what we learned about the old one.
  const facts = existing.address !== input.address || existing.port !== (input.port ?? null) ? null : existing.facts;
  ctx.db.transaction((tx) => {
    tx.update(hosts)
      .set({ ...hostValues(ctx, input), ...(pw !== undefined ? { passwordEnc: pw } : {}), facts, updatedAt: ctx.now() })
      .where(eq(hosts.id, id))
      .run();
    writeTags(ctx, id, input.tags);
  });
  return getHost(ctx, id);
}

// What names a host by its id without a foreign key: SQLite gives the next host the id of the
// newest one deleted, and a schedule then ran its command there (audit 2026-11-09).
const withoutHost = (json: string, id: number) => JSON.stringify((JSON.parse(json) as number[]).filter((x) => x !== id));

export function deleteHost(ctx: Ctx, id: number): Host {
  const h = getHost(ctx, id);
  ctx.db.transaction((tx) => {
    tx.delete(hosts).where(eq(hosts.id, id)).run();
    for (const s of tx.select().from(commandSchedules).all()) {
      if ((JSON.parse(s.hostIds) as number[]).includes(id)) tx.update(commandSchedules).set({ hostIds: withoutHost(s.hostIds, id) }).where(eq(commandSchedules.id, s.id)).run();
    }
    for (const s of tx.select().from(reportSchedules).all()) {
      if (s.hostIds && (JSON.parse(s.hostIds) as number[]).includes(id)) tx.update(reportSchedules).set({ hostIds: withoutHost(s.hostIds, id) }).where(eq(reportSchedules.id, s.id)).run();
    }
    tx.update(hosts).set({ wakeVia: null }).where(eq(hosts.wakeVia, String(id))).run();
    tx.delete(uploads).where(eq(uploads.hostId, id)).run();
  });
  forgetLimits(ctx, id);
  return h;
}

export function copyHost(ctx: Ctx, id: number): Host {
  const r = hostRow(ctx, id);
  const tags = tagsByHost(ctx, [id]).get(id) ?? [];
  const now = ctx.now();
  const { id: _omit, ...rest } = r;
  void _omit;
  const row = ctx.db
    .insert(hosts)
    .values({ ...rest, name: `${r.name} (copy)`, favorite: false, lastUsedAt: null, createdAt: now, updatedAt: now })
    .returning({ id: hosts.id })
    .get();
  writeTags(ctx, row.id, tags);
  return getHost(ctx, row.id);
}

export function setFacts(ctx: Ctx, id: number, facts: HostFacts): void {
  ctx.db.update(hosts).set({ facts: JSON.stringify(facts) }).where(eq(hosts.id, id)).run();
}

export function touchHost(ctx: Ctx, id: number): void {
  ctx.db.update(hosts).set({ lastUsedAt: ctx.now() }).where(eq(hosts.id, id)).run();
}

/** The stored password in the clear, for typing it into a session. */
export function hostPassword(ctx: Ctx, id: number): string | null {
  const r = hostRow(ctx, id);
  return r.passwordEnc ? ctx.box.open(r.passwordEnc, PASSWORD_CONTEXT) : null;
}

export function clearHostPassword(ctx: Ctx, id: number): Host {
  hostRow(ctx, id);
  ctx.db.update(hosts).set({ passwordEnc: null, updatedAt: ctx.now() }).where(eq(hosts.id, id)).run();
  return getHost(ctx, id);
}

export function useKeyForHost(ctx: Ctx, id: number, keyId: number): void {
  ctx.db.update(hosts).set({ keyId, authMethod: 'key', updatedAt: ctx.now() }).where(eq(hosts.id, id)).run();
}

/**
 * Everything needed to open a connection, with inheritance applied and
 * secrets decrypted. Throws a 400 describing what is missing.
 */
export function resolveTarget(ctx: Ctx, id: number, override?: { password: string }): SshTarget {
  const r = hostRow(ctx, id);
  const eff = effectiveConnection(toHost(r, []), groupMap(ctx), hostDefaults(ctx));
  if (!eff.username) throw new HttpError(400, 'no_username', 'Set a user on the host or its group.');
  if (override) {
    return { host: r.address, port: eff.port, username: eff.username, auth: { type: 'password', password: override.password } };
  }
  const method = eff.authMethod ?? (eff.keyId ? 'key' : r.passwordEnc ? 'password' : null);
  if (method === 'key') {
    if (!eff.keyId) throw new HttpError(400, 'no_key', 'Choose a key for this host or its group.');
    const key = unsealKey(ctx, eff.keyId);
    if (!key) throw new HttpError(400, 'no_key');
    return { host: r.address, port: eff.port, username: eff.username, auth: { type: 'key', ...key } };
  }
  if (method === 'password') {
    if (!r.passwordEnc) throw new HttpError(400, 'no_password', 'No password is stored for this host.');
    return {
      host: r.address,
      port: eff.port,
      username: eff.username,
      auth: { type: 'password', password: ctx.box.open(r.passwordEnc, PASSWORD_CONTEXT) },
    };
  }
  throw new HttpError(400, 'no_credentials', 'Choose a key or store a password for this host.');
}
