import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { dayNames, whenText, zonesWith } = await import('./schedule.js');

describe('when something runs by itself', () => {
  it('the days Sunday first, as the server counts them', () => {
    expect(dayNames('en')[0]).toBe('Sunday');
    expect(dayNames('en')[1]).toBe('Monday');
    expect(dayNames('nl')[6]).toBe('zaterdag');
  });

  it('said in words: weekly, daily, or the cron expression itself', () => {
    expect(whenText({ kind: 'weekly', day: 1, time: '08:00', cron: null })).toBe('every Monday at 08:00');
    expect(whenText({ kind: 'daily', day: 1, time: '03:00', cron: null })).toBe('every day at 03:00');
    expect(whenText({ kind: 'cron', day: 1, time: '03:00', cron: '0 4 * * *' })).toBe('cron 0 4 * * *');
  });

  it('the time zones offered: sorted, UTC and the one set always among them', () => {
    const z = zonesWith('Mars/Olympus');
    expect(z).toContain('UTC');
    expect(z).toContain('Mars/Olympus');
    expect([...z].sort()).toEqual(z);
  });
});
