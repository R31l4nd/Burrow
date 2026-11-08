import { ask } from './confirm.svelte.js';
import { t } from './i18n/index.svelte.js';

// A small hash router: #/hosts, #/hosts/12/edit, #/files/3?p=/etc ... Hash
// routing needs no server configuration and survives the Android WebView.

export const route = $state<{ path: string; parts: string[]; query: Record<string, string> }>(parse());

function parse() {
  const full = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = full.split('?', 2) as [string, string?];
  return { path: full, parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs)) };
}

// Pages with unsaved changes: asked before another page opens. A guard
// gets the path about to open and returns the question, or null.
const guards = new Set<(next: string) => string | null>();
export function guardLeave(fn: (next: string) => string | null): () => void {
  guards.add(fn);
  return () => guards.delete(fn);
}
/** A page holds work not saved yet: a guard would ask before any other page (the sign-in running out keeps it, lib/session.svelte.ts). */
export const unsavedHere = (): boolean => [...guards].some((g) => g('\u0000') !== null);
let current = location.hash;
// Once, after the person chose to leave: no second question.
let passing = false;
// Each entry of the history numbered (in its state), so a refused page is
// undone the way it came: a new entry by going back over it, a Back by going
// forward again. Putting the old address in its place left an entry of its
// own, and Back then stayed on the same page (AUDIT2 WEB-13).
const entry = () => (typeof history === 'undefined' ? 0 : (history.state as { burrowEntry?: number } | null)?.burrowEntry);
let index = entry() ?? 0;
if (entry() === undefined) history.replaceState({ ...(history.state as object | null), burrowEntry: index }, '');
let restoring = false;
// The page each entry of this tab's history showed, by its number: a page's own Back (up) goes
// back over the entry before when that is the page it leads to, else on to it.
const shown = new Map<number, string>([[index, parse().path]]);
// Where each entry was scrolled to when it was left: Back and Forward come to the same place, a
// list's too (report 78bf46: back from a part of the settings, at the top of the list again).
const scrolled = new Map<number, number>();

/** Scrolled back to y once the page is tall enough for it (its list read again), for a second at most. */
function scrollBack(y: number): void {
  const until = Date.now() + 1000;
  const step = () => {
    if (document.documentElement.scrollHeight - innerHeight >= y - 1 || Date.now() > until) return void globalThis.scrollTo(0, y);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

window.addEventListener('hashchange', () => {
  // The way back from a refused page: arrived where we were, nothing more to do.
  if (restoring && location.hash === current) {
    restoring = false;
    return;
  }
  const next = location.hash.replace(/^#/, '') || '/';
  const question = passing ? null : [...guards].map((g) => g(next)).find(Boolean);
  passing = false;
  if (question) {
    // Back where we were while the app asks (its own dialog, not the
    // browser's); on "leave", on to where the person was going.
    const target = location.hash;
    const at = entry();
    if (at === undefined) {
      restoring = true;
      history.back();
    } else if (at !== index) {
      restoring = true;
      history.go(index - at);
    } else history.replaceState(history.state, '', current || '#/');
    void ask({ text: question, confirm: t('common.leaveUnsaved'), danger: true }).then((yes) => {
      if (!yes) return;
      passing = true;
      location.hash = target;
    });
    return;
  }
  current = location.hash;
  scrolled.set(index, globalThis.scrollY ?? 0);
  const at = entry();
  if (at === undefined) {
    index++;
    history.replaceState({ ...(history.state as object | null), burrowEntry: index }, '');
  } else {
    index = at;
    const y = scrolled.get(at);
    if (y) scrollBack(y);
  }
  const r = parse();
  shown.set(index, r.path);
  route.path = r.path;
  route.parts = r.parts;
  route.query = r.query;
});

export function go(path: string): void {
  if (location.hash !== `#${path}`) location.hash = path;
}

/** The page now, to pass to goFrom after something that takes a while. */
export const here = (): string => route.path;

/**
 * After something that took a while (a save, a new session): on to path only
 * when the person is still on the page it was started from. Gone elsewhere
 * meanwhile, they stay there; the work itself is done all the same (AUDIT2 PAGE-17).
 */
export function goFrom(from: string, path: string): void {
  if (route.path === from) go(path);
}

/** A path with query parameters, e.g. to('/files/3', { p: '/etc' }). */
export const to = (path: string, query: Record<string, string>): string => `${path}?${new URLSearchParams(query).toString()}`;

/**
 * A page's own Back (the arrow in its bar): up to the page it belongs to (a
 * container -> Containers, a host's statistics -> Hosts), also when it was
 * opened from somewhere else (a link, a push, another section; report
 * 87f290: it went back to whatever page was before). When that page is the
 * one before in this tab's history, it goes back there (its place kept);
 * the browser's and the phone's own Back still go back in history.
 */
export function up(parent: string): void {
  if (shown.get(index - 1) === parent) history.back();
  else go(parent);
}
