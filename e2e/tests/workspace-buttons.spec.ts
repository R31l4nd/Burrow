import { expect, test, type Page } from './fixtures.js';
import { sayYes } from './confirm.js';
import { addAuthenticator, signIn } from './passkey.js';
import { lookAt } from './checks.js';

// The buttons no other test pressed (web/src/testids.test.ts keeps the
// list): each one once, with what it should do checked.

const DOCKER_HOST = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';

const api = <T,>(page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;

const dockerHost = async (page: Page) => (await api<{ id: number; address: string }[]>(page, 'GET', '/api/hosts')).find((h) => h.address === DOCKER_HOST)!.id;

test.beforeEach(async ({ page }) => {
  await sayYes(page);
  await signIn(page);
});

test('a container: analyse, its stack, following the log again', async ({ page }) => {
  const id = await dockerHost(page);
  await page.goto(`/#/containers/${id}/burrowtest-web`);
  await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 20_000 });

  // Scrolled up, the log stops following; the button brings it back.
  await expect.poll(() => page.getByTestId('log-line').count(), { timeout: 20_000 }).toBeGreaterThan(30);
  await page.getByTestId('log').first().hover();
  await page.mouse.wheel(0, -5000);
  await expect(page.getByTestId('log-resume')).toBeVisible();
  await page.getByTestId('log-resume').click();
  await expect(page.getByTestId('log-resume')).toBeHidden();

  await page.getByTestId('log-options').click();
  await page.getByTestId('container-analyze').click();
  await expect(page.getByRole('dialog', { name: 'Analyse with AI' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('log-options').click();
  await page.getByTestId('open-stack').click();
  await expect(page).toHaveURL(new RegExp(`#/stacks/${id}/burrowtest$`));
});

test('the containers page checks for image updates on request', async ({ page }) => {
  // Its check may take two minutes: the test's own time covers that (AUDIT2 TEST-12).
  test.setTimeout(180_000);
  await page.goto('/#/containers');
  // The update button is a menu (reported): check now, or show the updates.
  const menu = page.getByTestId('updates-menu');
  const check = page.getByTestId('check-updates');
  const line = page.getByTestId('updates-line');
  await menu.click();
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/docker/updates/check'), { timeout: 120_000 });
  await check.click();
  expect((await checked).ok()).toBe(true);
  await expect(line).toBeHidden();
  // The menu says when it last looked.
  await menu.click();
  await expect(page.getByTestId('updates-menu-items')).toContainText('Last checked');
  await page.keyboard.press('Escape');

  // A check still going on the server (the page left and opened again):
  // the page says so, the menu's check waits, and is back when it ends.
  let running = true;
  await page.route('**/api/docker/activity', (r) => r.fulfill({ json: { ops: [], check: running ? { done: 2, total: 9 } : null } }));
  await page.goto('/#/hosts');
  await page.goto('/#/containers');
  await expect(line).toBeVisible({ timeout: 10_000 });
  await menu.click();
  await expect(check).toBeDisabled();
  running = false;
  await expect(check).toBeEnabled({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.unroute('**/api/docker/activity');
});

test('from a terminal to its directory in Files', async ({ page }) => {
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!;
  const term = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId: sshd.id, cols: 80, rows: 24 });
  await page.goto(`/#/term/${term.id}`);
  await expect(page.locator('.xterm').first()).toBeVisible();
  await page.getByRole('button', { name: 'Sessions and more', exact: true }).click();
  await page.getByTestId('files-here').click();
  await expect(page).toHaveURL(new RegExp(`#/files/${sshd.id}`));
  await expect(page.getByRole('navigation', { name: 'Path' })).toBeVisible();
  await api(page, 'DELETE', `/api/terminal/sessions/${term.id}`);
});

test('beside a terminal a narrow rail of icons leads elsewhere on a computer; a phone has the whole screen', async ({ page }) => {
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!;
  const term = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId: sshd.id, cols: 80, rows: 24 });
  await page.goto(`/#/term/${term.id}`);
  await expect(page.locator('.xterm').first()).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Main' });
  const box = (await rail.boundingBox())!;
  expect(box.width).toBeLessThan(80);
  // The terminal starts where the rail ends.
  expect(Math.round((await page.getByTestId('terminal').boundingBox())!.x)).toBeGreaterThanOrEqual(Math.round(box.width));
  await expect(rail.getByTestId('rail-host')).toHaveCount(0);
  await rail.getByRole('link', { name: 'Files' }).click();
  await expect(page).toHaveURL(/#\/files/);
  // Back on a page of its own: the rail at its width again, with the hosts.
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeGreaterThan(150);
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/#/term/${term.id}`);
  await expect(page.locator('.xterm').first()).toBeVisible();
  await expect(rail).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  await api(page, 'DELETE', `/api/terminal/sessions/${term.id}`);
});

test("a host's stored password removed from its settings; a folder higher up from the path above the files", async ({ page }) => {
  // A host of its own with a password stored (the shared ones stay as they are).
  const h = await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'pw-host', address: '192.0.2.10', username: 'root', authMethod: 'password', password: 'hunter22' });
  try {
    expect((await api<{ hasPassword: boolean }>(page, 'GET', `/api/hosts/${h.id}`)).hasPassword).toBe(true);
    await page.goto(`/#/hosts/${h.id}/edit`);
    await page.getByLabel('Remove stored password').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(/#\/hosts$/);
    expect((await api<{ hasPassword: boolean }>(page, 'GET', `/api/hosts/${h.id}`)).hasPassword).toBe(false);
  } finally {
    await api(page, 'DELETE', `/api/hosts/${h.id}`);
  }
  // In Files, a folder of the path above the list: there at once.
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const sshd = hosts.find((x) => x.name === 'test-sshd')!;
  await page.goto(`/#/files/${sshd.id}?p=/etc/ssh`);
  const path = page.getByRole('navigation', { name: 'Path' });
  await expect(path.getByRole('button', { name: 'ssh', exact: true })).toHaveAttribute('aria-current', 'page');
  await path.getByRole('button', { name: 'etc', exact: true }).click();
  await expect(page).toHaveURL(/p=%2Fetc$|p=\/etc$/);
  await expect(path.getByRole('button', { name: 'etc', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('an nginx configuration is tested in a container', async ({ page }) => {
  const id = await dockerHost(page);
  const path = '/home/tester/site/nginx.conf';
  await api(page, 'POST', `/api/files/${id}/create`, { path: '/home/tester/site', kind: 'dir' }).catch(() => {});
  await api(page, 'PUT', `/api/files/${id}/text`, { path, content: 'events {}\nhttp {\n  server { listen 80; }\n}\n', baseHash: null }).catch(() => {});
  await page.goto(`/#/edit/${id}?p=${encodeURIComponent(path)}`);
  await page.getByTestId('editor-menu').click();
  await page.getByTestId('nginx-test').click();
  const dialog = page.getByRole('dialog', { name: 'nginx -t' });
  // burrowtest-web has no nginx: the answer says so, as nginx -t would fail.
  await dialog.getByRole('button', { name: 'burrowtest-web' }).click();
  await expect(dialog.getByTestId('nginx-output')).toBeVisible({ timeout: 20_000 });
});

test('two quick changes to the update window are saved in the order they were made', async ({ page }) => {
  await page.goto('/#/settings/updates');
  const auto = page.getByTestId('updates-auto');
  await expect(auto).toBeVisible();
  const was = await auto.isChecked();
  // The first save held up on its way: the second must not overtake it.
  let first = true;
  await page.route('**/api/docker/updates/settings', async (r) => {
    if (r.request().method() === 'PUT' && first) {
      first = false;
      await new Promise((w) => setTimeout(w, 1500));
    }
    await r.continue();
  });
  await auto.setChecked(!was);
  await auto.setChecked(was);
  await expect.poll(async () => (await api<{ settings: { autoUpdate: boolean } }>(page, 'GET', '/api/docker/updates')).settings.autoUpdate, { timeout: 10_000 }).toBe(was);
  await page.waitForTimeout(2000);
  expect((await api<{ settings: { autoUpdate: boolean } }>(page, 'GET', '/api/docker/updates')).settings.autoUpdate).toBe(was);
  await page.unroute('**/api/docker/updates/settings');
});

test('the update window and automatic updates are saved as they change', async ({ page }) => {
  await page.goto('/#/settings/updates');
  const auto = page.getByTestId('updates-auto');
  const was = await auto.isChecked();
  await auto.setChecked(!was);
  await expect(page.getByText('Saved.').first()).toBeVisible();
  await page.getByTestId('window-start').fill('04:15');
  await page.getByTestId('window-start').blur();
  await expect.poll(async () => (await api<{ settings: { windowStart: string } }>(page, 'GET', '/api/docker/updates')).settings.windowStart).toBe('04:15');
  await page.reload();
  await expect(page.getByTestId('window-start')).toHaveValue('04:15');
  expect(await page.getByTestId('updates-auto').isChecked()).toBe(!was);
  await page.getByTestId('updates-auto').setChecked(was);
  await expect.poll(async () => (await api<{ settings: { autoUpdate: boolean } }>(page, 'GET', '/api/docker/updates')).settings.autoUpdate).toBe(was);
  // How far by itself: fixes only, kept; then every version again.
  await page.getByTestId('updates-auto').setChecked(true);
  // Its caption names it (AUDIT2 UI-28: the help tip's button inside the label took it).
  await expect(page.getByLabel(/^Automatically up to/)).toHaveAttribute('data-testid', 'updates-level');
  await page.getByTestId('updates-level').selectOption('patch');
  await expect.poll(async () => (await api<{ settings: { autoLevel: string } }>(page, 'GET', '/api/docker/updates')).settings.autoLevel).toBe('patch');
  await page.reload();
  await expect(page.getByTestId('updates-level')).toHaveValue('patch');
  await lookAt(page, 'update-window-level');
  await page.getByTestId('updates-level').selectOption('major');
  await expect.poll(async () => (await api<{ settings: { autoLevel: string } }>(page, 'GET', '/api/docker/updates')).settings.autoLevel).toBe('major');
  await page.getByTestId('updates-auto').setChecked(was);
  await expect.poll(async () => (await api<{ settings: { autoUpdate: boolean } }>(page, 'GET', '/api/docker/updates')).settings.autoUpdate).toBe(was);

  // Weekly on a day, then by cron (its own time; no start field), then daily again.
  type S = { settings: { kind: string; day: number; cron: string | null }; nextWindowAt: string | null };
  await page.getByTestId('window-kind').selectOption('weekly');
  await page.getByTestId('window-day').selectOption('3');
  await expect.poll(async () => (await api<S>(page, 'GET', '/api/docker/updates')).settings).toMatchObject({ kind: 'weekly', day: 3 });
  await page.getByTestId('window-kind').selectOption('cron');
  await expect(page.getByTestId('window-start')).toHaveCount(0);
  await page.getByTestId('window-cron').fill('30 5 * * 1-5');
  await page.getByTestId('window-cron').blur();
  await expect.poll(async () => (await api<S>(page, 'GET', '/api/docker/updates')).settings).toMatchObject({ kind: 'cron', cron: '30 5 * * 1-5' });
  await expect(page.getByText(/^Next window: /)).toBeVisible();
  await lookAt(page, 'update-window-cron');
  await page.getByTestId('window-kind').selectOption('daily');
  await expect.poll(async () => (await api<S>(page, 'GET', '/api/docker/updates')).settings.kind).toBe('daily');
});

test('an app no longer watched', async ({ page }) => {
  await api(page, 'POST', '/api/apps', { name: 'Watch toggle', url: `${process.env.APPS_BASE ?? 'http://localhost:8191'}/app-ok?watch=1`, monitor: true });
  await page.goto('/#/apps');
  const tile = page.locator('.tile-wrap', { hasText: 'Watch toggle' });
  await expect(tile.getByTestId('app-state')).toBeVisible();
  // Managing is a list: each app a row with its buttons.
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByTestId('apps-manage').locator('.list-item', { hasText: 'Watch toggle' }).getByRole('button', { name: 'Edit' }).click();
  // Framed or not, looked at again from its dialog.
  await page.getByTestId('app-recheck').click();
  await page.getByTestId('app-monitor').uncheck();
  await page.locator('dialog[open]').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(tile).toBeVisible();
  await expect(tile.getByTestId('app-state')).toHaveCount(0);
  const app = (await api<{ id: number; name: string; monitor: boolean }[]>(page, 'GET', '/api/apps')).find((a) => a.name === 'Watch toggle')!;
  expect(app.monitor).toBe(false);
  await api(page, 'DELETE', `/api/apps/${app.id}`);
});

test('an invite accepted with a user name', async ({ page, browser }) => {
  const { url } = await api<{ url: string }>(page, 'POST', '/api/invites', { role: 'operator' });
  const other = await browser.newContext();
  const p = await other.newPage();
  await addAuthenticator(p);
  await p.goto(url.replace(/^https?:\/\/[^/]+/, ''));
  await p.getByTestId('invite-username').fill('invited-by-name');
  await p.getByTestId('invite-accept').click();
  // Signed in, on to choosing a way to sign in next time.
  await expect(p).not.toHaveURL(/#\/invite\//);
  await other.close();
  const users = await api<{ id: number; username: string; role: string }[]>(page, 'GET', '/api/users');
  const made = users.find((u) => u.username === 'invited-by-name');
  expect(made?.role).toBe('operator');
  await api(page, 'DELETE', `/api/users/${made!.id}`);
});

test('two containers picked, their logs together', async ({ page }) => {
  await page.goto('/#/containers');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByTestId('container-row').filter({ hasText: 'burrowtest-web' }).first().click();
  await page.getByTestId('container-row').filter({ hasText: 'burrowtest-worker' }).first().click();
  await page.getByTestId('picked-logs').click();
  await expect(page).toHaveURL(/#\/logs\?t=.*burrowtest-web.*burrowtest-worker|#\/logs\?t=.*burrowtest-worker.*burrowtest-web/);
  await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 20_000 });
});

test('every container the filters show, picked at once; their logs through one channel', async ({ page }) => {
  await page.goto('/#/containers');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('searchbox').fill('burrowtest-');
  await page.getByTestId('containers-filter').selectOption('state:running');
  await expect(page.getByTestId('container-row').filter({ hasText: 'burrowtest-worker' })).toHaveCount(0);
  const n = await page.getByTestId('container-row').count();
  expect(n).toBeGreaterThan(1);
  await page.getByTestId('pick-shown').click();
  await expect(page.getByTestId('picked-logs')).toHaveText(`Logs of ${n}`);
  // Again: none of them.
  await page.getByTestId('pick-shown').click();
  await expect(page.getByTestId('picked-logs')).toHaveCount(0);
  await page.getByTestId('pick-shown').click();
  await page.getByTestId('picked-logs').click();
  // Lines of more than one of them arrive (each line is marked with whose it is).
  await expect.poll(async () => new Set(await page.getByTestId('log-line').evaluateAll((els) => els.map((e) => e.getAttribute('data-src')))).size, { timeout: 20_000 }).toBeGreaterThan(1);
});

test("in select mode, a stack's own All and None (report 335a38)", async ({ page }) => {
  await page.goto('/#/containers');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const stack = page.getByTestId('stack').filter({ has: page.getByTestId('container-row').filter({ hasText: 'burrowtest-db' }) }).first();
  await expect(stack.getByTestId('container-row').first()).toBeVisible({ timeout: 30_000 });
  const n = await stack.getByTestId('container-row').count();
  expect(n).toBeGreaterThan(1);
  await stack.getByTestId('pick-stack').click();
  await expect(page.getByTestId('picked-logs')).toHaveText(`Logs of ${n}`);
  await expect(stack.getByTestId('pick-stack')).toHaveText('None');
  await stack.getByTestId('pick-stack').click();
  await expect(page.getByTestId('picked-logs')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('the rail lists the hosts whichever page is opened first: About, not only after Hosts (UIB-05)', async ({ page }) => {
  await page.goto('/#/settings/about');
  await page.reload();
  await expect(page.getByTestId('about')).toBeVisible();
  await expect(page.getByTestId('rail-host').first()).toBeVisible();
});

test('the rail lists the hosts; one opens its menu (a wide screen only)', async ({ page }) => {
  await page.goto('/#/containers');
  const hosts = page.getByTestId('rail-host');
  await expect(hosts.first()).toBeVisible();
  const name = (await hosts.first().innerText()).trim();
  await hosts.first().click();
  const sheet = page.getByRole('dialog', { name });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  // On a phone the bar below has no room for it.
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(hosts.first()).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('adding a host: the button in the title bar, on a wide screen and on a phone (no round one over the list, decision 25)', async ({ page }) => {
  await page.goto('/#/hosts');
  await page.getByTestId('hosts-add-top').click();
  await expect(page).toHaveURL(/#\/hosts\/new$/);
  await page.goto('/#/hosts');
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.locator('.fab')).toHaveCount(0);
  await page.locator('.topbar').getByRole('button', { name: 'Add host' }).click();
  await expect(page).toHaveURL(/#\/hosts\/new$/);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('a stack: a setting changed while a refresh is on its way is not undone by it', async ({ page }) => {
  const id = await dockerHost(page);
  const base = `/api/docker/${id}/stacks/burrowtest`;
  await api(page, 'PUT', `${base}/settings`, { autoUpdate: false });
  await page.goto(`/#/stacks/${id}/burrowtest`);
  const auto = page.getByTestId('auto-update');
  await expect(auto).toBeEnabled({ timeout: 30_000 });
  await expect(auto).not.toBeChecked();
  // The page reads the stack again every ten seconds; that read is slow (a
  // busy host) and says what was true when it was asked: off.
  await page.route(new RegExp(`${base}$`), async (r) => {
    if (r.request().method() !== 'GET') return r.continue();
    const asked = { ...((await (await r.fetch()).json()) as object), autoUpdate: false };
    await new Promise((w) => setTimeout(w, 3000));
    await r.fulfill({ json: asked }).catch(() => {});
  });
  await page.waitForRequest((r) => r.method() === 'GET' && new RegExp(`${base}$`).test(r.url()), { timeout: 15_000 });
  // Switched on while that read is out, and saved.
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/settings'));
  await auto.check();
  expect((await saved).ok()).toBe(true);
  // The slow read lands afterwards: the switch stays on (it flipped back off).
  await page.waitForTimeout(3500);
  await expect(auto).toBeChecked();
  await page.unroute(new RegExp(`${base}$`));
  await api(page, 'PUT', `${base}/settings`, { autoUpdate: false });
});

test('several containers at once: stopped, started, restarted; Burrow itself never stopped; one failing does not stop the rest', async ({ page }) => {
  test.setTimeout(180_000);
  const id = await dockerHost(page);
  const sh = async (command: string) => {
    const [res] = await api<{ exitCode: number; stdout: string; stderr: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [id], command });
    expect(res!.exitCode, `${command}: ${res!.stderr}`).toBe(0);
    return res!.stdout.trim();
  };
  const ALPINE = 'alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f';
  const names = ['burrowtest-bulk-a', 'burrowtest-bulk-b', 'burrowtest-bulk-c'];
  await sh(`docker rm -fv ${names.join(' ')} >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name ${names[0]} ${ALPINE} sleep 3600 >/dev/null && docker run -d --label burrow.ignore=true --name ${names[1]} ${ALPINE} sleep 3600 >/dev/null && docker create --label burrow.ignore=true --name ${names[2]} ${ALPINE} sleep 3600 >/dev/null`);
  const state = async (n: string) => sh(`docker inspect --format '{{.State.Status}}' ${n}`);
  const alertsBefore = (await api<{ container: string }[]>(page, 'GET', '/api/alerts')).filter((a) => a.container.startsWith('burrowtest-bulk')).length;

  await page.goto('/#/containers');
  await page.getByRole('searchbox').fill('burrowtest-bulk');
  const rows = page.getByTestId('container-row');
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const n of names) await rows.filter({ hasText: n }).click();
  const dialog = page.getByRole('dialog');
  // The bar on a small phone too (Dutch: the longest words).
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByTestId('bulk-restart')).toBeHidden();
  await lookAt(page, 'bulk-bar-phone');
  // There the actions are in a menu of their own.
  await page.getByTestId('bulk-more').click();
  await expect(dialog.getByTestId('bulk-stop')).toBeVisible();
  await lookAt(page, 'bulk-menu');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId('bulk-more')).toBeHidden();

  // The hosts could not be read again first: said, and nothing done on what was seen before (AUDIT2 WEB-08).
  await page.route(/\/api\/docker\/\d+\/containers$/, (r) => r.fulfill({ status: 500, json: { error: 'internal', message: 'not read' } }));
  await page.getByTestId('bulk-stop').click();
  await expect(dialog.getByTestId('bulk-unread')).toBeVisible();
  await expect(dialog.getByTestId('bulk-go')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.unroute(/\/api\/docker\/\d+\/containers$/);

  // Stop: the two that run; the third is left alone, and says why.
  await page.getByTestId('bulk-stop').click();
  await expect(dialog.getByTestId('bulk-act')).toContainText(names[0]!);
  await expect(dialog.getByTestId('bulk-skip')).toContainText(`${names[2]}not running`);
  await lookAt(page, 'bulk-confirm');
  await dialog.getByTestId('bulk-go').click();
  await expect(dialog.getByTestId('bulk-done')).toHaveText('2 done, 0 failed', { timeout: 60_000 });
  // Still what was asked, also now they stopped (not "nothing to do").
  await expect(dialog.getByRole('heading')).toHaveText('Stop 2 containers');
  await expect(dialog.getByTestId('bulk-state')).toHaveText(['done', 'done']);
  await expect(dialog.getByTestId('bulk-skip').locator('li')).toHaveCount(1);
  await lookAt(page, 'bulk-done');
  expect([await state(names[0]!), await state(names[1]!), await state(names[2]!)]).toEqual(['exited', 'exited', 'created']);
  await dialog.getByTestId('bulk-close').click();

  // Start: all three, right after. The list may still show the two as
  // running (a snapshot behind): the dialog reads it again first, and Go
  // waits for that (here held up on purpose).
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/docker/${id}/containers`, async (r) => {
    await held;
    await r.continue();
  });
  await page.getByTestId('bulk-start').click();
  await expect(dialog.getByTestId('bulk-go')).toBeDisabled();
  // Why it waits, said (report c2bff2: the button only came to life after a tap somewhere).
  await expect(dialog.getByTestId('bulk-reading')).toBeVisible();
  release();
  await expect(dialog.getByTestId('bulk-go')).toBeEnabled();
  await expect(dialog.getByTestId('bulk-reading')).toHaveCount(0);
  await page.unroute(`**/api/docker/${id}/containers`);
  await expect(dialog.getByTestId('bulk-act').locator('li')).toHaveCount(3);
  await dialog.getByTestId('bulk-go').click();
  await expect(dialog.getByTestId('bulk-done')).toHaveText('3 done, 0 failed', { timeout: 60_000 });
  for (const n of names) expect(await state(n)).toBe('running');
  await dialog.getByTestId('bulk-close').click();

  // Restart, with one answered by an error on the way: the others go on.
  const started = await sh(`docker inspect --format '{{.State.StartedAt}}' ${names[0]}`);
  await page.route(`**/containers/${names[1]}/action`, (r) => r.fulfill({ status: 502, json: { error: 'docker_error', message: 'stand-in failure' } }));
  await page.getByTestId('bulk-restart').click();
  await dialog.getByTestId('bulk-go').click();
  await expect(dialog.getByTestId('bulk-done')).toHaveText('2 done, 1 failed', { timeout: 60_000 });
  await expect(dialog).toContainText('stand-in failure');
  expect(await sh(`docker inspect --format '{{.State.StartedAt}}' ${names[0]}`)).not.toBe(started);
  await page.unroute(`**/containers/${names[1]}/action`);
  await dialog.getByTestId('bulk-close').click();

  // Closed while it runs (Esc), then opened again: what the first run still
  // answers does not show up as the progress of the second.
  let answer = () => {};
  const answered = new Promise<void>((r) => (answer = r));
  let asked = 0;
  const sent: string[] = [];
  await page.route('**/containers/*/action', async (r) => {
    asked++;
    sent.push((r.request().postDataJSON() as { action: string }).action);
    await answered;
    await r.fulfill({ json: { ok: true } });
  });
  await page.getByTestId('bulk-restart').click();
  await dialog.getByTestId('bulk-go').click();
  await expect.poll(() => asked).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Opened again for another action: the run under way stays a restart
  // (it read the dialog's action at each request, and went on with "stop").
  await page.getByTestId('bulk-stop').click();
  await expect(dialog.getByTestId('bulk-go')).toBeEnabled();
  answer();
  await expect.poll(() => asked).toBe(3);
  expect(sent).toEqual(['restart', 'restart', 'restart']);
  await page.waitForTimeout(500);
  await expect(dialog.getByTestId('bulk-state')).toHaveCount(0);
  await expect(dialog.getByTestId('bulk-go')).toBeVisible();
  await page.unroute('**/containers/*/action');
  await page.keyboard.press('Escape');
  // Stopped on purpose: no alert for it.
  expect((await api<{ container: string }[]>(page, 'GET', '/api/alerts')).filter((a) => a.container.startsWith('burrowtest-bulk')).length).toBe(alertsBefore);

  // Burrow's own container (this test's Burrow runs on the same Docker): never stopped.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('searchbox').fill('burrow-e2e-app');
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await rows.first().click();
  await page.getByTestId('bulk-stop').click();
  await expect(dialog.getByTestId('bulk-skip')).toContainText('Burrow itself: restarted if asked, never stopped');
  await expect(dialog.getByTestId('bulk-go')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await sh(`docker rm -fv ${names.join(' ')} >/dev/null`);
});

test("a host's images, volumes and networks; cleaning up shows what goes, volumes only when ticked", async ({ page }) => {
  // The test sshd's stand-in docker (never this machine's own), afresh.
  const sshd = (await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts')).find((h) => h.name === 'test-sshd')!;
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd.id], command: 'rm -rf /tmp/fakedocker' });
  await page.goto('/#/hosts');
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByTestId('host-docker').click();
  await expect(page).toHaveURL(new RegExp(`#/hosts/${sshd.id}/docker$`));
  const rows = page.getByTestId('res-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('postgres:17');
  await expect(rows.first()).toContainText('used by burrowtest-db');
  await expect(page.getByTestId('res-summary')).toContainText('Unused: 2 images');
  // Which kind: a dropdown (reported: three counts side by side did not fit a phone).
  await page.getByTestId('res-view').selectOption('volumes');
  await expect(rows).toHaveCount(2);
  await page.getByTestId('res-view').selectOption('networks');
  await expect(rows.filter({ hasText: "Docker's own" })).toHaveCount(3);
  await page.getByTestId('res-view').selectOption('images');
  // Clean up: the unused images and network ticked, the volume not.
  await page.getByTestId('res-prune').click();
  const dialog = page.getByRole('dialog', { name: 'Clean up' });
  await expect(dialog.getByTestId('prune-image')).toHaveCount(2);
  for (const b of await dialog.getByTestId('prune-image').all()) await expect(b).toBeChecked();
  await expect(dialog.getByTestId('prune-network')).toBeChecked();
  await expect(dialog.getByTestId('prune-volume')).not.toBeChecked();
  await lookAt(page, 'desktop-resources-prune');
  // All or none of a kind at a press (reported: a long list ticked one by one).
  const kind = (k: string) => dialog.locator(`[data-kind=${k}]`);
  await kind('images').getByTestId('prune-none').click();
  for (const b of await dialog.getByTestId('prune-image').all()) await expect(b).not.toBeChecked();
  await expect(dialog.getByTestId('prune-go')).toHaveText('Remove 1');
  await kind('images').getByTestId('prune-all').click();
  for (const b of await dialog.getByTestId('prune-image').all()) await expect(b).toBeChecked();
  await expect(kind('images').getByTestId('prune-all')).toBeDisabled();
  // One by one too: the network off and on again.
  await dialog.getByTestId('prune-network').uncheck();
  await expect(dialog.getByTestId('prune-go')).toHaveText('Remove 2');
  await dialog.getByTestId('prune-network').check();
  // Cancelled: nothing removed, asked afresh the next time.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(4);
  await page.getByTestId('res-prune').click();
  // One image kept after all; the volume this time too (all of that kind, then ticked by hand).
  await dialog.getByTestId('prune-image').first().uncheck();
  await kind('volumes').getByTestId('prune-all').click();
  await expect(dialog.getByTestId('prune-volume')).toBeChecked();
  await dialog.getByTestId('prune-volume').uncheck();
  await dialog.getByTestId('prune-volume').check();
  await dialog.getByTestId('prune-go').click();
  await expect(page.getByText('3 removed')).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('res-summary')).toContainText('Unused: 1 image');
  await page.getByTestId('res-view').selectOption('volumes');
  await expect(rows).toHaveCount(1);
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd.id], command: 'rm -rf /tmp/fakedocker' });
});

test.describe('in a browser in Amsterdam', () => {
  test.use({ timezoneId: 'Europe/Amsterdam' });
  test('a maintenance window saved in UTC stays in UTC when something else is changed', async ({ page }) => {
    // Audit WC-09: opening the settings took the browser's zone for UTC, and the next save kept that.
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Europe/Amsterdam');
    const cur = (await api<{ settings: Record<string, unknown> }>(page, 'GET', '/api/docker/updates')).settings;
    await api(page, 'PUT', '/api/docker/updates/settings', { ...cur, timeZone: 'UTC' });
    await page.goto('/#/settings/updates');
    const auto = page.getByTestId('updates-auto');
    const was = await auto.isChecked();
    await auto.setChecked(!was);
    await expect(page.getByText('Saved.').first()).toBeVisible();
    expect((await api<{ settings: { timeZone: string } }>(page, 'GET', '/api/docker/updates')).settings.timeZone).toBe('UTC');
    await auto.setChecked(was);
    await expect.poll(async () => (await api<{ settings: { autoUpdate: boolean } }>(page, 'GET', '/api/docker/updates')).settings.autoUpdate).toBe(was);
  });
});

test('Logs with nothing chosen: says where to choose, and leads there (UIB-10)', async ({ page }) => {
  await page.goto('/#/logs');
  await expect(page.getByTestId('logs-none')).toContainText('Choose them under Containers');
  await page.getByTestId('logs-to-containers').click();
  await expect(page).toHaveURL(/#\/containers$/);
});

test('a menu opens beside the button it came from on a computer, as a sheet at the foot on a phone (decision 28)', async ({ page }) => {
  await page.goto('/#/hosts');
  const button = page.getByRole('button', { name: 'Menu for test-sshd', exact: true }).first();
  await button.click();
  const sheet = page.locator('dialog[open][data-tour=host-sheet]');
  await expect(sheet).toBeVisible();
  const [b, d] = [(await button.boundingBox())!, (await sheet.boundingBox())!];
  // Under the button (or over it when there is no room), at its side, small; not a dialog in the middle.
  expect(d.width).toBeLessThanOrEqual(360);
  // Next to it: under it, over it, or (a tall menu) beside it from the top of the screen down.
  expect(d.y <= b.y + b.height + 16 && d.y + d.height >= b.y - 16).toBe(true);
  expect(Math.abs(d.x + d.width - (b.x + b.width)) < 16 || Math.abs(d.x - b.x) < 16).toBe(true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 412, height: 915 });
  await button.click();
  await expect(sheet).toBeVisible();
  const p = (await sheet.boundingBox())!;
  expect(Math.round(p.y + p.height)).toBeGreaterThanOrEqual(914);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("a host's own health alert is muted as the host's, not as a container (W-FUNC-12)", async ({ page }) => {
  const hosts = await page.evaluate(async () => (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]);
  const sshd = hosts.find((h) => h.name === 'test-sshd')!;
  await page.route(/\/api\/alerts$/, (r) =>
    r.request().method() !== 'GET'
      ? r.fallback()
      : r.fulfill({ json: [{ id: 9201, ruleId: null, ruleName: 'Host health', hostId: sshd.id, hostName: 'test-sshd', container: '@temperature', title: 'CPU at 89 C', detail: '', at: new Date().toISOString(), count: 1, read: false, pushed: 'yes' }] }),
  );
  await page.goto('/#/alerts');
  await page.reload();
  // In the row's menu: the host's health, not "this container"; no analysis of a host's health.
  await page.getByTestId('alert-menu').click();
  const menu = page.locator('dialog[open][data-tour=alert-menu]');
  await expect(menu.getByTestId('alert-mute')).toHaveText("Mute this host's health alerts");
  await expect(menu.getByTestId('alert-analyze')).toHaveCount(0);
  // Pressed: the mute's choices for the host's health, then left without muting.
  await menu.getByTestId('alert-mute').click();
  const dialog = page.locator('dialog[open][data-tour=alert-mute]');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.unroute(/\/api\/alerts$/);
});
