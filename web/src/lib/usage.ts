import { usageKeyOk, usagePage } from '@burrow/shared';

// Settings -> Usage: the pages and dialogs this browser opened, counted here
// and sent now and then (a minute after the first, and when the page goes out
// of sight), by name only (shared/src/usage.ts). Not through api(): a count
// that does not arrive is no failure to report, nor a reason to sign out.
// Only in the app itself (App.svelte starts it): the Android app's direct
// route shows the same dialogs where no Burrow answers.

const SEND_AFTER_MS = 60_000;
// A send that hangs (a proxy holding it) ends: the Usage page waits for it before reading.
const SEND_TIMEOUT_MS = 10_000;
const pending = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
// Started by the app, and off again while Burrow says it does not count.
let counting = false;
let started = false;

/** The app counts from now on (App.svelte). */
export function startUsage(): void {
  counting = true;
  if (started || typeof document === 'undefined') return;
  started = true;
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void sendUsage());
}

/** Turned on again in Settings -> Usage: this browser counts again (it stopped when told it was off). */
export function usageTurned(on: boolean): void {
  if (!started) return;
  counting = on;
  if (!on) dropUsage();
}

export function countUse(key: string): void {
  if (!counting || !usageKeyOk(key)) return;
  pending.set(key, (pending.get(key) ?? 0) + 1);
  timer ??= setTimeout(() => void sendUsage(), SEND_AFTER_MS);
}

/** What this browser counted and did not send yet, dropped: cleared means nothing left (Settings -> Usage). */
export function dropUsage(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
}

/** What was counted, sent; lost when it cannot be (only counts). */
export async function sendUsage(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending.size) return;
  const body = JSON.stringify(Object.fromEntries(pending));
  pending.clear();
  // keepalive: still sent while the tab closes.
  const res = await fetch('/api/usage', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true, signal: AbortSignal.timeout(SEND_TIMEOUT_MS), headers: { 'content-type': 'application/json' }, body }).catch(() => null);
  // Burrow does not count: nothing more sent until it is turned on here.
  const answer = res?.ok ? ((await res.json().catch(() => null)) as { on?: boolean } | null) : null;
  if (answer?.on === false) usageTurned(false);
}

/** A page by its address (#/hosts/3/stats): its name, never the host. */
export const pageKey = (hash: string): string => usagePage(hash);
