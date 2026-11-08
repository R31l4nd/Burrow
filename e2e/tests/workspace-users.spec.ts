import { expect, test, type Page } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { saveCredential, signIn } from './passkey.js';
import { nextCode } from './totp.js';

// Phase 11: single sign-on set up in Settings, an operator invited and
// joining through the provider, what an operator sees (and does not), and a
// host's statistics.

const IDP = process.env.IDP_URL ?? 'http://127.0.0.1:8200';

/** A screenshot for review, with every check of checks.ts on what is shown. */
async function shoot(page: Page, name: string) {
  await lookAt(page, name);
}

test('single sign-on, an invited operator who may look but not change, host statistics', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const questions = await sayYes(page);
  const key = await signIn(page);

  // The admin: single sign-on in Settings.
  await page.goto('/#/settings?s=sso');
  await page.reload();
  // Off: only the switch, not even Save, nothing to save there yet (report 2359e7); on, the provider's fields.
  await expect(page.getByTestId('sso-issuer')).toHaveCount(0);
  await expect(page.getByTestId('sso-enabled')).toBeVisible();
  await expect(page.getByTestId('sso-save')).toHaveCount(0);
  await page.getByTestId('sso-enabled').check();
  await page.getByTestId('sso-issuer').fill(IDP);
  await page.getByTestId('sso-client').fill('burrow');
  await page.getByTestId('sso-secret').fill('burrow-secret');
  await page.getByTestId('sso-label').fill('Test IdP');
  await page.getByTestId('sso-save').click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // An invite for an operator. The first try is answered "confirm it's you
  // first", as fifteen minutes after signing in: the passkey confirms, and
  // the invite is made after all.
  await page.goto('/#/settings/users');
  let asked = false;
  await page.route('**/api/invites', (r) => (r.request().method() === 'POST' && !asked ? ((asked = true), r.fulfill({ status: 403, json: { error: 'step_up_required' } })) : r.continue()));
  await page.getByTestId('invite-role').selectOption('operator');
  await page.getByTestId('invite').click();
  const confirm = page.getByRole('dialog', { name: "Confirm it's you" });
  await confirm.getByRole('button', { name: 'Confirm with passkey' }).click();
  await expect(confirm).toBeHidden();
  // The key's counter went up: the later tests sign in with this copy.
  await saveCredential(key);
  await page.unroute('**/api/invites');
  const url = await page.getByTestId('invite-url').inputValue();
  expect(url).toMatch(/#\/invite\/[\w-]+$/);
  await page.getByTestId('users').scrollIntoViewIfNeeded();
  await shoot(page, 'desktop-users');

  // Someone else, in their own browser: the link, then the provider.
  const other = await browser.newContext();
  const op = await other.newPage();
  await sayYes(op);
  await op.goto(url.replace(/^https?:\/\/[^/]+/, ''));
  await expect(op.getByTestId('invite-page')).toContainText('You are invited as Operator.');
  await shoot(op, 'desktop-invite');
  await op.getByTestId('invite-sso').click();
  await expect(op.getByRole('heading', { name: 'Test IdP' })).toBeVisible();
  await op.getByRole('button', { name: 'Sign in as newbie' }).click();
  // Back in Burrow, signed in: no terminal for an operator.
  await expect(op.getByRole('link', { name: 'Hosts' })).toBeVisible();
  await expect(op.getByRole('link', { name: 'Terminal' })).toHaveCount(0);
  await expect(op.getByRole('button', { name: 'Add host' })).toHaveCount(0);

  // A host: its statistics, not a shell.
  await op.getByRole('button', { name: /test-sshd - / }).first().click();
  await expect(op).toHaveURL(/#\/hosts\/\d+\/stats$/);
  await expect(op.getByTestId('stats-now')).toContainText('CPU');
  await expect(op.getByTestId('disk').first()).toBeVisible();
  await expect(op.getByTestId('smart-check')).toHaveCount(0);
  // A disk's activity (report d4a9c0): its numbers and history, but not who reads and writes,
  // which runs as root and shows every process and its files: not even asked for.
  let measured = false;
  op.on('request', (r) => void (/\/disks\/activity$/.test(r.url()) && (measured = true)));
  await op.getByTestId('io-disk').first().click();
  const diskDialog = op.locator('dialog[open][data-tour=disk-activity]');
  await expect(diskDialog.getByTestId('disk-now')).toBeVisible();
  await expect(diskDialog.getByTestId('disk-admin-only')).toBeVisible();
  await diskDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(diskDialog).toBeHidden();
  expect(measured).toBe(false);
  // The alert limits: shown, not changeable.
  // As text, not a box that looks editable (live UI round).
  await expect(op.locator('[data-testid=limits] input')).toHaveCount(0);
  await expect(op.getByTestId('limit-cpuCelsius')).toHaveText(/^\d+( \(default\))?$/);
  await expect(op.getByTestId('limits-save')).toHaveCount(0);
  await shoot(op, 'desktop-host-stats');
  // With a history to draw (a stand-in: samples come every five minutes),
  // on a narrow phone nothing sticks out past the screen.
  await op.route('**/api/hosts/*/stats/history*', (route) =>
    route.fulfill({ json: Array.from({ length: 12 }, (_, i) => ({ at: new Date(Date.now() - (12 - i) * 300_000).toISOString(), cpu: 10 + i, memPercent: 40, load1: 0.5, diskPercent: 47, maxCelsius: 50 })) }),
  );
  // Dutch too: its longer period names pushed the dropdown past the edge.
  for (const [width, lang] of [[390, 'en'], [360, 'nl'], [320, 'nl']] as const) {
    await op.setViewportSize({ width, height: 800 });
    await op.evaluate((l) => localStorage.setItem('burrow.locale', l), lang);
    await op.reload();
    await expect(op.locator('.chart').first()).toBeVisible();
    const wide = await op.evaluate(() =>
      [...document.querySelectorAll('.page *')]
        .filter((e) => (e as HTMLElement).offsetParent && e.getBoundingClientRect().right > window.innerWidth + 1)
        .map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}`)
        .slice(0, 5),
    );
    expect(wide, `past the right edge at ${width} px (${lang})`).toEqual([]);
    const period = (await op.getByRole('combobox').first().boundingBox())!;
    const card = (await op.locator('.card', { has: op.getByRole('combobox') }).first().boundingBox())!;
    expect(period.x + period.width, `period dropdown inside its card at ${width} px (${lang})`).toBeLessThanOrEqual(card.x + card.width - 16);
    expect(await op.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await op.evaluate(() => localStorage.setItem('burrow.locale', 'en'));
  await op.reload();
  await shoot(op, 'phone-host-stats');
  await op.unroute('**/api/hosts/*/stats/history*');
  await op.setViewportSize({ width: 1280, height: 720 });

  // Files: only in the folders an admin allows (A3-SRV-01). None yet: refused.
  const hostId = op.url().match(/hosts\/(\d+)/)![1];
  const refusedList = op.waitForResponse((r) => r.url().includes(`/api/files/${hostId}/list`) && r.status() === 403);
  await op.goto(`/#/files/${hostId}?p=%2Fetc`);
  expect((await (await refusedList).json()).error).toBe('no_file_access');
  // The admin allows /etc on this host, but not a folder of keys in it: in Users, the operator's folders.
  await page.goto('/#/settings/users');
  await page.reload();
  // One block per person, a line between: the buttons under a name are that person's (report 976582).
  expect(await page.getByTestId('user').nth(1).evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('solid');
  // Its role as text, what can be done in its menu (report e6fc13): made an admin and an operator again.
  const newbie = page.getByTestId('user').filter({ hasText: 'newbie' });
  await expect(newbie.getByTestId('user-role')).toHaveText('Operator');
  await fromRowMenu(newbie, 'user-menu', 'user-set-role');
  await expect(newbie.getByTestId('user-role')).toHaveText('Admin');
  await fromRowMenu(newbie, 'user-menu', 'user-set-role');
  await expect(newbie.getByTestId('user-role')).toHaveText('Operator');
  await fromRowMenu(newbie, 'user-menu', 'user-files');
  const folders = page.getByRole('dialog', { name: 'Folders newbie may open' });
  await folders.getByTestId('file-access-host').selectOption({ label: 'test-sshd' });
  await expect(folders.getByTestId('file-access-save')).toBeDisabled();
  await folders.getByTestId('file-access-allow').fill('/etc/\n/etc');
  await folders.getByTestId('file-access-deny').fill('/etc/ssl/private');
  await folders.getByTestId('file-access-save').click();
  await expect(folders.getByTestId('file-access-host')).toContainText('test-sshd (1 folder)');
  await expect(folders.getByTestId('file-access-allow')).toHaveValue('/etc');
  await shoot(page, 'desktop-file-access');
  await folders.getByTestId('file-access-cancel').click();
  await expect(folders).toBeHidden();
  // Files: to read, not to change.
  await op.goto(`/#/files/${hostId}?p=%2Fetc`);
  await op.reload();
  await expect(op.getByTestId('file-row').first()).toBeVisible();
  await expect(op.getByRole('button', { name: 'Upload' })).toHaveCount(0);
  // An operator's tap on a host opens its statistics, and the button says so (W-FUNC-12: "test-sshd - connect").
  await op.goto('/#/hosts');
  await expect(op.getByRole('button', { name: 'test-sshd - Statistics', exact: true })).toBeVisible();
  // From Files itself, not by a typed address (W-FUNC-05): only the hosts with folders for them, each at its folders (decision 14).
  await op.goto('/#/files');
  await op.reload();
  await expect(op.getByTestId('files-host')).toHaveCount(1);
  await expect(op.getByTestId('files-host')).toContainText('test-sshd');
  await expect(op.getByTestId('files-host')).toContainText('/etc');
  await op.getByTestId('files-host').click();
  await expect(op.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'etc', exact: true })).toHaveAttribute('aria-current', 'page');
  // A folder it may not open: the ones it may, to tap.
  await op.goto(`/#/files/${hostId}?p=%2Froot`);
  await op.getByTestId('files-allowed-folder').filter({ hasText: '/etc' }).click();
  await expect(op.getByTestId('file-row').first()).toBeVisible();
  await op.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/etc/hostname')}`);
  await expect(op.getByTestId('readonly-bar')).toBeVisible();
  // Read only, yet reachable by keyboard: a long file that scrolls (axe: a scrolling text with nothing to focus, seen on the live Burrow).
  await op.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/etc/ssh/sshd_config')}`);
  await expect(op.getByTestId('readonly-bar')).toBeVisible();
  await expect(op.locator('.cm-content')).toContainText('sshd');
  await lookAt(op, 'operator-editor-readonly');
  await op.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/etc/hostname')}`);
  await expect(op.getByTestId('readonly-bar')).toBeVisible();
  // Below the denied folder: not opened.
  const refusedText = op.waitForResponse((r) => r.url().includes(`/api/files/${hostId}/text`) && r.status() === 403);
  await op.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/etc/ssl/private/x.key')}`);
  expect((await (await refusedText).json()).error).toBe('no_file_access');
  await op.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/etc/hostname')}`);
  await expect(op.getByTestId('readonly-bar')).toBeVisible();
  await op.locator('.cm-content').click();
  await op.keyboard.type('changed');
  await expect(op.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);

  // Every page an operator can reach loads without asking for what is not
  // theirs (a refused request would leave a page empty or show an error).
  // A workspace the admin made: the operator opens it, but is not offered to remove it.
  const ws = await page.evaluate(async (id) => (await (await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: Number(id), root: '/etc', name: 'ops-look' }) })).json()) as { id: number }, hostId);
  const refused: string[] = [];
  op.on('response', (r) => {
    if (r.status() === 403 && r.url().includes('/api/')) refused.push(`${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  for (const path of ['/hosts', '/files', `/files/${hostId}?p=%2Fetc`, '/containers', '/apps', '/alerts', '/reports', '/settings', `/hosts/${hostId}/stats`]) {
    await op.goto(`/#${path}`);
    await op.reload();
    await expect(op.locator('h1').first()).toBeVisible();
    await expect(op.getByText('Loading...')).toHaveCount(0, { timeout: 10_000 });
    await op.waitForTimeout(800);
    // Nothing offered that the server would refuse: no delete or remove (an operator saw a workspace's bin on the live Burrow).
    const removers = await op.locator('button:visible, a:visible').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.textContent ?? ''}`.trim()).filter((x) => /^(Delete|Remove)\b/.test(x)));
    expect(removers, `delete or remove offered to an operator on ${path}`).toEqual([]);
  }
  expect(refused, 'requests refused on pages an operator opens').toEqual([]);
  // Images and volumes to look at (the live Burrow showed an operator only "forbidden"), not to clean up.
  await op.goto(`/#/hosts/${hostId}/docker`);
  await expect(op.getByTestId('res-list')).toBeVisible({ timeout: 20_000 });
  await expect(op.getByTestId('res-prune')).toHaveCount(0);
  // A workspace: files to read and logs below; no terminal, no saving, no folders taken out.
  await op.goto(`/#/ws/${ws.id}`);
  await expect(op.getByTestId('ws-quick')).toBeVisible();
  await expect(op.getByTestId('save')).toHaveCount(0);
  await op.getByTestId('panel-toggle').click();
  await expect(op.getByTestId('panel-tab-term')).toHaveCount(0);
  await expect(op.getByTestId('panel-tab-logs')).toBeVisible();
  await page.evaluate((id) => fetch(`/api/workspaces/${id}`, { method: 'DELETE' }), ws.id);

  // Settings: the operator's own account only.
  await op.goto('/#/settings');
  // An operator's settings: their own parts only, none of the admin's.
  const parts = op.getByTestId('settings-section');
  await expect(parts.filter({ hasText: 'Security' })).toHaveCount(1);
  for (const h of ['AI', 'Notification channels', 'Users', 'Single sign-on', 'Backups']) await expect(parts.filter({ has: op.getByText(h, { exact: true }) })).toHaveCount(0);
  // Nor by its address.
  await op.goto('/#/settings/ai');
  await expect(op.locator('h2#ai')).toHaveCount(0);
  await other.close();

  // The admin sees the new user, joined through the provider.
  await page.goto('/#/settings?s=users');
  await page.reload();
  await expect(page.getByTestId('user').filter({ hasText: 'newbie' })).toContainText('single sign-on');

  // The admin sets a host's own alert limits: the default as the hint, save
  // only once something changed, a hotter limit colours the temperature
  // later, and back to the defaults.
  await page.goto(`/#/hosts/${hostId}/stats`);
  await page.reload();
  const cpu = page.getByTestId('limit-cpuCelsius');
  await expect(cpu).toHaveAttribute('placeholder', /default \d+/);
  await expect(page.getByTestId('limits-save')).toBeDisabled();
  await expect(page.getByTestId('limits-reset')).toHaveCount(0);
  await cpu.fill('95');
  // A second limit changed while the first save is on its way: kept, still to save (AUDIT2 PAGE-13).
  let release!: () => void;
  let sending!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent = new Promise<void>((r) => (sending = r));
  await page.route(`**/api/hosts/${hostId}/limits`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    sending();
    await held;
    await route.continue();
  });
  await page.getByTestId('limits-save').click();
  await sent;
  await page.getByTestId('limit-diskPercent').fill('97');
  release();
  await expect(page.getByText('Limits saved')).toBeVisible();
  await page.unroute(`**/api/hosts/${hostId}/limits`);
  await expect(page.getByTestId('limit-diskPercent')).toHaveValue('97');
  await expect(page.getByTestId('limits-save')).toBeEnabled();
  await page.getByTestId('limits-save').click();
  await expect(page.getByTestId('limits-save')).toBeDisabled();
  await page.reload();
  await expect(cpu).toHaveValue('95');
  await expect(page.getByTestId('limit-diskPercent')).toHaveValue('97');
  await expect(page.getByTestId('limit-diskCelsius')).toHaveValue('');
  await page.getByTestId('limits-reset').click();
  await expect(cpu).toHaveValue('');
  await expect(page.getByTestId('limits-reset')).toHaveCount(0);

  // Signing out and in through the provider: the login page's button.
  const third = await browser.newContext();
  const p3 = await third.newPage();
  await p3.goto('/');
  await p3.getByTestId('login-sso').click();
  await p3.getByRole('button', { name: 'Sign in as newbie' }).click();
  await expect(p3.getByRole('link', { name: 'Hosts' })).toBeVisible();
  // Unknown at Burrow: told so, not signed in.
  await p3.context().clearCookies();
  await p3.goto('/');
  await p3.getByTestId('login-sso').click();
  await p3.getByRole('button', { name: 'Sign in as alice' }).click();
  await expect(p3.getByText('there is no Burrow account for you')).toBeVisible();
  await third.close();

  // The provider changed: the admin unlinks the account (after a yes), and its next sign-in
  // through the provider links it again by its username (AUDIT2 AUTH-06).
  await page.goto('/#/settings/users');
  const row = page.getByTestId('user').filter({ hasText: 'newbie' });
  await expect(row).toContainText('single sign-on');
  await fromRowMenu(row, 'user-menu', 'user-sso-unlink');
  await expect(row).not.toContainText('single sign-on');
  expect((await questions()).some((q) => q.includes('Unlink newbie'))).toBe(true);
  const fourth = await browser.newContext();
  const p4 = await fourth.newPage();
  await p4.goto('/');
  await p4.getByTestId('login-sso').click();
  await p4.getByRole('button', { name: 'Sign in as newbie' }).click();
  await expect(p4.getByRole('link', { name: 'Hosts' })).toBeVisible();
  await fourth.close();
  await page.reload();
  await expect(row).toContainText('single sign-on');

  // The admin removes the user again (after a yes): gone from the list, and
  // signing in through the provider finds no account any more.
  // The yes comes from sayYes (a click of our own raced it for the button).
  await fromRowMenu(row, 'user-menu', 'user-remove');
  await expect(row).toHaveCount(0);
  expect((await questions()).some((q) => q.includes('newbie'))).toBe(true);
});

test("another invite's address in the same tab: that invite, its role (AUDIT2 PAGE-14)", async ({ page, browser }) => {
  await signIn(page);
  const make = (role: string) =>
    page.evaluate(async (r) => {
      const res = await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: r }) });
      return (await res.json()) as { id: number; url: string };
    }, role);
  const a = await make('operator');
  const b = await make('admin');
  const other = await browser.newContext();
  const guest = await other.newPage();
  await guest.goto(a.url.replace(/^https?:\/\/[^/]+/, ''));
  await expect(guest.getByTestId('invite-page')).toContainText('You are invited as Operator.');
  await guest.evaluate((h) => (location.hash = h), b.url.replace(/^[^#]*/, ''));
  await expect(guest.getByTestId('invite-page')).toContainText('You are invited as Admin.');
  await other.close();
  for (const x of [a, b]) await page.evaluate((id) => fetch(`/api/invites/${id}`, { method: 'DELETE' }), x.id);
});

test('password and authenticator app: turned on by an invited person, signed in with a code, a step-up with one (the code field refused every code)', async ({ page, browser }) => {
  // Three codes of three time steps (each is taken once): up to a minute of waiting.
  test.setTimeout(150_000);
  await signIn(page);
  const inv = await page.evaluate(async () => (await (await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'operator' }) })).json()) as { id: number; url: string });
  const other = await browser.newContext();
  const p = await other.newPage();
  await sayYes(p);
  await p.goto(inv.url.replace(/^https?:\/\/[^/]+/, ''));
  const name = `totp-${Date.now().toString(36)}`;
  // Said to the one invited, not in the admin's words ("the folders you allow", W-FUNC-12).
  await expect(p.getByTestId('invite-page')).toContainText('folders an admin allows you');
  await p.getByTestId('invite-username').fill(name);
  await p.getByTestId('invite-accept').click();
  // Joining, not setting Burrow up (W-FUNC-12).
  await expect(p.getByRole('heading', { level: 1 })).toHaveText('Join Burrow');
  // Setup's second step: a password, then the authenticator app with a code typed in.
  await p.getByRole('button', { name: 'Password + authenticator app' }).click();
  const password = 'a long enough password 1';
  await p.getByLabel('New password (min. 12 characters)').fill(password);
  await p.getByRole('button', { name: 'Next', exact: true }).click();
  const secret = (await p.getByTestId('totp-secret').textContent())!.replace(/\s/g, '');
  // The QR code has a name (W-FUNC-12).
  await expect(p.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const first = await nextCode(secret, null);
  await p.getByLabel('Authenticator code').fill(first.code);
  await p.getByRole('button', { name: 'Confirm', exact: true }).click();
  await p.getByRole('button', { name: 'Finish setup' }).click();
  await expect(p.getByTestId('recovery-codes')).toBeVisible();
  await p.getByLabel('I have saved these codes').check();
  await p.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(p.getByRole('link', { name: 'Hosts' })).toBeVisible();

  // Signed out, and in again with the password and a code.
  await p.goto('/#/settings');
  await p.getByRole('button', { name: 'Sign out' }).click();
  await p.getByRole('button', { name: 'Use password instead' }).click();
  await p.getByLabel('Username').fill(name);
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Next', exact: true }).click();
  const second = await nextCode(secret, first.step);
  await p.getByLabel('Authenticator code').fill(second.code);
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(p.getByRole('link', { name: 'Hosts' })).toBeVisible();

  // A step-up with a code: the sign-in was one, so the first answer is held back as an older session's would be.
  let asked = false;
  await p.route('**/api/account/recovery-codes', (r) => {
    if (r.request().method() !== 'POST' || asked) return r.continue();
    asked = true;
    return r.fulfill({ status: 403, json: { error: 'step_up_required' } });
  });
  await p.goto('/#/settings/security');
  await p.getByRole('button', { name: 'Create new codes' }).click();
  const dlg = p.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dlg).toBeVisible();
  const third = await nextCode(secret, second.step);
  await dlg.getByLabel('Or enter your authenticator code').fill(third.code);
  const made = p.waitForResponse((r) => r.url().endsWith('/api/account/recovery-codes') && r.request().method() === 'POST' && r.status() === 200);
  await dlg.getByRole('button', { name: 'Confirm', exact: true }).click();
  await made;
  await expect(dlg).toBeHidden();
  await other.close();
  // Gone again, so the users list stays as the other tests expect.
  const users = await page.evaluate(async () => (await (await fetch('/api/users')).json()) as { id: number; username: string }[]);
  const made2 = users.find((u) => u.username === name);
  if (made2) await page.evaluate((id) => fetch(`/api/users/${id}`, { method: 'DELETE' }), made2.id);
});

/** An operator of the test's own, signed in in a browser of its own: invited, with a password and an authenticator app. */
async function newOperator(page: Page, browser: import('@playwright/test').Browser, prefix: string) {
  const inv = await page.evaluate(async () => (await (await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'operator' }) })).json()) as { url: string });
  const context = await browser.newContext();
  const p = await context.newPage();
  await sayYes(p);
  await p.goto(inv.url.replace(/^https?:\/\/[^/]+/, ''));
  const name = `${prefix}-${Date.now().toString(36)}`;
  await p.getByTestId('invite-username').fill(name);
  await p.getByTestId('invite-accept').click();
  await p.getByRole('button', { name: 'Password + authenticator app' }).click();
  await p.getByLabel('New password (min. 12 characters)').fill('a long enough password 1');
  await p.getByRole('button', { name: 'Next', exact: true }).click();
  const secret = (await p.getByTestId('totp-secret').textContent())!.replace(/\s/g, '');
  await p.getByLabel('Authenticator code').fill((await nextCode(secret, null)).code);
  await p.getByRole('button', { name: 'Confirm', exact: true }).click();
  await p.getByRole('button', { name: 'Finish setup' }).click();
  await p.getByLabel('I have saved these codes').check();
  await p.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(p.getByRole('link', { name: 'Hosts' })).toBeVisible();
  return { context, p, name };
}

test('a session shared to watch: seen read-only by the one picked, recorded, played back, unshared (F3)', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await sayYes(page);
  await signIn(page);
  const op = await newOperator(page, browser, 'watcher');
  const hosts = await page.evaluate(async () => (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]);
  const sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  const s = await page.evaluate(async (hostId) => (await (await fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId, tmux: 'never' }) })).json()) as { id: string }, sshd);
  await page.goto(`/#/term/${s.id}`);
  const screen = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(screen).toContainText('$', { timeout: 20_000 });

  // Shared with the operator from the Sessions menu.
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('term-share').click();
  const dlg = page.getByRole('dialog', { name: 'Share this session' });
  const pick = dlg.locator('label').filter({ hasText: op.name }).getByTestId('share-user');
  // Cancel: picked, then closed, and nothing shared (opened again, nobody picked).
  await pick.check();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toBeHidden();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('term-share').click();
  await expect(pick).not.toBeChecked();
  await pick.check();
  await lookAt(page, 'desktop-term-share');
  await dlg.getByTestId('share-save').click();
  await expect(page.getByText('Shared with 1 person.')).toBeVisible();

  // The watcher's connection through a stand-in that can drop it, as Wi-Fi to mobile data does
  // (audit 2026-11-05: any close read as "The session has ended.", never connected again).
  let dials = 0;
  const drops: (() => Promise<void>)[] = [];
  await op.p.routeWebSocket(/\/api\/terminal\/shared\/[^/]+\/ws/, async (ws) => {
    dials += 1;
    // The second one slowly: the page says it is connecting again meanwhile.
    if (dials > 1) await new Promise((r) => setTimeout(r, 1500));
    ws.connectToServer();
    drops.push(() => ws.close({ code: 1001, reason: 'gone' }));
  });
  // The operator: on the hosts page, and watching.
  await op.p.goto('/#/hosts');
  await op.p.reload();
  await op.p.getByTestId('shared-sessions').getByTestId('shared-watch').click();
  await expect(op.p.getByTestId('watch-readonly')).toBeVisible();
  const watched = op.p.locator('[data-testid=watch-page] .xterm-rows');
  await page.locator('[data-testid=terminal]').click();
  await page.keyboard.type('echo shared-$((40+2))\n');
  await expect(watched).toContainText('shared-42', { timeout: 15_000 });
  await lookAt(op.p, 'desktop-watch');
  // What the watcher types goes nowhere.
  await op.p.locator('[data-testid=watch-page] .xterm').click();
  await op.p.keyboard.type('echo from-watcher-$((1+1))\n');
  await page.keyboard.type('echo after-$((2+3))\n');
  await expect(screen).toContainText('after-5');
  await expect(screen).not.toContainText('from-watcher-2');
  // The connection dropped, the session not ended: said, connected again by itself, the screen anew.
  await drops.at(-1)!();
  await expect(op.p.getByTestId('watch-state')).toContainText('Connecting again');
  await expect.poll(() => dials).toBe(2);
  await expect(op.p.getByTestId('watch-state')).toHaveCount(0, { timeout: 15_000 });
  await page.locator('[data-testid=terminal]').click();
  await page.keyboard.type('echo back-$((3+4))\n');
  await expect(watched).toContainText('back-7', { timeout: 15_000 });

  // Recorded: the watcher sees it is; what is shown meanwhile is in the recording.
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('term-record').check();
  await expect(page.getByText('Recording.')).toBeVisible();
  await expect(op.p.getByTestId('watch-recording')).toBeVisible({ timeout: 15_000 }).catch(async () => {
    await op.p.reload();
    await expect(op.p.getByTestId('watch-recording')).toBeVisible();
  });
  await page.locator('[data-testid=terminal]').click();
  await page.keyboard.type('echo rec-$((6*7))\n');
  await expect(screen).toContainText('rec-42');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('term-record').uncheck();
  await expect(page.getByText('Recording stopped.')).toBeVisible();

  // Unshared: the watcher is told, at once.
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('term-share').click();
  await dlg.locator('label').filter({ hasText: op.name }).getByTestId('share-user').uncheck();
  await dlg.getByTestId('share-save').click();
  await expect(op.p.getByTestId('watch-state')).toContainText('no longer shared');
  await op.context.close();

  // Played back from Settings -> Recordings, downloaded, removed.
  await page.goto('/#/settings');
  // A part of the settings, as the others (report e34ebd).
  await page.getByTestId('settings-section').filter({ hasText: 'Recordings' }).click();
  await expect(page).toHaveURL(/#\/settings\/recordings$/);
  const row = page.getByTestId('rec-list').locator('.list-item').first();
  await expect(row).toContainText('test-sshd');
  await lookAt(page, 'desktop-recordings');
  await row.getByTestId('rec-open').click();
  await expect(page.locator('[data-testid=rec-screen] .xterm-rows')).toContainText('rec-42', { timeout: 15_000 });
  await page.getByTestId('rec-speed').selectOption('8');
  await page.getByTestId('rec-restart').click();
  await expect(page.locator('[data-testid=rec-screen] .xterm-rows')).toContainText('rec-42', { timeout: 15_000 });
  await expect(page.getByTestId('rec-play').or(page.getByTestId('rec-pause'))).toBeVisible();
  if (await page.getByTestId('rec-pause').isVisible()) await page.getByTestId('rec-pause').click();
  await page.getByTestId('rec-play').click();
  await lookAt(page, 'desktop-recording');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('rec-download').click()]);
  expect(download.suggestedFilename()).toMatch(/^burrow-test-sshd-\d+\.cast$/);
  // Back from the player: the list in the settings; the old address leads there too.
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page).toHaveURL(/#\/settings\/recordings$/);
  await page.goto('/#/recordings');
  await expect(page).toHaveURL(/#\/settings\/recordings$/);
  const mine = page.getByTestId('rec-list').locator('.list-item').filter({ hasText: 'test-sshd' }).first();
  const before = await page.getByTestId('rec-list').locator('.list-item').count();
  await mine.getByTestId('rec-remove').click();
  await expect(page.getByText('Recording removed.')).toBeVisible();
  await expect(page.getByTestId('rec-list').locator('.list-item').or(page.getByTestId('rec-none'))).toHaveCount(Math.max(1, before - 1));
  // How long they are kept: 30 days unless chosen otherwise (decision 16).
  await expect(page.getByTestId('rec-keep')).toHaveValue('30');
  await page.getByTestId('rec-keep').selectOption('90');
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(await page.evaluate(() => fetch('/api/recordings/settings').then((r) => r.json()))).toEqual({ keepDays: 90 });
  await page.getByTestId('rec-keep').selectOption('30');
  await expect.poll(() => page.evaluate(() => fetch('/api/recordings/settings').then((r) => r.json()))).toEqual({ keepDays: 30 });
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});
