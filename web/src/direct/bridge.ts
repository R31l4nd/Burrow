import type { DirectCache, PathEntry } from '@burrow/shared';
import { PortBridge, type Port } from '../lib/port.js';

// The direct route's page talks only to the app (`BurrowDirect`, injected
// into the app's own asset origin): the SSH connection is the app's
// (android/.../direct), this page is the same terminal UI as in Burrow.

export type ConnectResult =
  | { status: 'ok'; sessionId: string; viaWireGuard?: boolean; kept?: boolean }
  | { status: 'unknown_host_key'; keyType: string; fingerprint: string }
  | { status: 'host_key_changed'; keyType: string; fingerprint: string }
  | { status: 'cancelled' }
  | { status: 'auth_failed' | 'error'; message: string };

export type ForwardResult = { status: 'ok'; forwardId: string; localPort: number; viaWireGuard: boolean } | { status: 'cancelled' | 'auth_failed' | 'error'; message: string };

export interface Forwarding {
  forwardId: string;
  hostName: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
}

export interface DirectInfo {
  version: string;
  /** From the main app: language, theme and terminal settings (localStorage values). */
  uiPrefs: Record<string, string>;
  /** Android's own menu over the terminal's selection (apps from 1.8.0). */
  selectionMenu?: boolean;
}

class DirectBridge extends PortBridge {
  info = () => this.call<DirectInfo>('info');
  /**
   * Opened for one host (from its sheet in Burrow): that host, once; else null. resume: this page was
   * loaded again after Android ended its renderer, and the app still holds the session it showed (A3-AND-02).
   */
  takeConnectTo = () => this.call<{ hostId: number | null; resume?: { sessionId: string; hostId: number; viaWireGuard: boolean; kept: boolean; keepOpen?: boolean } | null }>('takeConnectTo');
  /** The cache Burrow handed out last time it was reachable; null if never. */
  cache = () => this.call<DirectCache | null>('cache');
  connect = (hostId: number, cols: number, rows: number) => this.call<ConnectResult>('connect', { hostId, cols, rows });
  /** Trust a host key for the direct route (first connection to a host Burrow never saw). */
  trust = (hostId: number, fingerprint: string) => this.call('trust', { hostId, fingerprint });
  /** The page listens for this session's output and end now: what came before is sent first (AUDIT2 AND-08). */
  attach = (sessionId: string) => this.call('attach', { sessionId });
  input = (sessionId: string, data: string) => this.call('input', { sessionId, data });
  resize = (sessionId: string, cols: number, rows: number) => this.call('resize', { sessionId, cols, rows });
  /** end: the kept session on the host goes too (else leaving only detaches). */
  close = (sessionId: string, end = false) => this.call('close', { sessionId, end });
  /** A port of a host on the phone's 127.0.0.1 (a web page on the host, in the phone's browser). */
  forward = (hostId: number, targetPort: number, targetHost = '127.0.0.1') => this.call<ForwardResult>('forward', { hostId, targetPort, targetHost });
  forwards = () => this.call<Forwarding[]>('forwards');
  stopForward = (forwardId: string) => this.call('stopForward', { forwardId });
  openForward = (forwardId: string, https = false) => this.call('openForward', { forwardId, https });
  /** Keep this session (and the app's WireGuard under it) open when the app is out of sight. */
  keepAlive = (sessionId: string, on: boolean) => this.call('keepAlive', { sessionId, on });
  exec = (sessionId: string, script: string, cwd: string | null) => this.call<{ stdout: string }>('exec', { sessionId, script, cwd });
  ls = (sessionId: string, path: string, cwd: string | null) => this.call<{ dir: string; entries: PathEntry[] }>('ls', { sessionId, path, cwd });
  /** A command run here, kept in the phone's cache for suggestions. */
  record = (hostId: number, command: string) => this.call('record', { hostId, command });
  backToBurrow = () => this.call('backToBurrow');
  /** While a terminal is shown: plain keyboard input, the volume keys as keys, the screen kept on. */
  terminal = (mode: { input: boolean; keys: boolean; screen: boolean }) => this.call('terminal', mode);
  /** Android's floating menu (Copy, Paste, Select all) over this box, or gone with null; picks come back as "selectionAction". */
  selectionMenu = (box: { x: number; y: number; w: number; h: number } | null) => this.call('selectionMenu', box ?? {});
}

const port = (globalThis as { BurrowDirect?: Port }).BurrowDirect;
export const direct: DirectBridge | null = port ? new DirectBridge(port) : null;
