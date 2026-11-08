import type { ServerMessage } from '@burrow/shared';
import { dialLimit, doubtSession, failedDials } from './dial.js';

// A session shared with you, watched (F3): its socket. The session's end comes as an exit message
// first; a socket that closes without one only lost its way (Wi-Fi to mobile data, Burrow
// restarting, a proxy that let go): said, and dialled again with backoff as a terminal is. The
// server answers every new connection with the screen as it is.

/** lost: the connection went, a new one on its way; unshared: no longer shared with you (4003). */
export type WatchState = 'lost' | 'unshared';

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const PING_MS = 25_000;

export class WatchConnection {
  #ws: WebSocket | null = null;
  #attempt = 0;
  #unopened = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ping: ReturnType<typeof setInterval>;
  #stopped = false;

  constructor(
    readonly sessionId: string,
    private readonly on: { message(m: ServerMessage): void; state(s: WatchState): void },
  ) {
    this.#ping = setInterval(() => this.#ws?.readyState === WebSocket.OPEN && this.#ws.send(JSON.stringify({ t: 'ping' })), PING_MS);
    this.#open();
  }

  #open(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/terminal/shared/${encodeURIComponent(this.sessionId)}/ws`);
    this.#ws = ws;
    dialLimit(ws);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.#attempt = 0;
      this.#unopened = 0;
    };
    ws.onmessage = (e) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      // Ended, closed, or not attached (the page says which): not dialled again. Lost: Burrow
      // restarting or its connection to the host gone; the session lives on in tmux there.
      if (m.t === 'exit' && m.reason !== 'lost') this.#stopped = true;
      this.on.message(m);
    };
    ws.onclose = (e) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.#stopped) return;
      if (e.code === 4003) {
        this.#stopped = true;
        return this.on.state('unshared');
      }
      this.on.state('lost');
      if (e.code === 4401) {
        // Signed out: the app shows its sign-in.
        this.#stopped = true;
        return doubtSession();
      }
      if (!opened) failedDials(++this.#unopened);
      const delay = BACKOFF_MS[Math.min(this.#attempt++, BACKOFF_MS.length - 1)]!;
      this.#timer = setTimeout(() => this.#open(), delay);
    };
  }

  close(): void {
    this.#stopped = true;
    clearInterval(this.#ping);
    if (this.#timer) clearTimeout(this.#timer);
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }
}
