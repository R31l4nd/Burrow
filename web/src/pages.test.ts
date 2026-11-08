import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The tour's list of pages (e2e/tests/pages.ts) knows every page App.svelte
// can show: a new page without a place in the tour fails here.

describe('pages in the tour', () => {
  it("every section of App.svelte is in the tour's list", () => {
    const app = readFileSync(join(__dirname, 'App.svelte'), 'utf8');
    const list = readFileSync(join(__dirname, '..', '..', 'e2e', 'tests', 'pages.ts'), 'utf8');
    const sections = [...new Set([...app.matchAll(/section === '([a-z]+)'/g)].map((m) => m[1]!))];
    expect(sections.length).toBeGreaterThan(10);
    const missing = sections.filter((s) => !new RegExp(`'${s}(/[^']*)?'`).test(list));
    expect(missing).toEqual([]);
  });
});
