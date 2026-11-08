import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/REGRESSIONS.md lists every reported problem with the test that
// catches it again. Each test named there must exist: renaming or dropping
// one would quietly lose what a person once had to report.

const ROOT = join(__dirname, '..', '..');

describe('the regressions list', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'REGRESSIONS.md'), 'utf8');
  const rows = doc.split('\n').filter((l) => /^\| \d{4}-\d{2}-\d{2}/.test(l));

  it('has a test for every reported problem', () => {
    expect(rows.length).toBeGreaterThan(0);
    const without = rows.filter((r) => !/`[^`]+ :: [^`]+`/.test(r));
    expect(without, without.join('\n')).toEqual([]);
  });

  it('names tests that exist', () => {
    const missing = rows.flatMap((r) => {
      const [, path, title] = /`([^`]+) :: ([^`]+)`/.exec(r)!;
      const file = join(ROOT, path!);
      if (!existsSync(file)) return [`${path}: no such file`];
      return readFileSync(file, 'utf8').includes(title!) ? [] : [`${path}: no test "${title}"`];
    });
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
