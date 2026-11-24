import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The gate's public step (scripts/check-public.sh) on a tree of its own.
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'check-public.sh');

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function check(files: Record<string, string>): { code: number | null; out: string } {
  dir = mkdtempSync(join(tmpdir(), 'burrow-public-'));
  const tree = join(dir, 'tree');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(tree, name, '..'), { recursive: true });
    writeFileSync(join(tree, name), text);
  }
  writeFileSync(join(dir, 'patterns'), 'nothing-private-here-xyz\n');
  const r = spawnSync('bash', [SCRIPT, tree], { env: { ...process.env, BURROW_PRIVATE_PATTERNS: join(dir, 'patterns') }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

// Built here, so this file has none of them as they are.
const tokens = ['ghp_' + 'a1B2'.repeat(9), 'github_pat_' + 'A1b2_'.repeat(13), 'sk-ant-api03-' + 'x9Y8'.repeat(8), 'AKIA' + 'ABCD2345EFGH6789', 'xoxb-' + '1234567890-abcdefghij', 'glpat-' + 'Ab1-'.repeat(5), '123456789:AA' + 'b'.repeat(33), 'https://discord.com/api/webhooks/123456/' + 'z'.repeat(40), 'https://hooks.slack.com/services/T0123/B0456/' + 'q'.repeat(24)];

describe('the public check', () => {
  it('finds an API token or webhook of a well-known kind in what would be published (audit 2026-11-23)', () => {
    for (const token of tokens) {
      const r = check({ 'deploy/dev.env.example': `TOKEN=${token}\n` });
      expect(r.code, token).toBe(1);
      expect(r.out, token).toContain('API tokens in');
    }
  });

  it('an environment file anywhere, not only at the top (audit 2026-11-23); an example is fine', () => {
    for (const name of ['.env.production', 'server/.env', 'deploy/.env.local']) expect(check({ [name]: 'X=1\n' }).out, name).toContain(`must not be public: ${name}`);
    expect(check({ '.env.example': 'X=\n', 'deploy/dev.env': 'X=1\n' }).code).toBe(0);
  });

  it("a test's made-up token is no secret: tests are where they belong", () => {
    expect(check({ 'shared/src/analysis.test.ts': `const t = '${tokens[0]}';\n`, 'e2e/tests/x.spec.ts': `'${tokens[4]}'\n`, 'server/test/fake.ts': `'${tokens[2]}'\n` }).code).toBe(0);
  });
});
