import type { DirListing, UploadState } from '@burrow/shared';
import { android, type UploadSource } from './android.js';
import { api, ApiFailure, currentAccount, errorMessage, get, post, sameAccount } from './api.js';
import { t } from './i18n/index.svelte.js';
import { onAccountChange } from './session.svelte.js';

// In the functions below `t` is the transfer: the translation by another name.
const say = t;

// State shared by the file pages: the clipboard (which can hold paths from
// one host and be pasted on another) and the transfer drawer (uploads and
// server-side copy jobs with their progress).

export const clipboard = $state<{ hostId: number | null; hostName: string; paths: string[]; move: boolean }>({
  hostId: null,
  hostName: '',
  paths: [],
  move: false,
});

export function setClipboard(hostId: number, hostName: string, paths: string[], move: boolean): void {
  clipboard.hostId = hostId;
  clipboard.hostName = hostName;
  clipboard.paths = paths;
  clipboard.move = move;
}

export function clearClipboard(): void {
  clipboard.hostId = null;
  clipboard.paths = [];
}

/**
 * What was copied or cut, put into a folder of a host (any host: the server copies between them),
 * followed as a transfer; cut, the clipboard is empty after. From the Files page's bar and from a
 * file's or folder's menu, a workspace's tree too (report 67d3e6: copied there, nowhere to paste).
 */
export async function pasteInto(toHostId: number, toHostName: string, dir: string, onDone: () => void): Promise<void> {
  if (clipboard.hostId === null) return;
  const fromHostId = clipboard.hostId;
  const move = clipboard.move;
  const paths = [...clipboard.paths];
  // A name taken there: asked what to do, as Material Files and Nautilus ask (report dfda31: the
  // paste only failed). Pasted into its own folder, a copy can only go beside it.
  const listing = await get<DirListing>(`/api/files/${toHostId}/list?path=${encodeURIComponent(dir)}`).catch(() => null);
  const there = new Set(listing?.entries.map((e) => e.name) ?? []);
  const taken = paths.map((p) => p.slice(p.lastIndexOf('/') + 1)).filter((n) => there.has(n));
  const same = fromHostId === toHostId && paths.every((p) => (p.slice(0, p.lastIndexOf('/')) || '/') === dir);
  let clash: ClashChoice | undefined;
  if (taken.length && !(same && move)) {
    const answer = await askClash(taken, same);
    if (!answer) return;
    clash = answer;
  }
  const job = await post<JobView>('/api/files/transfer', { fromHostId, paths, toHostId, toDir: dir, move, ...(clash ? { clash } : {}) });
  if (move) clearClipboard();
  void followJob(job, say(move ? 'files.moving' : 'files.copying', { n: paths.length, to: `${toHostName}:${dir}` }), move ? 'move' : 'copy', onDone);
}

export type ClashChoice = 'replace' | 'rename' | 'skip';
/** A paste whose names are taken where it goes, waiting for what to do (PasteClash.svelte). */
export const pasteClash = $state<{ names: string[]; same: boolean; answer: ((c: ClashChoice | null) => void) | null }>({ names: [], same: false, answer: null });

function askClash(names: string[], same: boolean): Promise<ClashChoice | null> {
  // One question at a time: an earlier one still open is cancelled.
  pasteClash.answer?.(null);
  return new Promise((resolve) => {
    pasteClash.names = names;
    pasteClash.same = same;
    pasteClash.answer = (c) => {
      pasteClash.answer = null;
      resolve(c);
    };
  });
}

export interface Transfer {
  id: string;
  label: string;
  kind: 'upload' | 'copy' | 'move' | 'archive' | 'extract';
  status: 'queued' | 'running' | 'done' | 'failed' | 'paused';
  bytes: number;
  total: number | null;
  error: string | null;
  /** A copy between hosts: checking each file's sha256 now, then how many matched (or why not checked). */
  checking?: boolean;
  verified?: number | null;
  unverified?: 'source' | 'destination' | null;
  /** Items left out: their name was taken where they went (asked to skip them). */
  skipped?: number | null;
  // Called when it finishes, e.g. to refresh the folder on screen.
  onDone?: () => void;
}

export const transfers = $state<{ items: Transfer[]; open: boolean }>({ items: [], open: false });
// Another account at this page: none of the last one's copied files or transfers (AUDIT2 WEB-01).
onAccountChange(() => {
  Object.assign(clipboard, { hostId: null, hostName: '', paths: [], move: false });
  transfers.items = [];
  transfers.open = false;
});

// In the Android app, running transfers keep a foreground service (with a
// notification) up, so Android does not stop the app while the screen is off.
if (android) {
  let last = -1;
  $effect.root(() => {
    $effect(() => {
      const active = transfers.items.filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'paused');
      if (active.length === last) return;
      last = active.length;
      void android!.transfers(active.length, active[0]?.label ?? '').catch(() => {});
    });
  });
}

const find = (id: string) => transfers.items.find((t) => t.id === id);

/** Stop an upload: a waiting one never starts, a running one ends and leaves nothing on the host. */
export function cancelUpload(id: string): void {
  // Already being put in place on the host: too late to stop, and it stays listed until it says how it went (AUDIT2 WEB-05).
  if (finishing.has(id)) return;
  const i = queue.findIndex((q) => q.tr.id === id);
  if (i >= 0) queue.splice(i, 1);
  // A running one ends after the chunk under way.
  else cancelled.add(id);
  transfers.items = transfers.items.filter((t) => t.id !== id);
}

export function clearFinished(): void {
  transfers.items = transfers.items.filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'paused');
}

interface JobView {
  id: string;
  status: 'running' | 'done' | 'failed';
  bytes: number;
  error: string | null;
  phase?: 'copying' | 'checking' | null;
  verified?: number | null;
  unverified?: 'source' | 'destination' | null;
  skipped?: number | null;
  errorCode?: string | null;
  errorDetail?: string | null;
}

/** Follow a server-side job until it is done. */
/** No answer about a job for this long: given up on (it may still run on the host). */
const JOB_GIVE_UP_MS = 5 * 60_000;

export async function followJob(job: JobView, label: string, kind: Transfer['kind'], onDone?: () => void): Promise<void> {
  const tr: Transfer = { id: job.id, label, kind, status: 'running', bytes: 0, total: null, error: null, ...(onDone ? { onDone } : {}) };
  transfers.items.push(tr);
  transfers.open = true;
  let wait = 700;
  let failingSince: number | null = null;
  for (;;) {
    let j: JobView | null = null;
    let gone = false;
    try {
      j = await get<JobView>(`/api/files/jobs/${job.id}`);
      failingSince = null;
      wait = 700;
    } catch (err) {
      // Gone (Burrow restarted) or not ours: it never finishes here. It
      // asked every 700 ms for ever before (audit WL-05). Otherwise less often.
      gone = err instanceof ApiFailure && [401, 403, 404].includes(err.status);
      failingSince ??= Date.now();
      wait = Math.min(5000, wait * 2);
    }
    const t = find(job.id);
    if (!t) return;
    if (j) {
      t.bytes = j.bytes;
      t.checking = j.phase === 'checking';
      t.verified = j.verified ?? null;
      t.unverified = j.unverified ?? null;
      t.skipped = j.skipped ?? null;
      if (j.status !== 'running') {
        t.status = j.status;
        // A copy that did not match: said in the reader's language, with the files (AUDIT2 WEB-16).
        // Any other refusal as an API error is said: in the reader's language where Burrow knows its words
        // (report 71b74a: "Already in the destination" stood in English in the Dutch app).
        t.error = j.errorCode === 'verify_failed' ? say('transfers.verifyFailed', { files: j.errorDetail ?? '' }) : j.errorCode === 'source_changed' ? say('transfers.sourceChanged', { files: j.errorDetail ?? '' }) : j.error && j.errorCode ? errorMessage(new ApiFailure(409, j.errorCode, j.error)) : j.error;
        if (j.status === 'done') t.onDone?.();
        return;
      }
    } else if (gone || Date.now() - failingSince! > JOB_GIVE_UP_MS) {
      t.status = 'failed';
      t.error = say(gone ? 'transfers.jobGone' : 'transfers.jobUnreachable');
      return;
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ---- uploads: 4 MiB chunks, one file after the other, resumable

const CHUNK = 4 * 1024 * 1024;
/** Uploads the person stopped while they ran. */
const cancelled = new Set<string>();
const queue: { tr: Transfer; hostId: number; dir: string; file: UploadSource; overwrite: boolean; account: number }[] = [];
let running = false;
/** Uploads whose last step (the file put in place) is under way. */
const finishing = new Set<string>();

/** Files up to a folder, one after another; onDone after each one that arrived, with its place in files. */
export function upload(hostId: number, dir: string, files: UploadSource[], onDone?: (index: number) => void, overwrite = false): void {
  for (const [i, file] of files.entries()) {
    const tr: Transfer = { id: `up-${crypto.randomUUID()}`, label: file.name, kind: 'upload', status: 'queued', bytes: 0, total: file.size, error: null, ...(onDone ? { onDone: () => onDone(i) } : {}) };
    transfers.items.push(tr);
    queue.push({ tr, hostId, dir, file, overwrite, account: currentAccount() });
  }
  transfers.open = true;
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // One that throws does not stop the ones after it (AUDIT2 WEB-04).
    for (let next = queue.shift(); next; next = queue.shift()) {
      const item = next;
      await runUpload(item).catch((err: unknown) => {
        const tr = find(item.tr.id) ?? item.tr;
        tr.status = 'failed';
        tr.error = errorMessage(err);
      });
    }
  } finally {
    running = false;
  }
}

async function putChunk(id: string, offset: number, blob: Blob): Promise<UploadState> {
  const res = await fetch(`/api/files/uploads/${id}?offset=${offset}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
  });
  const data = (await res.json().catch(() => ({}))) as UploadState & { error?: string; message?: string };
  if (!res.ok) throw new ApiFailure(res.status, data.error ?? `http_${res.status}`, data.message);
  // Not Burrow's answer (a proxy's page while it restarts): an error, not a state.
  if (typeof data.offset !== 'number') throw new ApiFailure(502, 'not_json', t('common.notBurrow'));
  return data;
}

async function runUpload(item: { tr: Transfer; hostId: number; dir: string; file: UploadSource; overwrite: boolean; account: number }): Promise<void> {
  const t = () => find(item.tr.id) ?? item.tr;
  t().status = 'running';
  let state: UploadState;
  try {
    // Picked by the account signed in then: not sent as the next one (AUDIT2 WEB-02).
    sameAccount(item.account);
    state = await post<UploadState>(`/api/files/${item.hostId}/uploads`, { dir: item.dir, name: item.file.name, size: item.file.size, overwrite: item.overwrite });
  } catch (err) {
    t().status = 'failed';
    t().error = errorMessage(err);
    return;
  }
  // Stopped, or given up: the part on the host goes too.
  const drop = () => void api('DELETE', `/api/files/uploads/${state.id}`).catch(() => {});
  let failures = 0;
  while (state.offset < item.file.size || item.file.size === 0) {
    if (item.file.size === 0) break;
    if (cancelled.delete(item.tr.id)) return drop();
    // A file that got shorter since it was picked (a shared file rewritten):
    // a short or empty piece went up as a success, again and again (audit WL-06).
    let piece: Blob;
    try {
      sameAccount(item.account);
      piece = await item.file.slice(state.offset, state.offset + CHUNK);
    } catch (err) {
      // The file could not be read any more (the other app took it back), or another account signed in.
      t().status = 'failed';
      t().error = errorMessage(err);
      if (!(err instanceof ApiFailure && err.code === 'signed_out')) drop();
      return;
    }
    if (piece.size !== Math.min(CHUNK, item.file.size - state.offset)) {
      t().status = 'failed';
      t().error = say('transfers.fileChanged');
      drop();
      return;
    }
    try {
      const before = state.offset;
      state = await putChunk(state.id, state.offset, piece);
      // Taken but not further: a failure like any other, so it ends.
      if (state.offset <= before) throw new ApiFailure(502, 'no_progress', 'no progress');
      t().bytes = state.offset;
      failures = 0;
    } catch {
      // Network gone (tunnel down, phone asleep): wait, ask where to
      // resume, carry on. Give up after about two minutes of failures.
      if (++failures > 12) {
        t().status = 'failed';
        t().error = say('transfers.connectionLost');
        drop();
        return;
      }
      t().status = 'paused';
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** Math.min(failures, 4))));
      const resumed = await get<UploadState>(`/api/files/uploads/${state.id}`).catch(() => null);
      if (resumed) state = resumed;
      t().status = 'running';
    }
  }
  if (cancelled.delete(item.tr.id)) return drop();
  finishing.add(item.tr.id);
  try {
    await post(`/api/files/uploads/${state.id}/finish`);
    t().status = 'done';
    t().bytes = item.file.size;
    t().onDone?.();
    // A folder on screen shows the new file, also when the upload was started
    // elsewhere (the share page hands over to Files while it runs).
    window.dispatchEvent(new CustomEvent('burrow:uploaded', { detail: { hostId: item.hostId, dir: item.dir } }));
  } catch (err) {
    t().status = 'failed';
    t().error = errorMessage(err);
  } finally {
    finishing.delete(item.tr.id);
  }
}

export { api };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const rawUrl = (hostId: number, path: string, download = false) =>
  `/api/files/${hostId}/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;

/** What opening a file does, by its name. */
export function openKind(name: string): 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'other' {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(n)) return 'image';
  if (/\.(mp4|m4v|webm|mov|mkv)$/.test(n)) return 'video';
  if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/.test(n)) return 'audio';
  if (/\.pdf$/.test(n)) return 'pdf';
  if (/\.(zip|tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2)$/.test(n)) return 'archive';
  if (/\.(iso|img|bin|so|o|a|deb|rpm|exe|dll|jar|class|pyc|db|sqlite3?|gz|xz|bz2|7z|rar|zst|woff2?|ttf|otf|mp4)$/.test(n)) return 'other';
  return 'text';
}
