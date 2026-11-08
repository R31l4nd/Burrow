import { describe, expect, it } from 'vitest';
import { alertRuleInput, isAlertSubject } from './analysis.js';
import { logSelection } from './logselect.js';
import { scheduleInput } from './reports.js';
import { fileLineTime, journalSource, journalUnit, parseTarget, parseUnits, splitFileLine, targetKey, targetLabel, validLogSource } from './logfiles.js';

describe('log files as targets', () => {
  it('written and read back, a comma or colon in the path kept whole', () => {
    for (const t of [
      { hostId: 3, container: 'web' },
      { hostId: 3, container: 'web', file: '/data/logs/app.log' },
      { hostId: 12, container: '', file: '/var/log/nginx/access,2026:10.log' },
    ]) {
      const key = targetKey(t);
      expect(key.split(',')).toHaveLength(1);
      expect(parseTarget(key)).toEqual(t);
    }
  });

  it('refuses what is not a target: no host, a bad name, a relative path, a way up, nothing at all', () => {
    for (const bad of ['web', 'x:web', '3:', '3:bad name', '3::relative/app.log', `3::${encodeURIComponent('/var/log/../../etc/shadow')}`, '3::%E0%A4%A', `3::${encodeURIComponent('/a\nb')}`]) {
      expect(parseTarget(bad), bad).toBeNull();
    }
  });

  it('labelled by the file name, with its container', () => {
    expect(targetLabel({ hostId: 1, container: 'web', file: '/data/logs/app.log' })).toBe('app.log (web)');
    expect(targetLabel({ hostId: 1, container: '', file: '/var/log/syslog' })).toBe('syslog');
    expect(targetLabel({ hostId: 1, container: 'web' })).toBe('web');
  });
});

describe("a unit's journal as a target", () => {
  it('written and read back, labelled by its unit', () => {
    // systemd's escapes stay as they are (AUDIT2 J-05).
    for (const unit of ['nginx.service', 'wg-quick@wg0.service', 'docker.socket', 'systemd-fsck@dev-disk-by\\x2duuid-1a2b.service']) {
      const t = { hostId: 4, container: '', file: journalSource(unit) };
      expect(parseTarget(targetKey(t))).toEqual(t);
      expect(journalUnit(t.file)).toBe(unit);
      expect(targetLabel(t)).toBe(`${unit} (journal)`);
    }
  });

  it("only the host's, and only a unit's name: no container's, no spaces or quotes, no file named like one", () => {
    expect(parseTarget(`4:web:${encodeURIComponent('journal:nginx.service')}`)).toBeNull();
    for (const bad of ['journal:', 'journal:a b', "journal:x';reboot", 'journal:../x', `journal:${'a'.repeat(256)}`]) {
      expect(validLogSource('', bad), bad).toBe(false);
      expect(journalUnit(bad), bad).toBeNull();
    }
    expect(journalUnit('/var/log/journal:nginx.service')).toBeNull();
    expect(validLogSource('', '/var/log/syslog')).toBe(true);
  });

  it('the units systemctl lists, a failed one with its mark, anything else left out', () => {
    const out = ['cron.service loaded active running Regular background program processing daemon', '\u25cf wg-quick@wg0.service loaded failed failed WireGuard via wg-quick(8) for wg0', 'not a unit line', "bad'name.service loaded active running x", ''].join('\n');
    expect(parseUnits(out)).toEqual([
      { unit: 'cron.service', load: 'loaded', active: 'active', sub: 'running', description: 'Regular background program processing daemon' },
      { unit: 'wg-quick@wg0.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'WireGuard via wg-quick(8) for wg0' },
    ]);
  });
});

describe("a log file's line: when it was written", () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('ISO 8601 with a zone, with a comma for the fraction, and the common log format', () => {
    expect(fileLineTime('2026-10-04T10:15:30.123Z INFO started', now)).toBe('2026-10-04T10:15:30.123Z');
    expect(fileLineTime('[app] 2026-10-04 12:15:30,5+02:00 WARN slow', now)).toBe('2026-10-04T10:15:30.500Z');
    expect(fileLineTime('192.0.2.1 - - [04/Oct/2026:12:15:30 +0200] "GET / HTTP/1.1" 200', now)).toBe('2026-10-04T10:15:30.000Z');
  });

  it('without a zone: local time; syslog without a year: this year, or last year when that would be the future', () => {
    expect(fileLineTime('2026-10-04 10:15:30 started', now)).toBe(new Date(2026, 9, 4, 10, 15, 30).toISOString());
    expect(fileLineTime('Oct  4 10:15:30 host sshd[1]: Accepted', now)).toBe(new Date(2026, 9, 4, 10, 15, 30).toISOString());
    expect(fileLineTime('Dec 31 23:59:59 host cron[2]: done', now)).toBe(new Date(2025, 11, 31, 23, 59, 59).toISOString());
  });

  it('none in the line (the next line of a stack trace), or only late in it', () => {
    expect(fileLineTime('    at Object.<anonymous> (/app/index.js:1:1)', now)).toBeNull();
    expect(fileLineTime(`${'x'.repeat(90)} 2026-10-04T10:15:30Z`, now)).toBeNull();
    expect(fileLineTime('Foo  4 10:15:30 not a month', now)).toBeNull();
  });
});

describe('an alert about a log file', () => {
  it('reads as the file and its container, or the file alone on the host', async () => {
    const { subjectLabel } = await import('./analysis.js');
    expect(subjectLabel(`web:${encodeURIComponent('/app/logs/app.log')}`)).toBe('app.log (web)');
    expect(subjectLabel(`:${encodeURIComponent('/var/log/syslog')}`)).toBe('syslog');
    expect(subjectLabel('web')).toBe('web');
    expect(subjectLabel('@disk /data')).toBe('Disk /data');
  });
});

describe("a log file's line shown", () => {
  it('without the time it starts with (that is in its own column); a time further in stays', () => {
    const now = new Date('2026-10-04T12:00:00Z');
    expect(splitFileLine('2026-10-04T10:15:30.123Z INFO started', now)).toEqual({ ts: '2026-10-04T10:15:30.123Z', text: 'INFO started' });
    expect(splitFileLine('2026-10-04 12:15:30,5+02:00 WARN slow', now)).toEqual({ ts: '2026-10-04T10:15:30.500Z', text: 'WARN slow' });
    expect(splitFileLine('Oct  4 10:15:30 host sshd[1]: Accepted', now).text).toBe('host sshd[1]: Accepted');
    expect(splitFileLine('192.0.2.1 - - [04/Oct/2026:12:15:30 +0200] "GET /"', now)).toEqual({ ts: '2026-10-04T10:15:30.000Z', text: '192.0.2.1 - - [04/Oct/2026:12:15:30 +0200] "GET /"' });
    expect(splitFileLine('    at main (app.js:1)', now)).toEqual({ ts: null, text: '    at main (app.js:1)' });
  });

  it('a time that is no real date or time is none, not another date (AUDIT2 AI-15)', () => {
    const now = new Date('2026-10-04T12:00:00Z');
    for (const bad of ['2026-02-30T10:00:00Z x', '2025-02-29 10:00:00 x', '2026-13-01T10:00:00Z x', '2026-10-04T24:00:00Z x', '2026-10-04T10:60:00Z x', '2026-10-04T10:00:61Z x', '2026-10-04T10:00:00+25:00 x', '2026-10-04T10:00:00+02:75 x', '[31/Feb/2026:10:00:00 +0200] x', '[04/Oct/2026:25:00:00 +0200] x', '[04/Oct/2026:10:00:00 +9900] x', 'Feb 30 10:00:00 host x', 'Oct  4 10:61:00 host x'])
      expect(fileLineTime(bad, now), bad).toBeNull();
    expect(fileLineTime('2024-02-29T10:00:00Z leap year', now)).toBe('2024-02-29T10:00:00.000Z');
    expect(fileLineTime('2026-10-04T10:00:00-14:00 far west', now)).toBe('2026-10-05T00:00:00.000Z');
  });

  it("a time without a zone is the source's time when its zone is known; fractions kept to the nanosecond (AUDIT2 AI-12)", () => {
    const now = new Date('2026-10-04T12:00:00Z');
    expect(fileLineTime('2026-10-04 10:15:30 started', now, '-0500')).toBe('2026-10-04T15:15:30.000Z');
    expect(fileLineTime('Oct  4 10:15:30 host sshd[1]: Accepted', now, '+0200')).toBe('2026-10-04T08:15:30.000Z');
    // A zone in the line wins over the source's.
    expect(fileLineTime('2026-10-04T10:15:30Z x', now, '+0200')).toBe('2026-10-04T10:15:30.000Z');
    // A zone that is none: as before, Burrow's own.
    expect(fileLineTime('2026-10-04 10:15:30 x', now, 'bogus')).toBe(new Date(2026, 9, 4, 10, 15, 30).toISOString());
    expect(fileLineTime('2026-10-04T10:15:30.123456789Z x', now)).toBe('2026-10-04T10:15:30.123456789Z');
    expect(fileLineTime('2026-10-04 12:15:30.1234+02:00 x', now)).toBe('2026-10-04T10:15:30.1234Z');
    expect(splitFileLine('2026-10-04 10:15:30 started', now, '+0000')).toEqual({ ts: '2026-10-04T10:15:30.000Z', text: 'started' });
  });
});


describe('a log source with a long path (AUDIT2 AI-13)', () => {
  // The longest path a source may have, in characters that take the most room once encoded.
  const path = `/${'\u00e9'.repeat(1023)}`;
  const subject = `${'c'.repeat(64)}:${encodeURIComponent(path)}`;

  it('can be kept, muted, picked for a report and given its own report rule', () => {
    expect(validLogSource('web', path)).toBe(true);
    expect(isAlertSubject(subject)).toBe(true);
    expect(isAlertSubject(`:${encodeURIComponent(path)}`)).toBe(true);
    const base = { name: 'Weekly', enabled: true, kind: 'weekly', timeZone: 'Europe/Amsterdam' };
    expect(scheduleInput.safeParse({ ...base, containers: [subject, `:${encodeURIComponent(path)}`] }).success).toBe(true);
    expect(logSelection.safeParse({ rules: [{ target: { hostId: 1, container: subject }, window: { kind: 'since_last' }, levels: ['error'] }] }).success).toBe(true);
    expect(alertRuleInput.safeParse({ name: 'File', kind: 'pattern', hostId: 1, container: subject, project: null, pattern: 'boom' }).success).toBe(true);
    expect(parseTarget(targetKey({ hostId: 1, container: 'web', file: path }))).toEqual({ hostId: 1, container: 'web', file: path });
  });
});
