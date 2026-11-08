import type { Activity, ReportProgress } from '@burrow/shared';
import { get } from './api.js';
import { onAccountChange } from './session.svelte.js';

// What runs now on the server: stack operations (from here, another device,
// or the maintenance window) and an image update check with its progress.
// The "busy" pill shows it; asked every few seconds, every second while
// something runs, and not while the page is hidden.

export const activity = $state<Activity & { report: ReportProgress | null }>({ ops: [], check: null, report: null });
// Another account at this page: not the last one's activity (AUDIT2 WEB-01).
onAccountChange(() => Object.assign(activity, { ops: [], check: null, report: null }));

let timer: ReturnType<typeof setTimeout> | null = null;
let fastUntil = 0;
let started = false;

// Each look numbered: after a stop (signed out) or a newer look, an answer still on its way is dropped (AUDIT2 WEB-11).
let looks = 0;

async function poll(): Promise<void> {
  const mine = ++looks;
  if (!document.hidden) {
    try {
      const [a, report] = await Promise.all([get<Activity>('/api/docker/activity'), get<ReportProgress | null>('/api/reports/progress').catch(() => null)]);
      if (mine !== looks || !started) return;
      activity.ops = a.ops;
      activity.check = a.check;
      activity.report = report;
    } catch {
      // Offline, or not an admin: nothing to show.
    }
  }
  schedule();
}

function schedule(): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  const busy = activity.ops.length > 0 || activity.check !== null || (activity.report !== null && activity.report.phase !== 'done' && activity.report.phase !== 'failed') || Date.now() < fastUntil;
  timer = setTimeout(() => void poll(), busy ? 1000 : 5000);
}

export function startActivity(): void {
  if (started) return;
  started = true;
  void poll();
}

export function stopActivity(): void {
  started = false;
  looks++;
  if (timer) clearTimeout(timer);
}

/** Something was just started here: look sooner, for a while. */
export function nudgeActivity(): void {
  fastUntil = Date.now() + 15_000;
  if (started) void poll();
}
