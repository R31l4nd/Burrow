import { describe, expect, it } from 'vitest';
import { USAGE_KEYS, usageCounts, usagePage } from './usage.js';

describe('what Settings -> Usage counts', () => {
  it('a page by its name, never by a host, container, file or token in its address', () => {
    expect(usagePage('#/hosts/12/stats')).toBe('page:hosts/:id/stats');
    expect(usagePage('#/containers/3/nginx?tab=logs')).toBe('page:containers/:id/:name');
    expect(usagePage('#/invite/abcdef123')).toBe('page:invite/:name');
    expect(usagePage('#/settings/appearance')).toBe('page:settings/appearance');
    expect(usagePage('#/settings/usage')).toBe('page:settings/usage');
    expect(usagePage('#/settings/somewhere')).toBe('page:settings/:name');
    expect(usagePage('')).toBe('page:hosts');
  });

  it('every page and every dialog is a key, so the ones never opened are listed too', () => {
    expect(USAGE_KEYS).toContain('page:hosts/:id/journal');
    expect(USAGE_KEYS).toContain('page:settings/usage');
    expect(USAGE_KEYS).toContain('dialog:processes');
    expect(USAGE_KEYS).not.toContain('page:settings/:name');
  });

  it('keeps the known keys of a batch and drops the rest (an old tab after an update, a made-up dialog): the valid counts are not lost', () => {
    expect(usageCounts.parse({ 'page:hosts/:id/stats': 2, 'page:settings/ai': 1, 'dialog:processes': 3 })).toEqual({ 'page:hosts/:id/stats': 2, 'page:settings/ai': 1, 'dialog:processes': 3 });
    expect(usageCounts.parse({ 'page:hosts': 1, 'page:containers/3/nginx': 1, 'page:nowhere': 1, 'dialog:made-up': 1, 'dialog:Has Spaces': 1, 'other:x': 1 })).toEqual({ 'page:hosts': 1 });
  });

  it('refuses counts that are not counts, and more than 200 keys at once', () => {
    for (const bad of [{ 'dialog:processes': 0 }, { 'dialog:processes': 1.5 }, { 'dialog:processes': 100_001 }]) expect(usageCounts.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`dialog:d${i}`, 1]));
    expect(usageCounts.safeParse(many).success).toBe(false);
  });
});
