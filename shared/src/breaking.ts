// What in release notes asks for attention before an update: breaking
// changes (the update may stop working as it did) and important notes
// (security fixes, deprecations, steps to take by hand). Read from the
// notes' own words and from the version numbers; release notes are free
// text, so this points at lines to read, it does not decide for anyone.

export interface ReleaseFlags {
  /** Lines that announce a breaking change (at most a few, trimmed). */
  breaking: string[];
  /** Security fixes, deprecations, manual steps. */
  important: string[];
  /** A new major version compared with the release before it (1.x -> 2.0). */
  major: boolean;
}

const BREAKING = [
  /\bbreaking\b/i,
  /\bbackwards?[- ]incompatible\b/i,
  /\bnot backwards? compatible\b/i,
  /\bmigration (is )?(required|needed)\b/i,
  /\baction required\b/i,
  /\bmust (now )?(be )?(migrate|update|change|set|rename)/i,
  /^\s*[-*]?\s*\w+(\([^)]*\))?!:/,
  /\bremoved\b.*\b(support|option|setting|variable|endpoint|flag)\b/i,
];
const IMPORTANT = [/\bsecurity\b/i, /\bCVE-\d{4}-\d+/i, /\bvulnerab/i, /\bdeprecat/i, /\bmanual(ly)? step/i, /\bbefore (updating|upgrading)\b/i, /\bupgrade notes?\b/i];

const MAX_LINES = 5;
const clean = (l: string) => l.replace(/^[\s#>*-]+/, '').replace(/\*\*/g, '').trim().slice(0, 240);

/** "v2.3.1", "2.3", "release-2.3.1" -> [2, 3, 1]; null when it is no version. */
export function versionParts(tag: string): number[] | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(tag.replace(/^(v|version|release)[-_ ]?/i, ''));
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/**
 * A pre-release by its tag: a version with rc, alpha, beta, preview and the
 * like after it ("v3.4.0-rc.1", "2.0.0beta2"). GitHub's own mark is read
 * beside this (server/src/docker/changelog.ts); not every project sets it.
 */
export function isPrerelease(tag: string): boolean {
  return /\d[-_.+~]?(?:rc|alpha|beta|pre|preview|dev|nightly|canary|snapshot|insiders?)(?:[-_.]?\d+)*(?:$|[-_.+])/i.test(tag.trim());
}

/** Orders two tags by their version parts; a tag that is no version comes first. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * The highest version among tags, or null. A release is a new major version
 * against the highest one before it, not against the one published just
 * before: a project that keeps two lines (valkey 8.0.12 after 9.0.7) would
 * otherwise mark every release of the newer line as a new major version.
 */
export function highestVersion(tags: string[]): string | null {
  let best: string | null = null;
  for (const t of tags) if (versionParts(t) && (best === null || compareVersions(t, best) > 0)) best = t;
  return best;
}

const NOT_A_VERSION = /^(latest|main|master|develop|dev|nightly|edge|stable|release|head)\b/i;
const ARCH_SUFFIX = /[-_](amd64|arm64|arm64v8|armv7|armhf|arm|x86_64|aarch64|i386)$/i;
/** Images whose own *_VERSION variable is named otherwise than the image. */
const ENV_ALIASES: Record<string, string> = { pg: 'postgres', postgresql: 'postgres' };

/**
 * The version an image runs, from what it says of itself (report 9190c5):
 * its org.opencontainers.image.version label, when that is a version (not
 * "latest" or "main"; "1.1.1-amd64" and "0.26.2.0+e472ecd7" as 1.1.1 and
 * 0.26.2.0); else its own *_VERSION variable, as the official images set
 * (PG_VERSION, REDIS_VERSION, NGINX_VERSION, VALKEY_VERSION); else its tag
 * when that is a whole version (nginx:1.27.3-alpine). Null when none says.
 */
export function imageVersion(image: string, label: string | null, env: string[] = []): string | null {
  const clean = (v: string) => v.trim().replace(/\+.*$/, '').replace(ARCH_SUFFIX, '');
  if (label) {
    const v = clean(label);
    if (/\d/.test(v) && !NOT_A_VERSION.test(v)) return v;
  }
  const name = (image.replace(/@.*$/, '').replace(/:[^/:]*$/, '').split('/').pop() ?? '').toLowerCase();
  for (const e of env) {
    const m = /^([A-Z][A-Z0-9_]*)_VERSION=v?(\d[\w.+~-]*)$/.exec(e);
    if (!m) continue;
    const prefix = m[1]!.toLowerCase().replace(/_/g, '-');
    const as = ENV_ALIASES[prefix] ?? prefix;
    if (name && (as === name || name.startsWith(as) || as.startsWith(name))) return clean(m[2]!);
  }
  const tag = /:([^/:@]+)(?:@.*)?$/.exec(image)?.[1] ?? '';
  const whole = /^v?(\d+\.\d+(?:\.\d+)*)(?:$|[-_])/.exec(tag);
  return whole ? whole[1]! : null;
}

/** The version line a tag follows ("9", "15-alpine", "1.25"): its leading numbers, or null ("latest"). */
export function tagLine(image: string): number[] | null {
  const tag = /:([^/:@]+)(?:@.*)?$/.exec(image)?.[1] ?? '';
  const m = /^v?(\d+)(?:\.(\d+))?(?:$|[-_])/.exec(tag);
  return m ? [Number(m[1]), ...(m[2] !== undefined ? [Number(m[2])] : [])] : null;
}

/** Whether a release tag is on a line (its leading numbers equal). */
export const onLine = (tag: string, line: number[]) => {
  const v = versionParts(tag);
  return !!v && line.every((n, i) => v[i] === n);
};

/** The flags of one release; `previous` is the tag of the release before it. */
export function releaseFlags(body: string, tag: string, previous: string | null): ReleaseFlags {
  const breaking: string[] = [];
  const important: string[] = [];
  // A heading such as "## Breaking changes": the lines under it count too, sub-headings included, up to the next heading at its level or above.
  let breakingLevel = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^\s*(#{1,6})\s/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (breakingLevel && level > breakingLevel) continue;
      breakingLevel = BREAKING.some((re) => re.test(line)) ? level : 0;
      if (breakingLevel) continue;
    }
    const underBreaking = breakingLevel > 0;
    const text = clean(line);
    if (!text) continue;
    if (underBreaking || BREAKING.some((re) => re.test(line))) {
      if (breaking.length < MAX_LINES && !breaking.includes(text)) breaking.push(text);
    } else if (IMPORTANT.some((re) => re.test(line)) && important.length < MAX_LINES && !important.includes(text)) important.push(text);
  }
  const now = versionParts(tag);
  const before = previous ? versionParts(previous) : null;
  // 0.x counts its minor as the major, as semantic versioning does.
  const major = !!now && !!before && (now[0]! > before[0]! || (now[0] === 0 && before[0] === 0 && now[1]! > before[1]!));
  return { breaking, important, major };
}

/** Whether a release needs reading before the update. */
export const needsReading = (f: ReleaseFlags) => f.breaking.length > 0 || f.major;

/**
 * A picture in release notes that Burrow may show: on GitHub's own image
 * hosts only (attachments, raw files, its image proxy). Fetched by the
 * server and served from Burrow (the browser never asks GitHub); anything
 * else stays a link.
 */
export function releaseImageAllowed(url: string): boolean {
  // https only, no user, no port: a host and a path ("shared" has no URL class).
  const m = /^https:\/\/([a-z0-9.-]+)(\/[^?#\s]*)(?:[?#][^\s]*)?$/i.exec(url);
  if (!m) return false;
  const host = m[1]!.toLowerCase();
  if (host === 'github.com') return /^\/(user-attachments\/assets\/[\w-]+|[\w.-]+\/[\w.-]+\/(assets|raw)\/.+)$/.test(m[2]!);
  return /^[a-z0-9-]+\.githubusercontent\.com$/.test(host);
}
