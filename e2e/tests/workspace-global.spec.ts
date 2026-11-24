import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { sayYes } from './confirm.js';
import { addAuthenticator, signIn } from './passkey.js';

const hostId = async (page: Page, name: string) =>
  (await page.evaluate(async () => (await fetch('/api/hosts')).json() as Promise<{ id: number; name: string }[]>)).find((h) => h.name === name)!.id;

// What acts on the whole instance, not only on what a spec made: the admin's other sign-ins ended,
// the terminal limit and the status interval set for everyone. Run after both lanes of specs
// (project "global", e2e/playwright.config.ts): beside them, the other lane's sign-in was ended
// mid-test and its terminals refused as too many (gate 2026-11-24).

test('the account: a second passkey, a password, new recovery codes, other sessions out', async ({ page, browser }) => {
  // A prompt (the new passkey's name) gets a name; the rest a yes.
  await sayYes(page, 'Second test key');
  const auth = await signIn(page);
  await page.goto('/#/settings/security');
  // A second passkey, on another authenticator (the one signed in with holds
  // this account's key already, and WebAuthn makes no second one there),
  // then removed again.
  await auth.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth.id });
  await addAuthenticator(page);
  await page.getByRole('button', { name: 'Add passkey' }).click();
  const fresh = page.locator('.list-item', { hasText: 'Second test key' });
  await expect(fresh).toHaveCount(1);
  await fresh.getByRole('button', { name: 'Delete' }).click();
  await expect(fresh).toHaveCount(0);

  await page.getByRole('button', { name: 'Set password' }).click();
  await page.getByLabel('New password (min. 12 characters)').fill('a-long-test-password');
  await page.locator('dialog[open]').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Remove password' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove password' }).click();
  await expect(page.getByRole('button', { name: 'Set password' })).toBeVisible();

  await page.getByRole('button', { name: 'Create new codes' }).click();
  await expect(page.locator('.codes span')).toHaveCount(10);
  // Asked first: the old codes stop working (AUDIT2 PAGE-32); and until they are saved, leaving asks too.
  const asked = () => page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? []);
  expect(await asked()).toContain('New codes replace your current ones: the old codes stop working at once. Go on?');
  await page.evaluate(() => (location.hash = '#/settings'));
  await expect.poll(asked).toContain('You have changes that are not saved. Leave anyway?');
  // Settings is one page: back in Security, the new codes are still there to save.
  await page.goto('/#/settings/security');
  await expect(page.locator('.codes span')).toHaveCount(10);
  await page.getByTestId('recovery-kept').check();

  // Another browser signed in, then signed out from here.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await signIn(p2);
  await page.reload();
  // Many browsers signed in by now: the newest five, the rest on request.
  const rows = page.locator('.list-item', { has: page.getByRole('button', { name: 'Sign out', exact: true }) });
  await expect(rows).toHaveCount(5);
  await page.getByTestId('sessions-all').click();
  expect(await rows.count()).toBeGreaterThan(5);
  await page.getByTestId('revoke-others').click();
  await p2.reload();
  await expect(p2.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
  await other.close();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test("Settings -> System: what was only in the .env file, set here; the .env's value said under each field, a value set applies at once, cleared the .env's again", async ({ page }) => {
  await signIn(page);
  const call = (method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, body: (r.status === 204 ? null : await r.json()) as { id?: string; error?: string; env?: Record<string, string | number>; saved?: Record<string, unknown> } };
    }, [method, url, body] as const);
  const env = (await call('GET', '/api/settings/system')).body.env!;
  await page.goto('/#/settings/system');
  const form = page.getByTestId('system');
  // What a value here does, not where they once were (report 4b06b3: "These were only in the .env file" read wrong).
  await expect(page.getByText('These were only in the .env file')).toHaveCount(0);
  await expect(page.getByText("A value here goes before the .env file's, at once.")).toBeVisible();
  // Each field empty, the .env's value under it.
  await expect(page.getByTestId('system-max-sessions')).toHaveValue('');
  await expect(form.locator('label', { has: page.getByTestId('system-max-sessions') })).toContainText(`Empty: ${env.terminalMaxSessions}, from the .env file`);
  // A pattern that is not one: said, nothing saved.
  await page.getByTestId('system-update-exclude').fill('^(');
  await page.getByTestId('system-save').click();
  await expect(page.getByTestId('toasts')).toContainText('regular expression');
  // The terminal limit at what is open now: the next session is refused, without a restart.
  const host = await hostId(page, 'test-sshd');
  const opened = (await call('POST', '/api/terminal/sessions', { hostId: host, tmux: 'never' })).body.id!;
  const open = ((await call('GET', '/api/terminal/sessions')).body as unknown as unknown[]).length;
  await page.getByTestId('system-max-sessions').fill(String(open));
  await page.getByTestId('system-idle-minutes').fill('120');
  await page.getByTestId('system-status-interval').fill('120');
  await page.getByTestId('system-update-exclude').fill('^registry\\.lan/');
  await page.getByTestId('system-registries').fill('registry.lan:5000=http://10.0.0.5:5000');
  await page.getByTestId('system-apps-domain').fill('home.example');
  // The dead-man switch's address (2026-11-07): kept like the others (its calls: server/test/unit/heartbeat.test.ts).
  await page.getByTestId('system-heartbeat').fill('https://hc-ping.example.invalid/burrow-e2e');
  await expect(page.getByTestId('system-unsaved')).toBeVisible();
  await page.getByTestId('system-save').click();
  await expect(page.getByTestId('toasts')).toContainText('System settings saved.');
  await expect(page.getByTestId('system-unsaved')).toHaveCount(0);
  expect((await call('POST', '/api/terminal/sessions', { hostId: host, tmux: 'never' })).body.error).toBe('too_many_sessions');
  // Kept: read again, the values are there.
  await page.reload();
  await expect(page.getByTestId('system-registries')).toHaveValue('registry.lan:5000=http://10.0.0.5:5000');
  await expect(page.getByTestId('system-update-exclude')).toHaveValue('^registry\\.lan/');
  await expect(page.getByTestId('system-heartbeat')).toHaveValue('https://hc-ping.example.invalid/burrow-e2e');
  await lookAt(page, 'desktop-settings-system');
  // Emptied: the .env's values again, a session opens.
  for (const id of ['system-max-sessions', 'system-idle-minutes', 'system-status-interval', 'system-update-exclude', 'system-registries', 'system-apps-domain', 'system-heartbeat']) await page.getByTestId(id).fill('');
  await page.getByTestId('system-save').click();
  await expect(page.getByTestId('toasts')).toContainText('System settings saved.');
  expect(Object.values((await call('GET', '/api/settings/system')).body.saved!).every((v) => v === null)).toBe(true);
  const again = (await call('POST', '/api/terminal/sessions', { hostId: host, tmux: 'never' })).body.id;
  expect(again).toBeTruthy();
  for (const id of [opened, again]) await call('DELETE', `/api/terminal/sessions/${id}`);
});
