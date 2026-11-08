// Newer versions of an image under another tag: a container on nginx:1.25
// runs a version, and the registry may have 1.27 by now. A new digest for
// the same tag is an update (updates.ts); a newer tag is a choice, made by
// changing the compose file. Only tags of the same shape count: as many
// numbers, the same "v" in front and the same kind of suffix (1.25-alpine
// looks at 1.27-alpine, never at 1.27 or 1.27-rc1).

/** Container labels: which tags count (regular expressions on the tag). */
export const TAG_INCLUDE_LABEL = 'burrow.tag.include';
export const TAG_EXCLUDE_LABEL = 'burrow.tag.exclude';

/**
 * Whether a tag counts, from a label's pattern: the server makes it with RE2
 * (server/src/linear.ts), since a label is a pattern from a compose file.
 */
export type TagTest = (tag: string) => boolean;

export interface TagShape {
  v: boolean;
  nums: number[];
  /** "-alpine3.19" */
  suffix: string;
  /** The suffix with its numbers left out ("-alpine#"): what must match. */
  kind: string;
  /** The numbers in the suffix (3, 19): the tie-breaker. */
  suffixNums: number[];
}

const SHAPE = /^(v?)(\d{1,9}(?:\.\d{1,9}){0,3})((?:[-_+][A-Za-z0-9._-]*)?)$/;

export function tagShape(tag: string): TagShape | null {
  const m = SHAPE.exec(tag);
  if (!m) return null;
  const suffix = m[3] ?? '';
  return {
    v: m[1] === 'v',
    nums: m[2]!.split('.').map(Number),
    suffix,
    kind: suffix.replace(/\d+/g, '#'),
    suffixNums: (suffix.match(/\d+/g) ?? []).map(Number),
  };
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/**
 * The newest tag of the same shape that is a higher version than `current`,
 * or null. A date-like tag (20240101) never counts as a newer "2".
 */
export type UpdateLevel = 'patch' | 'minor' | 'major';
const LEVELS: UpdateLevel[] = ['patch', 'minor', 'major'];
export const levelRank = (l: UpdateLevel): number => LEVELS.indexOf(l);

/**
 * How big a step from version `from` to the newest of `to` is: major (the
 * first number), minor (the second) or patch (anything after). Null when
 * either cannot be read as a version.
 */
export function updateLevel(from: string | null, to: string[]): UpdateLevel | null {
  const a = from ? tagShape(from.trim()) : null;
  const newer = to.map((t) => tagShape(t.trim())).filter((x): x is TagShape => !!x && !!a && compare(x.nums, a.nums) > 0);
  if (!a || !newer.length) return null;
  let level: UpdateLevel = 'patch';
  for (const b of newer) {
    const l: UpdateLevel = (b.nums[0] ?? 0) !== (a.nums[0] ?? 0) ? 'major' : (b.nums[1] ?? 0) !== (a.nums[1] ?? 0) ? 'minor' : 'patch';
    if (levelRank(l) > levelRank(level)) level = l;
  }
  return level;
}

export function newerTag(current: string, tags: string[], filter: { include?: TagTest | null; exclude?: TagTest | null } = {}): string | null {
  const cur = tagShape(current);
  if (!cur) return null;
  let best: { tag: string; s: TagShape } | null = null;
  for (const tag of tags) {
    if (tag === current || tag.length > 128) continue;
    if (filter.include && !filter.include(tag)) continue;
    if (filter.exclude && filter.exclude(tag)) continue;
    const s = tagShape(tag);
    if (!s || s.v !== cur.v || s.nums.length !== cur.nums.length || s.kind !== cur.kind) continue;
    if (cur.nums[0]! < 1000 && s.nums[0]! >= 1000) continue;
    const vs = compare(s.nums, cur.nums);
    if (vs < 0 || (vs === 0 && compare(s.suffixNums, cur.suffixNums) <= 0)) continue;
    if (!best || compare(s.nums, best.s.nums) > 0 || (compare(s.nums, best.s.nums) === 0 && compare(s.suffixNums, best.s.suffixNums) > 0)) best = { tag, s };
  }
  return best?.tag ?? null;
}

/**
 * The compose file with one service's image moved to another tag: the
 * `image:` key of a service under `services:` that names it exactly, not an
 * `image:` line deeper in a service (environment) or inside a block of text
 * (a script). Null when the file names it some other way (a variable, an
 * anchor, a flow mapping): then by hand in the editor.
 */
export function retagCompose(content: string, image: string, tag: string): string | null {
  const colon = image.lastIndexOf(':');
  if (colon <= image.lastIndexOf('/')) return null;
  const name = image.slice(0, colon);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*image:\\s*["']?)${esc(image)}(["']?\\s*(?:#.*)?)$`);
  const lines = content.split('\n');
  let n = 0;
  // Indents: of the service names, of a service's own keys, and of the key whose block scalar (| or >) is being read.
  let inServices = false;
  let serviceIndent = -1;
  let keyIndent = -1;
  let block = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (block >= 0) {
      if (indent > block) continue;
      block = -1;
    }
    if (indent === 0) {
      inServices = /^services:\s*(?:#.*)?$/.test(line.trimEnd());
      serviceIndent = keyIndent = -1;
    } else if (inServices) {
      if (serviceIndent < 0) serviceIndent = indent;
      if (indent <= serviceIndent) keyIndent = -1;
      else {
        if (keyIndent < 0) keyIndent = indent;
        const m = indent === keyIndent ? re.exec(line) : null;
        if (m) {
          lines[i] = `${m[1]}${name}:${tag}${m[2]}`;
          n++;
        }
      }
    }
    if (/:\s*[|>][-+0-9]*\s*(?:#.*)?$/.test(line.trimEnd())) block = indent;
  }
  return n ? lines.join('\n') : null;
}
