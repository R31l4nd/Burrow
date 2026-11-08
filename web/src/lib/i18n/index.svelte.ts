import { en, type MessageKey } from './en.js';

export type Locale = 'en' | 'nl';
// English is the source and always there; another language loads when it
// is chosen (each is some 100 KB of the page's first download, #149).
const loaded = $state<Partial<Record<Locale, Record<MessageKey, string>>>>({ en });
async function load(l: Locale): Promise<void> {
  if (l === 'nl' && !loaded.nl) loaded.nl = (await import('./nl.js')).nl;
}
const STORAGE_KEY = 'burrow.locale';

function initial(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'nl') return saved;
  } catch {
    // Storage can be unavailable (private mode); fall back to the browser.
  }
  return navigator.language.toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

const start = initial();
let current = $state<Locale>(start);
document.documentElement.lang = start;
/** The first language's words: the page is mounted once they are there (no English flash). */
export const localeReady: Promise<void> = load(start).catch(() => {});

export const locales: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'nl', label: 'Nederlands' },
];

export function locale(): Locale {
  return current;
}

// Chosen in another tab of this Burrow: this one follows, at once.
globalThis.window?.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY) return;
  const l = e.newValue === 'en' || e.newValue === 'nl' ? e.newValue : initial();
  void load(l).then(() => {
    current = l;
    document.documentElement.lang = l;
  });
});

export async function setLocale(l: Locale): Promise<void> {
  await load(l);
  current = l;
  document.documentElement.lang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // Not persisted; the choice still holds for this page.
  }
}

/**
 * Translate a key, filling {placeholders}; "{n:item|items}" picks the
 * singular when that parameter is 1. Reactive: re-runs when the locale changes.
 */
/** Whether the catalogue has words for a key made at run time (an audit action, a server's error code). */
export const hasKey = (key: string): key is MessageKey => key in en;

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let s = loaded[current]?.[key] ?? en[key];
  if (params) {
    // Plurals first (they may hold a placeholder), so a filled-in value is never read as one.
    s = s.replace(/\{(\w+):((?:[^|{}]|\{\w+\})*)\|((?:[^{}]|\{\w+\})*)\}/g, (_, k: string, one: string, other: string) => (Number(params[k]) === 1 ? one : other));
    s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  }
  return s;
}

/** The formats' locale: English as in Britain (day first), not America's "Sep 28, 2026" (A3-WEB-13). */
export const dateLocale = (): string => (current === 'en' ? 'en-GB' : current);

// English: "28 Sep 2026" made by hand: en-GB's own short month is "Sept" in newer browsers,
// en-US's is "Sep" but comes first. Dutch as the language writes it ("28 sep 2026").
const enDay = (d: Date) => `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${d.getFullYear()}`;

/** A date and time in the app's language (not the browser's): "28 Sep 2026, 16:05", "28 sep 2026, 16:05". */
export function dateTime(at: string | number | Date): string {
  // One way everywhere: the month in words (never 10/5 or 5/10), 24 hours.
  const d = new Date(at);
  if (current === 'en') return `${enDay(d)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
  return d.toLocaleString(current, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
}

/** A date in the app's language. */
export function dateOnly(at: string | number | Date): string {
  const d = new Date(at);
  return current === 'en' ? enDay(d) : d.toLocaleDateString(current, { dateStyle: 'medium' });
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  // Dutch in its short form ("5 min. geleden"): the long one took a meta line's room at 343 px (UIA-08).
  const rtf = new Intl.RelativeTimeFormat(current, { numeric: 'auto', style: current === 'nl' ? 'short' : 'long' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

/** The built-in report's name (stored in English) in the reader's language. */
export const reportName = (name: string): string => (name === 'Weekly report' ? t('reports.weekly') : name);
