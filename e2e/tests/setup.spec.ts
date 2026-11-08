import { expect, test, type Page } from './fixtures.js';
import { rmSync } from 'node:fs';
import { lookAt, SEEN } from './checks.js';
import { sayYes } from './confirm.js';
import { addAuthenticator, saveCredential, SLOTS } from './passkey.js';

/** The first screens a new user sees, looked at like every other page: a phone and a laptop. */
async function look(page: Page, name: string) {
  for (const [vp, size] of [
    ['phone', { width: 360, height: 780 }],
    ['desktop', { width: 1280, height: 800 }],
  ] as const) {
    await page.setViewportSize(size);
    // The desktop look takes the other passes too (Dutch, dark, the tablet; UIA-23).
    await lookAt(page, `${vp}-${name}`, vp === 'phone' ? { passes: [] } : {});
  }
}

const TOKEN = process.env.E2E_SETUP_TOKEN ?? '';

test('claims a fresh instance with a passkey and shows ten recovery codes', async ({ page }) => {
  // The first spec: what the tour has seen starts empty here.
  if (!process.env.E2E_RESUME) rmSync(SEEN, { force: true });
  expect(TOKEN, 'E2E_SETUP_TOKEN must be set (scripts/e2e.sh reads it from the container log)').not.toBe('');
  const auth = await addAuthenticator(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up Burrow' })).toBeVisible();
  await look(page, 'setup-token');

  // A wrong token is refused.
  await page.getByLabel('Setup token').fill('WRONG-TOKEN');
  await page.getByLabel('Username').fill('admin');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid setup token/i);

  await page.getByLabel('Setup token').fill(TOKEN.toLowerCase());
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'How do you want to sign in?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
  await look(page, 'setup-method');

  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.locator('.alert.ok', { hasText: 'Passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();

  const codes = page.getByTestId('recovery-codes').locator('span');
  await expect(codes).toHaveCount(10);
  await look(page, 'setup-codes');
  // Copied as they are shown, one per line.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy' }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).split('\n')).toEqual(await codes.allTextContents());
  await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
  await page.getByLabel('I have saved these codes').check();
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByText('No hosts yet.')).toBeVisible();
  await look(page, 'hosts-empty');
  await saveCredential(auth, 0);

  // A passkey of its own for each browser that runs beside the others
  // (passkey.ts, SLOTS), added the way a person adds one: Settings ->
  // Security, each on an authenticator of its own.
  await sayYes(page, 'Parallel test key');
  let current = auth;
  for (let slot = 1; slot < SLOTS; slot++) {
    await page.goto('/#/settings/security');
    await current.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: current.id });
    current = await addAuthenticator(page);
    await page.getByRole('button', { name: 'Add passkey' }).click();
    await expect(page.locator('.list-item', { hasText: 'Parallel test key' })).toHaveCount(slot);
    await saveCredential(current, slot);
  }
});
