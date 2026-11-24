import { expect, test } from './fixtures.js';
import { hostNamed, signIn } from './passkey.js';

// Settings -> Usage (the user, 2026-11-23: gather usage data before deciding what Burrow keeps):
// the pages and dialogs opened, counted by name only, sent by the browser, shown to an admin.

test('usage: pages and dialogs opened are counted by name, never a host; off counts nothing; cleared is gone', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  // What the browser sends: names only.
  const sent: string[] = [];
  page.on('request', (r) => void (r.url().endsWith('/api/usage') && r.method() === 'POST' && sent.push(r.postData() ?? '')));
  const usage = page.getByTestId('usage');
  const count = async (name: string) => {
    const row = usage.getByTestId('usage-row').filter({ has: page.locator('.mono', { hasText: new RegExp(`^${name.replace(/[/:]/g, (c) => `\\${c}`)}$`) }) });
    return (await row.count()) ? Number(await row.locator('.n').textContent()) : 0;
  };
  const open = async () => {
    await page.goto('/#/settings/usage');
    await expect(usage.getByTestId('usage-since')).toBeVisible();
  };

  // Start clean: whatever earlier specs opened, cleared (a fresh confirmation, asked first).
  await open();
  if (await usage.getByTestId('usage-clear').isEnabled()) {
    await usage.getByTestId('usage-clear').click();
    const confirm = page.locator('dialog[open][data-tour=confirm]');
    await expect(confirm.getByTestId('confirm-text')).toHaveText('Clear everything counted so far? It cannot be undone.');
    await confirm.getByRole('button', { name: 'Clear what was counted' }).click();
  }
  await expect(usage.getByTestId('usage-since')).toHaveText('Nothing counted yet.');

  // A host's statistics, the alerts twice, a dialog: counted when the usage page is opened (it sends first).
  await page.goto(`/#/hosts/${sshd}/stats`);
  await expect(page.getByTestId('tile-cpu')).toBeVisible({ timeout: 20_000 });
  await page.goto('/#/alerts');
  await page.getByTestId('new-rule').click();
  await expect(page.locator('dialog[open][data-tour=alert-rule]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/#/hosts');
  await page.goto('/#/alerts');
  // The same page with a query of its own (a folder in Files, a filter): not opened again.
  await page.goto('/#/alerts?x=1');
  await open();
  await expect.poll(() => count('alerts')).toBe(2);
  expect(await count('hosts/:id/stats')).toBe(1);
  expect(await count('alert-rule')).toBe(1);
  await expect(usage.getByTestId('usage-row').filter({ hasText: 'alert-rule' })).toContainText('dialog');
  await expect(usage.getByTestId('usage-since')).toContainText('Counted since');
  // Pages and dialogs not opened are named too: what is dead weight shows.
  await expect(usage.getByTestId('usage-unused')).toContainText('hosts/:id/journal');
  await expect(usage.getByTestId('usage-unused')).toContainText('processes');
  // Never the host's number, nor any name of it.
  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) {
    for (const key of Object.keys(JSON.parse(body) as Record<string, number>)) expect(key, body).toMatch(/^(page|dialog):[a-z0-9:/-]+$/);
    expect(body).not.toContain(`/${sshd}/`);
  }

  // The period asked for.
  const asked = page.waitForRequest((r) => r.url().includes('/api/usage?days=7'));
  await usage.getByTestId('usage-days').selectOption('7');
  await asked;
  await expect.poll(() => count('alerts')).toBe(2);

  // Turning it off that does not save: said, and still on.
  await page.route('**/api/usage/settings', (r) => r.fulfill({ status: 500, json: { error: 'internal', message: 'Disk full.' } }));
  await usage.getByTestId('usage-on').uncheck();
  await expect(usage.getByTestId('usage-save-failed')).toHaveText('Not changed: Disk full.');
  await expect(usage.getByTestId('usage-on')).toBeChecked();
  await page.unroute('**/api/usage/settings');

  // Off: opening pages counts nothing, until on again.
  await usage.getByTestId('usage-on').uncheck();
  await expect(usage.getByTestId('usage-on')).not.toBeChecked();
  await page.goto('/#/alerts');
  await open();
  await expect(usage.getByTestId('usage-on')).not.toBeChecked();
  expect(await count('alerts')).toBe(2);
  await usage.getByTestId('usage-on').check();
  await expect(usage.getByTestId('usage-on')).toBeChecked();
  await page.goto('/#/alerts');
  await open();
  await expect.poll(() => count('alerts')).toBe(3);
});
