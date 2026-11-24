import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIALOGS, SETTINGS_PARTS } from '../../shared/src/pages.js';

// The list of pages (shared/src/pages.ts, the tour's and Settings -> Usage's) knows every page App.svelte
// can show: a new page without a place in the tour fails here.

describe('pages in the tour', () => {
  it("every section of App.svelte is in the tour's list", () => {
    const app = readFileSync(join(__dirname, 'App.svelte'), 'utf8');
    const list = readFileSync(join(__dirname, '..', '..', 'shared', 'src', 'pages.ts'), 'utf8');
    const sections = [...new Set([...app.matchAll(/section === '([a-z]+)'/g)].map((m) => m[1]!))];
    expect(sections.length).toBeGreaterThan(10);
    const missing = sections.filter((s) => !new RegExp(`'${s}(/[^']*)?'`).test(list));
    expect(missing).toEqual([]);
  });
});

describe('the names Settings -> Usage counts by (shared/src/pages.ts)', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.svelte') ? [join(dir, e.name)] : []));
  it("every dialog's tour name is in the list, and the list has none the app lost: a new one was not counted", () => {
    const found = new Set(files(__dirname).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/tour="([a-z0-9-]+)"/g)].map((m) => m[1]!)));
    // Chosen while it is open (ChangelogDialog.svelte).
    for (const x of ['changelog', 'changelogs']) found.add(x);
    expect([...found].sort()).toEqual([...DIALOGS].sort());
  });

  it("every part of Settings is in the list (a part not in it was counted as nothing, and the tour skipped it)", () => {
    const settings = readFileSync(join(__dirname, 'pages', 'Settings.svelte'), 'utf8');
    const block = settings.slice(settings.indexOf('const sections'), settings.indexOf('const current'));
    const ids = [...block.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    expect([...new Set(ids)].sort()).toEqual([...SETTINGS_PARTS].sort());
  });
});

describe('the parts of Settings in the list', () => {
  it('each has its line under its name, in English and Dutch (Usage had none: an empty line, its key cast past the types)', () => {
    const en = JSON.parse(readFileSync(join(__dirname, 'lib', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
    const nl = JSON.parse(readFileSync(join(__dirname, 'lib', 'i18n', 'nl.json'), 'utf8')) as Record<string, string>;
    expect(SETTINGS_PARTS.filter((p) => !en[`settings.what.${p}`] || !nl[`settings.what.${p}`])).toEqual([]);
  });
});
