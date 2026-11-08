import type { DirListing } from '@burrow/shared';
import type { UploadSource } from './android.js';
import { get } from './api.js';
import { choose } from './confirm.svelte.js';
import { upload } from './files.svelte.js';
import { t } from './i18n/index.svelte.js';
import { toast } from './ui.svelte.js';

// Files into a folder of a host, from the file picker or dropped from the computer, the same way in
// Files and in a workspace's tree (report 6d86aa: a workspace took no dropped files).

/** "app.yaml" -> "app (1).yaml", the first not taken. */
export function freeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) if (!taken.has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
}

/**
 * Up to `dir`. A name that is there already (as the folder is now, read first): replace it, or keep
 * both under a free name, asked per file (decision 8). onDone after each one that arrived.
 */
export async function uploadInto(hostId: number, dir: string, files: UploadSource[], onDone?: () => void): Promise<void> {
  if (!files.length) return;
  const listing = await get<DirListing>(`/api/files/${hostId}/list?path=${encodeURIComponent(dir)}`);
  const taken = new Set(listing.entries.map((e) => e.name));
  const fresh: UploadSource[] = [];
  const replace: UploadSource[] = [];
  for (const f of files) {
    if (!taken.has(f.name)) {
      fresh.push(f);
      taken.add(f.name);
      continue;
    }
    const both = freeName(f.name, taken);
    const how = await choose({ text: t('files.uploadExists', { name: f.name, other: both }), confirm: t('files.uploadReplace'), other: t('files.uploadKeepBoth'), danger: true });
    if (how === 'confirm') replace.push(f);
    else if (how === 'other') {
      fresh.push({ name: both, size: f.size, slice: (a, b) => f.slice(a, b) });
      taken.add(both);
    }
  }
  if (fresh.length) upload(hostId, listing.path, fresh, onDone);
  if (replace.length) upload(hostId, listing.path, replace, onDone, true);
}

/** Whether a drag carries files from the computer (not text, not a tab of the page). */
export const dragsFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

/** The files of a drop; a folder dropped is left out and said (folders are not uploaded whole). */
export function droppedFiles(e: DragEvent): File[] {
  const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === 'file');
  const folders = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory).length;
  if (folders) toast(t('files.dropNoFolders', { n: folders }), 'error');
  const files = [...(e.dataTransfer?.files ?? [])];
  return folders ? files.filter((_, i) => !items[i]?.webkitGetAsEntry?.()?.isDirectory) : files;
}
