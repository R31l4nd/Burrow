import { expect, test, type Page } from './fixtures.js';
import { signIn } from './passkey.js';

// A page's own Back (the arrow in its bar) goes up to the page it belongs
// to, also when it was opened from somewhere else: a link, a push, another
// section (report 87f290: a container's arrow went back to the page before,
// not to the containers). The browser's and the phone's Back keep history.

const hostId = (page: Page, name: string) => page.evaluate(async (n) => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === n)!.id, name);
const pageBack = (page: Page) => page.locator('.topbar, .appbar').first().getByRole('button', { name: 'Back', exact: true }).click();

test("a detail page opened from elsewhere: its Back leads to its overview, not to where it came from (report 87f290)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostId(page, 'test-sshd');
  for (const [detail, overview] of [
    [`/#/containers/${sshd}/burrowtest-db`, /#\/containers$/],
    [`/#/stacks/${sshd}/burrowtest`, /#\/containers$/],
    [`/#/hosts/${sshd}/stats`, /#\/hosts$/],
    [`/#/hosts/${sshd}/journal`, /#\/hosts$/],
    [`/#/logs?t=${sshd}:burrowtest-db`, /#\/containers$/],
    ['/#/settings/audit', /#\/settings\/security$/],
  ] as const) {
    // From another section (as a push or a link does), and opened straight away (a new tab).
    await page.goto('/#/files');
    await page.goto(detail);
    await expect(page.locator('h1').first()).toBeVisible();
    await pageBack(page);
    await expect(page, detail).toHaveURL(overview);
  }
  // A new tab on the detail page, nothing before it.
  const fresh = await page.context().newPage();
  await fresh.goto(`/#/containers/${sshd}/burrowtest-db`);
  await expect(fresh.locator('h1').first()).toBeVisible();
  await pageBack(fresh);
  await expect(fresh).toHaveURL(/#\/containers$/);
  await fresh.close();
});

test('from the overview and Back: the overview again, the way it came (history, not a new entry)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/files');
  await page.goto('/#/containers');
  await page.getByTestId('container-row').filter({ hasText: 'burrowtest-db' }).first().click();
  await expect(page).toHaveURL(/#\/containers\/\d+\/burrowtest-db/);
  await pageBack(page);
  await expect(page).toHaveURL(/#\/containers$/);
  // Back over the detail page: the browser's Back now leads to what was before the overview.
  await page.goBack();
  await expect(page).toHaveURL(/#\/files$/);
});

test("the phone's Back (the app asks the page first): the dialog opened last closes first, a changed form asks; with none open the page goes back", async ({ page }) => {
  await signIn(page);
  await page.goto('/#/alerts');
  const back = () => page.evaluate(() => (window as unknown as { __burrowBack: () => boolean }).__burrowBack());
  const rule = page.locator('dialog[open][data-tour=alert-rule]');
  const confirm = page.locator('dialog[open][data-tour=confirm]');
  // Nothing open: the app goes back in its history itself.
  expect(await back()).toBe(false);
  // Unchanged: it just closes.
  await page.getByTestId('new-rule').click();
  await expect(rule).toBeVisible();
  expect(await back()).toBe(true);
  await expect(rule).toHaveCount(0);
  // Changed: asked first. The question is on top now, so Back closes the question (kept), not the form.
  await page.getByTestId('new-rule').click();
  await page.getByTestId('rule-name').fill('back-draft');
  expect(await back()).toBe(true);
  await expect(confirm.getByTestId('confirm-text')).toHaveText('You have changes that are not saved. Close anyway?');
  expect(await back()).toBe(true);
  await expect(confirm).toHaveCount(0);
  await expect(rule).toBeVisible();
  await expect(page.getByTestId('rule-name')).toHaveValue('back-draft');
  // Asked again, and this time closed.
  expect(await back()).toBe(true);
  await confirm.getByTestId('confirm-ok').click();
  await expect(rule).toHaveCount(0);
  expect(await back()).toBe(false);
});
