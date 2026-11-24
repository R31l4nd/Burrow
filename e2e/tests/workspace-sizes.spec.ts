import { expect, test } from './fixtures.js';
import { lookAt, loneControlsFill, widthUsed } from './checks.js';
import { SETTINGS_PARTS } from './pages.js';
import { signIn } from './passkey.js';
import { mainViews } from './views.js';

// Every kind of screen at every kind of size, not only a phone and a
// desktop: small and tall phones, a phone turned, a foldable with and without
// its keyboard, tablets both ways, wide and ultrawide screens. Each view
// goes through the same layout checks as the tour (lookAt; axe once per
// page, at the first size) and is kept as test-results/tour/size-*.png.

test.use({ cover: false });

const SIZES: [string, number, number][] = [
  // As narrow as the outer screen of a OnePlus Open (343 px), as low as a small phone.
  ['phone-small', 343, 640],
  ['phone', 412, 915],
  ['phone-tall', 360, 900],
  ['phone-turned', 820, 412],
  ['foldable', 698, 698],
  ['foldable-keyboard', 698, 355],
  ['tablet', 800, 1280],
  ['tablet-turned', 1280, 800],
  ['desktop', 1280, 720],
  ['wide', 1920, 1080],
  ['ultrawide', 2560, 1080],
];

// The pages that list things: on a wide screen they use its width (widthUsed).
// The key vault, snippets and forms keep a width that reads well.
const LISTS = ['hosts', 'containers', 'alerts', 'reports', 'apps'];

test('every page at every size', async ({ page }) => {
  test.setTimeout(30 * 60_000);
  await signIn(page);
  const { views, done } = await mainViews(page);
  for (const [i, [size, w, h]] of SIZES.entries()) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, url] of views) {
      await page.goto(url);
      // Settled: no "Loading..." left.
      await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 10_000 });
      await page.waitForTimeout(500);
      if (LISTS.includes(name)) await widthUsed(page, `size-${size}-${name}`);
      await lookAt(page, `size-${size}-${name}`, { axe: i === 0 });
    }
  }
  await done();
});

test("on a computer every part of Settings as on a phone: a button or field alone on its line takes the line, ones side by side share it (reports c7665e, c75bda, 46158b, c07d68, bc933c, a08646, 23a0b1, 7107f7, f6bfd6)", async ({ page }) => {
  // Reported on a 1912 px screen: Save, Audit log and the recordings' select words-wide beside
  // full-width fields and lists, New snippet and its neighbour, Open and Solved at the left.
  // Nineteen parts looked at, beside the tour's passes: more than the default 30 s.
  test.setTimeout(240_000);
  await signIn(page);
  await page.setViewportSize({ width: 1912, height: 914 });
  for (const part of SETTINGS_PARTS) {
    await page.goto(`/#/settings/${part}`);
    await expect(page.locator(`h2#${part}`)).toBeVisible();
    await expect(page.getByText('Loading...').filter({ visible: true })).toHaveCount(0, { timeout: 10_000 });
    // All the layout checks (lone controls and rows filling among them), and a picture to look at.
    await lookAt(page, `computer-settings-${part}`, { axe: false, passes: [] });
  }
});

test("a phone's layout folded open (698 px): a button or field alone on its line takes the line, the colours in the middle (reports 9d013e, ac7e33, 17c4ec, 6bd934, 9a3a92)", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 698, height: 698 });
  for (const part of ['ai', 'sso', 'hosts', 'recordings', 'appearance']) {
    await page.goto(`/#/settings/${part}`);
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.settings .btn, .settings label.field').first()).toBeVisible();
    await loneControlsFill(page, `foldable-settings-${part}`);
  }
  // The colours: as much room left of them as right, in their card.
  const [left, right] = await page.locator('.swatches').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const kids = [...el.children].map((c) => c.getBoundingClientRect());
    return [kids[0]!.left - box.left, box.right - kids.at(-1)!.right];
  });
  expect(Math.abs(left - right)).toBeLessThan(2);
});
