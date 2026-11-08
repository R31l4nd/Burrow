import type { FastifyInstance } from 'fastify';
import { guestAddress, guestParams, GUEST_ACTIONS, parsePctList, parseQmList, type GuestAction, type GuestKind, type GuestList } from '@burrow/shared';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import type { SftpPool } from '../files/pool.js';
import { getHost } from '../hosts/service.js';
import { actor, HttpError, idParam, parse } from '../http.js';
import { exec } from '../ssh/connect.js';

// Proxmox VE guests of a node (F5), with the node's own qm and pct over SSH:
// as root, or through `sudo -n` for a user allowed them without a password.
// No API token is stored. Listing is for everyone who sees the host;
// starting and stopping changes the host, so it takes an admin's step-up
// and goes in the audit log.

const NO_PVE = 3;
const NO_ROOT = 4;
// Root runs them as they are; anyone else through sudo without a password,
// tried once with a harmless call so a refusal is said, not an empty list.
const AS_ROOT = `{ command -v qm || command -v pct; } >/dev/null 2>&1 || exit ${NO_PVE}; if [ "$(id -u)" = 0 ]; then S=; elif sudo -n qm list >/dev/null 2>&1 || sudo -n pct list >/dev/null 2>&1; then S='sudo -n'; else echo 'needs root, or sudo without a password for qm and pct' >&2; exit ${NO_ROOT}; fi;`;
const tool = (kind: GuestKind) => (kind === 'vm' ? 'qm' : 'pct');

// Both lists in one round trip, each under its own marker with its exit
// code: a node with containers only (or VMs only) still lists those.
const LIST = `${AS_ROOT} for t in qm pct; do echo "@@burrow-pve $t"; if command -v $t >/dev/null 2>&1; then $S $t list 2>&1; echo "@@burrow-exit $?"; else echo "@@burrow-exit 127"; fi; done`;

function parseList(out: string): GuestList {
  const guests = [];
  const errors: string[] = [];
  for (const part of out.split('@@burrow-pve ').slice(1)) {
    const name = part.slice(0, part.indexOf('\n')).trim();
    const body = part.slice(part.indexOf('\n') + 1);
    const m = /@@burrow-exit (\d+)\s*$/.exec(body);
    const text = m ? body.slice(0, m.index) : body;
    const code = m ? Number(m[1]) : -1;
    if (code === 127) continue;
    if (code !== 0) {
      errors.push(`${name}: ${text.trim().split('\n').pop() || `exited with ${code}`}`);
      continue;
    }
    guests.push(...(name === 'qm' ? parseQmList(text) : parsePctList(text)));
  }
  return { guests: guests.sort((a, b) => a.vmid - b.vmid), error: errors.length ? errors.join('; ') : null };
}

function hostFailure(err: unknown): never {
  throw new HttpError(502, 'host_unreachable', (err as Error).message);
}

export function registerProxmoxRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool): void {
  app.get('/api/hosts/:id/guests', { config: { auth: 'user' } }, async (req): Promise<GuestList> => {
    const hostId = idParam(req);
    getHost(ctx, hostId);
    const r = await pool.with(hostId, ({ client }) => exec(client, LIST, 30_000, 1 << 20)).catch(hostFailure);
    if (r.code === NO_PVE) throw new HttpError(422, 'no_proxmox', 'This host has neither qm nor pct: not a Proxmox VE node.');
    if (r.code === NO_ROOT) throw new HttpError(403, 'pve_no_root', 'Listing the guests needs root, or sudo without a password for qm and pct.');
    if (!r.stdout.includes('@@burrow-pve')) throw new HttpError(502, 'host_failed', (r.stderr || r.stdout).trim().split('\n').pop() || `exited with ${r.code}`);
    return parseList(r.stdout);
  });

  app.post('/api/hosts/:id/guests/:kind/:vmid/:action', { config: { stepUp: true } }, async (req) => {
    const { id, kind, vmid } = parse(guestParams, req.params);
    const { action } = parse(z.object({ action: z.enum(GUEST_ACTIONS) }), req.params);
    const host = getHost(ctx, id);
    // A clean shutdown gets two minutes before qm/pct give up; a stop is at once.
    // `qm shutdown <vmid> --timeout 120`: the guest's number first, as qm and pct read their arguments.
    const opts: Record<GuestAction, string> = { start: '', shutdown: ' --timeout 120', stop: '', reboot: '' };
    const cmd = `${AS_ROOT} $S ${tool(kind)} ${action} ${vmid}${opts[action]}`;
    const r = await pool.with(id, ({ client }) => exec(client, cmd, 180_000, 1 << 16)).catch(hostFailure);
    audit(ctx, actor(req), `pve.${action}`, host.name, { kind, vmid, ok: r.code === 0 });
    if (r.code === NO_PVE) throw new HttpError(422, 'no_proxmox', 'This host has neither qm nor pct: not a Proxmox VE node.');
    if (r.code === NO_ROOT) throw new HttpError(403, 'pve_no_root', 'Starting and stopping guests needs root, or sudo without a password for qm and pct.');
    if (r.code !== 0) throw new HttpError(502, 'pve_failed', (r.stderr || r.stdout).trim().split('\n').pop() || `${tool(kind)} exited with ${r.code}`);
    return { ok: true };
  });

  // Where a guest can be reached, to add it as a host: asked when someone
  // adds one, not for every guest in the list.
  app.get('/api/hosts/:id/guests/:kind/:vmid/address', async (req): Promise<{ address: string | null }> => {
    const { id, kind, vmid } = parse(guestParams, req.params);
    getHost(ctx, id);
    const cmd =
      kind === 'ct'
        ? `${AS_ROOT} $S pct config ${vmid} 2>/dev/null; echo @@burrow-live; $S pct exec ${vmid} -- hostname -I 2>/dev/null`
        : `${AS_ROOT} echo @@burrow-live; $S qm guest cmd ${vmid} network-get-interfaces 2>/dev/null`;
    const r = await pool.with(id, ({ client }) => exec(client, cmd, 30_000, 1 << 18)).catch(hostFailure);
    if (r.code === NO_PVE) throw new HttpError(422, 'no_proxmox', 'This host has neither qm nor pct: not a Proxmox VE node.');
    if (r.code === NO_ROOT) throw new HttpError(403, 'pve_no_root', 'Needs root, or sudo without a password for qm and pct.');
    const at = r.stdout.indexOf('@@burrow-live');
    return { address: at < 0 ? null : guestAddress(kind, r.stdout.slice(0, at), r.stdout.slice(at + '@@burrow-live'.length)) };
  });
}
