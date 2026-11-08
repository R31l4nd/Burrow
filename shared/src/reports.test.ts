import { describe, expect, it } from 'vitest';
import { fixOf, reasonText, type ReportReason } from './reports.js';

// Why a container is in a report, in the reader's language.

describe('reasonText', () => {
  it('says every reason in English and Dutch, a count of one in the singular', () => {
    const cases: [ReportReason, string, string][] = [
      [{ code: 'crashes', n: 2 }, 'crashed 2x', '2x gecrasht'],
      [{ code: 'oom', n: 1 }, 'out of memory 1x', '1x geheugen op'],
      [{ code: 'unhealthy' }, 'unhealthy now', 'nu unhealthy'],
      [{ code: 'unhealthy_events', n: 3 }, 'unhealthy 3x', '3x unhealthy geweest'],
      [{ code: 'exited', n: 137 }, 'exited with code 137', 'gestopt met code 137'],
      [{ code: 'errors', n: 1 }, '1 error', '1 fout'],
      [{ code: 'errors', n: 4 }, '4 errors', '4 fouten'],
      [{ code: 'warnings', n: 1 }, '1 warning', '1 waarschuwing'],
      [{ code: 'warnings', n: 2 }, '2 warnings', '2 waarschuwingen'],
      [{ code: 'restarts', n: 5 }, 'restarted 5x', '5x herstart'],
      [{ code: 'logs_unread', what: '/var/log/app.log' }, 'logs could not be read (/var/log/app.log)', 'logs niet te lezen (/var/log/app.log)'],
    ];
    for (const [r, en, nl] of cases) {
      expect(reasonText(r, 'en')).toBe(en);
      expect(reasonText(r, 'nl')).toBe(nl);
    }
  });

  it('a fix from an older report (plain text) reads as a step without a command', () => {
    expect(fixOf('Restart it')).toEqual({ step: 'Restart it', command: null, risk: 'low', riskReasons: [] });
    const fix = { step: 'Free space', command: 'docker image prune', risk: 'medium' as const, riskReasons: ['removes images'] };
    expect(fixOf(fix)).toBe(fix);
  });
});
