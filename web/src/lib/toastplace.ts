// Where the toasts go (components/Toasts.svelte), worked out from boxes measured once: the buttons
// and fields in the toasts' column (their middle height and top), the toasts' own box at their own
// place, a bar at the foot to stay above (lift), an open dialog's sheet and the title bar's foot.
// Each spot tried used to move the toasts and measure every button of the page again, a forced
// layout per try, four times a second and on every scroll event (audit 2026-11-05).

/** Room kept between the toasts and the middle of a button, in pixels. */
const EDGE = 4;

export interface ToastSpot {
  /** From the screen's foot, or null when placed from the top. */
  bottom: number | null;
  top: number | null;
}

/** The spot that covers no button, else the fewest; null: their own place. */
export function toastSpot(o: { own: { top: number; bottom: number; height: number }; screen: number; lift: number; sheetTop: number | null; high: number; boxes: readonly { top: number; y: number }[] }): ToastSpot | null {
  const { own, screen: h, lift, high, boxes } = o;
  const covers = (s: ToastSpot) => {
    const top = s.bottom !== null ? h - s.bottom - own.height : s.top!;
    // A few pixels of room: a button whose middle was on the toasts' very edge counted as free, and a tap there hit them.
    return boxes.filter((r) => r.y >= top - EDGE && r.y <= top + own.height + EDGE).length;
  };
  // Where they may go, in this order: at the foot (above a bar there), just above the buttons
  // they would cover, under the title bar. The first that covers no button; else the one that
  // covers fewest (an empty list's Add, a row's Stop, a form's last button).
  const natural = h - own.bottom;
  const foot = Math.max(lift, natural);
  const tries: ToastSpot[] = [{ bottom: foot, top: null }];
  // Above an open dialog's sheet, over the dimmed page, when there is room: lifted over its
  // footer they lay on its fields (a name being typed, the refusal under it; 2.18.0).
  if (o.sheetTop !== null && o.sheetTop - 8 - own.height >= 8) tries.push({ bottom: h - o.sheetTop + 8, top: null });
  const under = boxes.filter((r) => r.y >= own.top - EDGE && r.y < h);
  if (under.length) tries.push({ bottom: h - Math.min(...under.map((r) => r.top)) + 8, top: null });
  // A gap between buttons, nearest the foot: a list of rows, each with its menu button, leaves one
  // between two rows where the foot, above them and under the title bar each cover one.
  const ys = boxes.filter((r) => r.y > 0 && r.y < h).map((r) => r.y);
  const gap = ys
    .map((y) => y + EDGE + 1)
    .filter((t) => t >= high && t + own.height <= h - foot && !ys.some((y) => y >= t - EDGE && y <= t + own.height + EDGE))
    .sort((a, b) => b - a)[0];
  if (gap !== undefined) tries.push({ bottom: h - gap - own.height, top: null });
  tries.push({ bottom: null, top: high });
  let best = tries[0]!;
  let fewest = Infinity;
  for (const t of tries) {
    const n = covers(t);
    if (n < fewest) [best, fewest] = [t, n];
    if (!n) break;
  }
  return best === tries[0] && !lift ? null : best;
}

/** fn once in the next frame, however often this is called before it (scroll events come many a frame). */
export function framed(fn: () => void): () => void {
  let asked = false;
  return () => {
    if (asked) return;
    asked = true;
    requestAnimationFrame(() => {
      asked = false;
      fn();
    });
  };
}
