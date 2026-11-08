// ANSI colours in log lines, as HTML: SGR codes only (colours, bold, dim,
// italic, underline); everything else is dropped. Text is escaped first, so
// a log line can never become markup.

import { escapeHtml as escape } from './escape.js';

// The 16 named colours come from the theme (app.css --ansi-N): the usual
// ones are made for a dark screen and unreadable on the light theme.
const BASIC = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `var(--ansi-${i})`);
const BRIGHT = [8, 9, 10, 11, 12, 13, 14, 15].map((i) => `var(--ansi-${i})`);


function color256(n: number): string {
  if (n < 8) return BASIC[n]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n < 232) {
    const v = n - 16;
    const c = (x: number) => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(v / 36))},${c(Math.floor(v / 6) % 6)},${c(v % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/**
 * What a terminal acts on but a log line does not show: OSC (a title, a
 * hyperlink), DCS/PM/APC strings, and the other escapes. Kept, they showed
 * as text and were searched (AUDIT2 TERM-19). An unterminated one runs to
 * the end of the line; linear, whatever the input.
 */
// eslint-disable-next-line no-control-regex
const OTHER = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_][^\x1b]*(?:\x1b\\)?|\x1b[()*+#][0-9A-Za-z]|\x1b[0-?@-Z\\^_`a-z{|}~]/g;
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-?]*)[ -/]*([@-~])/g;

export function stripAnsi(s: string): string {
  return s.replace(OTHER, '').replace(CSI, '');
}

/** What an SGR code set: the colours and kinds of letter, carried from one piece of text to the next. */
interface Sgr {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  under: boolean;
  inverse: boolean;
  strike: boolean;
}
const plain = (): Sgr => ({ fg: null, bg: null, bold: false, dim: false, italic: false, under: false, inverse: false, strike: false });

function convert(raw: string, st: Sgr): string {
  let out = '';
  const text = raw.replace(OTHER, '');
  const re = new RegExp(CSI.source, 'g');
  let last = 0;
  const emit = (chunk: string) => {
    if (!chunk) return;
    // Reversed (a selection, a status bar): the letters in the background's colour, on the letters' own.
    const fg = st.inverse ? (st.bg ?? 'var(--bg-sunken)') : st.fg;
    const bg = st.inverse ? (st.fg ?? 'var(--text)') : st.bg;
    const deco = [st.under && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
    const style = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && 'font-weight:700', st.dim && 'opacity:.7', st.italic && 'font-style:italic', deco && `text-decoration:${deco}`]
      .filter(Boolean)
      .join(';');
    out += style ? `<span style="${style}">${escape(chunk)}</span>` : escape(chunk);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    emit(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) Object.assign(st, plain());
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.under = true;
      else if (c === 7) st.inverse = true;
      else if (c === 9) st.strike = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.under = false;
      else if (c === 27) st.inverse = false;
      else if (c === 29) st.strike = false;
      else if (c >= 30 && c <= 37) st.fg = BASIC[c - 30]!;
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = BASIC[c - 40]!;
      else if (c === 49) st.bg = null;
      else if (c >= 90 && c <= 97) st.fg = BRIGHT[c - 90]!;
      else if (c >= 100 && c <= 107) st.bg = BRIGHT[c - 100]!;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = color256(codes[i + 2] ?? 0);
        if (c === 38) st.fg = col;
        else st.bg = col;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (c === 38) st.fg = col;
        else st.bg = col;
        i += 4;
      }
    }
  }
  emit(text.slice(last));
  return out;
}

export function ansiToHtml(raw: string): string {
  return convert(raw, plain());
}

/**
 * A terminal's history as HTML, a line each: a colour set on one line goes
 * on to the next (tmux's capture-pane -e sets it once for a run of lines).
 */
export function ansiLines(raw: string): string[] {
  const st = plain();
  return raw.split('\n').map((line) => convert(line, st));
}

/**
 * Wrapping places in long names (Emby.Server.Implementations..., paths):
 * after a dot, slash, underscore or colon followed by a letter or digit, so
 * a log line wraps there and not between two letters. <wbr> adds nothing
 * to copied text. Text only: tags and entities are left alone.
 */
export function softBreaks(html: string): string {
  return html
    .split(/(<[^>]*>|&[#\w]+;)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<=\S)([./_:\\])(?=[A-Za-z0-9])/g, '$1<wbr>')))
    .join('');
}
