import { expect, test } from './fixtures.js';
import { sweepLook } from './checks.js';
import { signIn } from './passkey.js';
import { mainViews } from './views.js';

// Every width from a small phone to a wide screen, 40 px apart, on the main pages: the tour and
// the sizes look at fixed sizes, and the layout reports came from the ones between (a phone turned
// at 698 px, report 95ce1f; just over 1700 px, report 5a729b). Each page loaded once and its
// window widened step by step, as a phone turned or a window dragged; at each width only what
// runs past an edge is checked (sweepLook). A width with a finding is kept as a picture
// (test-results/tour/sweep-<page>-<width>.png).

test.use({ cover: false });

const WIDTHS = Array.from({ length: 42 }, (_, i) => 320 + i * 40);

test('every width, 40 px apart, on the main pages: nothing past an edge', async ({ page }) => {
  test.setTimeout(30 * 60_000);
  await signIn(page);
  const { views, done } = await mainViews(page);
  for (const [name, url] of views) {
    await page.setViewportSize({ width: WIDTHS[0]!, height: 760 });
    await page.goto(url);
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId('skeleton').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 760 : 820 });
      // Laid out at the new width: two frames.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const before = test.info().errors.length;
      await sweepLook(page, `sweep-${name}-${w}`);
      if (test.info().errors.length > before) await page.screenshot({ path: `test-results/tour/sweep-${name}-${w}.png` });
    }
  }
  await done();
});
