import { highestVersion, isPrerelease, needsReading, onLine, releaseFlags, releaseImageAllowed, type Changelog, type Release } from '@burrow/shared';
import { readCapped } from '../apps/probe.js';
import { HttpError } from '../http.js';
import type { FetchFn } from './registry.js';

// What changed in a newer image: the release notes of its source repository.
// Images say where their source lives in the OCI label
// org.opencontainers.image.source, and which version they are in
// org.opencontainers.image.version (or otherwise, imageVersion in shared).
// GitHub only, anonymously (60 requests an hour per address), so answers are
// kept for an hour; the last 100 releases, one request.

const CACHE_MS = 3600_000;
const cache = new Map<string, { at: number; releases: Release[] }>();

/** "https://github.com/owner/repo(.git)(/...)" -> { owner, repo }. */
export function githubRepo(source: string | null): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec((source ?? '').trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** "v1.2.3", "1.2.3", "release-1.2.3" name the same version. */
const norm = (v: string) => v.trim().toLowerCase().replace(/^(v|version|release)[-_ ]?/, '');

/**
 * The releases after `version` (newest first), or the latest few when it is
 * not among them: of the line the tag follows when it says one (valkey:9 ->
 * the 9.x releases, not 8.0.12 published after them).
 */
export function releasesSince(every: Release[], version: string | null, latest = 5, line: number[] | null = null): { releases: Release[]; matched: boolean } {
  // Pre-releases only for someone who runs one (report 0d33eb): a release tag does not move to a release candidate.
  const all = version && isPrerelease(version) ? every : every.filter((r) => !r.prerelease);
  if (version) {
    const i = all.findIndex((r) => norm(r.tag) === norm(version) || norm(r.name) === norm(version));
    if (i >= 0) return { releases: all.slice(0, i).filter((r) => !line || onLine(r.tag, line) || !onLine(version, line)), matched: true };
  }
  const own = line ? all.filter((r) => onLine(r.tag, line)) : [];
  return { releases: (own.length ? own : all).slice(0, latest), matched: false };
}

export async function changelog(source: string | null, version: string | null, opts: { fetch?: FetchFn; now?: number; line?: number[] | null } = {}): Promise<Changelog> {
  const gh = githubRepo(source);
  if (!gh) throw new HttpError(404, 'no_changelog', 'This image does not say where its release notes are (only GitHub is supported).');
  const key = `${gh.owner}/${gh.repo}`.toLowerCase();
  const now = opts.now ?? Date.now();
  let hit = cache.get(key);
  if (!hit || now - hit.at > CACHE_MS) {
    const f = opts.fetch ?? fetch;
    const res = await f(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases?per_page=100`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Burrow' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw new HttpError(404, 'no_changelog', 'The repository has no releases (or is private).');
    if (res.status === 403 || res.status === 429) throw new HttpError(503, 'rate_limited', 'GitHub limits how often it may be asked; try again in an hour.');
    if (!res.ok) throw new HttpError(502, 'changelog_error', `GitHub: HTTP ${res.status}`);
    const raw = (await res.json()) as { tag_name?: string; name?: string | null; published_at?: string | null; body?: string | null; html_url?: string; draft?: boolean; prerelease?: boolean }[];
    const kept = raw.filter((r) => !r.draft && r.tag_name).map((r) => ({ ...r, pre: !!r.prerelease || isPrerelease(r.tag_name!) }));
    const releases = kept.map((r, i) => {
      const body = (r.body ?? '').slice(0, 20_000);
      return {
        tag: r.tag_name!,
        name: r.name || r.tag_name!,
        publishedAt: r.published_at ?? null,
        body,
        url: r.html_url ?? `https://github.com/${gh.owner}/${gh.repo}/releases/tag/${encodeURIComponent(r.tag_name!)}`,
        // Newest first: a new major version against the highest of all before it (a backport of an older line is none),
        // pre-releases not counted (4.0.0 is new after 3.x, also when 4.0.0-rc.1 came first).
        flags: releaseFlags(body, r.tag_name!, highestVersion(kept.slice(i + 1).filter((x) => !x.pre).map((x) => x.tag_name!))),
        prerelease: r.pre,
      };
    });
    hit = { at: now, releases };
    cache.set(key, hit);
  }
  const since = releasesSince(hit.releases, version, 5, opts.line ?? null);
  return { url: `https://github.com/${gh.owner}/${gh.repo}/releases`, version, ...since, breaking: since.releases.filter((r) => needsReading(r.flags)).length };
}

// Pictures in release notes (report 64498b): fetched here from GitHub's own
// hosts and served from Burrow, so the page needs no other origin and the
// browser never asks GitHub. Raster images only (an SVG can carry script),
// at most 5 MB, kept a day.
const IMAGE_MAX = 5 << 20;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_KEEP_MS = 86_400_000;
const images = new Map<string, { at: number; type: string; bytes: Buffer }>();

/** Where a picture's redirects may lead: GitHub, its content hosts, and the S3 buckets of its attachments. */
const imageHop = (u: URL) => u.protocol === 'https:' && (u.hostname === 'github.com' || /^[a-z0-9-]+\.githubusercontent\.com$/.test(u.hostname) || /^github-production-[a-z0-9-]+\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/.test(u.hostname));

export async function releaseImage(url: string, opts: { fetch?: FetchFn; now?: number } = {}): Promise<{ type: string; bytes: Buffer }> {
  if (!releaseImageAllowed(url)) throw new HttpError(400, 'not_allowed', 'Only pictures on GitHub are shown.');
  const now = opts.now ?? Date.now();
  const hit = images.get(url);
  if (hit && now - hit.at < IMAGE_KEEP_MS) return hit;
  const f = opts.fetch ?? fetch;
  let at = url;
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    res = await f(at, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'image/*' } });
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get('location');
    if (!next) break;
    const u = new URL(next, at);
    if (!imageHop(u)) throw new HttpError(502, 'image_error', `GitHub sent the picture elsewhere (${u.hostname}).`);
    at = u.toString();
    res = null;
  }
  if (!res || !res.ok) throw new HttpError(502, 'image_error', `GitHub: HTTP ${res?.status ?? 'redirected too often'}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw new HttpError(502, 'image_error', `Not a picture Burrow shows (${type || 'no type'}).`);
  // Read up to the limit and no further: a chunked body names no length, and was read whole before (A3-SRV-16).
  const bytes = await readCapped(res, IMAGE_MAX);
  if (!bytes) throw new HttpError(502, 'image_error', 'The picture is larger than 5 MB.');
  const kept = { at: now, type, bytes };
  images.set(url, kept);
  // Kept small: the oldest go first beyond 64 pictures.
  while (images.size > 64) images.delete(images.keys().next().value!);
  return kept;
}
