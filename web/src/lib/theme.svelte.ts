// Appearance: light/dark/black (OLED)/system and an accent preset. A per-device choice,
// kept in localStorage: a phone and a laptop may well want different themes.
// app.css reads html[data-theme] and html[data-accent].

import { android } from './android.js';
import { cssToHex } from './colorhex.js';

export type ThemeMode = 'auto' | 'light' | 'dark' | 'black';
export const ACCENTS = ['green', 'blue', 'purple', 'orange', 'pink', 'teal'] as const;
export type Accent = (typeof ACCENTS)[number];

const KEY = 'burrow.appearance';

function read(): { mode: ThemeMode; accent: Accent } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { mode?: string; accent?: string };
    return {
      mode: v.mode === 'light' || v.mode === 'dark' || v.mode === 'black' ? v.mode : 'auto',
      accent: (ACCENTS as readonly string[]).includes(v.accent ?? '') ? (v.accent as Accent) : 'green',
    };
  } catch {
    return { mode: 'auto', accent: 'green' };
  }
}

export const appearance = $state(read());

export function applyAppearance(): void {
  const root = document.documentElement;
  if (appearance.mode === 'auto') delete root.dataset.theme;
  else root.dataset.theme = appearance.mode;
  root.dataset.accent = appearance.accent;
  paintChrome();
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch {
    // Not remembered on this device; the choice holds for this page.
  }
}

// The browser's and the phone's bar above the page: the title bar's colour,
// dark on a phone, light on a wider screen. The Android app paints its status
// bar the same way. On a wider screen it was the page's background, a grey
// strip over the white title bar on a phone held sideways (report dfc5b0).
const narrow = window.matchMedia('(max-width: 719px)');
// A colour as the browser computes it, as hex (a mixed token reads as
// "color-mix(...)", which neither theme-color nor the app takes).
function colorHex(css: string, fallback: string): string {
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;visibility:hidden;color:${css}`;
  document.documentElement.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return cssToHex(color) ?? getComputedStyle(document.documentElement).getPropertyValue(fallback).trim();
}
function paintChrome(): void {
  // The wide title bar is the raised colour, 94% over the page (app.css .topbar).
  const top = narrow.matches ? colorHex('var(--side)', '--side') : colorHex('color-mix(in srgb, var(--bg-raised) 94%, var(--bg))', '--bg');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', top);
  void android?.chrome(top).catch(() => {});
}
narrow.addEventListener('change', paintChrome);

export function setMode(mode: ThemeMode): void {
  appearance.mode = mode;
  applyAppearance();
}

export function setAccent(accent: Accent): void {
  appearance.accent = accent;
  applyAppearance();
}

// Chosen in another tab of this Burrow: this one follows, at once.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  Object.assign(appearance, read());
  applyAppearance();
});

// Follow the system while in auto, so theme-color stays in step.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (appearance.mode === 'auto') applyAppearance();
});
