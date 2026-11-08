import { z } from 'zod';

// Workspaces (phase 7): a folder on a host opened as a project, with a file
// tree, tabs, search and replace across files, and basic git.

export interface Workspace {
  id: number;
  hostId: number;
  hostName: string;
  root: string;
  /** More folders on the same host, shown beside the root (search and git per folder). */
  folders: string[];
  name: string;
  gitName: string | null;
  gitEmail: string | null;
  lastOpenedAt: string | null;
}

export const workspaceInput = z.object({
  hostId: z.number().int().positive(),
  root: z.string().min(1).max(4096).startsWith('/'),
  name: z.string().trim().min(1).max(80).optional(),
});

export interface SearchMatch {
  /** Relative to the workspace root. */
  path: string;
  line: number;
  /** 1-based column of the first match on the line. */
  col: number;
  text: string;
}

export interface SearchResult {
  tool: 'rg' | 'grep';
  matches: SearchMatch[];
  truncated: boolean;
}

export const workspaceSearchInput = z.object({
  root: z.string().min(1).max(4096).startsWith('/'),
  query: z.string().min(1).max(500),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
});

export const replaceInput = workspaceSearchInput.extend({
  replacement: z.string().max(10_000),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(1000),
});

export interface ReplaceResult {
  path: string;
  count: number;
  error?: string;
}

export interface GitFile {
  /** Relative to the workspace root. */
  path: string;
  /** Porcelain status letters: index (staged) and work tree. '?' for untracked. */
  index: string;
  worktree: string;
  /** A staged rename: the name it had (unstaging takes both back). */
  oldPath?: string;
}

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}
