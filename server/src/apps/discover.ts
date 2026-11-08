import type { AppSource } from '@burrow/shared';

// Finding web apps from the labels on a host's running containers. These
// conventions are understood, most specific first:
//   homepage.href / homepage.name / homepage.group   (gethomepage.dev)
//   swag=enable, swag_url=radarr.example.*           (SWAG auto-proxy)
//   traefik.http.routers.<r>.rule=Host(`radarr.example.com`)
//   caddy=radarr.example.com                         (caddy-docker-proxy)
// And the confs of a proxy itself: SWAG's (report 6d39c6: apps proxied by a
// conf written by hand carry swag=disable, and were not found) and Nginx
// Proxy Manager's proxy hosts, which no label names.

export interface ContainerLabels {
  name: string;
  labels: Record<string, string>;
}

export interface Found {
  name: string;
  url: string;
  group: string | null;
  source: AppSource;
  container: string;
}

/**
 * The command that lists running containers with their labels, one per line:
 * `"/name" {"label":"value",...}`. `docker ps` itself joins labels with
 * commas, which breaks on values that contain one; inspect does not.
 */
export const LIST_COMMAND =
  `ids=$(docker ps -q) && { [ -z "$ids" ] || docker inspect --format '{{json .Name}} {{json .Config.Labels}}' $ids; }`;

export function parseInspect(out: string): ContainerLabels[] {
  const res: ContainerLabels[] = [];
  for (const line of out.split('\n')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    try {
      const name = (JSON.parse(m[1]!) as string).replace(/^\//, '');
      const labels = (JSON.parse(m[2]!) as Record<string, string> | null) ?? {};
      res.push({ name, labels });
    } catch {
      // Not ours; skip the line.
    }
  }
  return res;
}

const title = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function httpUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The URL for one container, or null. `baseDomain` fills the `*` in a SWAG
 * url (radarr.local.* -> radarr.local.example.com).
 */
export function appFromLabels(c: ContainerLabels, baseDomain: string): Found | null {
  const l = c.labels;
  const name = l['homepage.name']?.trim() || title(c.name);
  const group = l['homepage.group']?.trim() || null;

  const href = l['homepage.href'] && httpUrl(l['homepage.href'].trim());
  if (href) return { name, url: href, group, source: 'homepage', container: c.name };

  if (l.swag === 'enable') {
    // Without swag_url, SWAG serves the container at <name>.<domain>.
    const first = (l.swag_url?.split(',')[0]?.trim() || `${c.name}.*`).replace(/\*$/, baseDomain).replace(/\*/g, baseDomain);
    const url = httpUrl(`https://${first}/`);
    if (url && !first.includes('*')) return { name, url, group, source: 'swag', container: c.name };
  }

  for (const [k, v] of Object.entries(l)) {
    if (!/^traefik\.http\.routers\.[^.]+\.rule$/.test(k)) continue;
    const host = /Host\(\s*`([^`]+)`/.exec(v)?.[1];
    if (!host) continue;
    const router = k.slice(0, -'.rule'.length);
    // Plain http only when the router says so: an entrypoint named web and no TLS.
    const plain = l[`${router}.entrypoints`] === 'web' && !l[`${router}.tls`] && !l[`${router}.tls.certresolver`];
    const url = httpUrl(`${plain ? 'http' : 'https'}://${host}/`);
    if (url) return { name, url, group, source: 'traefik', container: c.name };
  }

  // caddy-docker-proxy: `caddy` (or caddy_0, caddy_1, ...) is a site address list. Not a snippet
  // "(name)", global options (an empty address) or a bare port; a wildcard names no one app.
  for (const [k, v] of Object.entries(l)) {
    if (!/^caddy(_\d+)?$/.test(k)) continue;
    const first = v.split(/[\s,]+/).find(Boolean);
    if (!first || first.startsWith('(') || first.startsWith(':') || first.includes('*') || first.includes('{')) continue;
    const url = httpUrl(/^https?:\/\//.test(first) ? first.replace(/\/?$/, '/') : `https://${first}/`);
    if (url) return { name, url, group, source: 'caddy', container: c.name };
  }
  return null;
}

/** example.com for burrow.local.example.com: the last two labels of the origin. */
export function baseDomainOf(origin: string): string {
  const host = new URL(origin).hostname;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  return host.split('.').slice(-2).join('.');
}

/**
 * The proxy confs of every SWAG container on the host (an image named swag), read with grep inside
 * it: each conf file, then its server_name and upstream_app lines. Nothing is changed in it.
 */
export const SWAG_CONFS_COMMAND =
  `for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ "(^|/)swag(:|@|$)" {print $1}'); do ` +
  `docker exec "$c" sh -c 'for f in /config/nginx/proxy-confs/*.subdomain.conf; do [ -f "$f" ] || continue; echo "@@conf $f"; grep -hE "^[[:space:]]*(server_name|set [$]upstream_app)[[:space:]]" "$f"; done' 2>/dev/null; done; true`;

/**
 * The proxy hosts of every Nginx Proxy Manager container on the host (an image named
 * nginx-proxy-manager), read inside it: each conf, then its server_name, where it forwards to and
 * whether it listens with TLS. Nothing is changed in it.
 */
export const NPM_CONFS_COMMAND =
  `for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ "(^|/)nginx-proxy-manager(:|@|$)" {print $1}'); do ` +
  `docker exec "$c" sh -c 'for f in /data/nginx/proxy_host/*.conf; do [ -f "$f" ] || continue; echo "@@conf $f"; grep -hE "^[[:space:]]*(server_name|set [$]server|listen)[[:space:]]" "$f"; done' 2>/dev/null; done; true`;

/**
 * The apps Nginx Proxy Manager's proxy hosts serve: the first name of `server_name`, https when it
 * listens on 443 with TLS, and what `set $server` forwards to (a container's name, or an address).
 */
export function appsFromNpmConfs(out: string): Found[] {
  const res: Found[] = [];
  let server: string | null = null;
  let upstream: string | null = null;
  let tls = false;
  const flush = () => {
    const url = server && upstream ? httpUrl(`${tls ? 'https' : 'http'}://${server}/`) : null;
    if (url) res.push({ name: title(server!.split('.')[0]!), url, group: null, source: 'npm', container: upstream! });
    server = null;
    upstream = null;
    tls = false;
  };
  for (const line of out.split('\n')) {
    const l = line.trim();
    if (l.startsWith('@@conf ')) {
      flush();
      continue;
    }
    const sn = /^server_name\s+([^;]+);/.exec(l);
    if (sn && !server) server = sn[1]!.trim().split(/\s+/).find((x) => /^[\w.-]+$/.test(x) && x.includes('.')) ?? null;
    const up = /^set\s+\$server\s+"?([\w.:-]+)"?\s*;/.exec(l);
    if (up && !upstream) upstream = up[1]!;
    if (/^listen\s+(\[::\]:)?443\b.*\bssl\b/.test(l)) tls = true;
  }
  flush();
  return res;
}

/**
 * The apps the proxy confs serve: radarr.subdomain.conf with `server_name radarr.*;` and
 * `set $upstream_app radarr;` is https://radarr.<domain>/, from the container radarr. The first
 * server_name of a conf that is a real one (not `_`), and its first upstream_app.
 */
export function appsFromSwagConfs(out: string, baseDomain: string): Found[] {
  const res: Found[] = [];
  let server: string | null = null;
  let upstream: string | null = null;
  const flush = () => {
    if (server && upstream && !server.includes('$')) {
      const host = server.replace(/\*$/, baseDomain).replace(/\*/g, baseDomain);
      const url = httpUrl(`https://${host}/`);
      if (url) res.push({ name: title(server.split('.')[0]!), url, group: null, source: 'swag', container: upstream });
    }
    server = null;
    upstream = null;
  };
  for (const line of out.split('\n')) {
    const l = line.trim();
    if (l.startsWith('@@conf ')) {
      flush();
      continue;
    }
    const sn = /^server_name\s+([^;]+);/.exec(l);
    if (sn && !server) {
      const first = sn[1]!.trim().split(/\s+/).find((x) => x !== '_' && /^[\w*.-]+$/.test(x));
      if (first) server = first;
    }
    const up = /^set\s+\$upstream_app\s+([\w.-]+);/.exec(l);
    if (up && !upstream) upstream = up[1]!;
  }
  flush();
  return res;
}
