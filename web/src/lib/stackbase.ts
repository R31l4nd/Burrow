import { onAccountChange } from './session.svelte.js';

// A stack's compose file as it was when editing started (per tab), for the
// diff before deploying when Burrow has not deployed the stack itself yet.
// Kept with the file's hash then and the hash of what this tab saved since:
// editing again when the file is neither (changed elsewhere, a deploy from
// another place, days later) starts from the file as it is now; and none of
// it is left for the next account on this tab (A3-WEB-14: compose files
// often hold secrets).
const PREFIX = 'burrow.stackbase.';
const baseKey = (hostId: number, file: string): string => `${PREFIX}${hostId}:${file}`;

interface Base {
  content: string;
  hash: string;
  saved: string | null;
}

function read(k: string): Base | null {
  try {
    const raw = sessionStorage.getItem(k);
    if (raw === null) return null;
    const b = JSON.parse(raw) as Partial<Base>;
    return typeof b.content === 'string' && typeof b.hash === 'string' ? { content: b.content, hash: b.hash, saved: b.saved ?? null } : null;
  } catch {
    // An older entry (the bare text, without its hash): not known to still hold.
    return null;
  }
}

function write(k: string, b: Base): void {
  try {
    sessionStorage.setItem(k, JSON.stringify(b));
  } catch {
    // The diff then starts from the saved file.
  }
}

/** Editing starts: the file as it is now, unless the base kept is still this file (as it was, or as this tab saved it). */
export function rememberBase(hostId: number, file: string, content: string, hash: string): void {
  const k = baseKey(hostId, file);
  const b = read(k);
  if (b && (b.hash === hash || b.saved === hash)) return;
  write(k, { content, hash, saved: null });
}

/** This tab saved the file (its new hash): still "since you started editing". */
export function noteSaved(hostId: number, file: string, hash: string): void {
  const k = baseKey(hostId, file);
  const b = read(k);
  if (b) write(k, { ...b, saved: hash });
}

/** The text editing started from, or null. */
export function readBase(hostId: number, file: string): string | null {
  return read(baseKey(hostId, file))?.content ?? null;
}

/** Deployed from this tab: the next review compares with what Burrow deployed. */
export function forgetBase(hostId: number, file: string): void {
  try {
    sessionStorage.removeItem(baseKey(hostId, file));
  } catch {
    // Nothing kept.
  }
}

function forgetAll(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    // Nothing kept.
  }
}
onAccountChange(forgetAll);
