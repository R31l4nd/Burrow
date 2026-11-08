import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures.js';
import { SEEN, SOME_PASSES, WIDE_ONLY_SCREENS } from './checks.js';
import { DIALOGS_ELSEWHERE, PAGES } from './pages.js';

// After every test that looks (the tour's four passes, the sizes, the
// specs before them; playwright.config.ts, project "press-each"): nothing
// left out.

test('every page and every dialog in the source was looked at', async () => {
  test.skip(!!process.env.TOUR_ONLY, 'a few tour screens only');
  const seen = new Set(readFileSync(SEEN, 'utf8').split('\n').filter(Boolean));
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
  const dialogs = new Set<string>();
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(dir, f.name));
      else if (f.name.endsWith('.svelte')) for (const m of readFileSync(join(dir, f.name), 'utf8').matchAll(/<Dialog tour="([\w-]+)"/g)) dialogs.add(m[1]!);
    }
  };
  walk(src);
  expect(dialogs.size, 'dialogs found in the source').toBeGreaterThan(30);
  const missingDialogs = [...dialogs].filter((d) => !seen.has(`dialog:${d}`) && !(d in DIALOGS_ELSEWHERE)).sort();
  const missingPages = PAGES.filter((p) => !seen.has(`page:${p}`));
  expect(missingDialogs, 'dialogs no test looked at (add a screen to workspace-tour.spec.ts)').toEqual([]);
  expect(missingPages, 'pages no test looked at (add a screen to workspace-tour.spec.ts)').toEqual([]);
});

test('every screen seen in light English on a computer is seen in the five other passes too (UIA-23, UIB-02)', async () => {
  test.skip(!!process.env.TOUR_ONLY, 'a few tour screens only');
  const dir = dirname(SEEN);
  const files = new Set(readdirSync(dir).filter((f) => f.endsWith('.png')));
  const missing = [...files]
    .filter((f) => /^desktop-(?!dark-nl-)/.test(f) && !WIDE_ONLY_SCREENS.includes(f.slice(8, -4)) && !(f.slice(8, -4) in SOME_PASSES))
    .flatMap((f) => ['phone', 'phone-nl', 'phone-dark', 'tablet-nl', 'desktop-dark-nl'].map((p) => f.replace(/^desktop-/, `${p}-`)).filter((g) => !files.has(g)));
  expect(existsSync(dir)).toBe(true);
  expect(missing, 'screens without all their passes (lookAt takes them; see otherPasses in checks.ts)').toEqual([]);
});
