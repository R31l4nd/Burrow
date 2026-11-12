import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Client, SFTPWrapper } from 'ssh2';
import type { DirListing, FileEntry, FileType, TextFile } from '@burrow/shared';
import { MAX_TEXT_BYTES, oneAtATime, realTarget, savableBytes, sha256, utf8Text } from '../files/service.js';
import { HttpError } from '../http.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';

// Files only root may read or write (/etc/..., a root-owned compose file):
// through sudo on the host, after a step-up. The password, when sudo wants
// one, goes to sudo's stdin (-S) and is never stored for this. Saving is
// like sudoedit: the new text goes to a private temporary file first, then
// sudo stages it beside the original (owner and mode copied) and renames it
// over the original in one step.

/** sh: walks a path's parts as the kernel would and exits 4 at a symbolic link not owned by root. */
const LINKS_ROOTS_ONLY = [
  'chk() { c=""; r="${1#/}"; n=0; while [ -n "$r" ]; do',
  'x="${r%%/*}"; case "$r" in */*) r="${r#*/}";; *) r="";; esac',
  '[ -n "$x" ] && [ "$x" != . ] || continue',
  'if [ -L "$c/$x" ]; then',
  '[ "$(stat -c %u -- "$c/$x")" = 0 ] || { echo "a link not owned by root: $c/$x" >&2; exit 4; }',
  'n=$((n+1)); [ "$n" -le 40 ] || { echo "too many links" >&2; exit 4; }',
  'l=$(readlink -- "$c/$x"); case "$l" in /*) c=""; r="${l#/}${r:+/$r}";; *) r="$l${r:+/$r}";; esac',
  'else c="$c/$x"; fi; done; }',
].join('\n');

const sudo = (password: string | null) => (password !== null ? "sudo -S -p ''" : 'sudo -n');

function sudoFailure(stderr: string): HttpError | null {
  if (/a password is required|a terminal is required|no tty present/i.test(stderr)) return new HttpError(401, 'sudo_password', 'sudo wants a password.');
  if (/incorrect password|Sorry, try again|\d+ incorrect password attempt/i.test(stderr)) return new HttpError(401, 'sudo_wrong_password', 'That sudo password was not accepted.');
  if (/not in the sudoers|not allowed to (run|execute)|may not run sudo/i.test(stderr)) return new HttpError(403, 'sudo_denied', 'This user may not use sudo on the host.');
  if (/sudo: .*command not found|sudo: not found/i.test(stderr)) return new HttpError(400, 'sudo_missing', 'sudo is not installed on the host.');
  return null;
}

export async function sudoRead(client: Client, path: string, password: string | null): Promise<TextFile> {
  const q = shellQuote(path);
  // Through a link to its file (-L), a regular file only, and its bytes
  // counted as read: a link's own size let a large target through, cut off
  // at the limit and opened as if whole; a shorter save then lost the rest
  // (AUDIT2 FS-03).
  const cmd = `${sudo(password)} sh -c '[ -f "$1" ] || { echo "not a regular file" >&2; exit 3; }; stat -L -c "%s %Y %a" -- "$1" && head -c ${MAX_TEXT_BYTES + 1} -- "$1" | base64 -w0' _ ${q}`;
  // In base64: the bytes as they are, so text that is not UTF-8 is seen, not decoded with replacements (AUDIT2 FS-30).
  const r = await exec(client, cmd, 20_000, Math.ceil((MAX_TEXT_BYTES + 1) / 3) * 4 + 4096, password !== null ? `${password}\n` : undefined);
  const fail = sudoFailure(r.stderr);
  if (fail) throw fail;
  if (r.code === 3) throw new HttpError(400, 'not_a_file', `${path} is not a regular file.`);
  if (r.code !== 0) throw new HttpError(r.stderr.includes('No such file') ? 404 : 400, 'sudo_failed', r.stderr.trim().split('\n').pop() || 'sudo failed');
  const nl = r.stdout.indexOf('\n');
  const [size = '0', mtime = '0', mode = '644'] = r.stdout.slice(0, nl).split(' ');
  const bytes = Buffer.from(r.stdout.slice(nl + 1).trim(), 'base64');
  if (Number(size) > MAX_TEXT_BYTES || bytes.length > MAX_TEXT_BYTES) throw new HttpError(413, 'too_large', 'The editor opens files up to 5 MB.');
  if (bytes.subarray(0, 8192).includes(0)) throw new HttpError(415, 'binary', 'This looks like a binary file.');
  const content = utf8Text(bytes);
  return { path, content, hash: sha256(bytes), size: Number(size), mtime: new Date(Number(mtime) * 1000).toISOString(), mode: parseInt(mode, 8) };
}

const TYPES: Record<string, FileType> = { f: 'file', d: 'dir', l: 'link' };
const LISTING_BYTES = 8 << 20;

/**
 * A folder only root may read, listed through sudo (report 4d30e6): to look and to open its text
 * files through sudoRead, nothing changed in it. GNU find's -printf, every field ended by a NUL (a
 * name may hold any other byte); a link's target and the type of what it points to (N: none).
 */
export async function sudoList(client: Client, home: string, path: string, password: string | null): Promise<DirListing> {
  const fields = '%y\\0%Y\\0%s\\0%T@\\0%m\\0%u\\0%g\\0%l\\0%f\\0';
  const cmd = `${sudo(password)} sh -c '[ -d "$1" ] || { echo "not a folder" >&2; exit 3; }; find "$1/" -mindepth 1 -maxdepth 1 -printf "${fields}"' _ ${shellQuote(path)}`;
  const r = await exec(client, cmd, 20_000, LISTING_BYTES, password !== null ? `${password}\n` : undefined);
  const fail = sudoFailure(r.stderr);
  if (fail) throw fail;
  if (r.code === 3) throw new HttpError(400, 'not_a_folder', `${path} is not a folder.`);
  if (r.code !== 0) throw new HttpError(r.stderr.includes('No such file') ? 404 : 400, 'sudo_failed', r.stderr.trim().split('\n').pop() || 'sudo failed');
  const parts = r.stdout.split('\0');
  const entries: FileEntry[] = [];
  for (let i = 0; i + 9 <= parts.length; i += 9) {
    const [y = '', ty = '', size = '0', mtime = '0', mode = '0', owner = '', group = '', target = '', name = ''] = parts.slice(i, i + 9);
    const e: FileEntry = { name, path: path === '/' ? `/${name}` : `${path}/${name}`, type: TYPES[y] ?? 'other', size: Number(size), mtime: new Date(Math.floor(Number(mtime)) * 1000).toISOString(), mode: parseInt(mode, 8), owner, group };
    if (e.type === 'link') {
      e.target = target;
      e.targetType = ty === 'N' || ty === 'L' ? 'broken' : (TYPES[ty] ?? 'other');
    }
    entries.push(e);
  }
  return { path, parent: path === '/' ? null : posix.dirname(path), home, entries };
}

export async function sudoWrite(
  client: Client,
  sftp: SFTPWrapper,
  path: string,
  content: string,
  baseHash: string,
  password: string | null,
  /** Which host: saves to one file go one at a time (with the editor's own saves too). */
  host: number | string = '',
): Promise<{ ok: true; file: TextFile } | { ok: false; current: TextFile }> {
  // What may be written, before anything changes (AUDIT2 FS-08); one lock
  // with the editor's own saves of the same file, whatever its spelling (FS-02).
  savableBytes(content);
  const target = await realTarget(sftp, path);
  return oneAtATime(`${host}:${target}`, () => sudoWriteNow(client, sftp, path, content, baseHash, password));
}

async function sudoWriteNow(
  client: Client,
  sftp: SFTPWrapper,
  path: string,
  content: string,
  baseHash: string,
  password: string | null,
): Promise<{ ok: true; file: TextFile } | { ok: false; current: TextFile }> {
  const current = await sudoRead(client, path, password);
  if (current.hash !== baseHash) return { ok: false, current };
  const tmp = `/tmp/.burrow-sudo-${randomBytes(6).toString('hex')}`;
  await new Promise<void>((resolve, reject) => sftp.writeFile(tmp, Buffer.from(content, 'utf8'), { mode: 0o600 }, (err) => (err ? reject(err) : resolve())));
  try {
    // As root: staged beside the target (through a symlink to its file),
    // given the target's owner and mode, then renamed over it in one step.
    // "cat > file" truncated the original first: a full disk or a broken
    // connection left an empty /etc file. A failed staging is removed.
    const script = [
      'set -e',
      // Every link on the way must be root's: one a less trusted user planted (in /tmp, a
      // bind-mounted folder) sent root's write wherever it pointed (A3-SRV-21).
      LINKS_ROOTS_ONLY,
      'chk "$2"',
      't=$(readlink -f -- "$2")',
      'n="$(dirname -- "$t")/.$(basename -- "$t").burrow-$3"',
      'gone() { rm -f -- "$n"; }',
      'trap gone EXIT',
      // Private from the start, and only a file of its own: other users cannot read the
      // staged copy of a private file before its mode is set (AUDIT2 FS-26).
      'umask 077',
      'set -C',
      'cat -- "$1" > "$n"',
      'set +C',
      'chown "$(stat -c %u:%g -- "$t")" "$n"',
      'chmod "$(stat -c %a -- "$t")" "$n"',
      'mv -f -- "$n" "$t"',
      'trap - EXIT',
    ].join('; ');
    const r = await exec(client, `${sudo(password)} sh -c ${shellQuote(script)} _ ${shellQuote(tmp)} ${shellQuote(path)} ${randomBytes(4).toString('hex')}`, 20_000, 64 * 1024, password !== null ? `${password}\n` : undefined);
    const fail = sudoFailure(r.stderr);
    if (fail) throw fail;
    if (r.code === 4) throw new HttpError(409, 'sudo_link', `Not saved as root: ${r.stderr.trim().split('\n').pop() || 'the path goes through a link that root does not own'}.`);
    if (r.code !== 0) throw new HttpError(400, 'sudo_failed', r.stderr.trim().split('\n').pop() || 'sudo failed');
  } finally {
    await new Promise<void>((resolve) => sftp.unlink(tmp, () => resolve()));
  }
  return { ok: true, file: await sudoRead(client, path, password) };
}
