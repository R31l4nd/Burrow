/**
 * How long a WebSocket may take to open. One dialled while the way to Burrow was not there yet
 * (the phone's WireGuard tunnel coming up) can hang for a minute or more before it fails: its
 * first packets went nowhere, and TCP waits ever longer before it sends them again. Closed then,
 * its owner's close handler dials again, on the way that is there now.
 */
export const DIAL_MS = 4000;

/** Gives the socket DIAL_MS to open, then closes it (still dialling) so its close handler tries again. */
export function dialLimit(ws: WebSocket, ms = DIAL_MS): void {
  setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) ws.close();
  }, ms);
}

// A WebSocket refused before it opens (the sign-in expired or revoked: the server answers the
// upgrade with 401) closes as 1006 to the page, as one with the network gone does: the code alone
// never says "signed out", and the socket dialled again for ever. After a few dials in a row that
// never opened, who is signed in is read again; signed out, the app shows its sign-in.
let doubt: (() => void) | null = null;
/** Set by the app shell: reads who is signed in again. */
export function onSessionDoubt(fn: () => void): void {
  doubt = fn;
}
/** Dials in a row that closed before they opened, after which (and every so many after) the sign-in is checked. */
export const DOUBT_AFTER = 3;
/** A socket's owner, its nth dial in a row that closed without opening. */
export function failedDials(n: number): void {
  if (n > 0 && n % DOUBT_AFTER === 0) doubt?.();
}
/** The server said signed out (4401) or not allowed (4403): who is signed in read again now. */
export function doubtSession(): void {
  doubt?.();
}
