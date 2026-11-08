import { expect, test } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { fillSettled, signIn } from './passkey.js';
import { lookAt } from './checks.js';

const SSHD_HOST = process.env.SSHD_HOST ?? 'burrow-e2e-sshd';
const SSHD_PASSWORD = 'burrow-test-password';

test.describe.configure({ mode: 'serial' });

test('signs in with the passkey, builds a group and a host, trusts it and installs a key', async ({ page }) => {
  await signIn(page);

  // Group with a default user that the host inherits.
  await page.getByRole('button', { name: 'Add group' }).click();
  await fillSettled(page.getByLabel('Name'), 'Home');
  await page.getByLabel('User').fill('tester');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /Home/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add host' }).click();
  await fillSettled(page.getByLabel('Name'), 'test-sshd');
  await page.getByLabel('Address').fill(SSHD_HOST);
  await page.getByLabel('Group').selectOption({ label: 'Home' });
  await expect(page.getByText('from group Home: tester')).toBeVisible();
  await page.getByLabel('Authentication').selectOption({ label: 'Password' });
  await page.getByLabel('Password', { exact: true }).fill(SSHD_PASSWORD);
  await page.getByLabel('Tags').fill('test, Docker');
  await page.getByRole('button', { name: 'Save' }).click();

  const row = page.getByTestId('host-row').filter({ hasText: 'test-sshd' });
  await expect(row).toContainText(`tester@${SSHD_HOST}`);

  // Fuzzy search finds it by tag and by a typo; nonsense finds nothing.
  const search = page.getByPlaceholder('Search name, address or tag');
  await search.fill('docker');
  await expect(page.getByTestId('host-row')).toHaveCount(1);
  await search.fill('tset-sshd');
  await expect(page.getByTestId('host-row')).toHaveCount(1);
  await search.fill('zzzzzz');
  await expect(page.getByText('No host matches')).toBeVisible();
  await search.fill('');

  // First connection, from the host menu: fingerprint, trust, connected.
  await page.getByRole('button', { name: 'Menu for test-sshd' }).click();
  await page.getByTestId('test-connection').click();
  await expect(page.getByText('First connection to this host')).toBeVisible();
  await expect(page.getByTestId('fingerprint')).toHaveText(/^SHA256:/);
  await page.getByRole('button', { name: 'Trust and connect' }).click();
  await expect(page.getByTestId('test-ok')).toContainText('Connected');
  await page.keyboard.press('Escape');

  // Key vault: generate, then install on the host with the password.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^Key vault/ }).click();
  await page.getByRole('button', { name: 'Generate key' }).click();
  await fillSettled(page.getByLabel('Name'), 'burrow-main');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('key-row')).toContainText('SHA256:');
  // Its public key copied from the row's menu.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await fromRowMenu(page.getByTestId('key-row').filter({ hasText: 'burrow-main' }), 'key-menu', 'key-copy');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^ssh-ed25519 /);

  await page.getByRole('link', { name: 'Hosts' }).click();
  await page.getByRole('button', { name: 'Menu for test-sshd' }).click();
  await page.getByRole('button', { name: 'Install key on host' }).click();
  await page.getByLabel(/Password for tester@/).fill(SSHD_PASSWORD);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByTestId('install-ok')).toContainText('Key "burrow-main" installed');
  await page.getByRole('button', { name: 'Remove stored password' }).click();
  await expect(page.getByTestId('install-ok')).not.toContainText('still stored');
  await page.getByTestId('test-connection').click();
  await expect(page.getByTestId('test-ok')).toBeVisible();
  await expect(page.locator('.badge', { hasText: 'tmux' })).toBeVisible();
});

test('a first tap on a new host: its fingerprint at once, no raw code; trusting it opens the terminal in one step (W-FUNC-02, decision 13)', async ({ page }) => {
  await signIn(page);
  const SSHD2 = process.env.SSHD2_HOST ?? 'burrow-e2e-sshd2';
  const host = await page.evaluate(async (address) => {
    const r = await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'first-tap', address, port: 22, username: 'tester', authMethod: 'password', password: 'burrow-test-password' }) });
    return (await r.json()) as { id: number };
  }, SSHD2);
  try {
    await page.goto('/#/hosts');
    await page.reload();
    await page.getByTestId('host-row').filter({ hasText: 'first-tap' }).getByRole('button', { name: /^first-tap/ }).first().click();
    const sheet = page.getByRole('dialog', { name: 'first-tap' });
    // What to check, without pressing Test connection first; not "Host key check: unknown_host_key".
    await expect(sheet.getByTestId('fingerprint')).toHaveText(/^SHA256:/);
    await expect(page.getByText('unknown_host_key')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Trust and connect' }).click();
    // Trusted and connected: the terminal, not a "Connected." and a third press.
    await expect(page).toHaveURL(/#\/term\//, { timeout: 20_000 });
    await expect(page.locator('.xterm').first()).toBeVisible();
  } finally {
    await page.evaluate(async (id) => {
      const list = (await (await fetch('/api/terminal/sessions')).json()) as { id: string; hostId: number }[];
      for (const s of list.filter((x) => x.hostId === id)) await fetch(`/api/terminal/sessions/${s.id}`, { method: 'DELETE' });
      await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
    }, host.id);
  }
});

test('imports hosts from an ssh config', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Import' }).click();
  await page.locator('textarea[name=config]').fill('Host server2\n  HostName 192.168.1.20\n  User alice\n  IdentityFile ~/.ssh/burrow-main\n\nHost spare3\n  HostName 192.168.1.23\n\nHost spare4\n  HostName 192.168.1.24\n\nHost spare5\n  HostName 192.168.1.25\n\nHost *\n  Port 22\n');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('server2')).toBeVisible();
  // Many at once: all or none (the same as every long list), then only the one wanted.
  await page.getByTestId('import-none').click();
  await expect(page.getByRole('button', { name: 'Import 0 hosts' })).toBeDisabled();
  await page.getByTestId('import-all').click();
  await expect(page.getByRole('button', { name: 'Import 4 hosts' })).toBeEnabled();
  await page.getByTestId('import-none').click();
  await page.getByRole('checkbox').first().check();
  await expect(page.getByRole('combobox', { name: 'Key' }).first()).toHaveValue(/\d+/);
  await page.getByRole('button', { name: 'Import 1 host' }).click();
  await expect(page.getByTestId('host-row').filter({ hasText: 'server2' })).toContainText('alice@192.168.1.20');
});

test('shows sessions, switches language and signs out', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  // The overview: each part on a page of its own, and back.
  await page.getByTestId('settings-section').filter({ hasText: 'Security' }).click();
  await expect(page.getByText('this device', { exact: true })).toBeVisible();
  await expect(page.getByText('Passkey').first()).toBeVisible();
  // A computer: the list stays beside the open part, no Back (report 774696).
  await expect(page.getByTestId('settings-back')).toHaveCount(0);
  await page.getByTestId('settings-section').filter({ hasText: 'Appearance' }).click();

  // Appearance: explicit dark/light override the system, accent presets apply.
  await page.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'Light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: 'Blue' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // A light ground, tinted by the accent (report 5d820e): blue leans blue.
  const ground = async () => {
    const c = await page.locator('html').evaluate((e) => getComputedStyle(e).backgroundColor);
    const n = (c.match(/[\d.]+/g) ?? []).map(Number);
    const [r, , b] = c.startsWith('color(') ? n.map((x) => x * 255) : n;
    return r! > 230 && b! > r!;
  };
  await expect.poll(ground, { message: 'a light ground with a blue tint' }).toBe(true);
  // Black for an OLED screen: true black behind everything, cards apart by
  // their borders; kept after a reload, also when the system asks for light.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'Black (OLED)' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(page.locator('.card').first()).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  // Cards apart by a dark border, tinted by the accent (report 5d820e), never black on black.
  const edge = await page.locator('.card').first().evaluate((e) => getComputedStyle(e).borderTopColor);
  const rgb = (edge.match(/[\d.]+/g) ?? []).map(Number).map((x) => (edge.startsWith('color(') ? x * 255 : x));
  expect(rgb.slice(0, 3).every((x) => x >= 30 && x <= 80), `card border ${edge}`).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  expect(await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content'))).toMatch(/^#000(000)?$/);
  await lookAt(page, 'desktop-settings-black');
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'Auto' });
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);

  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('nl');
  await expect(page.getByRole('heading', { name: 'Instellingen' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Taal', exact: true }).selectOption('en');

  // The audit log: in Security.
  await page.getByTestId('settings-section').filter({ hasText: 'Security' }).click();
  await page.getByRole('button', { name: 'Audit log' }).click();
  // In words, not keys (UIA-07).
  await expect(page.getByTestId('audit-entry').filter({ hasText: 'Host key trusted' }).first()).toBeVisible();
  await expect(page.getByTestId('audit-entry').filter({ hasText: 'Setup finished' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
});
