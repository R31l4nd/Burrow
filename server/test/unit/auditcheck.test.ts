import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The gate's dependency audit (scripts/audit-check.mjs) with a stand-in npm.
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'audit-check.mjs');

function run(npmOutput: string, today?: string): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-npm-'));
  try {
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\ncat <<'EOF'\n${npmOutput}\nEOF\nexit 1\n`);
    chmodSync(join(dir, 'npm'), 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...(today ? { BURROW_TODAY: today } : {}) }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the dependency audit', () => {
  it('fails when npm audit gives no report (it passed as "nothing found")', () => {
    const r = run('{"error":{"code":"ENOTFOUND","summary":"registry unreachable"}}');
    expect(r.code).toBe(1);
    expect(r.out).toContain('no usable report');
    expect(run('not json').code).toBe(1);
  });

  it('passes a clean report, fails a high advisory that is not allowed', () => {
    expect(run('{"vulnerabilities":{},"metadata":{"vulnerabilities":{"high":0}}}').code).toBe(0);
    const bad = { vulnerabilities: { x: { via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'bad' }] } }, metadata: { vulnerabilities: { high: 1 } } };
    expect(run(JSON.stringify(bad)).code).toBe(1);
  });

  it('says so two weeks before an allowance ends, still passing: it would turn the gate red on the day without a word before', () => {
    const allow = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'audit-allow.json'), 'utf8')) as Record<string, { until: string }>;
    const [id, { until }] = Object.entries(allow)[0]!;
    const report = JSON.stringify({ vulnerabilities: { x: { via: [{ severity: 'high', url: `https://github.com/advisories/${id}`, title: 'allowed' }] } }, metadata: { vulnerabilities: { high: 1 } } });
    const day = (n: number) => new Date(Date.parse(until) - n * 86_400_000).toISOString().slice(0, 10);
    const soon = run(report, day(11));
    expect(soon.code).toBe(0);
    expect(soon.out).toContain(`NOTE: ${id} allowed until ${until}, in 11 days: look again`);
    const early = run(report, day(30));
    expect(early.code).toBe(0);
    expect(early.out).not.toContain('NOTE:');
    expect(run(report, day(-1)).code).toBe(1);
    // Also when npm audit does not name it now (a dependency gone for a while): it may come back after the date.
    const clean = run('{"vulnerabilities":{},"metadata":{"vulnerabilities":{"high":0}}}', day(11));
    expect(clean.code).toBe(0);
    expect(clean.out).toContain(`NOTE: ${id} allowed until ${until}, in 11 days`);
    expect(clean.out.split(`NOTE: ${id} `).length).toBe(2);
    // Once per advisory, also when it is reported.
    expect(soon.out.split(`NOTE: ${id} `).length).toBe(2);
  });
});
