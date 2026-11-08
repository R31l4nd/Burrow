// A finger's scroll when the host scrolls (a tmux, or a program that takes
// the mouse): each step is a round trip and a redraw there, so a slow drag
// goes line for line (precise) and a fast swipe takes more lines per bit of
// finger, as a phone's own lists do. Burrow's own history (a plain shell)
// stays one to one: it scrolls here, at once.

/** Below this finger speed (px/ms): one line per line the finger moved. */
const SLOW = 0.4;
/** From this speed on: the most lines per line the finger moved. */
const FAST = 2;
const MOST = 4;

export function speedUp(speed: number): number {
  const v = Math.abs(speed);
  if (v <= SLOW) return 1;
  if (v >= FAST) return MOST;
  return 1 + ((v - SLOW) / (FAST - SLOW)) * (MOST - 1);
}

/** Finger speed (px/ms) over the last touches, newest last. */
export function fingerSpeed(track: { y: number; t: number }[]): number {
  const first = track[0];
  const last = track[track.length - 1];
  if (!first || !last || last.t - first.t < 8) return 0;
  return (last.y - first.y) / (last.t - first.t);
}
