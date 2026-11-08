import type { ImageCheck, OpInfo, OpServerMessage, UpdatesOverview } from '@burrow/shared';
import { nudgeActivity } from './activity.svelte.js';
import { get, post } from './api.js';

// Image updates (phase 8): the last check's result, for the badge on
// Containers, the rows and the stack page. Loaded at start and now and then.

export const updates = $state<{ overview: UpdatesOverview | null }>({ overview: null });

export async function loadUpdates(): Promise<UpdatesOverview | null> {
  try {
    updates.overview = await get<UpdatesOverview>('/api/docker/updates');
  } catch {
    // Not an admin, or offline: no badge.
  }
  return updates.overview;
}

export async function checkUpdates(hostIds: number[], images?: string[]): Promise<void> {
  nudgeActivity();
  updates.overview = await post<UpdatesOverview>('/api/docker/updates/check', { hostIds, ...(images ? { images } : {}) });
}

export function checkOf(hostId: number, image: string): ImageCheck | undefined {
  return updates.overview?.checks.find((c) => c.hostId === hostId && c.image === image);
}

export const updateCount = (): number => updates.overview?.checks.filter((c) => c.status === 'update').length ?? 0;

/** "sha256:1f9b3fc4fe..." -> "1f9b3fc4fe12". */
export const shortDigest = (d: string | null): string => (d ? d.replace(/^sha256:/, '').slice(0, 12) : '?');

/**
 * Follows a stack operation's output until it ends. A connection that drops
 * before the end (a phone asleep, the network changing) says so with an empty
 * error and is made again: the server sends all output so far again, so
 * `again` tells the page to start its copy over. Not for an operation the
 * server no longer knows (Burrow restarted): its own error says so.
 */
export function followOp(op: OpInfo, on: (m: OpServerMessage) => void, again: () => void = () => {}): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ended = false;
  let stopped = false;
  let tries = 0;
  let connected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ws: WebSocket;
  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/api/docker/ops/${op.id}/ws`);
    ws.onopen = () => {
      if (connected) again();
      connected = true;
      tries = 0;
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as OpServerMessage;
      if (m.t === 'exit') ended = true;
      on(m);
    };
    ws.onclose = (e) => {
      if (ended || stopped) return;
      // Empty message: the connection dropped before the end.
      on({ t: 'error', message: '' });
      if (e?.code === 4404) return;
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** tries++));
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws.close();
  };
}
