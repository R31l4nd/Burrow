import { expect, test } from './fixtures.js';
import { lookAt } from './checks.js';
import { en, type MessageKey } from '../../web/src/lib/i18n/en.js';
import { hostNamed, signIn } from './passkey.js';

/** The app's English words, filled in as the app fills them. */
const T = (key: MessageKey, params: Record<string, string | number> = {}) =>
  en[key]
    .replace(/\{(\w+):((?:[^|{}]|\{\w+\})*)\|((?:[^{}]|\{\w+\})*)\}/g, (_, k: string, one: string, other: string) => (Number(params[k]) === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));

// A host's package updates (2.11.0): read as the host's package manager has
// them. The test host's image has a local apt repository that offers newer
// builds of bash and tar (a -security suite) and gzip.

const ONE = /\/api\/hosts\/\d+\/packages$/;

test("package updates: Check now lists them, security first; the host list marks the host; a Host health alert; the command to copy, never run", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.goto(`/#/hosts/${sshd}/stats`);
  const box = page.getByTestId('packages');
  await expect(box).toBeVisible({ timeout: 20_000 });
  const asked = page.waitForRequest((r) => r.method() === 'POST' && ONE.test(r.url()));
  await page.getByTestId('packages-check').click();
  await asked;
  await expect(page.getByTestId('packages-check')).toHaveText(T('stats.checkNow'), { timeout: 60_000 });
  await expect(page.getByTestId('packages-state')).toHaveText('3 updates | 2 security');
  const rows = page.getByTestId('packages-list').locator('li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('bash');
  await expect(rows.nth(0)).toContainText(T('packages.securityOne'));
  await expect(rows.nth(1)).toContainText('tar');
  await expect(rows.nth(2)).toContainText('gzip');
  await expect(rows.nth(2)).not.toContainText(T('packages.securityOne'));
  await expect(rows.nth(2)).toContainText(/ -> .*\+burrowtest1/);
  await expect(page.getByTestId('packages-age')).toContainText('Package lists from ');
  await lookAt(page, 'desktop-host-packages');
  // The command to update, copied for a terminal: Burrow does not run it.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('packages-copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('sudo apt update && sudo apt upgrade');

  // The host list marks it, with what waits.
  await page.goto('/#/hosts');
  const row = page.getByTestId('host-row').filter({ hasText: 'test-sshd' }).first();
  await expect(row.getByTestId('host-updates')).toHaveAttribute('aria-label', '3 updates | 2 security', { timeout: 20_000 });
  await expect(row.getByTestId('host-updates')).toHaveText('3');

  // Told once as a Host health alert (by this check, or the one Burrow made by itself before it).
  await expect
    .poll(async () => (await page.evaluate(async () => (await (await fetch('/api/alerts')).json()) as { container: string; title: string }[])).filter((a) => a.container === '@packages').map((a) => a.title), { timeout: 20_000 })
    .toContain('2 security updates waiting: bash, tar');
});

test('package updates: many folded to the first twelve; a check that failed is said, never "up to date"', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `pkg${String(i).padStart(2, '0')}`, from: '1.0', to: '1.1', security: false }));
  await page.route(ONE, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: { hostId: sshd, checkedAt: new Date().toISOString(), state: 'ok', manager: 'dnf', listAt: null, updates: many, security: 0, reboot: true, message: null } }) : r.fallback(),
  );
  await page.goto(`/#/hosts/${sshd}/stats`);
  await expect(page.getByTestId('packages-state')).toHaveText('15 updates | restart needed', { timeout: 20_000 });
  const rows = page.getByTestId('packages-list').locator('li');
  await expect(rows).toHaveCount(12);
  await page.getByTestId('packages-all').click();
  await expect(rows).toHaveCount(15);
  await expect(page.getByTestId('packages-all')).toHaveText(T('packages.fewer'));
  await page.getByTestId('packages-all').click();
  await expect(rows).toHaveCount(12);
  await expect(page.getByTestId('packages-age')).toContainText(T('packages.listsUnknown'));
  await expect(page.getByTestId('packages')).toContainText('sudo dnf upgrade');

  await page.unroute(ONE);
  await page.route(ONE, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: { hostId: sshd, checkedAt: new Date().toISOString(), state: 'error', manager: 'apt', listAt: null, updates: [], security: 0, reboot: false, message: 'E: Could not open lock file' } }) : r.fallback(),
  );
  await page.reload();
  await expect(page.getByTestId('packages-state')).toHaveText(T('packages.failed', { error: 'E: Could not open lock file' }), { timeout: 20_000 });
  await expect(page.getByTestId('packages')).not.toContainText(T('packages.upToDate'));
  await page.unroute(ONE);
});

test("package lists a month old: said with how the host fetches them itself, and fetched again at a press (report 1f6c0c)", async ({ page }) => {
  // Reported: lists from a month before, the host's own daily refresh off, and Burrow only saying so.
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const old = new Date(Date.now() - 28 * 86_400_000).toISOString();
  await page.route(ONE, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: { hostId: sshd, checkedAt: new Date().toISOString(), state: 'ok', manager: 'apt', listAt: old, updates: [], security: 0, reboot: false, message: null } }) : r.fallback(),
  );
  await page.goto(`/#/hosts/${sshd}/stats`);
  await expect(page.getByTestId('packages-age')).toContainText('not fetched for a week', { timeout: 20_000 });
  // How the host does it each day by itself, to copy; and Burrow doing it now.
  await expect(page.getByTestId('packages-timer')).toHaveText('sudo systemctl enable --now apt-daily.timer');
  await lookAt(page, 'desktop-host-packages-old');
  // The test host signs in with a key and keeps no password: sudo asks for one, and that is said,
  // the lists as old as before (the server's part with a password: integration/packages.test.ts).
  await page.getByTestId('packages-refresh').click();
  await expect(page.getByTestId('toasts')).toContainText('The package lists could not be fetched: sudo: a password is required', { timeout: 60_000 });
  await expect(page.getByTestId('packages-age')).toContainText('not fetched for a week');
  // Fetched: fresh, the button gone.
  await page.route(/\/api\/hosts\/\d+\/packages\/refresh$/, (r) =>
    r.fulfill({ json: { hostId: sshd, checkedAt: new Date().toISOString(), state: 'ok', manager: 'apt', listAt: new Date().toISOString(), updates: [{ name: 'bash', from: '5.2', to: '5.2+1', security: true }], security: 1, reboot: false, message: null } }),
  );
  await page.getByTestId('packages-refresh').click();
  await expect(page.getByTestId('toasts')).toContainText(T('packages.refreshed'));
  await expect(page.getByTestId('packages-state')).toHaveText('1 update | 1 security');
  await expect(page.getByTestId('packages-age')).not.toContainText('not fetched for a week');
  await expect(page.getByTestId('packages-refresh')).toHaveCount(0);
  await page.unroute(/\/api\/hosts\/\d+\/packages\/refresh$/);
  await page.unroute(ONE);
});
