import { describe, expect, it, vi } from 'vitest';
import type { PackageSummary } from '@burrow/shared';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { marks, updatesLine } = await import('./packages.js');

const sum = (s: Partial<PackageSummary>): PackageSummary => ({ hostId: 1, checkedAt: '2026-11-01T12:00:00.000Z', state: 'ok', total: 0, security: 0, reboot: false, listAt: null, ...s });

describe("a host's package updates", () => {
  it('said with only what applies', () => {
    expect(updatesLine(sum({ total: 3, security: 2, reboot: true }))).toBe('3 updates | 2 security | restart needed');
    expect(updatesLine(sum({ total: 1 }))).toBe('1 update');
    expect(updatesLine(sum({ reboot: true }))).toBe('restart needed');
    expect(updatesLine(sum({}))).toBe('0 updates');
  });

  it('marked on the host list only when something waits, at a check that read the list', () => {
    expect(marks(sum({ total: 2 }))).toBe(true);
    expect(marks(sum({ reboot: true }))).toBe(true);
    expect(marks(sum({}))).toBe(false);
    expect(marks(sum({ state: 'error', total: 2 }))).toBe(false);
    expect(marks(undefined)).toBe(false);
  });
});
