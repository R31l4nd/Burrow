import { Socket } from 'node:net';
import { effectiveConnection, type HostStatus } from '@burrow/shared';
import { hostDefaults } from './defaults.js';
import type { Ctx } from '../context.js';
import { groupMap, listHosts } from './service.js';

// The green/red dot in the host list: a plain TCP connect to the SSH port.
// Cheap, needs no credentials, and says what the user wants to know first
// ("is it up?"). A few checks run in parallel so one dead host does not delay
// the rest.

const TIMEOUT_MS = 3000;
const CONCURRENCY = 8;

export function tcpCheck(host: string, port: number, timeoutMs = TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok ? Math.round(performance.now() - started) : null);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export class StatusMonitor {
  readonly #status = new Map<number, HostStatus>();
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly ctx: Ctx) {}

  start(intervalSeconds: number): void {
    if (intervalSeconds <= 0) return;
    void this.checkAll();
    this.#timer = setInterval(() => void this.checkAll(), intervalSeconds * 1000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  all(): HostStatus[] {
    return [...this.#status.values()];
  }

  async checkAll(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const groups = groupMap(this.ctx);
      const all = hostDefaults(this.ctx);
      const queue = listHosts(this.ctx).map((h) => ({ id: h.id, address: h.address, port: effectiveConnection(h, groups, all).port }));
      const ids = new Set(queue.map((q) => q.id));
      for (const id of this.#status.keys()) if (!ids.has(id)) this.#status.delete(id);
      const worker = async () => {
        for (let q = queue.shift(); q; q = queue.shift()) await this.checkOne(q.id, q.address, q.port);
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      this.#running = false;
    }
  }

  async checkOne(hostId: number, address: string, port: number): Promise<HostStatus> {
    const latency = await tcpCheck(address, port);
    const s: HostStatus = {
      hostId,
      reachable: latency !== null,
      latencyMs: latency,
      checkedAt: new Date(this.ctx.now()).toISOString(),
    };
    this.#status.set(hostId, s);
    return s;
  }
}
