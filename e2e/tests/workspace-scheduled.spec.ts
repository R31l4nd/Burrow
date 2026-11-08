import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { sayYes } from './confirm.js';
import { signIn } from './passkey.js';

// Commands on a schedule (2.11.0): made in Settings, run now, their runs
// and output; a failed run said on the row and as a Host health alert;
// changed and deleted (each with a fresh step-up, the passkey answers).

const dialog = (page: Page, tour: string) => page.locator(`dialog[open][data-tour=${tour}]`);
const row = (page: Page, name: string) => page.getByTestId('sched-row').filter({ hasText: name });

async function openMenu(page: Page, name: string, item: string) {
  await row(page, name).getByTestId('sched-menu').click();
  await dialog(page, 'sched-menu').getByTestId(item).click();
}

test('scheduled commands: made, run now, its output read; a failure said on its row and as an alert; changed and deleted', async ({ page }) => {
  test.setTimeout(120_000);
  await sayYes(page);
  await signIn(page);
  await page.goto('/#/settings/scheduled');
  const part = page.getByTestId('scheduled-part');
  await expect(part).toBeVisible();
  await expect(part.getByText('No scheduled commands yet')).toBeVisible();
  await lookAt(page, 'settings-scheduled-empty');

  await page.getByTestId('sched-new').click();
  const form = dialog(page, 'sched-form');
  await form.getByTestId('sched-name').fill('e2e hello');
  await form.getByTestId('sched-command').fill('echo hello-$((40+2))');
  await form.getByTestId('picklist').locator('label').filter({ has: page.getByText('test-sshd', { exact: true }) }).getByTestId('pick-item').check();
  await form.getByTestId('schedule-kind').selectOption('cron');
  await form.getByTestId('schedule-cron').fill('0 4 * * *');
  await form.getByTestId('sched-timeout').fill('5');
  // On or off only on its row, as channels and report schedules: a new one is on (report 3f6c59).
  await expect(form.getByTestId('sched-enabled')).toHaveCount(0);
  await lookAt(page, 'sched-form');
  await form.getByTestId('sched-save').click();
  await expect(form).toHaveCount(0, { timeout: 20_000 });
  await expect(row(page, 'e2e hello')).toContainText('cron 0 4 * * *');
  await expect(row(page, 'e2e hello')).toContainText('test-sshd');
  await expect(row(page, 'e2e hello')).toContainText('next: ');

  // Run now: as the host's user, its output kept.
  await row(page, 'e2e hello').getByTestId('sched-menu').click();
  await lookAt(page, 'sched-menu');
  await dialog(page, 'sched-menu').getByTestId('sched-run').click();
  await expect(page.getByTestId('toasts')).toContainText('e2e hello ran.', { timeout: 30_000 });
  await expect(row(page, 'e2e hello')).toContainText('ran well');
  await lookAt(page, 'settings-scheduled');
  await openMenu(page, 'e2e hello', 'sched-runs');
  const runs = dialog(page, 'sched-runs');
  await expect(runs.getByTestId('sched-run-row')).toHaveCount(1);
  await expect(runs.getByTestId('sched-run-row')).toContainText('test-sshd');
  await lookAt(page, 'sched-runs');
  await runs.getByTestId('sched-run-row').click();
  const out = runs;
  await expect(out.getByTestId('sched-output')).toHaveText('hello-42');
  await expect(out.getByTestId('sched-output-state')).toHaveText('ran well');
  await lookAt(page, 'sched-output');
  await out.getByTestId('sched-output-back').click();
  await expect(runs.getByTestId('sched-run-row')).toHaveCount(1);
  await runs.getByRole('button', { name: 'Close', exact: true }).click();

  // Changed to one that fails: said on its row, in its run, and as a Host health alert.
  await openMenu(page, 'e2e hello', 'sched-edit');
  await form.getByTestId('sched-command').fill('echo nope; exit 5');
  await form.getByTestId('schedule-kind').selectOption('daily');
  // Alone on its line (no day beside it): as wide as the fields above and below, not half (report 1c454c).
  const width = async (testId: string) => (await form.getByTestId(testId).boundingBox())!.width;
  expect(Math.abs((await width('schedule-time')) - (await width('schedule-kind')))).toBeLessThan(2);
  await form.getByTestId('schedule-time').fill('05:30');
  await form.getByTestId('sched-save').click();
  await expect(form).toHaveCount(0, { timeout: 20_000 });
  await expect(row(page, 'e2e hello')).toContainText('every day at 05:30');
  await openMenu(page, 'e2e hello', 'sched-run');
  await expect(page.getByTestId('toasts')).toContainText('e2e hello ran, but failed on a host', { timeout: 30_000 });
  await expect(row(page, 'e2e hello').getByTestId('sched-failed')).toBeVisible();
  await openMenu(page, 'e2e hello', 'sched-runs');
  await expect(runs.getByTestId('sched-run-row')).toHaveCount(2);
  await runs.getByTestId('sched-run-row').first().click();
  await expect(out.getByTestId('sched-output-state')).toHaveText('failed with exit code 5');
  await expect(out.getByTestId('sched-output')).toHaveText('nope');
  await runs.getByRole('button', { name: 'Close', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(async () => (await (await fetch('/api/alerts')).json()) as { container: string; title: string }[])).filter((a) => a.container === '@scheduled').map((a) => a.title), { timeout: 20_000 })
    .toContain('"e2e hello" failed with exit code 5');

  // Off on its row, then deleted.
  await expect(row(page, 'e2e hello').getByTestId('sched-on')).toBeChecked();
  await row(page, 'e2e hello').getByTestId('sched-on').uncheck();
  await expect(row(page, 'e2e hello')).toContainText('off');
  await expect(row(page, 'e2e hello')).not.toContainText('next: ');
  await openMenu(page, 'e2e hello', 'sched-remove');
  await expect(row(page, 'e2e hello')).toHaveCount(0, { timeout: 20_000 });
  await expect(part.getByText('No scheduled commands yet')).toBeVisible();
});
