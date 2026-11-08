import type { TextFile } from '@burrow/shared';
import type { NativeFile, PhoneEntry, PhoneListing, PhoneText } from './android.js';
import { ApiFailure } from './api.js';
import { t } from './i18n/index.svelte.js';
import type { MessageKey } from './i18n/en.js';

// The phone's own files on the Files page (report a9552e), through the
// Android app's bridge: the folders the person granted, their listings and
// files. What comes from the bridge stays on this page; nothing of it goes
// to Burrow unless the person copies a file to a host.

/** What of the bridge this needs (the app's, or a test's stand-in). */
export interface PhoneBridge {
  phoneText(path: string): Promise<PhoneText>;
  phoneSaveText(path: string, content: string, baseHash: string): Promise<PhoneText | { conflict: true }>;
  read(token: string, offset: number, length: number): Promise<{ data: string }>;
  release(token: string): Promise<unknown>;
}

const ROOT_ID = /^[0-9a-f]{16}$/;

/**
 * A phone path from the address, as the app takes it: "/" (the granted
 * folders) or "/<folder id>/<names>", never "." or ".." (the app refuses
 * them too); anything else is "/".
 */
export function phonePath(p: string | null | undefined): string {
  if (!p || !p.startsWith('/')) return '/';
  const parts = p.slice(1).replace(/\/+$/, '').split('/');
  if (parts.length === 1 && parts[0] === '') return '/';
  if (!ROOT_ID.test(parts[0]!) || parts.slice(1).some((x) => x === '' || x === '.' || x === '..' || x.includes('\0'))) return '/';
  return `/${parts.join('/')}`;
}

/** The page a problem report names: on the phone's own files only which page, not which file (its names stay on the phone). */
export const reportedPage = (path: string) => (/^\/(files|edit)\/phone(\?|\/|$)/.test(path) ? path.split('?')[0]! : path).slice(0, 300);

/** The folder a file is in ("/<id>" at a folder's top). */
export const phoneDir = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** The way back up: the granted folder, then each folder inside it. */
export function phoneCrumbs(l: PhoneListing): { name: string; path: string }[] {
  const top = `/${l.root.id}`;
  return [{ name: l.root.name, path: top }, ...l.names.map((name, i) => ({ name, path: `${top}/${l.names.slice(0, i + 1).join('/')}` }))];
}

/** As a host's folder is shown: folders first, then by name (numbers as numbers); hidden ones only when asked. */
export function sortEntries(list: PhoneEntry[], hidden: boolean): PhoneEntry[] {
  return list
    .filter((e) => hidden || !e.name.startsWith('.'))
    .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

// The app's refusals by their code (PhoneFolders.PhoneError), in the reader's words.
const ERRORS: Record<string, MessageKey> = {
  bad_path: 'phone.error.bad_path',
  bad_folder: 'phone.error.bad_folder',
  no_folder: 'phone.error.no_folder',
  no_access: 'phone.error.no_access',
  not_found: 'phone.error.not_found',
  not_a_folder: 'phone.error.not_a_folder',
  not_a_file: 'phone.error.not_a_file',
  too_large: 'phone.error.too_large',
  binary: 'phone.error.binary',
  read_only: 'phone.error.read_only',
  too_many: 'phone.error.too_many',
  bad_name: 'phone.error.bad_name',
  exists: 'phone.error.exists',
  not_done: 'phone.error.not_done',
  not_an_archive: 'phone.error.not_an_archive',
  bad_archive: 'phone.error.bad_archive',
  changed: 'phone.error.changed',
};

/** An archive the app shows as a folder (Archives.kt): zip and what is a zip (jar, apk), tar, tar.gz. */
export const isArchive = (name: string): boolean => /\.(zip|jar|apk|tar|tar\.gz|tgz)$/i.test(name);
/** An app to install: Android's installer has it, as in Material Files (report 99d993). */
export const isApk = (name: string): boolean => /\.apk$/i.test(name);

/**
 * Text Burrow's editor can open, by what the phone says the file is: a name
 * Burrow does not know as anything else was taken for text, and an APK went
 * to the editor, which refused it (report 99d993).
 */
export function textual(mime: string): boolean {
  return !mime || mime === 'application/octet-stream' || /^text\/|[/+](json|xml|javascript|ecmascript|typescript|yaml|x-yaml|toml|x-sh|x-shellscript|sql|csv|x-empty|x-ndjson)$/.test(mime);
}

/** The folder above [inner] inside an archive ("" its top). */
export const innerUp = (inner: string): string => inner.split('/').slice(0, -1).join('/');

/** An error of the bridge as the reader's words, with its code (an ApiFailure, as the editor expects). */
export function phoneFailure(err: unknown): ApiFailure {
  const code = err instanceof Error ? err.message : String(err);
  const key = ERRORS[code];
  return new ApiFailure(400, key ? code : 'phone', key ? t(key) : code);
}

/** The editor's file from the phone's text. */
function asTextFile(f: PhoneText): TextFile & { writable: boolean } {
  return { path: f.path, content: f.content, hash: f.hash, size: f.size, mtime: f.mtime ?? '', mode: 0, writable: f.writable };
}

/** Where the editor reads and saves a file that is not on a host (EditorPane's `source`). */
export interface TextSource {
  read(): Promise<TextFile & { writable: boolean }>;
  /** Written only over the version read: changed since, an ApiFailure "conflict" (the editor shows both). */
  write(content: string, baseHash: string): Promise<TextFile>;
}

/** A text file of the phone for the editor; read only when asked, or when the phone does not let it be written. */
export function phoneTextSource(bridge: PhoneBridge, path: string, readOnly: boolean): TextSource {
  return {
    async read() {
      const f = await bridge.phoneText(path).catch((err: unknown) => Promise.reject(phoneFailure(err)));
      return { ...asTextFile(f), writable: f.writable && !readOnly };
    },
    async write(content, baseHash) {
      if (readOnly) throw new ApiFailure(400, 'read_only', t('phone.error.read_only'));
      const r = await bridge.phoneSaveText(path, content, baseHash).catch((err: unknown) => Promise.reject(phoneFailure(err)));
      if ('conflict' in r) throw new ApiFailure(409, 'conflict', t('phone.error.conflict'));
      return asTextFile(r);
    },
  };
}

/** A picture shown at most this big (read over the bridge into the page). */
export const MAX_VIEW = 30 * 1024 * 1024;

/** A held file read whole (1 MiB at a time), then let go; refused above `max`. */
export async function readHeld(bridge: PhoneBridge, f: NativeFile, max = MAX_VIEW): Promise<Blob> {
  try {
    if (f.size > max) throw new ApiFailure(413, 'too_large', t('phone.error.tooLargeToShow'));
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let at = 0; at < f.size; ) {
      const { data } = await bridge.read(f.token, at, Math.min(1 << 20, f.size - at));
      const bin = atob(data);
      if (!bin.length) break;
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      parts.push(bytes);
      at += bytes.length;
    }
    return new Blob(parts, { type: f.mime });
  } finally {
    void bridge.release(f.token).catch(() => {});
  }
}
