import { eq, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { authThrottle } from '../db/schema.js';

// Brute-force protection for every way of proving who you are. Failures are
// counted per IP and per account; both must be under the limit. The delay
// grows with each failure, and at BLOCK_AFTER the key is blocked outright.
// Stored in SQLite so a restart does not hand out a fresh set of attempts.

export const BLOCK_AFTER = 10;
export const BLOCK_MS = 15 * 60_000;
// Failures older than this no longer count.
export const WINDOW_MS = 15 * 60_000;

export interface ThrottleState {
  blockedUntil: number | null;
  delayMs: number;
}

function row(ctx: Ctx, key: string) {
  return ctx.db.select().from(authThrottle).where(eq(authThrottle.key, key)).get();
}

/** Delay after n failures: none for the first three, then 1s, 2s, 4s ... max 8s. */
export const delayFor = (failures: number): number =>
  failures < 3 ? 0 : Math.min(8000, 1000 * 2 ** (failures - 3));

export function check(ctx: Ctx, keys: string[]): ThrottleState {
  const now = ctx.now();
  let blockedUntil: number | null = null;
  let delayMs = 0;
  for (const key of keys) {
    const r = row(ctx, key);
    if (!r) continue;
    if (r.blockedUntil && r.blockedUntil > now) {
      blockedUntil = Math.max(blockedUntil ?? 0, r.blockedUntil);
    }
    if (now - r.firstAt < WINDOW_MS) delayMs = Math.max(delayMs, delayFor(r.failures));
  }
  return { blockedUntil, delayMs };
}

/** Record a failure. Returns the keys that just became blocked. */
export function fail(ctx: Ctx, keys: string[]): string[] {
  const now = ctx.now();
  const newlyBlocked: string[] = [];
  for (const key of keys) {
    const r = row(ctx, key);
    const fresh = !r || now - r.firstAt >= WINDOW_MS || (r.blockedUntil !== null && r.blockedUntil <= now);
    const failures = fresh ? 1 : r.failures + 1;
    const blockedUntil = failures >= BLOCK_AFTER ? now + BLOCK_MS : null;
    if (blockedUntil && !(r?.blockedUntil && r.blockedUntil > now)) newlyBlocked.push(key);
    ctx.db
      .insert(authThrottle)
      .values({ key, failures, firstAt: fresh ? now : r.firstAt, blockedUntil })
      .onConflictDoUpdate({
        target: authThrottle.key,
        set: { failures, firstAt: fresh ? now : r.firstAt, blockedUntil },
      })
      .run();
  }
  return newlyBlocked;
}

export function succeed(ctx: Ctx, keys: string[]): void {
  for (const key of keys) ctx.db.delete(authThrottle).where(eq(authThrottle.key, key)).run();
}

export function pruneThrottle(ctx: Ctx): void {
  const cutoff = ctx.now() - WINDOW_MS - BLOCK_MS;
  ctx.db.delete(authThrottle).where(lt(authThrottle.firstAt, cutoff)).run();
}

/** The client a forwarding header names last (the one the proxy itself added), or null. */
export function forwardedClient(req: FastifyRequest): string | null {
  const xff = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  let last = list.at(-1) ?? null;
  if (!last) {
    const fwd = req.headers.forwarded;
    const m = [...(fwd ?? '').matchAll(/for=("?)\[?([^\];",\s]+)\]?\1/gi)].at(-1);
    last = m?.[2] ?? null;
  }
  if (!last) {
    const real = req.headers['x-real-ip'];
    last = (Array.isArray(real) ? real[0] : real)?.trim() || null;
  }
  return last && /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : last ? 'other' : null;
}

/**
 * A request through a proxy Burrow was not told about: TRUST_PROXY empty,
 * or set but not naming this proxy (recreated with a new address on its
 * Docker network, OPS-W-12). req.ip is then the proxy's, not the client's.
 */
export const viaUnknownProxy = (ctx: Ctx, req: FastifyRequest): boolean => {
  if (forwardedClient(req) === null) return false;
  if (!ctx.config.trustProxy) return true;
  // Trusted, Fastify takes the client from the header; not trusted, the connection's own address.
  const peer = req.socket?.remoteAddress;
  return !!peer && req.ip === peer && forwardedClient(req) !== peer;
};

/** What to set TRUST_PROXY to for a proxy at this address: its Docker network for a private address, else itself. */
export function trustProxySuggestion(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(v4);
  if (!m) return ip;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a === 172 && b >= 16 && b <= 31) return `172.${b}.0.0/16`;
  if (a === 192 && b === 168) return `192.168.${c}.0/24`;
  if (a === 10) return `10.${b}.${c}.0/24`;
  return v4;
}

/**
 * The address an attempt is counted under. Behind the proxy named in TRUST_PROXY, req.ip is the
 * client. Through a proxy Burrow was not told about, req.ip is that proxy's for everyone: ten
 * failures by anyone blocked every sign-in for all, again and again (A3-SRV-02). Then the
 * address is the proxy plus the client it names. That name is not verified (a client that
 * reaches Burrow directly can make one up), so the account keys still hold each account to ten
 * attempts whatever the address; the fix for the address itself is TRUST_PROXY.
 */
export function addressKey(ctx: Ctx, req: FastifyRequest): string {
  const ip = req.ip ?? 'unknown';
  return viaUnknownProxy(ctx, req) ? `${ip}>${forwardedClient(req)}` : ip;
}

// An object rather than a bare function so tests can replace the wait.
export const timing = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};
