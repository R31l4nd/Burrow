// Asking a registry which image a tag points to now, without pulling: a HEAD
// request for the manifest returns its digest in Docker-Content-Digest.
// Docker Hub does not count HEAD requests against its pull rate limit.
// Anonymous tokens only: images that need a login come back as unknown.

export interface ImageRef {
  /** Registry host as Docker writes it: docker.io, ghcr.io, localhost:5000. */
  registry: string;
  /** Repository path: library/nginx, linuxserver/radarr. */
  repo: string;
  tag: string | null;
  digest: string | null;
}

const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const REPO = new RegExp(`^${COMPONENT}(?:/${COMPONENT})*$`);
const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * Docker's reference rules: the first part is a registry when it has a dot
 * or a port, or is localhost; otherwise the image is on Docker Hub, and a
 * single name is an official image under library/.
 */
export function parseImageRef(ref: string): ImageRef | null {
  let rest = ref.trim();
  if (!rest || /\s/.test(rest) || /^(sha256:)?[0-9a-f]{64}$/.test(rest)) return null;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  }
  let tag: string | null = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0]!.includes('.') || parts[0]!.includes(':') || parts[0] === 'localhost')) registry = parts.shift()!;
  if (registry === 'index.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');
  const repo = parts.join('/');
  if (!REPO.test(repo) || (tag !== null && !TAG.test(tag))) return null;
  if (!tag && !digest) tag = 'latest';
  return { registry, repo, tag, digest };
}

/** "nginx" and "docker.io/library/nginx:latest" name the same thing. */
export function refKey(r: ImageRef): string {
  return `${r.registry}/${r.repo}`;
}

/** Where to send requests for a registry: HTTPS, plain HTTP for localhost, or a configured endpoint. */
export function registryBase(registry: string, endpoints: Record<string, string> = {}): string {
  const mapped = endpoints[registry];
  if (mapped) return mapped.replace(/\/$/, '');
  if (registry === 'docker.io') return 'https://registry-1.docker.io';
  if (/^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/.test(registry)) return `http://${registry}`;
  return `https://${registry}`;
}

/** Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull" */
export function parseChallenge(header: string | null): { realm: string; params: Record<string, string> } | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) params[m[1]!.toLowerCase()] = m[2]!;
  const realm = params.realm;
  if (!realm) return null;
  delete params.realm;
  return { realm, params };
}

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// Token services that live on another domain than their registry's.
const AUTH_HOSTS: Record<string, string[]> = { 'nvcr.io': ['authn.nvidia.com'], 'registry.redhat.io': ['sso.redhat.com'] };

/** The last two labels of a host name (an address: itself), to tell a registry's own auth host. */
const baseDomain = (host: string) => (/^[\d.]+$|:/.test(host) ? host : host.split('.').slice(-2).join('.'));

/**
 * Where an anonymous token may be asked for: https (http only when the registry itself answered
 * over http, and then on its own host), on the host that answered or a host of the same domain
 * (registry-1.docker.io -> auth.docker.io, registry.gitlab.com -> gitlab.com), or a known auth
 * service. Any realm was fetched, so an image name or a hostile registry made Burrow ask any
 * address on its networks (A3-SRV-14).
 */
export function realmAllowed(realm: string, answeredBy: string, registry: string): URL | null {
  let u: URL;
  let from: URL;
  try {
    u = new URL(realm);
    from = new URL(answeredBy);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'http:') return from.protocol === 'http:' && u.host === from.host ? u : null;
  if (u.protocol !== 'https:') return null;
  if (u.hostname === from.hostname || baseDomain(u.hostname) === baseDomain(from.hostname)) return u;
  return (AUTH_HOSTS[registry] ?? []).includes(u.hostname) ? u : null;
}

/**
 * A request that follows at most five redirects, each to https (or, from a registry asked over
 * http, to that same host): lscr.io sends everything to ghcr.io. Returns the answer and the URL
 * that gave it.
 */
async function follow(f: FetchFn, url: string, init: RequestInit): Promise<{ res: Response; at: string }> {
  let at = url;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await f(at, { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return { res, at };
    await res.body?.cancel().catch(() => {});
    const next = new URL(location, at);
    const prev = new URL(at);
    if (next.protocol !== 'https:' && !(next.protocol === 'http:' && prev.protocol === 'http:' && next.host === prev.host)) throw new RegistryError('the registry redirected elsewhere');
    at = next.toString();
  }
  throw new RegistryError('the registry redirected too often');
}

/** The registry's answer to a request, with an anonymous token when it asks for one. */
async function withToken(r: ImageRef, url: string, init: RequestInit, opts: { fetch?: FetchFn; timeoutMs?: number; token?: { value: string | null } }): Promise<Response> {
  const f = opts.fetch ?? fetch;
  const timeout = () => AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const headers = (init.headers ?? {}) as Record<string, string>;
  const auth = (t: string | null | undefined): Record<string, string> => (t ? { ...headers, authorization: `Bearer ${t}` } : headers);
  const first = await follow(f, url, { ...init, headers: auth(opts.token?.value), signal: timeout() });
  let res = first.res;
  const at = first.at;
  if (res.status === 401) {
    const ch = parseChallenge(res.headers.get('www-authenticate'));
    if (!ch) throw new RegistryError('the registry wants a login');
    const realm = realmAllowed(ch.realm, at, r.registry);
    if (!realm) throw new RegistryError('the registry named a token service Burrow does not ask');
    for (const [k, v] of Object.entries({ ...ch.params, scope: ch.params.scope ?? `repository:${r.repo}:pull` })) realm.searchParams.set(k, v);
    // Not followed anywhere, and its status not passed on: only "a token" or "none".
    const tr = await f(realm.toString(), { signal: timeout(), redirect: 'manual' });
    if (!tr.ok) throw new RegistryError(tr.status === 401 || tr.status === 403 ? 'the registry wants a login' : 'the registry gave no token');
    const tj = (await tr.json().catch(() => ({}))) as { token?: string; access_token?: string };
    const token = tj.token ?? tj.access_token;
    if (!token) throw new RegistryError('the registry gave no token');
    if (opts.token) opts.token.value = token;
    res = (await follow(f, url, { ...init, headers: auth(token), signal: timeout() })).res;
  }
  if (res.status === 429) throw new RegistryError('rate limited by the registry', true);
  if (res.status === 401 || res.status === 403) throw new RegistryError('the registry wants a login');
  if (res.status === 404) throw new RegistryError('not in the registry (any more)');
  if (!res.ok) throw new RegistryError(`HTTP ${res.status}`);
  return res;
}

const MAX_TAG_PAGES = 20;

/**
 * Every tag of the repository (tags/list, page by page through the Link
 * header; at most 20 pages of 1000). Listing tags does not count against
 * Docker Hub's pull limit.
 */
export async function listTags(r: ImageRef, opts: { endpoints?: Record<string, string>; fetch?: FetchFn; timeoutMs?: number } = {}): Promise<string[]> {
  const base = registryBase(r.registry, opts.endpoints);
  const token = { value: null as string | null };
  const out: string[] = [];
  let path: string | null = `/v2/${r.repo}/tags/list?n=1000`;
  for (let page = 0; path && page < MAX_TAG_PAGES; page++) {
    const res = await withToken(r, `${base}${path}`, { headers: { accept: 'application/json' } }, { ...opts, token });
    const j = (await res.json()) as { tags?: unknown };
    if (Array.isArray(j.tags)) for (const t of j.tags) if (typeof t === 'string' && TAG.test(t)) out.push(t);
    // Link: </v2/library/nginx/tags/list?last=1.25&n=1000>; rel="next"
    const next = /<([^>]+)>;\s*rel="?next"?/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    path = next && next.startsWith('/v2/') ? next : null;
  }
  return out;
}

/** The digest the tag points to in the registry now. */
export async function remoteDigest(r: ImageRef, opts: { endpoints?: Record<string, string>; fetch?: FetchFn; timeoutMs?: number } = {}): Promise<string> {
  const url = `${registryBase(r.registry, opts.endpoints)}/v2/${r.repo}/manifests/${r.tag ?? 'latest'}`;
  const res = await withToken(r, url, { method: 'HEAD', headers: { accept: ACCEPT } }, opts);
  const d = res.headers.get('docker-content-digest');
  if (!d || !/^sha256:[0-9a-f]{64}$/.test(d)) throw new RegistryError('the registry did not say the digest');
  return d;
}

/**
 * The digest this image was pulled with, from `docker image inspect`'s
 * RepoDigests ("nginx@sha256:..."): the entry of the same repository.
 */
export function localDigest(ref: ImageRef, repoDigests: string[]): string | null {
  return localDigests(ref, repoDigests)[0] ?? null;
}

/**
 * Every digest this image was pulled with for the repository. One image can
 * have several: a pull that finds a new manifest list for the same image
 * adds a digest (nginx:alpine did), and any of them may be the tag's now.
 */
export function localDigests(ref: ImageRef, repoDigests: string[]): string[] {
  const out: string[] = [];
  for (const rd of repoDigests) {
    const p = parseImageRef(rd);
    if (p && p.digest && refKey(p) === refKey(ref) && !out.includes(p.digest)) out.push(p.digest);
  }
  return out;
}

/** "a=b,c=d" -> { a: "b", c: "d" }. */
export function parseEndpoints(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
