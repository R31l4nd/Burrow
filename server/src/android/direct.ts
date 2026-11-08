import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { effectiveConnection, type DirectCache, type DeviceHostResult } from '@burrow/shared';
import { audit } from '../audit.js';
import { hostDefaults } from '../hosts/defaults.js';
import type { Ctx } from '../context.js';
import { appSettings, deviceHosts, devices, hosts, snippets } from '../db/schema.js';
import { getHost, groupMap, listHosts, resolveTarget } from '../hosts/service.js';
import { listHistory } from '../history/service.js';
import { requireStepUp } from '../auth/sessions.js';
import { actor, HttpError, idParam, parse, requireAuth } from '../http.js';
import { authorizedKeysCommand, exec, keysLock, openSsh, type SshTarget } from '../ssh/connect.js';
import { storedKeys } from '../ssh/knownhosts.js';

// The Android app's direct SSH route (phase 5): when Burrow cannot be
// reached, the phone connects to a host itself with its own key. That key is
// made in the phone's Keystore and never leaves it; Burrow only puts the
// public half on the hosts the user picks, and hands the phone a cache of
// what it needs offline (addresses, host keys, snippets, history). Never
// Burrow's own keys or passwords.

const HISTORY_PER_HOST = 300;
const TYPE = 'ecdsa-sha2-nistp256';

function sshString(buf: Buffer, at: number): { value: Buffer; next: number } | null {
  if (at + 4 > buf.length) return null;
  const len = buf.readUInt32BE(at);
  if (at + 4 + len > buf.length) return null;
  return { value: buf.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

/** "ecdsa-sha2-nistp256 AAAA..." (a comment is dropped), checked field by field; else null. */
export function parseDevicePublicKey(line: string): string | null {
  const [type, b64] = line.trim().split(/\s+/);
  if (type !== TYPE || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const blob = Buffer.from(b64, 'base64');
  const t = sshString(blob, 0);
  const curve = t && sshString(blob, t.next);
  const point = curve && sshString(blob, curve.next);
  if (!t || !curve || !point || point.next !== blob.length) return null;
  if (t.value.toString() !== TYPE || curve.value.toString() !== 'nistp256') return null;
  if (point.value.length !== 65 || point.value[0] !== 4) return null;
  return `${TYPE} ${b64}`;
}

/** The comment that marks this phone's line in authorized_keys. */
export const marker = (deviceId: number) => `burrow-direct:${deviceId}:`;

export function keyLine(deviceId: number, deviceName: string, key: string): string {
  const name = deviceName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'phone';
  return `${key} ${marker(deviceId)}${name}`;
}

/**
 * Removes every line of this phone from authorized_keys, keeping the rest.
 * The new file replaces the old one only when grep read all of it (exit 0,
 * or 1 when no line is left): a grep that failed half way (a full disk)
 * must never leave the person locked out with half a file. A symlinked
 * file (keys managed elsewhere) is written where it points. A subshell:
 * its early exit (no file yet) must not end a command it is part of, such
 * as the install that follows it. Its own staging file (mktemp), not a
 * fixed name another change could be writing too (AUDIT2 MON-02).
 */
export function removeKeyCommand(deviceId: number): string {
  const m = ` ${marker(deviceId)}`;
  return '( ' + [
    'f="$HOME/.ssh/authorized_keys"',
    '[ -f "$f" ] || exit 0',
    '{ [ ! -L "$f" ] || f="$(readlink -f "$f")"; }',
    'umask 077',
    't="$(mktemp "$f.burrow-XXXXXX")"',
    `if { grep -vF '${m}' "$f"; [ $? -le 1 ]; } > "$t" && chmod 600 "$t"; then mv "$t" "$f"; else rm -f "$t"; exit 1; fi`,
  ].join(' && ') + ' )';
}

/** A change to authorized_keys on that account, one at a time (keysLock). */
async function onTarget(ctx: Ctx, target: SshTarget, command: string): Promise<void> {
  await keysLock(target, async () => {
    const conn = await openSsh(ctx, target);
    if (!('client' in conn)) throw new Error('message' in conn ? conn.message : `host key: ${conn.status}`);
    try {
      const r = await exec(conn.client, command, 20_000);
      if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `exit ${r.code}`);
    } finally {
      conn.client.end();
    }
  });
}

const onHost = async (ctx: Ctx, hostId: number, command: string): Promise<void> => onTarget(ctx, resolveTarget(ctx, hostId), command);

type Device = typeof devices.$inferSelect;

function installCommand(d: Device): string {
  if (!d.sshPublicKey) throw new Error('This phone has no SSH key yet; open the app once.');
  // Old lines first: the key may have changed (the app was reinstalled).
  // Only when they are off does the new one go on: an old key left beside
  // a new one reported as installed stayed valid (AUDIT2 MON-03).
  return `${removeKeyCommand(d.id)} && ${authorizedKeysCommand(keyLine(d.id, d.name, d.sshPublicKey))}`;
}

/**
 * The phone's key onto a host, noted on its grant. `grant`: made now (the
 * host was chosen); else only an existing grant is noted, so a grant taken
 * away meanwhile does not come back (AUDIT2 AUTH-03).
 */
async function install(ctx: Ctx, d: Device, hostId: number, grant = false): Promise<void> {
  await onHost(ctx, hostId, installCommand(d));
  const g = and(eq(deviceHosts.deviceId, d.id), eq(deviceHosts.hostId, hostId));
  if (grant) ctx.db.insert(deviceHosts).values({ deviceId: d.id, hostId, installedAt: ctx.now(), installedKey: d.sshPublicKey }).onConflictDoUpdate({ target: [deviceHosts.deviceId, deviceHosts.hostId], set: { installedKey: d.sshPublicKey } }).run();
  else ctx.db.update(deviceHosts).set({ installedKey: d.sshPublicKey }).where(g).run();
}

const result = (ctx: Ctx, hostId: number, err?: unknown): DeviceHostResult => ({
  hostId,
  hostName: (() => {
    try {
      return getHost(ctx, hostId).name;
    } catch {
      return String(hostId);
    }
  })(),
  ok: !err,
  ...(err ? { message: (err as Error).message } : {}),
});

// Keys that could not come off a host (it was unreachable): kept apart from
// the grants, and taken off when the host answers again. The grant itself
// goes at once, so nothing (a new key the phone reports) puts the key back
// (AUDIT2 AUTH-03).
const PENDING_KEY = 'direct_key_removals';
type PendingRemoval = { deviceId: number; hostId: number };
export function pendingKeyRemovals(ctx: Ctx): PendingRemoval[] {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, PENDING_KEY)).get();
  return row ? (JSON.parse(row.value) as PendingRemoval[]) : [];
}
function setPending(ctx: Ctx, list: PendingRemoval[]): void {
  const value = JSON.stringify(list);
  ctx.db.insert(appSettings).values({ key: PENDING_KEY, value, updatedAt: ctx.now() }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ctx.now() } }).run();
}

/** Takes the phone's key off every host it is on; returns the hosts where that failed (taken off later). */
export async function removeDeviceEverywhere(ctx: Ctx, deviceId: number): Promise<DeviceHostResult[]> {
  const rows = ctx.db.select().from(deviceHosts).where(eq(deviceHosts.deviceId, deviceId)).all();
  ctx.db.delete(deviceHosts).where(eq(deviceHosts.deviceId, deviceId)).run();
  return removeKeys(ctx, deviceId, rows);
}

/** The grants of a user's phones, gone at once; their keys to take off after (removeKeys). */
export function takeGrants(ctx: Ctx, deviceIds: number[]): { deviceId: number; hostId: number }[] {
  const rows = deviceIds.flatMap((id) => ctx.db.select().from(deviceHosts).where(eq(deviceHosts.deviceId, id)).all());
  for (const id of deviceIds) ctx.db.delete(deviceHosts).where(eq(deviceHosts.deviceId, id)).run();
  return rows;
}

/** A phone's key off these hosts; the ones where that failed are kept to try again. */
export async function removeKeys(ctx: Ctx, deviceId: number, rows: { hostId: number }[]): Promise<DeviceHostResult[]> {
  const out = await Promise.all(
    rows.map(async (r) => {
      try {
        await onHost(ctx, r.hostId, removeKeyCommand(deviceId));
        return result(ctx, r.hostId);
      } catch (err) {
        return result(ctx, r.hostId, err);
      }
    }),
  );
  const failed = out.filter((r) => !r.ok);
  if (failed.length) setPending(ctx, [...pendingKeyRemovals(ctx).filter((p) => p.deviceId !== deviceId), ...failed.map((f) => ({ deviceId, hostId: f.hostId }))]);
  return failed;
}

/**
 * Before a host entry goes, or after it came to point at another account
 * (`target`: the one it pointed at): every phone key off that account, and
 * the grants gone. A key that cannot come off cannot be taken off later
 * either (no host, or one that is now another account): those phones are
 * returned, to be said (AUDIT2 MON-01). Returns the phones that had a grant.
 */
export async function keysOffHost(ctx: Ctx, hostId: number, target: SshTarget | null): Promise<{ deviceIds: number[]; left: string[] }> {
  const deviceIds = ctx.db.select().from(deviceHosts).where(eq(deviceHosts.hostId, hostId)).all().map((g) => g.deviceId);
  const ids = [...new Set([...deviceIds, ...pendingKeyRemovals(ctx).filter((p) => p.hostId === hostId).map((p) => p.deviceId)])];
  if (!ids.length) return { deviceIds, left: [] };
  let left: number[] = [];
  try {
    if (!target) throw new Error('no connection');
    await onTarget(ctx, target, ids.map(removeKeyCommand).join(' && '));
  } catch {
    left = ids;
  }
  ctx.db.delete(deviceHosts).where(eq(deviceHosts.hostId, hostId)).run();
  setPending(ctx, pendingKeyRemovals(ctx).filter((p) => p.hostId !== hostId));
  const names = new Map(ctx.db.select({ id: devices.id, name: devices.name }).from(devices).all().map((d) => [d.id, d.name]));
  return { deviceIds, left: left.map((id) => names.get(id) ?? `#${id}`) };
}

/** The phones' keys onto a host again (its account changed); returns the phones where that failed. */
export async function keysOnHost(ctx: Ctx, hostId: number, deviceIds: number[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of deviceIds) {
    const d = ctx.db.select().from(devices).where(eq(devices.id, id)).get();
    if (!d?.sshPublicKey) continue;
    await install(ctx, d, hostId, true).catch(() => failed.push(d.name));
  }
  return failed;
}

/** Keys still to take off: tried again (now and then, and at start). */
export async function retryKeyRemovals(ctx: Ctx): Promise<void> {
  for (const p of pendingKeyRemovals(ctx)) {
    try {
      await onHost(ctx, p.hostId, removeKeyCommand(p.deviceId));
      setPending(ctx, pendingKeyRemovals(ctx).filter((x) => !(x.deviceId === p.deviceId && x.hostId === p.hostId)));
    } catch {
      // Still unreachable: next time. A host that is gone is dropped.
      if (!ctx.db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, p.hostId)).get()) setPending(ctx, pendingKeyRemovals(ctx).filter((x) => x.hostId !== p.hostId));
    }
  }
}

export function registerDirectRoutes(app: FastifyInstance, ctx: Ctx): void {
  const retry = () => void retryKeyRemovals(ctx).catch((err: Error) => ctx.log.warn(`direct route: removing old keys: ${err.message}`));
  setTimeout(retry, 60_000).unref();
  setInterval(retry, 60 * 60_000).unref();
  const ownDevice = (userId: number, id: number): Device => {
    const d = ctx.db.select().from(devices).where(and(eq(devices.id, id), eq(devices.userId, userId))).get();
    if (!d) throw new HttpError(404, 'not_found');
    return d;
  };
  const currentDevice = (req: Parameters<typeof requireAuth>[0]): Device => {
    const a = requireAuth(req);
    if (!a.session.deviceId) throw new HttpError(403, 'not_a_device', 'Only the paired app can do this.');
    return ownDevice(a.user.id, a.session.deviceId);
  };
  const enabled = (deviceId: number) =>
    ctx.db.select({ hostId: deviceHosts.hostId }).from(deviceHosts).where(eq(deviceHosts.deviceId, deviceId)).all().map((r) => r.hostId);

  /**
   * The app reports its SSH key (at every start; a no-op when unchanged). A
   * new key (the app was reinstalled) replaces the old one on its hosts, after
   * a fresh step-up: a stolen device cookie put its own key on every granted
   * host (A3-SRV-03). The same key again (a host that missed it) needs none.
   */
  app.put('/api/account/devices/current/ssh-key', { config: { auth: 'user' } }, async (req) => {
    const d = currentDevice(req);
    const key = parseDevicePublicKey(parse(z.object({ publicKey: z.string().max(400) }), req.body).publicKey);
    if (!key) throw new HttpError(400, 'invalid_key', 'Expected an ecdsa-sha2-nistp256 public key.');
    // A host that could not take the key last time gets it now (AUDIT2 MON-04).
    const behind = ctx.db.select().from(deviceHosts).where(eq(deviceHosts.deviceId, d.id)).all().filter((g) => g.installedKey !== key).map((g) => g.hostId);
    const changed = key !== d.sshPublicKey;
    if (!changed && !behind.length) return { changed: false, results: [] };
    if (changed) requireStepUp(ctx, req);
    if (changed) {
      ctx.db.update(devices).set({ sshPublicKey: key }).where(eq(devices.id, d.id)).run();
      audit(ctx, actor(req), 'device.ssh_key', d.name, { deviceId: d.id });
    }
    const updated = { ...d, sshPublicKey: key };
    const results = await Promise.all(
      behind.map((h) =>
        install(ctx, updated, h).then(
          () => result(ctx, h),
          (err: unknown) => result(ctx, h, err),
        ),
      ),
    );
    return { changed, results };
  });

  app.get('/api/account/devices/:id/hosts', async (req) => {
    const d = ownDevice(requireAuth(req).user.id, idParam(req));
    return { hasKey: !!d.sshPublicKey, hostIds: enabled(d.id) };
  });

  /**
   * Which hosts this phone may reach directly: its key goes onto the added
   * hosts and off the removed ones, over Burrow's own SSH connection. A host
   * that cannot be reached keeps its old state and is reported.
   */
  app.put('/api/account/devices/:id/hosts', { config: { stepUp: true } }, async (req) => {
    const d = ownDevice(requireAuth(req).user.id, idParam(req));
    const want = new Set(parse(z.object({ hostIds: z.array(z.number().int().positive()).max(500) }), req.body).hostIds);
    for (const h of want) getHost(ctx, h);
    const have = new Set(enabled(d.id));
    const add = [...want].filter((h) => !have.has(h));
    const remove = [...have].filter((h) => !want.has(h));
    const results = await Promise.all([
      ...add.map(async (h) => {
        try {
          await install(ctx, d, h, true);
          return result(ctx, h);
        } catch (err) {
          return result(ctx, h, err);
        }
      }),
      ...remove.map(async (h) => {
        try {
          await onHost(ctx, h, removeKeyCommand(d.id));
          ctx.db.delete(deviceHosts).where(and(eq(deviceHosts.deviceId, d.id), eq(deviceHosts.hostId, h))).run();
          return result(ctx, h);
        } catch (err) {
          return result(ctx, h, err);
        }
      }),
    ]);
    audit(ctx, actor(req), 'device.direct_hosts', d.name, { deviceId: d.id, added: add, removed: remove, failed: results.filter((r) => !r.ok).map((r) => r.hostId) });
    return { hostIds: enabled(d.id), results };
  });

  /**
   * What the app needs when Burrow is out of reach, for this phone's direct
   * hosts only. Host keys come along so the app checks them exactly like
   * Burrow does; no credentials of Burrow's are in here.
   */
  app.get('/api/android/cache', async (req): Promise<DirectCache> => {
    const d = currentDevice(req);
    const ids = new Set(enabled(d.id));
    const groups = groupMap(ctx);
    const all = hostDefaults(ctx);
    const hostList = listHosts(ctx)
      .filter((h) => ids.has(h.id))
      .map((h) => {
        const eff = effectiveConnection(h, groups, all);
        return {
          id: h.id,
          name: h.name,
          address: h.address,
          port: eff.port,
          username: eff.username ?? '',
          groupId: h.groupId,
          favorite: h.favorite,
          color: h.color,
          encoding: eff.encoding,
          hostKeys: storedKeys(ctx, h.address, eff.port).map((k) => ({ keyType: k.keyType, keyB64: k.keyB64, fingerprint: k.fingerprint })),
          history: listHistory(ctx, h.id, HISTORY_PER_HOST).map((e) => ({ command: e.command, count: e.count, lastAt: e.lastAt })),
        };
      });
    const snippetRows = ctx.db.select().from(snippets).all();
    return {
      generatedAt: new Date(ctx.now()).toISOString(),
      deviceId: d.id,
      hosts: hostList,
      snippets: snippetRows
        .filter((s) => !s.hostId || ids.has(s.hostId))
        .map((s) => ({ id: s.id, name: s.name, command: s.command, description: s.description, hostId: s.hostId, groupId: s.groupId })),
      groups: [...groups.values()].map((g) => ({ id: g.id, name: g.name, parentId: g.parentId })),
    };
  });

}
