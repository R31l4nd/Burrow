import { describe, expect, it } from 'vitest';
import { judgeFix } from './fixrisk.js';

// A fix's command and its risk, as the run dialog shows them (components/FixRun.svelte).
describe('the risk of a fix to run', () => {
  it("Burrow's rules raised the model's label: their reasons are said beside the model's (audit 2026-11-05)", () => {
    const fix = { command: 'rm -rf /tmp/cache', risk: 'low' as const, riskReasons: [] };
    expect(judgeFix(fix, 'rm -rf /tmp/cache')).toEqual({ risk: 'high', reasons: ['rm with -r or -f deletes without asking'] });
    const told = { command: 'sudo rm -rf /tmp/cache', risk: 'medium' as const, riskReasons: ['clears the cache'] };
    expect(judgeFix(told, 'sudo rm -rf /tmp/cache')).toEqual({ risk: 'high', reasons: ['clears the cache', 'rm with -r or -f deletes without asking', 'runs as root'] });
  });

  it('a reason given twice (a report keeps the rules\' own already) is said once', () => {
    const fix = { command: 'sudo ls', risk: 'medium' as const, riskReasons: ['runs as root'] };
    expect(judgeFix(fix, 'sudo ls').reasons).toEqual(['runs as root']);
  });

  it("an edited command is judged by Burrow's rules alone; the model's label counts for its own command only", () => {
    const fix = { command: 'df -h', risk: 'high' as const, riskReasons: ['the model says so'] };
    expect(judgeFix(fix, 'df -h /')).toEqual({ risk: 'low', reasons: [] });
    expect(judgeFix(null, 'reboot').risk).toBe('high');
  });
});
