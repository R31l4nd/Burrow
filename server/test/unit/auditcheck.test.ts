import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The gate's dependency audit (scripts/audit-check.mjs) with a stand-in npm.
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'audit-check.mjs');

function run(npmOutput: string): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-npm-'));
  try {
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\ncat <<'EOF'\n${npmOutput}\nEOF\nexit 1\n`);
    chmodSync(join(dir, 'npm'), 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
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
});
