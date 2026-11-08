import { z } from 'zod';

// Remote file management over SFTP. Paths are absolute POSIX paths on the
// host; `~` is resolved by the server.

export type FileType = 'file' | 'dir' | 'link' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  type: FileType;
  // For links: what the link points to, and that target's type.
  target?: string;
  targetType?: FileType | 'broken';
  size: number;
  mtime: string;
  // Permission bits, e.g. 0o755.
  mode: number;
  owner: string;
  group: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  entries: FileEntry[];
}

// Absolute only: a path goes into commands on the host (find, du, tar), and
// one that starts with "-" was taken as an option there ("-delete" as the
// folder of a search deleted files). Quoting does not help against that.
export const absPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/') && !p.includes('\0'), 'an absolute path');

export const pathsInput = z.object({ paths: z.array(absPath).min(1).max(1000) });

export const renameInput = z.object({ from: absPath, to: absPath });

export const createInput = z.object({ path: absPath, kind: z.enum(['file', 'dir']) });

export const chmodInput = z.object({
  path: absPath,
  mode: z.number().int().min(0).max(0o7777),
  recursive: z.boolean().default(false),
});

export const chownInput = z.object({
  path: absPath,
  owner: z.string().regex(/^[a-z_][a-z0-9_-]*\$?$|^\d+$/i).max(32),
  group: z.string().regex(/^[a-z_][a-z0-9_-]*\$?$|^\d+$/i).max(32).optional(),
  recursive: z.boolean().default(false),
});

// Copy or move one or more paths into a directory, on the same host or
// another one.
export const transferInput = z.object({
  fromHostId: z.number().int().positive(),
  paths: z.array(absPath).min(1).max(1000),
  toHostId: z.number().int().positive(),
  toDir: absPath,
  move: z.boolean().default(false),
  // Replace what exists at the destination; otherwise a clash is an error.
  overwrite: z.boolean().default(false),
  // A name taken at the destination (report dfda31): fail (the default; replace when overwrite),
  // replace it, keep both (the copy as "name (1).txt"), or skip that item and copy the rest.
  clash: z.enum(['fail', 'replace', 'rename', 'skip']).optional(),
});

export const archiveInput = z.object({
  paths: z.array(absPath).min(1).max(1000),
  // Full path of the archive to create; its extension picks the format.
  dest: absPath.refine((p) => /\.(zip|tar\.gz|tgz)$/i.test(p), 'use .zip, .tar.gz or .tgz'),
});

export const extractInput = z.object({ path: absPath, toDir: absPath });

export const searchInput = z.object({ dir: absPath, name: z.string().trim().min(1).max(200) });

export const uploadInit = z.object({
  dir: absPath,
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !n.includes('/') && n !== '.' && n !== '..' && !n.includes('\0'), 'invalid file name'),
  size: z.number().int().min(0).max(1024 ** 4),
  overwrite: z.boolean().default(false),
});

export interface UploadState {
  id: string;
  offset: number;
  size: number;
}

export interface TextFile {
  path: string;
  content: string;
  // SHA-256 of the content as read; sent back on save to detect conflicts.
  hash: string;
  size: number;
  mtime: string;
  mode: number;
  /** Whether the SSH user may write it (the editor's text read): when not, the editor offers sudo before any typing. */
  writable?: boolean;
}

/**
 * The request body a text save may have: the editor opens files up to 5 MB,
 * and JSON escaping can make text up to six times longer (\u0001).
 */
export const TEXT_SAVE_BODY_LIMIT = 6 * 5 * 1024 * 1024 + 64 * 1024;

export const saveInput = z.object({
  path: absPath,
  content: z.string().max(5 * 1024 * 1024),
  // Hash of what the editor loaded; null for a new file. A different hash on
  // the host means someone else changed it.
  baseHash: z.string().length(64).nullable(),
});

export interface Bookmark {
  id: number;
  hostId: number;
  path: string;
  name: string;
}

export const bookmarkInput = z.object({ path: absPath, name: z.string().trim().min(1).max(80) });

export interface Diagnostic {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
  code?: string;
}

// ---- folders an operator may open (A3-SRV-01)

/** At most this many folders in each list, per operator and host. */
export const MAX_ACCESS_FOLDERS = 50;

/**
 * Which folders an operator may open on a host: the longest folder that holds a path decides, a
 * denied one where both lists name it. Nothing granted: no files on that host. Admins open
 * everything; keys and Burrow's own secrets stay closed to operators whatever is granted.
 */
export const fileAccessInput = z.object({
  allow: z.array(absPath).max(MAX_ACCESS_FOLDERS),
  deny: z.array(absPath).max(MAX_ACCESS_FOLDERS),
});

export interface FileAccessRule {
  hostId: number;
  allow: string[];
  deny: string[];
}

/** A folder as the rules keep it: normalised, no trailing slash ("/" stays). */
export function accessFolder(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `/${parts.join('/')}`;
}

/** The parts of a list that are folders the rules can hold: normalised, each once, sorted. */
export const accessFolders = (list: string[]): string[] => [...new Set(list.map(accessFolder))].sort();

/** Whether a path is that folder or inside it. */
export const insideFolder = (path: string, folder: string): boolean => folder === '/' || path === folder || path.startsWith(`${folder}/`);

/** The longest matching folder decides; a denied one on a tie; none matching: no access. */
export function folderAllowed(path: string, rule: { allow: string[]; deny: string[] }): boolean {
  let best = -1;
  let ok = false;
  for (const f of rule.allow) if (insideFolder(path, f) && f.length > best) [best, ok] = [f.length, true];
  for (const f of rule.deny) if (insideFolder(path, f) && f.length >= best) [best, ok] = [f.length, false];
  return ok;
}
