import { z } from 'zod';

// Proxmox VE guests on a node, over SSH with the node's own tools (qm for
// virtual machines, pct for containers), as root or through sudo without a
// password; no API token (F5). Pure parsing here; the commands are in
// server/src/proxmox.

export type GuestKind = 'vm' | 'ct';

export interface Guest {
  kind: GuestKind;
  vmid: number;
  name: string;
  /** As qm/pct say it: running, stopped, paused, ... */
  status: string;
  /** A lock (backup, migrate, snapshot) keeps actions away until it is gone. */
  lock: string | null;
}

export interface GuestList {
  guests: Guest[];
  /** Why the list could not be read whole (no root, no sudo, a tool missing), or null. */
  error: string | null;
}

export const GUEST_ACTIONS = ['start', 'shutdown', 'stop', 'reboot'] as const;
export type GuestAction = (typeof GUEST_ACTIONS)[number];

export const guestParams = z.object({
  id: z.coerce.number().int().positive(),
  kind: z.enum(['vm', 'ct']),
  vmid: z.coerce.number().int().min(100).max(999_999_999),
});

const VMID = /^\d{3,9}$/;

/**
 * `qm list`: a header, then VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID. Names
 * have no spaces (Proxmox takes DNS names); a line that does not fit is
 * left out, not guessed at.
 */
export function parseQmList(out: string): Guest[] {
  const guests: Guest[] = [];
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || !VMID.test(f[0]!)) continue;
    guests.push({ kind: 'vm', vmid: Number(f[0]), name: f[1]!, status: f[2]!, lock: null });
  }
  return guests;
}

/**
 * `pct list`: a header, then VMID Status Lock Name, where Lock is often
 * empty: three fields are VMID Status Name, four have the lock between.
 */
export function parsePctList(out: string): Guest[] {
  const guests: Guest[] = [];
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || !VMID.test(f[0]!)) continue;
    const [vmid, status, a, b] = f;
    guests.push({ kind: 'ct', vmid: Number(vmid), name: b ?? a!, status: status!, lock: b !== undefined ? a! : null });
  }
  return guests;
}

/**
 * The address to reach a guest at, for adding it as a host: a container's
 * static `ip=` from `pct config` (not dhcp), else the first IPv4 address
 * that is not loopback or link-local from `hostname -I` (a container) or the
 * guest agent's interfaces (a VM, JSON). Null when none is known.
 */
export function guestAddress(kind: GuestKind, config: string, live: string): string | null {
  const usable = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.');
  if (kind === 'ct') {
    for (const m of config.matchAll(/^net\d+:.*?\bip=([^,/\s]+)/gm)) if (usable(m[1]!)) return m[1]!;
    return live.split(/\s+/).find(usable) ?? null;
  }
  try {
    const ifaces = JSON.parse(live) as { name?: string; 'ip-addresses'?: { 'ip-address-type'?: string; 'ip-address'?: string }[] }[];
    for (const i of Array.isArray(ifaces) ? ifaces : []) {
      if (i.name === 'lo') continue;
      for (const a of i['ip-addresses'] ?? []) if (a['ip-address-type'] === 'ipv4' && a['ip-address'] && usable(a['ip-address'])) return a['ip-address'];
    }
  } catch {
    // No guest agent, or it said something else: no address.
  }
  return null;
}
