import { SCREENSHOT_MAX_CHARS, type BugContext, type BugReportInput } from '@burrow/shared';
import { termDebug } from './termdebug.js';
import { recordedCount, recording, type Recording } from './inputlog.js';
import { android, androidInfo } from './android.js';
import { post, recentFailures } from './api.js';
import { locale, t } from './i18n/index.svelte.js';
import { route } from './router.svelte.js';
import { dropToast, toastWhile } from './ui.svelte.js';
import { appearance } from './theme.svelte.js';
import { WEB_VERSION } from './version.js';
import { onAccountChange } from './session.svelte.js';
import { reportedPage } from './phonefiles.js';
import { keepLine, markLines } from './shotlines.js';

// Reporting a problem to the developer. "Report a problem" in Settings arms
// a small button on every screen: go to where it goes wrong, tap it, and
// that screen is captured before the form opens. The report goes into the
// server's data directory (bugreports/), nowhere else.

// shot: the picture with what files, terminals and logs show hidden (report 50a6f6: a whole .env
// readable in it); shotFull: as the screen was, sent only when the person ticks it; hidden: how many
// parts were covered (none: the two are the same).
// The report button on every screen stays on this device until turned off (its x, or Settings): a
// series of reports without going to Settings for each one (the user, 2026-10-30).
const ARMED_KEY = 'burrow.bugArmed';
function armedBefore(): boolean {
  try {
    return localStorage.getItem(ARMED_KEY) === '1';
  } catch {
    return false;
  }
}
export const bug = $state({ armed: armedBefore(), open: false, shot: null as string | null, shotFull: null as string | null, hidden: 0, capturing: false, dialog: null as string | null, recording: null as Recording | null });
// Another account at this page: nothing of the last one's report (AUDIT2 WEB-01).
/** The report button on or off, kept on this device. */
export function setArmed(on: boolean): void {
  bug.armed = on;
  try {
    if (on) localStorage.setItem(ARMED_KEY, '1');
    else localStorage.removeItem(ARMED_KEY);
  } catch {
    // Storage refused (a private window): on for this visit only.
  }
}
onAccountChange(() => (setArmed(false), Object.assign(bug, { open: false, shot: null, shotFull: null, hidden: 0, capturing: false, dialog: null, recording: null })));

// The last errors in the page, for the report.
const errors: string[] = [];
function note(s: string): void {
  errors.push(s.slice(0, 500));
  if (errors.length > 30) errors.shift();
}

export function watchErrors(): void {
  window.addEventListener('error', (e) => note(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno})`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined;
    note(`Unhandled: ${r?.message ?? String(e.reason)}`);
  });
}

// The Android app's own version (it can be older than the page it shows:
// its WireGuard and its downloads are its own), read once.
let androidApp: string | null = null;
void androidInfo().then((i) => (androidApp = i?.version ?? null));

/** "Europe/Amsterdam +02:00": the zone the page shows times in, and its offset now. */
function zoneNow(): string {
  const off = -new Date().getTimezoneOffset();
  const hm = `${off < 0 ? '-' : '+'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  return `${Intl.DateTimeFormat().resolvedOptions().timeZone ?? '?'} ${hm}`.slice(0, 80);
}

export function bugContext(): BugContext {
  return {
    page: reportedPage(route.path),
    dialog: bug.dialog,
    appVersion: WEB_VERSION,
    androidApp,
    userAgent: navigator.userAgent.slice(0, 400),
    viewport: { width: innerWidth, height: innerHeight, dpr: Math.round(devicePixelRatio * 100) / 100 },
    locale: locale(),
    theme: `${appearance.mode}/${appearance.accent}`,
    timeZone: zoneNow(),
    android: android !== null,
    online: navigator.onLine,
    errors: [...errors],
    failedCalls: [...recentFailures],
    terminal: route.path.startsWith('/term/') ? { ...termDebug, keys: [...termDebug.keys] } : null,
  };
}

/** The app's @font-face rules with their files inline (data: URLs), read once. */
let fonts: Promise<string | null> | null = null;
function fontCss(): Promise<string | null> {
  fonts ??= (async () => {
    const out: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of [...rules]) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        let css = rule.cssText;
        for (const m of [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)]) {
          if (m[2]!.startsWith('data:')) continue;
          const blob = await (await fetch(new URL(m[2]!, sheet.href ?? location.href))).blob();
          const data = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
          });
          css = css.replace(m[0], `url("${data}")`);
        }
        out.push(css);
      }
    }
    return out.length ? out.join('\n') : null;
  })().catch(() => null);
  return fonts;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The private parts' boxes in the picture's pixels: from the page's own corner, times the scale, cut to the page; none of no size. */
export function hiddenAreas(parts: Box[], page: Box, scale: number): Area[] {
  const out: Area[] = [];
  for (const p of parts) {
    const x0 = Math.max(0, p.left - page.left);
    const y0 = Math.max(0, p.top - page.top);
    const x1 = Math.min(page.width, p.left - page.left + p.width);
    const y1 = Math.min(page.height, p.top - page.top + p.height);
    if (x1 > x0 && y1 > y0) out.push({ x: Math.round(x0 * scale), y: Math.round(y0 * scale), w: Math.round((x1 - x0) * scale), h: Math.round((y1 - y0) * scale) });
  }
  return out;
}

/** The picture with the areas covered, each saying it was hidden; in the picture's own format. */
async function cover(picture: string, areas: Area[], scale: number): Promise<string | null> {
  const img = new Image();
  img.src = picture;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const fill = css.getPropertyValue('--bg-sunken').trim() || '#888';
  const ink = css.getPropertyValue('--text-dim').trim() || '#444';
  g.font = `${Math.round(13 * scale)}px ${css.getPropertyValue('--font').trim() || 'sans-serif'}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const a of areas) {
    g.fillStyle = fill;
    g.fillRect(a.x, a.y, a.w, a.h);
    g.fillStyle = ink;
    g.fillText(t('bug.hiddenArea'), a.x + a.w / 2, a.y + Math.min(a.h / 2, 40 * scale), a.w - 8);
  }
  const jpeg = picture.startsWith('data:image/jpeg');
  const out = canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.8);
  return out.length <= SCREENSHOT_MAX_CHARS ? out : canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * In the app: the screen as the person sees it, taken by the app (report "the picture is not the
 * screen I see": drawn from the markup it showed the whole page, the editor's panels and a dialog
 * not as they were). The report's own button left out; what files, terminals and logs show covered
 * as in the drawn picture. Null (an app before 2.9.2, a copy that failed): the page draws its own.
 */
async function appScreen(): Promise<{ full: string; masked: string; hidden: number } | null> {
  if (!android) return null;
  const own = [...document.querySelectorAll<HTMLElement>('.bugbar')];
  for (const el of own) el.style.visibility = 'hidden';
  try {
    // Painted without the button before the copy.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const parts = [...document.querySelectorAll<HTMLElement>('[data-private]')].filter((el) => el.getClientRects().length && !el.closest('[data-bug-ui]')).map((el) => el.getBoundingClientRect());
    const shot = await android.screenshot(Math.round(innerWidth * Math.min(devicePixelRatio, 2)));
    const areas = hiddenAreas(parts, { left: 0, top: 0, width: innerWidth, height: innerHeight }, shot.width / innerWidth);
    if (!areas.length) return { full: shot.picture, masked: shot.picture, hidden: 0 };
    // Not covered is not sent: without a picture rather than with the secrets in it.
    const masked = await cover(shot.picture, areas, shot.width / innerWidth).catch(() => null);
    return masked ? { full: shot.picture, masked, hidden: areas.length } : null;
  } catch {
    return null;
  } finally {
    for (const el of own) el.style.visibility = '';
  }
}

export async function captureScreen(): Promise<{ full: string; masked: string; hidden: number } | null> {
  const fromApp = await appScreen();
  if (fromApp) return fromApp;
  // The picture is drawn from the page's markup: a ticked box or a typed
  // value lives in the element, not the markup, and showed empty ("40 of 40
  // chosen" above forty empty boxes). Written into the markup for the
  // picture, and taken out again after.
  const undo: (() => void)[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type=checkbox], input[type=radio]')) {
    const had = el.hasAttribute('checked');
    el.toggleAttribute('checked', el.checked);
    undo.push(() => el.toggleAttribute('checked', had));
  }
  for (const el of document.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=radio]):not([type=password]):not([type=file])')) {
    const had = el.getAttribute('value');
    el.setAttribute('value', el.value);
    undo.push(() => (had === null ? el.removeAttribute('value') : el.setAttribute('value', had)));
  }
  // A chosen option likewise: the picture showed a Dutch page with
  // "English" in its language box (the first option).
  for (const sel of document.querySelectorAll<HTMLSelectElement>('select')) {
    for (const o of sel.options) {
      const had = o.hasAttribute('selected');
      o.toggleAttribute('selected', o.selected);
      undo.push(() => o.toggleAttribute('selected', had));
    }
  }
  // A very long page is drawn as the part around the screen (report 8344c1: a folder of 4000+
  // files crashed the app), and the rows of a long list far from it are left out meanwhile.
  const win = shotWindow(document.documentElement.scrollHeight, document.documentElement.scrollTop || 0, innerHeight);
  thinLongLists(win, undo);
  // A page longer than the screen is drawn whole; a bar fixed to the screen
  // (the phone's bottom nav) came out in the middle of it, over the content.
  // While the picture is taken: at the top or the bottom of the part drawn.
  if (document.documentElement.scrollHeight > innerHeight + 1) {
    const body = document.body;
    const hadPos = body.style.position;
    body.style.position = 'relative';
    undo.push(() => (body.style.position = hadPos));
    for (const el of shown()) {
      if (getComputedStyle(el).position !== 'fixed' || !el.getClientRects().length || el.closest('dialog, [data-bug-ui]')) continue;
      const r = el.getBoundingClientRect();
      const atBottom = r.top > innerHeight / 2;
      // As high as the screen (the rail at the left): as high as the page,
      // it stopped halfway down a long one (report 117b14).
      const fullHeight = r.top <= 1 && r.bottom >= innerHeight - 1;
      const had = el.getAttribute('style');
      if (win.top === 0 && win.height >= document.documentElement.scrollHeight) {
        el.style.position = 'absolute';
        el.style.top = atBottom ? 'auto' : '0';
        el.style.bottom = atBottom || fullHeight ? '0' : 'auto';
        if (fullHeight) el.style.height = 'auto';
      } else {
        // Only a part of the page is drawn: still fixed, which in the picture is to its frame, whose
        // bottom is not the page's (the bottom bar was left out).
        if (atBottom) {
          el.style.top = `${win.height - r.height}px`;
          el.style.bottom = 'auto';
        }
        if (fullHeight) el.style.height = `${win.height}px`;
      }
      undo.push(() => (had === null ? el.removeAttribute('style') : el.setAttribute('style', had)));
    }
  }
  // Lines a long log skips drawing off screen (content-visibility) came out
  // empty in the picture: drawn in full while it is taken.
  document.documentElement.classList.add('capturing');
  undo.push(() => document.documentElement.classList.remove('capturing'));
  // What stands on one line on the screen stays on one line in the picture (shotlines.ts).
  undo.push(markLines(document.body, (el) => !!el.closest(`[${SKIP}], [data-bug-ui]`)));
  try {
    const { domToJpeg, domToPng } = await import('modern-screenshot');
    const whole = win.top === 0 && win.height >= document.body.scrollHeight;
    const options = {
      scale: shotScale(document.body.scrollWidth, whole ? document.body.scrollHeight : win.height),
      // Only the part around the screen of a very long page: the body moved up under a frame of that height.
      ...(whole ? {} : { height: win.height, style: { marginTop: `${-win.top}px` } }),
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      // Rows scrolled sideways (a long path) as they are on the screen: the picture showed them at
      // their start, the folder and its star out of sight (report b7caab).
      features: { restoreScrollPosition: true },
      onCloneEachNode: keepLine,
      // The rows left out (thinLongLists) not copied at all: hidden, they were still copied one by one.
      filter: (n: Node) => !(n instanceof Element && (n.hasAttribute(SKIP) || n.closest('[data-bug-ui]'))),
      // The fonts in the picture, read here: the library resolves them with a <base> set to the
      // stylesheet, which the page's policy (base-uri 'none') refuses, ten errors a report (W-FUNC-14).
      ...((await fontCss()) ? { font: { cssText: (await fontCss())! } } : {}),
    };
    // A very long page (a host's Docker images) made a picture the server
    // refused, and the report with it (report 8f41d4): drawn smaller, and
    // as a JPEG when the PNG is still too big.
    // What files, terminals and logs show, where it is on the page: covered in the picture sent
    // unless the person chooses otherwise. Measured now, with the fixed bars where the picture has them.
    const parts = [...document.querySelectorAll<HTMLElement>('[data-private]')].filter((el) => el.getClientRects().length && !el.closest('[data-bug-ui]')).map((el) => el.getBoundingClientRect());
    const body = document.body.getBoundingClientRect();
    const areas = hiddenAreas(parts, whole ? body : { left: body.left, top: body.top + win.top, width: body.width, height: win.height }, options.scale);
    const png = await domToPng(document.body, options);
    let full: string | null = png;
    if (png.length > SCREENSHOT_MAX_CHARS) {
      const jpeg = await domToJpeg(document.body, { ...options, quality: 0.8 });
      full = jpeg.length <= SCREENSHOT_MAX_CHARS ? jpeg : null;
    }
    if (!full) return null;
    if (!areas.length) return { full, masked: full, hidden: 0 };
    // Not covered is not sent: without a picture rather than with the secrets in it.
    const masked = await cover(full, areas, options.scale).catch(() => null);
    return masked ? { full, masked, hidden: areas.length } : null;
  } catch {
    // A page the library cannot draw: the report goes without.
    return null;
  } finally {
    for (const u of undo) u();
  }
}

/**
 * Without going through Settings first: a shake of the phone (the app sends
 * it) or Ctrl+Shift+B on a computer reports what is on the screen. Taken in
 * the capture phase, so a terminal does not get it as Ctrl+B (tmux's key).
 */
export function watchReportGestures(): void {
  android?.on('shake', () => void startReport());
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== 'KeyB') return;
      e.preventDefault();
      e.stopPropagation();
      void startReport();
    },
    { capture: true },
  );
}

/** The longest part of a page a picture shows, in CSS pixels: about ten phone screens. */
export const MAX_SHOT_HEIGHT = 8000;

/**
 * The part of the page the picture shows: all of it when it is not too long, else MAX_SHOT_HEIGHT
 * around the screen, kept within the page.
 */
export function shotWindow(pageHeight: number, viewTop: number, viewHeight: number): { top: number; height: number } {
  if (pageHeight <= MAX_SHOT_HEIGHT) return { top: 0, height: pageHeight };
  const top = Math.round(Math.min(Math.max(0, viewTop + viewHeight / 2 - MAX_SHOT_HEIGHT / 2), pageHeight - MAX_SHOT_HEIGHT));
  return { top, height: MAX_SHOT_HEIGHT };
}

/** Marks a row left out of the picture. */
const SKIP = 'data-shot-skip';

/** The page's elements, without the rows left out and what is in them. */
function shown(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => ((n as Element).hasAttribute(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n as HTMLElement);
  return out;
}

/** A list with more rows than this has the ones far from the screen left out of the picture. */
const LONG_LIST = 150;

/**
 * Which rows (their tops and bottoms on the page; null for one not drawn at all) touch the part
 * drawn: from the first to the last that do; null for none. One not drawn says nothing about where
 * the part is: a header hidden on a phone was "at the top", and the whole list was kept.
 */
export function rowsInWindow(rows: ({ top: number; bottom: number } | null)[], win: { top: number; height: number }): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  rows.forEach((r, i) => {
    if (r && r.bottom > win.top && r.top < win.top + win.height) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return first < 0 ? null : { first, last };
}

/**
 * Every list of more than LONG_LIST rows: the rows outside the part drawn hidden while the picture
 * is taken, a spacer of their height in their place, so what is drawn stays where it was. Copying
 * thousands of rows with their styles into the picture took the app's memory.
 */
function thinLongLists(win: { top: number; height: number }, undo: (() => void)[]): void {
  const lists = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => el.childElementCount > LONG_LIST && !el.closest('[data-bug-ui]'));
  // Page coordinates: what the page is scrolled by.
  const y = document.documentElement.scrollTop || 0;
  for (const list of lists) {
    const kids = [...list.children] as HTMLElement[];
    const rows = kids.map((k) => {
      if (!k.getClientRects().length) return null;
      const r = k.getBoundingClientRect();
      return { top: r.top + y, bottom: r.bottom + y };
    });
    const keep = rowsInWindow(rows, win);
    if (keep && keep.first === 0 && keep.last === kids.length - 1) continue;
    const height = () => list.getBoundingClientRect().height;
    const before = height();
    const spacer = () => {
      const el = document.createElement(kids[0]!.tagName);
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'display:block;height:0;margin:0;padding:0;border:0;flex:none;grid-column:1/-1';
      undo.push(() => el.remove());
      return el;
    };
    kids.forEach((k, i) => {
      if ((keep && i >= keep.first && i <= keep.last) || !rows[i]) return;
      const had = k.getAttribute('style');
      k.style.display = 'none';
      k.setAttribute(SKIP, '');
      undo.push(() => (k.removeAttribute(SKIP), had === null ? k.removeAttribute('style') : k.setAttribute('style', had)));
    });
    // Above the rows kept: as high as what went, measured again for gaps between rows.
    if (keep && keep.first > 0) {
      const above = spacer();
      kids[keep.first]!.before(above);
      const want = rows[keep.first]!.top;
      const now = kids[keep.first]!.getBoundingClientRect().top + y;
      above.style.height = `${Math.max(0, want - now)}px`;
    }
    // Below (or in place of all of them): what is left of the list's height.
    const below = spacer();
    if (keep) kids[keep.last]!.after(below);
    else list.append(below);
    below.style.height = `${Math.max(0, before - height())}px`;
  }
}

/**
 * How much bigger than CSS pixels the picture is drawn: the screen's own
 * density up to 2, less for a long page, so that it stays within what a
 * canvas can hold and what the server takes.
 */
export function shotScale(width: number, height: number, dpr = devicePixelRatio): number {
  const MAX_PIXELS = 12_000_000;
  const MAX_SIDE = 16_000;
  return Math.min(dpr, 2, MAX_SIDE / Math.max(1, height), MAX_SIDE / Math.max(1, width), Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
}

/** Tapped the report button: capture first, then open the form. */
/** How long the picture may take before the screen says it is being made. */
const CAPTURE_SAID_MS = 300;

export async function startReport(): Promise<void> {
  // A second shake, or the key again: the form is there already.
  if (bug.open || bug.capturing) return;
  // Which dialog was open (the report's own is not open yet).
  bug.dialog = document.querySelector<HTMLElement>('dialog[open]')?.dataset.tour ?? null;
  bug.capturing = true;
  // How to start a report: said, and done; not in the picture, nor over the form (report 04436d).
  dropToast(t('bug.armed'));
  // On a terminal: the input up to now, before the form takes the keyboard.
  bug.recording = route.path.startsWith('/term/') && recordedCount() ? recording(true) : null;
  // A picture that takes a while (a phone's terminal page: seconds, gate 38): said while it is
  // made, the words not in it. Not for a quick one: no flash.
  let done = (): void => {};
  const slow = setTimeout(() => (done = toastWhile(t('bug.capturing'), { apart: true, testid: 'bug-capturing' })), CAPTURE_SAID_MS);
  const shot = await captureScreen().finally(() => (clearTimeout(slow), done()));
  bug.shot = shot?.masked ?? null;
  bug.shotFull = shot?.full ?? null;
  bug.hidden = shot?.hidden ?? 0;
  bug.capturing = false;
  bug.open = true;
}

/** `shot`: the screenshot's private parts, covered or shown on purpose (null: no screenshot sent). */
export async function sendReport(input: Omit<BugReportInput, 'context'>, shot: BugContext['shot'] = null): Promise<string> {
  const { id } = await post<{ id: string }>('/api/bugreports', { ...input, context: { ...bugContext(), shot } });
  return id;
}
