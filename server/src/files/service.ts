import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Client, FileEntry as SftpEntry, SFTPWrapper, Stats } from "ssh2";
import type { DirListing, FileEntry, FileType, TextFile } from "@burrow/shared";
import { HttpError } from "../http.js";
import { exec, execChannel } from "../ssh/connect.js";
import { shellArgs, shellQuote } from "../ssh/quote.js";

// File operations on one host. SFTP where it is enough (listing, reading,
// writing, renaming); the host's own tools over SSH where they do the job
// better (recursive delete and copy, chmod -R, archives, du, find).

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const S_IFMT = 0o170000;
const typeOf = (mode: number): FileType =>
  (mode & S_IFMT) === 0o040000
    ? "dir"
    : (mode & S_IFMT) === 0o100000
      ? "file"
      : (mode & S_IFMT) === 0o120000
        ? "link"
        : "other";

function sftpError(err: unknown, path: string): HttpError {
  const e = err as { code?: number; message?: string };
  // SFTP status codes: 2 no such file, 3 permission denied, 4 failure.
  if (e.code === 2)
    return new HttpError(404, "not_found", `${path} does not exist.`);
  if (e.code === 3)
    return new HttpError(
      403,
      "permission_denied",
      `No permission for ${path}.`,
    );
  return new HttpError(502, "sftp_error", e.message ?? String(err));
}

const p = <T>(
  fn: (cb: (err: Error | null | undefined, v: T) => void) => void,
): Promise<T> =>
  new Promise((resolve, reject) =>
    fn((err, v) => (err ? reject(err) : resolve(v))),
  );

export function normalize(path: string, home: string): string {
  // "~" and "~/..." are the home; "~name" (another user's) is left as typed, as the terminal's completion does.
  let out = path === "~" || path.startsWith("~/") ? home + path.slice(1) : path;
  if (!out.startsWith("/")) out = `${home}/${out}`;
  out = posix.normalize(out);
  return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

/**
 * Refuse obviously catastrophic targets for recursive operations. Compared
 * as paths, not as spellings: "/home/me/", "//home//me" and "/home/me/."
 * are the home too (AUDIT2 FS-24).
 */
export function guardDestructive(path: string, home: string): void {
  const clean = (p: string) => posix.normalize(p).replace(/\/+$/, "") || "/";
  const p = clean(path);
  const depth = p.split("/").filter(Boolean).length;
  if (p === "/" || p === clean(home) || depth < 1) {
    throw new HttpError(400, "refused", `Burrow will not do this to ${path}.`);
  }
}

/** Owner and group names from an `ls -l`-style longname. */
function ownersFromLongname(longname: string): {
  owner: string;
  group: string;
} {
  const parts = longname.split(/\s+/);
  return { owner: parts[2] ?? "", group: parts[3] ?? "" };
}

export async function list(
  sftp: SFTPWrapper,
  home: string,
  rawPath: string,
): Promise<DirListing> {
  const path = normalize(rawPath, home);
  const items = await p<SftpEntry[]>((cb) => sftp.readdir(path, cb)).catch(
    (err) => {
      throw sftpError(err, path);
    },
  );
  const entries: FileEntry[] = await Promise.all(
    items.map(async (it) => {
      const full = path === "/" ? `/${it.filename}` : `${path}/${it.filename}`;
      const e: FileEntry = {
        name: it.filename,
        path: full,
        type: typeOf(it.attrs.mode),
        size: it.attrs.size,
        mtime: new Date(it.attrs.mtime * 1000).toISOString(),
        mode: it.attrs.mode & 0o7777,
        ...ownersFromLongname(it.longname),
      };
      if (e.type === "link") {
        e.target = await p<string>((cb) => sftp.readlink(full, cb)).catch(
          () => undefined,
        );
        const st = await p<Stats>((cb) => sftp.stat(full, cb)).catch(
          () => null,
        );
        e.targetType = st ? typeOf(st.mode) : "broken";
      }
      return e;
    }),
  );
  return {
    path,
    parent: path === "/" ? null : posix.dirname(path),
    home,
    entries,
  };
}

/** null only when there is nothing there; any other failure is an error, not "absent" (AUDIT2 FS-12). */
export async function stat(
  sftp: SFTPWrapper,
  path: string,
): Promise<Stats | null> {
  return p<Stats>((cb) => sftp.stat(path, cb)).catch((err: { code?: number }) => {
    if (err?.code === 2) return null;
    throw sftpError(err, path);
  });
}

/** Removed, or already gone: true; a failure (no permission, host away): false. */
export async function removeIfThere(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return p<void>((cb) => sftp.unlink(path, (err) => cb(err, undefined))).then(
    () => true,
    (err: { code?: number }) => err?.code === 2,
  );
}

export async function create(
  sftp: SFTPWrapper,
  path: string,
  kind: "file" | "dir",
): Promise<void> {
  if (await stat(sftp, path))
    throw new HttpError(
      409,
      "exists",
      `${posix.basename(path)} already exists.`,
    );
  try {
    if (kind === "dir")
      await p<void>((cb) => sftp.mkdir(path, (err) => cb(err, undefined)));
    else {
      const h = await p<Buffer>((cb) => sftp.open(path, "wx", cb));
      await p<void>((cb) => sftp.close(h, (err) => cb(err, undefined)));
    }
  } catch (err) {
    throw sftpError(err, path);
  }
}

export async function rename(
  sftp: SFTPWrapper,
  from: string,
  to: string,
): Promise<void> {
  if (await stat(sftp, to))
    throw new HttpError(409, "exists", `${posix.basename(to)} already exists.`);
  await p<void>((cb) =>
    sftp.rename(from, to, (err) => cb(err, undefined)),
  ).catch((err) => {
    throw sftpError(err, from);
  });
}

async function run(
  client: Client,
  command: string,
  timeoutMs = 60_000,
): Promise<string> {
  const r = await exec(client, command, timeoutMs, 4 << 20);
  // Cut off is not the answer: a listing or a sum of part of it (AUDIT2 DO-13).
  if (r.truncated) throw new HttpError(400, "command_failed", "The host's answer was larger than Burrow reads (4 MB).");
  if (r.code !== 0)
    throw new HttpError(
      400,
      "command_failed",
      (r.stderr || r.stdout).trim().slice(0, 500) || `exit ${r.code}`,
    );
  return r.stdout;
}

export async function remove(
  client: Client,
  home: string,
  paths: string[],
): Promise<void> {
  for (const path of paths) guardDestructive(path, home);
  await run(client, `rm -rf -- ${shellArgs(paths)}`, 10 * 60_000);
}

export async function chmod(
  client: Client,
  path: string,
  mode: number,
  recursive: boolean,
): Promise<void> {
  await run(
    client,
    `chmod ${recursive ? "-R " : ""}${mode.toString(8)} -- ${shellQuote(path)}`,
    10 * 60_000,
  );
}

export async function chown(
  client: Client,
  home: string,
  path: string,
  owner: string,
  group: string | undefined,
  recursive: boolean,
): Promise<void> {
  if (recursive) guardDestructive(path, home);
  await run(
    client,
    `chown ${recursive ? "-R " : ""}${shellQuote(group ? `${owner}:${group}` : owner)} -- ${shellQuote(path)}`,
    10 * 60_000,
  );
}

/**
 * Size of a path in bytes (du), for directories, with how many files and
 * folders are below it (report 1b1aa2); a count find did not give is null,
 * not 0.
 */
export async function du(client: Client, path: string): Promise<{ bytes: number; files: number | null; dirs: number | null }> {
  // -s summary, -k kilobytes: works with GNU and busybox du. find takes no
  // "--": the path is absolute (checked before). The folder itself is not
  // counted: one folder less than find names.
  const p = shellQuote(path);
  const out = await run(
    client,
    `du -sk -- ${p} 2>/dev/null | tail -n1; echo "@@dirs $(find ${p} -type d 2>/dev/null | wc -l)"; echo "@@files $(find ${p} ! -type d 2>/dev/null | wc -l)"`,
    5 * 60_000,
  ).catch(() => "");
  const kb = Number(out.trim().split(/\s+/)[0]);
  if (!Number.isFinite(kb) || !out.trim())
    throw new HttpError(400, "command_failed", "du gave no answer.");
  const count = (name: string) => {
    const n = Number(new RegExp(`^@@${name} +(\\d+)$`, "m").exec(out)?.[1]);
    return Number.isFinite(n) ? n : null;
  };
  const dirs = count("dirs");
  return { bytes: kb * 1024, files: count("files"), dirs: dirs === null ? null : Math.max(0, dirs - 1) };
}

export async function search(
  client: Client,
  dir: string,
  name: string,
): Promise<string[]> {
  // find takes no "--": a folder that is not absolute could be an expression.
  if (!dir.startsWith("/")) throw new HttpError(400, "invalid_path", "An absolute path.");
  const pattern = `*${name.replace(/[[\]*?\\]/g, (c) => `\\${c}`)}*`;
  // A folder that is not there, or cannot be read, fails; folders below it
  // that cannot be read are skipped, as find does (AUDIT2 FS-17).
  const out = await run(
    client,
    `[ -d ${shellQuote(dir)} ] && [ -r ${shellQuote(dir)} ] || { echo "cannot read ${dir.replace(/[^\w./ -]/g, '')}" >&2; exit 3; }; find ${shellQuote(dir)} -maxdepth 8 -iname ${shellQuote(pattern)} 2>/dev/null | head -n 500; true`,
    60_000,
  );
  return out.split("\n").filter(Boolean);
}

export async function copyLocal(
  client: Client,
  paths: string[],
  toDir: string,
  move: boolean,
  overwrite: boolean,
): Promise<void> {
  if (overwrite) {
    await run(client, `${move ? "mv" : "cp -a"} -f -- ${shellArgs(paths)} ${shellQuote(`${toDir}/`)}`, 60 * 60_000);
    return;
  }
  // Said at once when the name is taken; and refused again at the moment
  // each one is put in place, as something may have appeared since (another
  // tab, a program on the host): the check and cp/mv were two steps and the
  // second replaced it (AUDIT2 FS-01). mv -nT renames without replacing (and
  // never into a folder of that name); a copy is made beside it first, then
  // renamed in the same way. What is still where it was had its name taken.
  await assertNoClash(client, paths, toDir);
  const script = [
    'd="$1"; m="$2"; shift 2',
    'taken() { [ -e "$1" ] || [ -L "$1" ]; }',
    'for s in "$@"; do',
    '  b=$(basename -- "$s"); t="$d/$b"',
    '  if [ "$m" = 1 ]; then',
    '    mv -nT -- "$s" "$t" 2>/dev/null',
    '    if taken "$s"; then if taken "$t"; then echo "$b"; else echo "could not move $b" >&2; exit 2; fi; fi',
    '  else',
    '    w=$(mktemp -d "$d/.burrow-copy.XXXXXX") || exit 2',
    '    cp -a -- "$s" "$w/$b" || { rm -rf -- "$w"; exit 2; }',
    '    mv -nT -- "$w/$b" "$t" 2>/dev/null',
    '    if taken "$w/$b"; then if taken "$t"; then echo "$b"; else rm -rf -- "$w"; echo "could not copy $b" >&2; exit 2; fi; fi',
    '    rm -rf -- "$w"',
    '  fi',
    'done',
  ].join("\n");
  const out = await run(client, `sh -c ${shellQuote(script)} sh ${shellQuote(toDir)} ${move ? 1 : 0} ${shellArgs(paths)}`, 60 * 60_000);
  const clash = out.split("\n").filter(Boolean);
  if (clash.length)
    throw new HttpError(409, "exists", `Already in the destination: ${clash.join(", ")}`);
}

async function assertNoClash(
  client: Client,
  paths: string[],
  toDir: string,
): Promise<void> {
  const clash = await clashes(client, paths, toDir);
  if (clash.length)
    throw new HttpError(
      409,
      "exists",
      `Already in the destination: ${clash.map((c) => posix.basename(c)).join(", ")}`,
    );
}

/** The items whose name is taken in `toDir` already. */
export async function clashes(client: Client, paths: string[], toDir: string): Promise<string[]> {
  const out = await run(client, `for f in ${shellArgs(paths.map((p0) => `${toDir}/${posix.basename(p0)}`))}; do { [ -e "$f" ] || [ -L "$f" ]; } && echo "$f"; done; true`);
  const taken = new Set(out.split("\n").filter(Boolean).map((f) => posix.basename(f)));
  return paths.filter((p0) => taken.has(posix.basename(p0)));
}

/**
 * Both kept (report dfda31: a paste where the name was taken only failed): a folder of its own in
 * `toDir` that the copy goes into first, each item put in place after under a free name.
 */
export async function keepBothFolder(client: Client, toDir: string): Promise<string> {
  const out = (await run(client, `mktemp -d ${shellQuote(`${toDir}/.burrow-copy.XXXXXX`)}`)).trim();
  if (!out.startsWith(`${toDir}/.burrow-copy.`)) throw new HttpError(400, "command_failed", "Could not make a folder for the copy.");
  return out;
}

/**
 * The items in `from` (a keepBothFolder) into `toDir`, each under its own name or, where that is
 * taken, "name (1).txt", "name (2).txt", ... (a folder's whole name, an archive's .tar.gz kept
 * together), as Material Files and Nautilus do; `from` removed when empty. Never replaces: mv -nT,
 * and when the name was taken meanwhile the next one. The names given, in order.
 */
export async function placeKeepingBoth(client: Client, from: string, names: string[], toDir: string): Promise<string[]> {
  const script = [
    't="$1"; d="$2"; shift 2',
    'taken() { [ -e "$1" ] || [ -L "$1" ]; }',
    'for b in "$@"; do',
    '  s="$t/$b"; taken "$s" || continue',
    '  stem="$b"; ext=""',
    '  if [ ! -d "$s" ] || [ -L "$s" ]; then case "$b" in ?*.tar.*) stem="${b%.tar.*}"; ext=".tar.${b##*.tar.}";; ?*.*) stem="${b%.*}"; ext=".${b##*.}";; esac; fi',
    '  n=0; name="$b"',
    '  while :; do',
    '    if ! taken "$d/$name"; then mv -nT -- "$s" "$d/$name" 2>/dev/null; taken "$s" || break; fi',
    '    n=$((n+1)); name="$stem ($n)$ext"',
    '    [ "$n" -gt 9999 ] && { echo "no free name for $b" >&2; exit 2; }',
    '  done',
    '  echo "$name"',
    'done',
    'rmdir -- "$t" 2>/dev/null; true',
  ].join("\n");
  const out = await run(client, `sh -c ${shellQuote(script)} sh ${shellQuote(from)} ${shellQuote(toDir)} ${shellArgs(names)}`, 10 * 60_000);
  return out.split("\n").filter(Boolean);
}

/** No byte for this long: the copy is stuck, and both ends are closed. */
const COPY_STALL_MS = 120_000;

/**
 * One tar stream from a source channel into a destination channel. Both are
 * owned together: one that fails to open closes the other, a stall closes
 * both, and only two exit statuses of 0 are a copy (AUDIT2 FS-10).
 */
async function pipeTar(src: Client, srcCmd: string, dst: Client, dstCmd: string, onBytes: (n: number) => void): Promise<number> {
  const [o, i] = await Promise.allSettled([execChannel(src, srcCmd), execChannel(dst, dstCmd)]);
  if (o.status === "rejected" || i.status === "rejected") {
    if (o.status === "fulfilled") o.value.close();
    if (i.status === "fulfilled") i.value.close();
    throw o.status === "rejected" ? o.reason : (i as PromiseRejectedResult).reason;
  }
  const out = o.value;
  const inp = i.value;
  return new Promise<number>((resolve, reject) => {
    let bytes = 0;
    let srcErr = "";
    let dstErr = "";
    let srcCode: number | null | undefined;
    let ended = false;
    const fail = (err: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(stall);
      out.close();
      inp.close();
      reject(err);
    };
    let stall = setTimeout(() => fail(new HttpError(504, "copy_stalled", "The copy stopped moving.")), COPY_STALL_MS);
    const moved = () => {
      clearTimeout(stall);
      stall = setTimeout(() => fail(new HttpError(504, "copy_stalled", "The copy stopped moving.")), COPY_STALL_MS);
    };
    const keep = (s: string, d: Buffer) => (s.length < 4096 ? s + d.toString() : s);
    out.stderr.on("data", (d: Buffer) => (srcErr = keep(srcErr, d)));
    inp.stderr.on("data", (d: Buffer) => (dstErr = keep(dstErr, d)));
    out.on("error", (err: Error) => fail(err));
    inp.on("error", (err: Error) => fail(err));
    // Forward by hand, with backpressure, and send end-of-input when the
    // source is done so tar on the destination can finish.
    out.on("data", (d: Buffer) => {
      bytes += d.length;
      moved();
      onBytes(bytes);
      if (!inp.write(d)) out.pause();
    });
    inp.on("drain", () => out.resume());
    out.on("close", (code: number | null) => {
      srcCode = code;
      inp.end();
    });
    // The destination's stdout must be read, or its channel never closes;
    // tar prints nothing there anyway.
    inp.resume();
    inp.on("close", (code: number | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(stall);
      if (srcCode !== 0) {
        out.close();
        return reject(new HttpError(400, "command_failed", srcCode === null || srcCode === undefined ? "tar on the source ended without an exit status." : `tar on the source: ${srcErr.trim().slice(0, 300)}`));
      }
      if (code !== 0) return reject(new HttpError(400, "command_failed", `tar on the destination: ${dstErr.trim().slice(0, 300)}`));
      resolve(bytes);
    });
  });
}

/**
 * The destination's side of a copy between hosts: unpacks into `toDir` only
 * the names that were asked for (and what is below them), never another
 * member a source sends along (~/.ssh beside the folder, ../ paths are
 * dropped by tar itself). As the destination's SSH user, under its umask,
 * and without set-user-id or set-group-id bits on files: a source that is
 * not to be trusted could leave a root-owned set-user-id program (audit
 * 2026-11-05). GNU tar reads the names literally; busybox and bsdtar read
 * them as patterns, so their * ? [ \ are escaped there. Both take
 * --no-same-owner and --no-same-permissions.
 */
export function untarCommand(toDir: string, names: string[], overwrite: boolean): string {
  // Not overwriting holds while unpacking too (-k): something that
  // arrived after the check is refused, and a move keeps its source.
  const x = (list: string[]) => `tar -C ${shellQuote(toDir)} ${overwrite ? "" : "-k "}--no-same-owner --no-same-permissions -xf - -- ${shellArgs(list)}`;
  const strip = `cd -- ${shellQuote(toDir)} && find ${shellArgs(names.map((n) => `./${n}`))} -type f \\( -perm -4000 -o -perm -2000 \\) -exec chmod ug-s {} +`;
  return `if tar --version 2>/dev/null | grep -q 'GNU tar'; then ${x(names)}; else ${x(names.map((n) => n.replace(/[*?[\\]/g, "\\$&")))}; fi && ${strip}`;
}

/**
 * Copy between two hosts: tar on the source, tar on the destination, the
 * byte stream piped through Burrow. Works for files and whole trees, keeps
 * times (permissions under the destination's umask, owned by its SSH user),
 * and needs nothing but tar on either side.
 */
export async function copyBetweenHosts(
  src: Client,
  dst: Client,
  paths: string[],
  toDir: string,
  overwrite: boolean,
  onProgress?: (bytes: number) => void,
): Promise<number> {
  if (!overwrite) await assertNoClash(dst, paths, toDir);
  // Group by parent directory: tar -C takes one directory per invocation.
  const byParent = new Map<string, string[]>();
  for (const path of paths)
    byParent.set(posix.dirname(path), [
      ...(byParent.get(posix.dirname(path)) ?? []),
      posix.basename(path),
    ]);
  let total = 0;
  for (const [parent, names] of byParent) {
    const before = total;
    total += await pipeTar(
      src,
      `tar -C ${shellQuote(parent)} -cf - -- ${shellArgs(names)}`,
      dst,
      untarCommand(toDir, names, overwrite),
      // All folders' bytes so far, not this folder's alone (AUDIT2 FS-27).
      (n) => onProgress?.(before + n),
    );
  }
  return total;
}

const NO_HASH_TOOL = 3;

/**
 * sha256 of every file under the items (in `parent`), keyed by its path
 * below `parent` ("./photos/a.jpg"); null when the host has neither
 * sha256sum nor shasum.
 */
export async function treeChecksums(client: Client, parent: string, names: string[]): Promise<Map<string, string> | null> {
  // Each stage's failure counts (a pipe kept only the last one's): the list
  // of files first, its own status checked, then the sums (AUDIT2 FS-11).
  const cmd = [
    `H=; if command -v sha256sum >/dev/null 2>&1; then H=sha256sum; elif command -v shasum >/dev/null 2>&1; then H='shasum -a 256'; else exit ${NO_HASH_TOOL}; fi;`,
    `L=$(mktemp) || exit 5; trap 'rm -f "$L"' EXIT;`,
    `cd -- ${shellQuote(parent)} || exit 6;`,
    `find ${shellArgs(names.map((n) => `./${n}`))} -type f -print0 > "$L" || { echo 'listing the files failed' >&2; exit 7; };`,
    `LC_ALL=C sort -z "$L" | xargs -0r $H --`,
  ].join(' ');
  const r = await exec(client, cmd, 60 * 60_000, 64 << 20);
  if (r.code === NO_HASH_TOOL) return null;
  if (r.code !== 0) throw new HttpError(400, "command_failed", `checksums: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}`);
  // Cut off or not readable as sums: not a list to compare against.
  if (r.truncated) throw new HttpError(400, "command_failed", "checksums: too many files to compare in one go");
  return parseChecksums(r.stdout, true);
}

const NOT_UTF8 = "This file is not UTF-8 text: saved from here its other characters would change. Download it instead.";

/**
 * The bytes as text when they are UTF-8; refused otherwise. Decoded with
 * replacements and saved again as UTF-8, a Latin-1 file changed bytes no one
 * edited (AUDIT2 FS-30). A byte order mark stays in the text, so a save keeps it.
 */
export function utf8Text(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new HttpError(415, "not_utf8", NOT_UTF8);
  }
}

/** sha256sum's lines ("<hash>  <path>"; "*" before the path in binary mode) as path -> hash. */
export function parseChecksums(out: string, strict = false): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const x = /^\\?([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (x) m.set(x[2]!, x[1]!);
    else if (strict) throw new HttpError(400, "command_failed", `checksums: an unreadable line (${line.slice(0, 80)})`);
  }
  return m;
}

/** The files that differ (or are missing) on the destination, by path. */
export function checksumMismatches(src: Map<string, string>, dst: Map<string, string>): string[] {
  return [...src].filter(([path, hash]) => dst.get(path) !== hash).map(([path]) => path);
}

/**
 * After a copy between hosts: every file's sha256 on both sides, so a copy
 * that came through damaged (or a disk that wrote it wrong) is said, and a
 * move keeps its source. Hosts without a sha256 tool: not checked, and why.
 */
export async function verifyCopy(src: Client, dst: Client, paths: string[], toDir: string): Promise<{ files: number; sources: Map<string, Map<string, string>> } | { skipped: string }> {
  const byParent = new Map<string, string[]>();
  for (const path of paths) byParent.set(posix.dirname(path), [...(byParent.get(posix.dirname(path)) ?? []), posix.basename(path)]);
  let files = 0;
  const sources = new Map<string, Map<string, string>>();
  for (const [parent, names] of byParent) {
    const [a, b] = await Promise.all([treeChecksums(src, parent, names), treeChecksums(dst, toDir, names)]);
    if (!a || !b) return { skipped: !a ? "source" : "destination" };
    sources.set(parent, a);
    const bad = checksumMismatches(a, b);
    if (bad.length) {
      const names = `${bad.slice(0, 5).map((x) => x.replace(/^\.\//, "")).join(", ")}${bad.length > 5 ? ` (+${bad.length - 5})` : ""}`;
      // The names apart, for a message in the reader's language.
      throw Object.assign(new HttpError(409, "verify_failed", `Not the same on the destination after copying (sha256): ${names}`), { detail: names });
    }
    files += a.size;
  }
  return { files, sources };
}

/**
 * Before a move removes its sources: they are still what was copied and
 * checked. A file changed, or one added, since then keeps the sources
 * where they are (AUDIT2 FS-05).
 */
export async function sourcesUnchanged(src: Client, paths: string[], checked: Map<string, Map<string, string>>): Promise<string[]> {
  const byParent = new Map<string, string[]>();
  for (const path of paths) byParent.set(posix.dirname(path), [...(byParent.get(posix.dirname(path)) ?? []), posix.basename(path)]);
  const changed: string[] = [];
  for (const [parent, names] of byParent) {
    const now = await treeChecksums(src, parent, names);
    const before = checked.get(parent);
    if (!now || !before) return ["(not checked)"];
    for (const [p, h] of now) if (before.get(p) !== h) changed.push(p.replace(/^\.\//, ""));
    for (const p of before.keys()) if (!now.has(p)) changed.push(p.replace(/^\.\//, ""));
  }
  return changed;
}

export async function archive(
  client: Client,
  paths: string[],
  dest: string,
): Promise<void> {
  const parent = posix.dirname(paths[0]!);
  if (paths.some((x) => posix.dirname(x) !== parent))
    throw new HttpError(
      400,
      "invalid_request",
      "Archive items from one folder at a time.",
    );
  const names = paths.map((x) => posix.basename(x));
  // Made under a name of its own beside it, then linked to its name, which
  // fails when that name is taken: another archive or file that appeared
  // after the check is never replaced (AUDIT2 FS-01).
  const zip = /\.zip$/i.test(dest);
  const tmp = `${posix.dirname(dest)}/.${posix.basename(dest)}.burrow-${randomBytes(4).toString("hex")}${zip ? ".zip" : ".tar.gz"}`;
  const build = zip
    ? `cd ${shellQuote(parent)} && zip -qr ${shellQuote(tmp)} -- ${shellArgs(names)}`
    : `tar -C ${shellQuote(parent)} -czf ${shellQuote(tmp)} -- ${shellArgs(names)}`;
  const publish = [
    't="$1"; d="$2"',
    'if ln -- "$t" "$d" 2>/dev/null; then rm -f -- "$t"',
    'elif [ -e "$d" ] || [ -L "$d" ]; then rm -f -- "$t"; echo @@exists',
    'else mv -nT -- "$t" "$d" 2>/dev/null; if [ -e "$t" ]; then rm -f -- "$t"; echo @@exists; fi; fi',
  ].join("\n");
  const cmd = `{ ${build}; } || { rc=$?; rm -f -- ${shellQuote(tmp)}; exit $rc; }; sh -c ${shellQuote(publish)} sh ${shellQuote(tmp)} ${shellQuote(dest)}`;
  const out = await run(client, cmd, 60 * 60_000).catch((err: HttpError) => {
    if (/not found/.test(err.message))
      throw new HttpError(
        400,
        "tool_missing",
        "The archive tool (zip or tar) is not installed on the host.",
      );
    throw err;
  });
  if (out.includes("@@exists"))
    throw new HttpError(409, "exists", `${posix.basename(dest)} already exists.`);
}

export async function extract(
  client: Client,
  path: string,
  toDir: string,
): Promise<void> {
  const cmd = /\.zip$/i.test(path)
    ? `unzip -oq ${shellQuote(path)} -d ${shellQuote(toDir)}`
    : /\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2|tar)$/i.test(path)
      ? `tar -C ${shellQuote(toDir)} -xf ${shellQuote(path)}`
      : null;
  if (!cmd)
    throw new HttpError(
      400,
      "unsupported",
      "Not an archive Burrow can extract (zip, tar, tar.gz, tar.xz, tar.bz2).",
    );
  await run(client, cmd, 60 * 60_000).catch((err: HttpError) => {
    if (/not found/.test(err.message))
      throw new HttpError(
        400,
        "tool_missing",
        "The tool for this archive (unzip or tar) is not installed on the host.",
      );
    throw err;
  });
}

// ---- text files for the editor

export const sha256 = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");

/** At most `max` bytes of a file, read piece by piece (never the whole of a file larger than its stat said). */
async function readUpTo(sftp: SFTPWrapper, path: string, max: number): Promise<Buffer> {
  const h = await p<Buffer>((cb) => sftp.open(path, "r", cb));
  try {
    const parts: Buffer[] = [];
    let got = 0;
    while (got < max) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, max - got));
      const n = await p<number>((cb) => sftp.read(h, chunk, 0, chunk.length, got, (err, bytes) => cb(err, bytes)));
      if (!n) break;
      parts.push(chunk.subarray(0, n));
      got += n;
    }
    return Buffer.concat(parts);
  } finally {
    await p<void>((cb) => sftp.close(h, (err) => cb(err, undefined))).catch(() => {});
  }
}

/**
 * Whether the SSH user may write the file: opened for writing and closed at
 * once (nothing written, nothing truncated). Most configuration is root's
 * and readable by all; the editor offers sudo before any typing (W-FUNC-01).
 */
export async function writable(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) =>
    sftp.open(path, "r+", (err, h) => (err ? resolve(false) : sftp.close(h, () => resolve(true)))),
  );
}

export async function readText(
  sftp: SFTPWrapper,
  path: string,
): Promise<TextFile> {
  const st = await stat(sftp, path);
  if (!st) throw new HttpError(404, "not_found", `${path} does not exist.`);
  if (typeOf(st.mode) !== "file")
    throw new HttpError(400, "not_a_file", `${path} is not a regular file.`);
  if (st.size > MAX_TEXT_BYTES)
    throw new HttpError(
      413,
      "too_large",
      "The editor opens files up to 5 MB; download larger ones.",
    );
  const buf = await readUpTo(sftp, path, MAX_TEXT_BYTES + 1).catch((err) => {
    throw sftpError(err, path);
  });
  // The size it said was not the size it had (a growing file, /proc).
  if (buf.length > MAX_TEXT_BYTES)
    throw new HttpError(
      413,
      "too_large",
      "The editor opens files up to 5 MB; download larger ones.",
    );
  if (buf.subarray(0, 8192).includes(0))
    throw new HttpError(415, "binary", "This looks like a binary file.");
  return {
    path,
    content: utf8Text(buf),
    hash: sha256(buf),
    size: buf.length,
    mtime: new Date(st.mtime * 1000).toISOString(),
    mode: st.mode & 0o7777,
  };
}

/**
 * Save safely: write a temporary file next to the target, then rename it
 * over the original in one step, so an interrupted upload never leaves half
 * a file. The original's permissions are kept. If the file changed since the
 * editor loaded it (hash differs), nothing is written and the current
 * content comes back for a diff.
 */
/**
 * Puts a finished temporary file in place of `path`, replacing what is
 * there. posix-rename does that atomically. A server without the extension
 * (and only then: any other error is the answer) gets a plain rename, which
 * refuses to overwrite: the old file is moved aside first and put back when
 * the new one cannot take its place. It was deleted before, and a failed
 * rename then lost both.
 */
export async function replaceWith(sftp: SFTPWrapper, tmp: string, path: string, exists: boolean): Promise<void> {
  const rename = (a: string, b: string) =>
    p<void>((cb) => sftp.rename(a, b, (e) => cb(e, undefined)));
  await p<void>((cb) =>
    sftp.ext_openssh_rename(tmp, path, (err) => cb(err, undefined)),
  ).catch(async (err: Error) => {
    if (!/does not support/i.test(err.message)) throw err;
    if (!exists) return rename(tmp, path);
    const old = `${posix.dirname(path)}/.${posix.basename(path)}.burrow-old-${randomBytes(4).toString("hex")}`;
    await rename(path, old);
    try {
      await rename(tmp, path);
    } catch (e) {
      await rename(old, path);
      throw e;
    }
    await p<void>((cb) => sftp.unlink(old, (e) => cb(e, undefined))).catch(
      () => {},
    );
  });
}

/**
 * Puts a finished temporary file at `path` only when nothing is there: a
 * plain SFTP rename refuses an existing target, in one step (a check
 * before it would leave a moment for another upload to arrive).
 */
export async function placeNew(sftp: SFTPWrapper, tmp: string, path: string): Promise<void> {
  await p<void>((cb) => sftp.rename(tmp, path, (e) => cb(e, undefined))).catch(async (err) => {
    if (await stat(sftp, path)) throw new HttpError(409, "exists", `${posix.basename(path)} already exists.`);
    throw err;
  });
}

// Saves to one file on one host, one at a time: the check that the file
// is still what the editor opened and the replacement are one step for
// Burrow. Two saves from the same version both reported success, and one
// edit was gone.
const saving = new Map<string, Promise<unknown>>();
export async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = saving.get(key) ?? Promise.resolve();
  const mine = before.catch(() => {}).then(fn);
  saving.set(key, mine);
  try {
    return await mine;
  } finally {
    if (saving.get(key) === mine) saving.delete(key);
  }
}

/**
 * The text a save may write, as bytes: what the editor could open again
 * (5 MB, no NUL early on), checked before anything on the host changes. The
 * character limit let a multibyte text over 5 MB be written, and a NUL went
 * to disk; both then failed to read back and the file no longer opened
 * (AUDIT2 FS-08).
 */
export function savableBytes(content: string): Buffer {
  const body = Buffer.from(content, "utf8");
  if (body.length > MAX_TEXT_BYTES)
    throw new HttpError(413, "too_large", "The editor saves files up to 5 MB.");
  if (body.subarray(0, 8192).includes(0))
    throw new HttpError(415, "binary", "The text has a NUL character in it; it would no longer open as text.");
  return body;
}

/**
 * The file a path names, by its full real path: through a symlink to its
 * target (saving replaced the link with a plain file), and through linked
 * folders, so two spellings of one file share one lock (AUDIT2 FS-02). A new
 * file: its folder's real path and its name.
 */
export async function realTarget(sftp: SFTPWrapper, path: string): Promise<string> {
  const real = await p<string>((cb) => sftp.realpath(path, cb)).catch(() => null);
  if (real) return real;
  const dir = await p<string>((cb) => sftp.realpath(posix.dirname(path), cb)).catch(() => null);
  return dir ? posix.join(dir, posix.basename(path)) : path;
}

/**
 * A replacement keeps the file's mode, owner and group, or is refused: saved as
 * this user, another user's file became this user's (the failures were
 * swallowed, AUDIT2 FS-09). Not 409: that is "changed meanwhile".
 */
export async function keepOwnerAndMode(sftp: SFTPWrapper, tmp: string, st: Stats, target: string): Promise<void> {
  await p<void>((cb) => sftp.chmod(tmp, st.mode & 0o7777, (err) => cb(err, undefined)));
  const chowned = await p<void>((cb) => sftp.chown(tmp, st.uid, st.gid, (err) => cb(err, undefined))).then(
    () => true,
    () => false,
  );
  if (chowned) return;
  const mine = await stat(sftp, tmp);
  if (mine && (mine.uid !== st.uid || mine.gid !== st.gid))
    throw new HttpError(403, "owner_would_change", `${posix.basename(target)} belongs to another user or group: saved from here it would become yours. Save it with sudo instead.`);
}

export async function writeText(
  sftp: SFTPWrapper,
  path: string,
  content: string,
  baseHash: string | null,
  /** Which host (for the one-at-a-time lock; files of two hosts can share a path). */
  host: number | string = "",
): Promise<{ ok: true; file: TextFile } | { ok: false; current: TextFile }> {
  const body = savableBytes(content);
  const target = await realTarget(sftp, path);
  return oneAtATime(`${host}:${target}`, async () => {
    const st = await stat(sftp, target);
    if (st && baseHash !== null) {
      const current = await readText(sftp, path);
      if (current.hash !== baseHash) return { ok: false as const, current };
    } else if (st && baseHash === null) {
      return { ok: false as const, current: await readText(sftp, path) };
    } else if (!st && baseHash !== null) {
      throw new HttpError(
        409,
        "deleted",
        "The file was deleted on the host since you opened it.",
      );
    }
    const dir = posix.dirname(target);
    const tmp = `${dir}/.${posix.basename(target)}.burrow-${randomBytes(4).toString("hex")}`;
    try {
      await p<void>((cb) =>
        sftp.writeFile(
          tmp,
          body,
          { mode: st ? st.mode & 0o7777 : 0o644 },
          (err) => cb(err, undefined),
        ),
      );
      if (st) await keepOwnerAndMode(sftp, tmp, st, target);
      // A new file only where none has appeared meanwhile.
      if (st) await replaceWith(sftp, tmp, target, true);
      else await placeNew(sftp, tmp, target);
    } catch (err) {
      await p<void>((cb) => sftp.unlink(tmp, (e) => cb(e, undefined))).catch(
        () => {},
      );
      if (err instanceof HttpError && err.status === 409)
        return { ok: false as const, current: await readText(sftp, path) };
      throw err instanceof HttpError ? err : sftpError(err, path);
    }
    return { ok: true as const, file: await readText(sftp, path) };
  });
}
