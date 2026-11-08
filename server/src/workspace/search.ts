import { posix } from 'node:path';
import type { SearchMatch, SearchResult } from '@burrow/shared';
import { RE2JS } from 're2js';
import { shellQuote } from '../ssh/quote.js';

// Searching all files of a workspace on the host itself: ripgrep when the
// host has it (fast, respects .gitignore), grep otherwise. The same folders
// are skipped either way (.git, node_modules).

export const MAX_MATCHES = 2000;
export const MAX_FILES = 20_000;
const SKIP = ['.git', 'node_modules'];

export function searchCommand(root: string, query: string, regex: boolean, caseSensitive: boolean): string {
  const q = shellQuote(query);
  const rg = [
    `rg --json --no-messages --max-filesize 5M --max-count ${PER_FILE} --hidden`,
    ...SKIP.map((d) => `-g ${shellQuote(`!${d}`)}`),
    caseSensitive ? '-s' : '-i',
    regex ? '' : '-F',
    `-e ${q}`,
    // A path, always: without one rg reads stdin when it is not a terminal,
    // and over SSH it is a pipe that never ends.
    '.',
  ]
    .filter(Boolean)
    .join(' ');
  const grep = (mode: string, pattern: string) =>
    ['grep -rnI --no-messages', ...SKIP.map((d) => `--exclude-dir=${d}`), caseSensitive ? '' : '-i', mode, `-e ${shellQuote(pattern)}`, '.'].filter(Boolean).join(' ');
  // A regular expression as Replace reads it (RE2: \d, (?:...), lazy *?): grep's Perl mode when it has
  // one, else its extended one with \d made [0-9] (review 2026-10-24: \d found nothing without rg).
  const plain = regex ? `if echo | grep -qP '^' 2>/dev/null; then ${grep('-P', query)}; else ${grep('-E', asEre(query))}; fi` : grep('-F', query);
  // A folder that cannot be entered fails (exit 3), as in filesCommand: under bash a failed cd
  // exited 1, which is grep's and rg's "nothing found" (audit 2026-11-05).
  return `exec </dev/null; cd ${shellQuote(root)} || exit 3; if command -v rg >/dev/null 2>&1; then echo '@@rg'; ${rg}; else echo '@@grep'; ${plain}; fi`;
}

/** An RE2 expression for grep -E: \d and \D as POSIX classes (GNU grep reads \w, \s and \b itself). */
export function asEre(query: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i]!;
    if (c === '\\' && i + 1 < query.length) {
      const n = query[++i]!;
      if (n === 'd') out += inClass ? '0-9' : '[0-9]';
      else if (n === 'D' && !inClass) out += '[^0-9]';
      else out += c + n;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return out;
}

const rel = (p: string) => p.replace(/^\.\//, '');

/** As many matches as ripgrep lists in one file (--max-count). */
const PER_FILE = 200;

/** cut: the output stopped at its size limit. Either limit reached says "incomplete" (AUDIT2 FS-18). */
export function parseSearch(out: string, cut = false): SearchResult {
  const nl = out.indexOf('\n');
  const tool = out.slice(0, nl).trim() === '@@rg' ? 'rg' : 'grep';
  const body = out.slice(nl + 1);
  const matches: SearchMatch[] = [];
  for (const line of body.split('\n')) {
    if (!line || matches.length >= MAX_MATCHES) continue;
    if (tool === 'rg') {
      try {
        const m = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start: number }[] } };
        if (m.type !== 'match' || !m.data?.path?.text) continue;
        const text = (m.data.lines?.text ?? '').replace(/\r?\n$/, '');
        // rg counts bytes; the column is for the editor, in characters.
        const start = m.data.submatches?.[0]?.start ?? 0;
        const col = Buffer.from(text).subarray(0, start).toString('utf8').length + 1;
        matches.push({ path: rel(m.data.path.text), line: m.data.line_number ?? 1, col, text: text.slice(0, 500) });
      } catch {
        // Not a JSON line.
      }
    } else {
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (m) matches.push({ path: rel(m[1]!), line: Number(m[2]), col: 1, text: m[3]!.slice(0, 500) });
    }
  }
  const perFile = new Map<string, number>();
  for (const m of matches) perFile.set(m.path, (perFile.get(m.path) ?? 0) + 1);
  const full = tool === 'rg' && [...perFile.values()].some((n) => n >= PER_FILE);
  return { tool, matches, truncated: matches.length >= MAX_MATCHES || cut || full };
}

/** All files under the root, for quick open. */
/** How long a listing may take on the host before what it found by then is the answer (tests shorten it). */
export const listLimit = { seconds: 20 };
/** The line a listing cut off by that limit ends with. */
export const SLOW_MARK = '@@burrow-slow';

export function filesCommand(root: string): string {
  const rg = `rg --files --hidden --no-messages ${SKIP.map((d) => `-g ${shellQuote(`!${d}`)}`).join(' ')} . | sed 's#^\\./##'`;
  const find = `find . \\( ${SKIP.map((d) => `-name ${shellQuote(d)}`).join(' -o ')} \\) -prune -o -type f -print | sed 's#^\\./##'`;
  const list = `if command -v rg >/dev/null 2>&1; then ${rg}; else ${find}; fi`;
  // A folder that cannot be entered fails (exit 3), not "no files" (AUDIT2 FS-17). A huge folder
  // (a media disk) is listed for as long as the limit, then what was found is the answer, marked:
  // the 30 s of the SSH command ran out first and the page got "internal" (live log 2026-10-19).
  const limited = `if command -v timeout >/dev/null 2>&1; then timeout ${listLimit.seconds} sh -c ${shellQuote(list)}; [ $? -eq 124 ] && echo ${SLOW_MARK}; else ${list}; fi`;
  return `exec </dev/null; cd ${shellQuote(root)} || exit 3; { ${limited}; } | head -n ${MAX_FILES}`;
}

/** The listing's lines as files; whether it was cut off by the limit (slow) or by the count. */
export function parseFiles(stdout: string): { files: string[]; slow: boolean; truncated: boolean } {
  const lines = stdout.split('\n').filter(Boolean);
  const slow = lines.includes(SLOW_MARK);
  const files = lines.filter((l) => l !== SLOW_MARK);
  return { files, slow, truncated: slow || lines.length >= MAX_FILES };
}

/** A path from the page, relative to the root, as an absolute path that stays inside it. */
export function insideRoot(root: string, relPath: string): string | null {
  const full = posix.normalize(posix.join(root, relPath));
  const base = root.endsWith('/') ? root : `${root}/`;
  return full.startsWith(base) ? full : null;
}

/** A replacement may grow the file this much at most: past it, refused rather than a server out of memory. */
export const MAX_REPLACED = 50 << 20;

/**
 * The replacement the page asked for, with RE2 (re2js): its time grows with the
 * text, never exponentially, so a pattern that backtracks for ever cannot stall
 * the server (AUDIT2 FS-16); the result is bounded too. $1, $2 and $& in the
 * replacement, like the editor's own search panel. Line by line, as rg and grep
 * listed the hits: ^ and $ at each line, and no match across a line end.
 */
export function replaceAll(content: string, query: string, regex: boolean, caseSensitive: boolean, replacement: string): { text: string; count: number } {
  const re = RE2JS.compile(regex ? query : RE2JS.quote(query), caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  const parts: string[] = [];
  let size = 0;
  let count = 0;
  // Each line, then the end that followed it ("\n", "\r\n" or none).
  const lines = content.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i]!;
    const m = re.matcher(line);
    let at = 0;
    while (m.find()) {
      const start = m.start();
      const end = m.end();
      const by = regex ? replacement.replace(/\$(&|\d+)/g, (_, g: string) => (g === '&' ? (m.group(0) ?? '') : Number(g) <= m.groupCount() ? (m.group(Number(g)) ?? '') : '')) : replacement;
      parts.push(line.slice(at, start), by);
      size += start - at + by.length;
      if (size > MAX_REPLACED) throw new Error('the result would be too large');
      at = end;
      count++;
    }
    parts.push(line.slice(at), lines[i + 1] ?? '');
    size += line.length - at;
  }
  return { text: parts.join(''), count };
}
