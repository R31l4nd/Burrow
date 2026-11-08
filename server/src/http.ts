import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Actor } from './audit.js';
import type { Auth } from './auth/sessions.js';
import { CommandTimeout } from './ssh/connect.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * An error that is not an HttpError but has an answer of its own: a command on a host that did not
 * end in time is a 504 saying so, not "internal" (live log 2026-10-19). Null: left to the handler.
 */
export function httpErrorOf(err: unknown): HttpError | null {
  if (err instanceof CommandTimeout) return new HttpError(504, 'host_timeout', `The host did not answer within ${Math.round(err.ms / 1000)} s.`);
  return null;
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    // A field's name before its problem; a sentence about the whole request (a refine without a path) as it is.
    const msg = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
    throw new HttpError(400, 'invalid_request', msg);
  }
  return r.data;
}

export function idParam(req: FastifyRequest, name = 'id'): number {
  const raw = (req.params as Record<string, string>)[name];
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'invalid_id');
  return n;
}

// Route-level access rules, set with `config` on each route. The default,
// when a route says nothing, is an admin with a finished account: forgetting
// to mark a route makes it stricter, never more open.
export interface RouteAccess {
  auth?: 'public' | 'user' | 'admin';
  stepUp?: boolean;
  allowIncomplete?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
  // Declaration merging needs an interface, even an empty one.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyContextConfig extends RouteAccess {}
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw new HttpError(401, 'unauthenticated');
  return req.auth;
}

export function actor(req: FastifyRequest): Actor {
  return {
    userId: req.auth?.user.id ?? null,
    username: req.auth?.user.username ?? null,
    ip: req.ip,
  };
}

export const noContent = (reply: FastifyReply) => reply.code(204).send();

/**
 * A Content-Disposition header that every client names the file by (RFC 6266): first an ASCII
 * `filename` (quotes, backslashes, percent signs, control and non-ASCII characters made `_`),
 * then, when that is not the name itself, the exact name as `filename*` (RFC 5987, UTF-8).
 * Android's URLUtil.guessFileName reads only `filename`, and without it named a download after
 * the address: "raw.bin" (report 1fb877).
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  if (ascii === name) return `${kind}; filename="${name}"`;
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

/**
 * A stored secret goes with its destination: when the address it is sent to changes and no
 * secret comes along, the stored one is dropped instead of handed to the new address
 * (A3-SRV-07, A3-SRV-17). undefined keeps, '' removes, anything else replaces.
 */
export function secretFor(stored: string | null, given: string | undefined, sameDestination: boolean, seal: (v: string) => string): string | null {
  if (given === '') return null;
  if (given !== undefined) return seal(given);
  return sameDestination ? stored : null;
}

/** An address's origin (scheme, host and port), or the text itself when it is none. */
export const originOf = (url: string | null | undefined): string => {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return url ?? '';
  }
};

/** What a socket may have waiting to go out before its viewer counts as too slow. */
export const MAX_SOCKET_BUFFER = 4 << 20;

/**
 * A sender for a WebSocket that does not queue without end: a viewer that
 * reads slower than the logs or the output come is let go (4008, as the
 * terminal does), not buffered in Burrow's memory (AUDIT2 DO-20).
 */
export function boundedSender<T>(socket: { readyState: number; OPEN: number; bufferedAmount: number; send(data: string): void; close(code?: number, reason?: string): void }): (m: T) => void {
  return (m) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER) return socket.close(4008, 'too slow');
    socket.send(JSON.stringify(m));
  };
}
