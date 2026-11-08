import { describe, expect, it } from 'vitest';
import { judgeDisk, sameDisk, type SmartDisk } from './hoststats.js';
import { alertTitle } from './analysis.js';

const disk = (o: Partial<SmartDisk> = {}): SmartDisk => ({
  device: '/dev/sda',
  model: 'WDC',
  serial: 'S1',
  passed: true,
  celsius: 35,
  powerOnHours: 1000,
  reallocated: 0,
  pending: 0,
  percentUsed: null,
  mediaErrors: null,
  uncorrectable: 0,
  timeouts: 0,
  offlineUncorrectable: 0,
  ...o,
});
const AGO = '2026-09-10T00:00:00.000Z';

describe("a disk judged by Backblaze's five SMART attributes (N4)", () => {
  it('all at zero and SMART says passed: good', () => {
    expect(judgeDisk(disk(), [], 80)).toEqual({ verdict: 'good', reasons: [] });
  });

  it('any of them above zero: watch, with which and how many', () => {
    expect(judgeDisk(disk({ reallocated: 8 }), [], 80)).toEqual({ verdict: 'watch', reasons: [{ code: 'attr', attr: 'reallocated', value: 8 }] });
    expect(judgeDisk(disk({ offlineUncorrectable: 2, uncorrectable: 1 }), [{ at: AGO, disk: disk({ offlineUncorrectable: 2, uncorrectable: 1 }) }], 80).verdict).toBe('watch');
  });

  it('getting worse since the oldest kept check: failing, with what it was and when', () => {
    expect(judgeDisk(disk({ pending: 5 }), [{ at: AGO, disk: disk({ pending: 1 }) }], 80)).toEqual({ verdict: 'failing', reasons: [{ code: 'attr', attr: 'pending', value: 5, was: 1, since: AGO }] });
  });

  it('command timeouts alone (often a cable) never count as failing, even rising', () => {
    expect(judgeDisk(disk({ timeouts: 9 }), [{ at: AGO, disk: disk({ timeouts: 1 }) }], 80).verdict).toBe('watch');
  });

  it("SMART's own verdict, an NVMe critical warning or a worn-out NVMe: failing; worn past the limit: watch", () => {
    expect(judgeDisk(disk({ passed: false }), [], 80)).toEqual({ verdict: 'failing', reasons: [{ code: 'smart_failed' }] });
    const nvme = disk({ device: '/dev/nvme0', reallocated: null, pending: null, uncorrectable: null, timeouts: null, offlineUncorrectable: null, percentUsed: 12, mediaErrors: 0, criticalWarning: 0 });
    expect(judgeDisk(nvme, [], 80).verdict).toBe('good');
    expect(judgeDisk({ ...nvme, criticalWarning: 4 }, [], 80).reasons).toEqual([{ code: 'critical_warning', value: 4 }]);
    expect(judgeDisk({ ...nvme, percentUsed: 85 }, [], 80)).toEqual({ verdict: 'watch', reasons: [{ code: 'worn', value: 85 }] });
    expect(judgeDisk({ ...nvme, percentUsed: 100 }, [], 80).verdict).toBe('failing');
  });

  it('each count against the oldest check that has it: an early check without it does not hide growth (AUDIT2 SMART-02)', () => {
    const history = [
      { at: '2026-08-01T00:00:00.000Z', disk: disk({ pending: null }) },
      { at: AGO, disk: disk({ pending: 3 }) },
    ];
    expect(judgeDisk(disk({ pending: 8 }), history, 80)).toEqual({ verdict: 'failing', reasons: [{ code: 'attr', attr: 'pending', value: 8, was: 3, since: AGO }] });
  });

  it('a disk that says nothing at all: unknown, not good', () => {
    expect(judgeDisk(disk({ passed: null, reallocated: null, pending: null, uncorrectable: null, timeouts: null, offlineUncorrectable: null }), [], 80).verdict).toBe('unknown');
  });

  it('the same disk found again by its serial number, even under another device name', () => {
    const older = [disk({ device: '/dev/sdb', serial: 'S1', reallocated: 1 }), disk({ device: '/dev/sda', serial: 'S2' })];
    expect(sameDisk(disk(), older)?.reallocated).toBe(1);
    expect(sameDisk(disk({ serial: null }), [disk({ serial: null, reallocated: 3 })])?.reallocated).toBe(3);
    expect(sameDisk(disk({ serial: 'S9' }), older)).toBeNull();
  });
});

describe('the SMART alert titles in Dutch (AUDIT2 SMART-07)', () => {
  it('the new ones too, not left in English', () => {
    expect(alertTitle('3 uncorrectable errors (was 1)', 'nl')).toBe('3 onherstelbare fouten (was 1)');
    expect(alertTitle('1 unreadable sector (was 0)', 'nl')).toBe('1 onleesbare sector (was 0)');
    expect(alertTitle('the disk reports a critical warning', 'nl')).toBe('de schijf meldt een kritieke waarschuwing');
    expect(alertTitle('getting worse: 8 pending sectors (was 3)', 'nl')).toBe('slechter: 8 wachtende sectoren (was 3)');
    expect(alertTitle('worn out: 100% used', 'nl')).toBe('versleten: 100% gebruikt, aan vervanging toe');
  });
});
