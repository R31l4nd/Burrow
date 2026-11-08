// Is a phone's on-screen keyboard open? The page gets shorter while it is
// (the Android app and phone browsers resize it), so: shorter than the
// tallest seen at this width by more than a key row. A key bar that belongs
// to typing shows only then; closing the keyboard (the back gesture) leaves
// the focus where it was, so focus alone keeps the bar up for nothing.

export const softKeyboard = $state({ open: false });

/**
 * Key bars (Esc, Ctrl, arrows) are for a finger: shown on a touch screen or
 * a narrow window, not on a computer with its own keyboard.
 */
export const keyBars = $state({ show: true });

let width = 0;
let tallest = 0;

function measure(): void {
  const vv = window.visualViewport;
  const h = vv?.height ?? window.innerHeight;
  if (window.innerWidth !== width) {
    // Turned or resized sideways: start over.
    width = window.innerWidth;
    tallest = h;
  }
  tallest = Math.max(tallest, h);
  softKeyboard.open = h < tallest - 120;
  keyBars.show = navigator.maxTouchPoints > 0 || window.innerWidth < 900;
}

if (typeof window !== 'undefined') {
  measure();
  window.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('resize', measure);
}
