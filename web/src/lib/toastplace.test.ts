import { afterEach, describe, expect, it, vi } from 'vitest';
import { framed, toastSpot } from './toastplace.js';

// Where the toasts go (components/Toasts.svelte): never over a button, a field or a message. The
// page is measured once per placing; the spots tried are worked out from those boxes (audit
// 2026-11-05: each try moved the toasts and measured the whole page again).
const H = 800;
// The toasts at their own place: 100 px high, their foot 80 px above the screen's.
const own = { top: 620, bottom: 720, height: 100 };
const spot = (boxes: { top: number; y: number }[], more: Partial<Parameters<typeof toastSpot>[0]> = {}) => toastSpot({ own, screen: H, lift: 0, sheetTop: null, high: 60, boxes, ...more });

describe('toastSpot', () => {
  it('nothing under them: their own place', () => {
    expect(spot([])).toBeNull();
    // A button far above them is not in the way.
    expect(spot([{ top: 200, y: 220 }])).toBeNull();
  });

  it('a bar at the foot under them (a selection bar): lifted above it', () => {
    expect(spot([], { lift: 150 })).toEqual({ bottom: 150, top: null });
  });

  it('a button under them: just above the buttons they would cover', () => {
    // A button at 650-690: over it at their place; above it they cover nothing.
    expect(spot([{ top: 650, y: 670 }])).toEqual({ bottom: H - 650 + 8, top: null });
  });

  it("an open dialog's sheet with room above it: over the dimmed page, not on its fields", () => {
    expect(spot([{ top: 650, y: 670 }, { top: 500, y: 520 }], { sheetTop: 450 })).toEqual({ bottom: H - 450 + 8, top: null });
  });

  it('buttons all down the column (a list of rows): in a gap between two, else under the title bar', () => {
    const rows = [100, 200, 300, 520, 620, 700].map((y) => ({ top: y - 15, y }));
    const at = spot(rows)!;
    const top = H - at.bottom! - own.height;
    for (const r of rows) expect(r.y < top - 4 || r.y > top + own.height + 4).toBe(true);
    // No spot free: the one that covers fewest (here above the crowded foot), the first of equals.
    const full = [...Array.from({ length: 20 }, (_, i) => ({ top: 40 * i + 5, y: 40 * i + 20 })), ...[630, 650, 670, 690, 710].map((y) => ({ top: y - 10, y }))];
    expect(spot(full)).toEqual({ bottom: 203, top: null });
    // Rows from below the title bar to the foot, too close for a gap: under the title bar.
    const rows2 = Array.from({ length: 15 }, (_, i) => ({ top: 160 + 40 * i, y: 170 + 40 * i }));
    expect(spot(rows2)).toEqual({ bottom: null, top: 60 });
  });
});

describe('framed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a burst of scroll events in one frame: placed once, in the next frame', () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f));
    const place = vi.fn();
    const soon = framed(place);
    for (let i = 0; i < 30; i++) soon();
    expect(place).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(place).toHaveBeenCalledOnce();
    soon();
    expect(frames).toHaveLength(1);
  });
});
