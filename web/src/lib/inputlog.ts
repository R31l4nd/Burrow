// The last half minute of input on a terminal, for a problem report: what
// the keyboard and the fingers did, and what Burrow made of it (what went to
// the session, how many suggestions showed). Kept in memory only; it leaves
// the device only with a report, and the typed text only when the person
// ticks that box (a terminal is where passwords and tokens get typed).
// `make replay ID=...` plays it again against the test setup.

import type { InputRecording } from '@burrow/shared';

const WINDOW_MS = 30_000;
const MAX = 3000;

/** One event: milliseconds since the page started, its kind (keydown, beforeinput, input, compositionend, touchstart, sent, suggestions, ...) and what it carried. */
export type Entry = InputRecording['entries'][number];
export type Recording = InputRecording;

const entries: Entry[] = [];
const start = typeof performance !== 'undefined' ? performance.now() : 0;
export const terminalState: { compose: boolean; mode: string | null; cols: number; rows: number } = { compose: false, mode: null, cols: 0, rows: 0 };

export function note(e: Omit<Entry, 't'>): void {
  const t = Math.round(performance.now() - start);
  entries.push({ t, ...e });
  while (entries.length > MAX || (entries.length && t - entries[0]!.t > WINDOW_MS)) entries.shift();
}

/**
 * A key that names itself ("Enter", "ArrowUp", "F5"), not a character
 * typed. By its spelling, not its length: an emoji is two UTF-16 units and
 * passed for a named key, kept without consent (AUDIT2 TERM-01).
 */
export const namedKey = (key: string | undefined): key is string => !!key && /^[A-Z][A-Za-z0-9]+$/.test(key);

/** A keyboard, input or composition event on the terminal's field. */
export function noteEvent(ev: Event, field: HTMLTextAreaElement | null): void {
  const k = ev as KeyboardEvent & InputEvent & CompositionEvent;
  if (ev.type.startsWith('key')) {
    const named = namedKey(k.key);
    note({ e: ev.type, keyCode: k.keyCode, key: named ? k.key : undefined, text: !named && k.key ? k.key : undefined, composing: k.isComposing || undefined });
    return;
  }
  note({ e: ev.type, inputType: k.inputType || undefined, text: k.data ?? undefined, composing: k.isComposing || undefined, len: field?.value.length, value: field?.value });
}

/** Touches on the terminal, relative to it. */
export function noteTouch(ev: TouchEvent, area: Element | null): void {
  const r = area?.getBoundingClientRect();
  if (!r || !r.width || !r.height) return;
  const list = ev.type === 'touchend' ? ev.changedTouches : ev.touches;
  const points = [...list].map((p): [number, number] => [Math.round(((p.clientX - r.left) / r.width) * 1000) / 1000, Math.round(((p.clientY - r.top) / r.height) * 1000) / 1000]);
  note({ e: ev.type, points });
}

/** For the report: the last half minute, with or without the text. */
export function recording(withText: boolean): Recording {
  const t = Math.round(performance.now() - start);
  const full: Recording = {
    version: 1,
    withText: true,
    viewport: typeof window !== 'undefined' ? { width: innerWidth, height: innerHeight } : { width: 0, height: 0 },
    terminal: terminalState.cols ? { ...terminalState } : null,
    // A long paste: its start (the report keeps 4000 characters of a text).
    entries: entries.filter((x) => t - x.t <= WINDOW_MS).map((x) => ({ ...x, ...(x.text !== undefined ? { text: x.text.slice(0, 4000) } : {}), ...(x.value !== undefined ? { value: x.value.slice(-4000) } : {}) })),
  };
  return withText ? full : withoutText(full);
}

/** The same without what was typed: its length only, so a replay can type as much. */
export function withoutText(r: Recording): Recording {
  return {
    ...r,
    withText: false,
    entries: r.entries.map((x) => {
      const { text, value, keyCode, ...rest } = x;
      // A key code says which letter or digit it was (80 is "p"): kept only
      // for named keys (Enter, arrows) and an IME's 229, which say nothing typed.
      const code = keyCode !== undefined && (x.key !== undefined || keyCode === 229) ? { keyCode } : {};
      return { ...rest, ...code, ...(text !== undefined ? { textLength: [...text].length } : {}), ...(value !== undefined ? { len: [...value].length } : {}) };
    }),
  };
}

export const recordedCount = (): number => entries.filter((x) => performance.now() - start - x.t <= WINDOW_MS).length;
