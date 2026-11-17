// A workspace's sizes on this device (report 780048): the file list's width
// in pixels, and the share of the left editor of two side by side and of a
// file beside its Markdown preview. Changed by dragging the edge between
// them, as VS Code's sashes; a double click puts one back.

const KEY = 'burrow.wsLayout';

export const WS_LAYOUT = { side: 290, split: 0.5, md: 0.5 } as const;
/** The file list's narrowest, and the room the editor always keeps beside it. */
export const SIDE_MIN = 180;
export const EDITOR_MIN = 480;

type Layout = { side: number; split: number; md: number };

/** A share of the room between 20 and 80 %, as the terminal's dividers. */
export const share = (n: number) => Math.min(0.8, Math.max(0.2, Math.round(n * 1000) / 1000));

function read(): Layout {
  const out: Layout = { ...WS_LAYOUT };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof Layout, unknown>>;
    if (typeof v.side === 'number' && v.side >= SIDE_MIN) out.side = Math.round(v.side);
    for (const k of ['split', 'md'] as const) {
      const n = v[k];
      if (typeof n === 'number') out[k] = share(n);
    }
  } catch {
    // Nothing kept, or not readable: the sizes to start with.
  }
  return out;
}

export const wsLayout = $state<Layout>(read());

export function keepWsLayout() {
  try {
    localStorage.setItem(KEY, JSON.stringify(wsLayout));
  } catch {
    // Not kept: it holds until the page is left.
  }
}

