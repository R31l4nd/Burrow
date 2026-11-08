import { createSocket } from 'node:dgram';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import type { SftpPool } from '../files/pool.js';
import { actor, HttpError, idParam, parse } from '../http.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { getHost, listHosts } from './service.js';
import type { StatusMonitor } from './status.js';

// Wake-on-LAN: a sleeping host is woken by a "magic packet" on its own
// network. Burrow (in a container) cannot broadcast on the LAN, so another
// host that is up sends it: over SSH, with perl (on every Debian and
// Ubuntu), python3, or a wake tool, to 255.255.255.255 and every broadcast
// address of that host's networks. The MAC address comes from the facts
// Burrow read while the host was up, or the one set on the host. Per host
// the sender can be chosen: one host, or Burrow itself, which reaches the
// LAN only with host networking or macvlan.

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/** The shell script a relay host runs to send the packet for `mac`. */
export function wakeScript(mac: string, extra: string[] = []): string {
  if (!MAC.test(mac)) throw new Error('not a MAC address');
  const targets = ['255.255.255.255', ...extra].map(shellQuote).join(' ');
  const perl =
    'use IO::Socket::INET; my $m=shift; $m=~s/://g; my $p=("\\xff" x 6).(pack("H12",$m) x 16); my $s=IO::Socket::INET->new(Proto=>"udp",Broadcast=>1) or die "socket: $!"; for my $a (@ARGV) { $s->send($p,0,pack_sockaddr_in(9,inet_aton($a))) or die "send $a: $!" }';
  const py =
    'import socket,sys;m=bytes.fromhex(sys.argv[1].replace(":",""));p=b"\\xff"*6+m*16;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);[s.sendto(p,(a,9)) for a in sys.argv[2:]]';
  return [
    `m=${shellQuote(mac)}`,
    // Every IPv4 broadcast address of this host's networks, too.
    `b=$(ip -4 -o addr show 2>/dev/null | awk '/brd/ {for (i=1;i<=NF;i++) if ($i=="brd") print $(i+1)}' | sort -u | tr '\\n' ' ')`,
    `if command -v perl >/dev/null 2>&1; then perl -e ${shellQuote(perl)} "$m" ${targets} $b`,
    `elif command -v python3 >/dev/null 2>&1; then python3 -c ${shellQuote(py)} "$m" ${targets} $b`,
    `elif command -v wakeonlan >/dev/null 2>&1; then wakeonlan "$m"`,
    `elif command -v etherwake >/dev/null 2>&1; then etherwake "$m"`,
    `else echo "no perl, python3, wakeonlan or etherwake on this host" >&2; exit 3; fi`,
  ].join('\n');
}

/** The magic packet: six 0xff, then the MAC address sixteen times. */
export function magicPacket(mac: string): Buffer {
  if (!MAC.test(mac)) throw new Error('not a MAC address');
  const m = Buffer.from(mac.replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => m)]);
}

/** Sent from Burrow's own network: to 255.255.255.255 and the host's /24 broadcast (an IPv4 address). */
export async function sendFromBurrow(mac: string, address: string, port = 9, targets?: string[]): Promise<void> {
  const packet = magicPacket(mac);
  const net = net24(address);
  const to = targets ?? ['255.255.255.255', ...(net ? [`${net}.255`] : [])];
  const s = createSocket('udp4');
  try {
    await new Promise<void>((res, rej) => s.bind(0, () => res()).once('error', rej));
    s.setBroadcast(true);
    for (const a of to) await new Promise<void>((res, rej) => s.send(packet, port, a, (err) => (err ? rej(err) : res())));
  } finally {
    s.close();
  }
}

/** The first four octets' network, for "same LAN" (an IPv4 address only). */
const net24 = (address: string) => (/^(\d+\.\d+\.\d+)\.\d+$/.exec(address) ?? [])[1] ?? null;

export function registerWakeRoutes(app: FastifyInstance, ctx: Ctx, status: StatusMonitor, pool: SftpPool): void {
  app.post('/api/hosts/:id/wake', async (req) => {
    const id = idParam(req);
    const { relayId } = parse(z.object({ relayId: z.number().int().positive().optional() }), req.body ?? {});
    const host = getHost(ctx, id);
    const mac = host.wakeMac ?? host.facts?.mac;
    if (!mac) throw new HttpError(409, 'no_mac', "Burrow does not know this host's MAC address yet: it learns it once the host is up, or set it in the host's Advanced settings.");
    // Chosen on the host: Burrow itself.
    if (!relayId && host.wakeVia === 'burrow') {
      try {
        await sendFromBurrow(mac, host.address);
      } catch (err) {
        audit(ctx, actor(req), 'host.wake', host.name, { relay: 'Burrow', ok: false });
        throw new HttpError(502, 'wake_failed', `Burrow: ${(err as Error).message}`);
      }
      audit(ctx, actor(req), 'host.wake', host.name, { relay: 'Burrow', ok: true });
      return { relay: 'Burrow' };
    }
    const up = new Set(status.all().filter((s) => s.reachable).map((s) => s.hostId));
    const all = listHosts(ctx);
    // One host asked for (here, or chosen on the host while it still exists), else a host that is up, on the same /24 if there is one.
    const chosen = relayId ?? (typeof host.wakeVia === 'number' && all.some((h) => h.id === host.wakeVia) ? host.wakeVia : null);
    const candidates = all.filter((h) => h.id !== id && (chosen ? h.id === chosen : up.has(h.id)));
    const same = net24(host.address);
    const relay = candidates.find((h) => same && net24(h.address) === same) ?? candidates[0];
    if (!relay) throw new HttpError(409, 'no_relay', 'No other host is up to send the wake-up from.');
    // The host chosen on it is known to be down: said, not another one used instead.
    if (!relayId && chosen && status.all().some((s) => s.hostId === chosen && !s.reachable)) throw new HttpError(409, 'relay_down', `${relay.name} is not up to send the wake-up from: choose another in the host's Advanced settings.`);
    const r = await pool.with(relay.id, ({ client }) => exec(client, wakeScript(mac), 20_000));
    audit(ctx, actor(req), 'host.wake', host.name, { relay: relay.name, ok: r.code === 0 });
    if (r.code !== 0) throw new HttpError(502, 'wake_failed', `${relay.name}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    return { relay: relay.name };
  });
}
