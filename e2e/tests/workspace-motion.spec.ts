import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './passkey.js';

// The UI's motion (1.23.0, asked for: "nice animations, a professional
// feel"): a dialog fades and rises in, the line under the section tabs
// slides to the tab chosen, a waiting list shimmers. With the system's
// "less motion" all of it is off: the other specs run that way for still
// pictures.

/** How many animations and transitions the open dialog has two frames after it opened. */
async function dialogMotion(page: Page): Promise<number> {
  // Settings loads on its own (2.3.0): its list first, then "?" (the keyboard shortcuts' dialog).
  await page.getByTestId('settings-section').first().waitFor();
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const d = document.querySelector('dialog[open]');
            resolve(d ? d.getAnimations().length : -1);
          }),
        );
      }),
  );
}

test('motion: a dialog comes in, the tab line slides; none of it with less motion asked for', async ({ browser, page }) => {
  // With motion (the default of most systems).
  const ctx = await browser.newContext({ reducedMotion: 'no-preference', baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8190' });
  const moving = await ctx.newPage();
  await signIn(moving);
  await moving.goto('/#/settings');
  expect(await dialogMotion(moving)).toBeGreaterThan(0);
  await moving.keyboard.press('Escape');
  await expect(moving.locator('dialog[open]')).toHaveCount(0);
  // The tab line: a transition on its place, and it ends under the tab chosen.
  await moving.goto('/#/containers');
  const line = moving.locator('.tabs .line');
  await expect(line).toBeVisible();
  expect(await line.evaluate((l) => getComputedStyle(l).transitionDuration)).toContain('0.32s');
  await moving.getByRole('tab', { name: 'Reports' }).click();
  await expect(moving).toHaveURL(/#\/reports/);
  const tab = moving.getByRole('tab', { name: 'Reports' });
  await expect.poll(async () => Math.round((await line.boundingBox())!.x - (await tab.boundingBox())!.x)).toBe(0);
  await ctx.close();

  // Less motion: nothing moves.
  await signIn(page);
  await page.goto('/#/settings');
  expect(await dialogMotion(page)).toBe(0);
});
