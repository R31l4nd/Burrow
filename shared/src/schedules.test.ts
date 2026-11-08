import { describe, expect, it } from 'vitest';
import { commandScheduleInput, scheduledScript } from './schedules.js';

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

describe('scheduled commands', () => {
  it('the host runs it in bash (else sh), sudo only without a password, ended at its time limit', () => {
    const script = scheduledScript("echo 'hi'", 10, quote);
    expect(script).toContain('s=$(command -v bash || command -v sh)');
    expect(script).toContain('exec timeout -k 10 600 "$s" -c ');
    expect(script).toContain('sudo() { command sudo -n "$@"; }');
    expect(script).toContain("echo '\\''hi'\\''");
    // Without timeout(1): run as it is, Burrow ends it from its side.
    expect(script).toContain('else exec "$s" -c ');
  });

  it('a cron schedule needs its expression; at least one host; a time limit within a day', () => {
    const base = { name: 'x', command: 'true', hostIds: [1], enabled: true, kind: 'daily', timeZone: 'UTC' };
    expect(commandScheduleInput.parse(base)).toMatchObject({ time: '03:00', timeoutMinutes: 10, cron: null });
    expect(commandScheduleInput.safeParse({ ...base, kind: 'cron' }).success).toBe(false);
    expect(commandScheduleInput.safeParse({ ...base, hostIds: [] }).success).toBe(false);
    expect(commandScheduleInput.safeParse({ ...base, timeoutMinutes: 24 * 60 + 1 }).success).toBe(false);
  });
});
