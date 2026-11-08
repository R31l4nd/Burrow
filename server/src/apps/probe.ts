import type { Embeddable } from '@burrow/shared';

// Looking at an app from the server: may Burrow show it in a frame, and what
// is its icon. Both are best effort; an app that cannot be reached is
// "unknown" and gets the default icon.

const TIMEOUT_MS = 6000;
const MAX_ICON = 256 * 1024;
const MAX_HTML = 512 * 1024;
const ICON_TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Whether a page with these headers may be framed by `origin`. X-Frame-Options
 * DENY/SAMEORIGIN forbid it (an app is never Burrow's origin); CSP
 * frame-ancestors, when present, overrides X-Frame-Options, as in browsers.
 */
export function embeddableFrom(headers: Headers, origin: string): Embeddable {
  const csp = headers.get('content-security-policy');
  const fa = csp
    ?.split(';')
    .map((d) => d.trim().split(/\s+/))
    .find((d) => d[0]?.toLowerCase() === 'frame-ancestors');
  if (fa) {
    const sources = fa.slice(1).map((s) => s.toLowerCase());
    const { protocol, host } = new URL(origin);
    const ok = sources.some((s) => {
      if (s === '*') return true;
      if (s === `${protocol}` || s === origin.toLowerCase() || s === host) return true;
      // https://*.example.com
      const m = /^(?:(https?:)\/\/)?\*\.(.+)$/.exec(s);
      return !!m && (!m[1] || m[1] === protocol) && host.endsWith(`.${m[2]}`);
    });
    return ok ? 'yes' : 'no';
  }
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return 'no';
  return 'yes';
}

async function get(fetcher: Fetcher, url: string, accept: string): Promise<Response> {
  return fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept } });
}

/**
 * The body, or null when it is larger than `max`: counted while it comes,
 * and given up at once (a chunked reply without a length was read whole
 * first, however large).
 */
export async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > max) return null;
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** The icon links of an HTML page, best first. */
export function iconLinks(html: string, base: string): string[] {
  const out: { href: string; rank: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href) continue;
    const rank = rel.includes('apple-touch-icon') ? 0 : rel.split(/\s+/).includes('icon') ? 1 : -1;
    if (rank < 0) continue;
    try {
      out.push({ href: new URL(href, base).toString(), rank });
    } catch {
      // Unusable href.
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.href);
}

export interface ProbeResult {
  embeddable: Embeddable;
  icon: { data: Buffer; type: string } | null;
}

export async function probeApp(url: string, origin: string, fetcher: Fetcher = fetch): Promise<ProbeResult> {
  let page: Response;
  try {
    page = await get(fetcher, url, 'text/html,*/*;q=0.8');
  } catch {
    return { embeddable: 'unknown', icon: null };
  }
  const embeddable = page.ok || page.status === 401 ? embeddableFrom(page.headers, origin) : 'unknown';
  let html = '';
  if (page.headers.get('content-type')?.includes('text/html')) {
    const buf = await readCapped(page, MAX_HTML).catch(() => null);
    html = buf?.toString('utf8') ?? '';
  } else {
    await page.body?.cancel().catch(() => {});
  }
  const candidates = [...iconLinks(html, page.url || url), new URL('/favicon.ico', page.url || url).toString()];
  for (const c of candidates.slice(0, 4)) {
    try {
      const res = await get(fetcher, c, 'image/*');
      const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!res.ok || !ICON_TYPES.has(type)) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const data = await readCapped(res, MAX_ICON);
      if (data?.length) return { embeddable, icon: { data, type } };
    } catch {
      // Next candidate.
    }
  }
  return { embeddable, icon: null };
}
