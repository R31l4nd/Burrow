import { describe, expect, it, vi } from 'vitest';

// Times in the app's language (A3-WEB-13): "draait 2h" was English in the
// Dutch app, and English dates were American ("Oct 11, 2026") while the rule
// is "28 Sep 2026, 16:05".
vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { since } = await import('./docker.svelte.js');
const { dateOnly, dateTime, setLocale } = await import('./i18n/index.svelte.js');
const { uptimeLabel } = await import('./uptime.js');

describe('a duration', () => {
  it('short in English, in words in Dutch, and singular for one', async () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    const ago = (s: number) => new Date(now - s * 1000).toISOString();
    await setLocale('en');
    expect([45, 720, 10800, 172800, 86400].map((s) => since(ago(s), now))).toEqual(['45s', '12m', '3h', '2d', '1d']);
    await setLocale('nl');
    expect([45, 720, 10800, 172800, 86400].map((s) => since(ago(s), now))).toEqual(['45 s', '12 min', '3 uur', '2 dagen', '1 dag']);
    await setLocale('en');
  });
});

describe('a date', () => {
  it('the month in words, day first, 24 hours, in both languages', async () => {
    const at = new Date(2026, 8, 28, 16, 5);
    await setLocale('en');
    expect(dateTime(at)).toBe('28 Sep 2026, 16:05');
    expect(dateOnly(at)).toBe('28 Sep 2026');
    await setLocale('nl');
    expect(dateTime(at)).toBe('28 sep 2026, 16:05');
    await setLocale('en');
  });
});

describe("an app's uptime (A3-WEB-22)", () => {
  it('a short outage is not rounded away to 100%', () => {
    expect(uptimeLabel(1)).toBe('100%');
    expect(uptimeLabel(0.9996)).toBe('99.9%');
    expect(uptimeLabel(0.995)).toBe('99.5%');
    expect(uptimeLabel(0.951)).toBe('95.1%');
    expect(uptimeLabel(0.5)).toBe('50%');
    expect(uptimeLabel(null)).toBe('100%');
  });
});
