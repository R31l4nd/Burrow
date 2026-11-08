// The terminal's colours from the page's theme, ANSI ones included (xterm's
// own are for a dark screen: bright green on the light theme could not be
// read). Shared by the terminal, the watching view and the recording player.

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** "#1a7f37" at 40%: a selection that shows (grey on grey did not). */
function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  return m ? `#${m[1]}${Math.round(a * 255).toString(16).padStart(2, '0')}` : hex;
}

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

export function termTheme() {
  const named = Object.fromEntries(
    ANSI.flatMap((n, i) => [
      [n, cssVar(`--ansi-${i}`)],
      [`bright${n[0]!.toUpperCase()}${n.slice(1)}`, cssVar(`--ansi-${i + 8}`)],
    ]),
  );
  return { background: cssVar('--bg-sunken'), foreground: cssVar('--text'), cursor: cssVar('--accent'), selectionBackground: withAlpha(cssVar('--accent'), 0.4), ...named };
}

/**
 * Keeps a terminal's colours with the page's theme: light/dark or the accent
 * changed (Settings, or the system). The watching view kept a light terminal
 * on a dark page (its text at 1.1:1); returns the stop.
 */
export function followTheme(term: { options: { theme?: unknown } }): () => void {
  const retheme = () => (term.options.theme = termTheme());
  const watch = new MutationObserver(retheme);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', retheme);
  return () => {
    watch.disconnect();
    scheme.removeEventListener('change', retheme);
  };
}
