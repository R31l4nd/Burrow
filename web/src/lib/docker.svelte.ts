import { untrack } from 'svelte';
import { dialLimit, doubtSession, failedDials } from './dial.js';
import { applyDockerDelta, type DockerClientMessage, type DockerServerMessage, type HostContainers } from '@burrow/shared';
import { get } from './api.js';
import { loadAll } from './data.svelte.js';
import { t } from './i18n/index.svelte.js';

// The container overview's socket: which hosts to watch goes out, a
// snapshot per host (containers, stats, a few minutes of history) comes
// back, then every few seconds what changed (decision 19). Reconnects by
// itself, like the terminal.

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
/** A host polled every 5 s that said nothing for this long has stopped answering (OPS-W-04). */
export const SILENT_AFTER_MS = 20_000;

// The last snapshot per host, kept across pages: a page that opens shows it
// at once, and the socket's fresh one replaces it a moment later.
const lastSeen = new Map<number, HostContainers>();

export class DockerWatch {
  hosts = $state<Record<number, HostContainers>>({});
  /** Hosts whose snapshot came from this socket, not from an earlier page. */
  fresh = $state<Record<number, true>>({});
  connected = $state(false);
  /** Hosts that stopped answering: how many seconds since their last word (OPS-W-04). */
  silent = $state<Record<number, number>>({});
  /** Each host as this socket last said it: what its deltas apply to. */
  #base = new Map<number, HostContainers>();
  /** When each watched host was last heard of (this device's clock). */
  #heard = new Map<number, number>();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #ws: WebSocket | null = null;
  #want: number[] = [];
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  /** Dials in a row that closed before they opened (lib/dial.ts: the sign-in may be gone). */
  #unopened = 0;

  constructor() {
    this.#open();
    this.#ticker = setInterval(() => this.#tick(), 5000);
  }

  /** Marks the hosts that stopped answering while the socket is up (a hung host sends nothing at all). */
  #tick(now = Date.now()): void {
    const next: Record<number, number> = {};
    if (this.connected)
      for (const id of this.#want) {
        const heard = this.#heard.get(id);
        if (heard !== undefined && now - heard > SILENT_AFTER_MS) next[id] = Math.round((now - heard) / 1000);
      }
    if (JSON.stringify(next) !== JSON.stringify(this.silent)) this.silent = next;
  }

  #got(h: HostContainers): void {
    const id = h.hostId;
    this.#base.set(id, h);
    lastSeen.set(id, h);
    this.#heard.set(id, Date.now());
    if (this.silent[id] !== undefined) delete this.silent[id];
    // A host no longer watched (a snapshot on its way when the page moved on): kept for later, not shown (A3-WEB-20).
    if (!this.#want.includes(id)) return;
    this.hosts[id] = h;
    this.fresh[id] = true;
  }

  #open(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/docker/ws`);
    this.#ws = ws;
    dialLimit(ws);
    let opened = false;
    ws.onopen = () => {
      this.#attempt = 0;
      opened = true;
      this.#unopened = 0;
      this.connected = true;
      ws.send(JSON.stringify({ t: 'watch', hostIds: this.#want } satisfies DockerClientMessage));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as DockerServerMessage;
      if (m.t === 'host') this.#got(m.host);
      // Hosts added or changed, maybe on another device: the list read again, its new Docker hosts watched (W-FUNC-09).
      else if (m.t === 'hosts-changed') void loadAll().catch(() => {});
      else if (m.t === 'delta') {
        // Changes only to a snapshot this socket gave; the whole one always comes first.
        const base = this.#base.get(m.d.hostId);
        if (base) this.#got(applyDockerDelta(base, m.d));
      }
    };
    ws.onclose = (e) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.connected = false;
      // Disconnected: what is shown is no longer this socket's word, until a new snapshot (AUDIT2 WEB-07).
      this.fresh = {};
      this.#base.clear();
      this.#heard.clear();
      this.silent = {};
      if (this.#stopped) return;
      // Signed out, or no longer allowed: not dialled again, and the app told (it shows its sign-in).
      if (e.code === 4401 || e.code === 4403) return doubtSession();
      if (!opened) failedDials(++this.#unopened);
      const delay = BACKOFF_MS[Math.min(this.#attempt++, BACKOFF_MS.length - 1)]!;
      this.#timer = setTimeout(() => this.#open(), delay);
    };
  }

  watch(hostIds: number[]): void {
    // Not read by the caller's effect: it read the hosts below and ran again
    // with every snapshot, sending "watch" each poll (or, in the bottom panel,
    // opening a new socket).
    untrack(() => this.#watch(hostIds));
  }

  #watch(hostIds: number[]): void {
    this.#want = hostIds;
    for (const id of Object.keys(this.hosts).map(Number))
      if (!hostIds.includes(id)) {
        delete this.hosts[id];
        delete this.fresh[id];
      }
    for (const id of this.#heard.keys()) if (!hostIds.includes(id)) this.#heard.delete(id);
    for (const id of hostIds) {
      const seen = lastSeen.get(id);
      if (seen && !this.hosts[id]) this.hosts[id] = seen;
      // Silent from the watch on: a host that hangs before its first answer counts too.
      if (!this.#heard.has(id)) this.#heard.set(id, Date.now());
    }
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'watch', hostIds } satisfies DockerClientMessage));
  }

  /** Reads every watched host now (pull to refresh), instead of waiting for the next snapshot; returns the hosts that could not be read (AUDIT2 WEB-08). */
  async refresh(): Promise<number[]> {
    const failed: number[] = [];
    await Promise.all(
      this.#want.map(async (id) => {
        // Through api(): never from the HTTP cache, and only Burrow's own answer.
        const h = await get<HostContainers>(`/api/docker/${id}/containers`).catch(() => null);
        if (!h) {
          failed.push(id);
          return;
        }
        lastSeen.set(id, h);
        this.#heard.set(id, Date.now());
        if (!this.#want.includes(id)) return;
        this.hosts[id] = h;
        this.fresh[id] = true;
      }),
    );
    return failed;
  }

  close(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ws?.close(1000);
  }
}

export function formatBytesShort(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** A readable duration in the app's language: 45s, 12m, 3h, 2d ("3 uur", "2 dagen" in Dutch, A3-WEB-13). */
export function since(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return t('time.seconds', { n: s });
  if (s < 3600) return t('time.minutes', { n: Math.round(s / 60) });
  if (s < 86400) return t('time.hours', { n: Math.round(s / 3600) });
  return t('time.days', { n: Math.round(s / 86400) });
}

/** Colour per log source in a merged view: stable for a given index. */
// app.css defines them per theme (dark ones are unreadable on a light log).
export const SOURCE_COLORS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `var(--src-${i})`);
