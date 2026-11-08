// A computed CSS colour as "#rrggbb": what the browser's theme-color and the
// Android app's status bar take. Tokens mixed with the accent (report 5d820e)
// read as "color-mix(...)" and compute to "color(srgb r g b)", not hex; the
// app ignored them and its status bar kept its old colour.

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');

/** "rgb(9, 9, 9)", "rgba(...)" or "color(srgb 0.03 0.04 0.05)" as "#rrggbb"; null for anything else. */
export function cssToHex(css: string): string | null {
  const c = css.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(c);
  if (srgb) return `#${[srgb[1], srgb[2], srgb[3]].map((v) => hex2(Number(v) * 255)).join('')}`;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((v) => hex2(Number(v))).join('')}`;
  return null;
}
