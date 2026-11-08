import { expect, test } from './fixtures.js';
import { fillSettled, signIn } from './passkey.js';
import { lookAt } from './checks.js';
import { sayYes } from './confirm.js';
import type { AppTab } from '@burrow/shared';

// Phase 4 in a browser: app tabs (framed when the app allows it, else a new
// tab), finding apps in container labels, and a pairing code for the phone.

const APPS_BASE = process.env.APPS_BASE ?? 'http://localhost:8191';

test('app tabs open framed or in a new tab; discovery; pairing code', async ({ page, context }) => {
  await signIn(page);
  // Apps share a place with Containers in the bottom bar.
  await page.getByRole('link', { name: 'Containers' }).click();
  await page.getByRole('tab', { name: 'Apps' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();

  // No apps yet: the ways to get some right there (the first one added
  // from it), the next from Manage.
  await expect(page.getByText('No apps yet.')).toBeVisible();
  await lookAt(page, 'desktop-apps-empty');
  for (const [name, path] of [
    ['Framed app', '/app-ok'],
    ['Own tab app', '/app-deny'],
  ] as const) {
    if (name === 'Own tab app') await page.getByRole('button', { name: 'Manage' }).click();
    await page.getByRole('button', { name: 'Add app' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add app' });
    await fillSettled(dialog.getByLabel('Name'), name);
    await fillSettled(dialog.getByLabel('Address'), APPS_BASE + path);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(page.getByText('Opens here')).toBeVisible();
  await expect(page.getByText('Opens in a new tab')).toBeVisible();

  // Order: dragged by the grip (a mouse here, a finger works the same), by
  // the arrow keys on it, and A-Z in one go.
  const names = () => page.getByTestId('app-row').locator('.title').allTextContents();
  const order0 = await names();
  const grip = page.getByTestId('app-row').filter({ hasText: 'Own tab app' }).getByTestId('app-grip');
  const target = (await page.getByTestId('app-row').filter({ hasText: 'Framed app' }).boundingBox())!;
  const from = (await grip.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + 4, { steps: 8 });
  await page.mouse.up();
  // Compared anew on every poll (the order changes under it).
  const ownFirst = async () => ((n) => n.indexOf('Own tab app') < n.indexOf('Framed app'))(await names());
  await expect.poll(ownFirst).toBe(true);
  await grip.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(ownFirst).toBe(false);
  await page.getByTestId('apps-sort-az').click();
  await page.getByTestId('confirm-ok').click();
  await expect.poll(names).toEqual([...order0].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));

  // Labels on the test sshd's (fake) containers.
  await page.getByRole('button', { name: 'Find in containers' }).click();
  const found = page.getByRole('dialog', { name: 'Find in containers' });
  // This machine's real Docker may be a host too, with its own apps: look at the test host's.
  const fake = found.locator('.list-item', { hasText: 'test-sshd' });
  // Several Docker hosts: one at a time.
  if (await found.getByTestId('discover-host').count()) {
    await found.getByTestId('discover-host').selectOption({ label: 'test-sshd' });
    await expect(found.locator('.list-item').filter({ hasNotText: 'test-sshd' })).toHaveCount(0);
  }
  await expect(fake.getByText('Radarr', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(fake.getByText('Sonarr', { exact: true })).toBeVisible();
  // The Close at the bottom (the dialog's title bar has one too).
  await found.locator('footer').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  // Frameable: inside Burrow, under a bar with a way back. Also after leaving Apps and coming
  // back: the page's frame rules from before the app was added still need a reload (AUDIT2 PAGE-18).
  await page.getByRole('link', { name: 'Hosts' }).first().click();
  await page.getByRole('heading', { name: 'Hosts' }).waitFor();
  await page.goto('/#/apps');
  await page.getByRole('button', { name: 'Framed app' }).click();
  await expect(page.frameLocator('iframe[title="Framed app"]').locator('#app')).toHaveText('app-ok');
  await page.getByRole('button', { name: 'Back' }).click();

  // Not frameable, at its own address (a bookmark, or changed since the list): a link to its own
  // tab, pressed by the person, not a popup the browser may block (AUDIT2 PAGE-19).
  const ownApp = (await page.evaluate(async () => (await fetch('/api/apps')).json() as Promise<{ id: number; name: string; url: string }[]>)).find((a) => a.name === 'Own tab app')!;
  await page.goto(`/#/apps/${ownApp.id}`);
  await expect(page.getByTestId('app-not-framed')).toContainText('Own tab app cannot be shown inside Burrow');
  await expect(page.getByTestId('app-not-framed').getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute('href', ownApp.url);
  await page.goto('/#/apps');

  // Not frameable: a new browser tab.
  // Said on its tile, with the reason (report c2fde7); the framed one has no mark.
  const tileOf = (name: string) => page.getByTestId('app-tile').filter({ hasText: name });
  await expect(tileOf('Own tab app').getByTestId('app-new-tab')).toHaveAttribute('title', 'Opens in a tab of its own: this app does not allow being shown inside another site');
  await expect(tileOf('Framed app').getByTestId('app-new-tab')).toHaveCount(0);
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Own tab app' }).click();
  await expect(await popup).toHaveURL(`${APPS_BASE}/app-deny`);
  // Always in a tab of its own, chosen for an app that may be framed: then it opens so.
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByTestId('app-row').filter({ hasText: 'Framed app' }).getByTestId('app-edit').click();
  const form = page.getByRole('dialog', { name: 'Framed app' });
  await form.getByTestId('app-new-tab-always').check();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(tileOf('Framed app').getByTestId('app-new-tab')).toHaveAttribute('title', 'Opens in a tab of its own (as set for this app)');
  const own = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Framed app' }).click();
  await expect(await own).toHaveURL(`${APPS_BASE}/app-ok`);
  // Back as it was, for the specs after this one.
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByTestId('app-row').filter({ hasText: 'Framed app' }).getByTestId('app-edit').click();
  await form.getByTestId('app-new-tab-always').uncheck();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: 'Done' }).click();

  // Settings: a pairing code for the Android app.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByTestId('settings-section').filter({ hasText: 'Android app' }).click();
  await page.getByRole('button', { name: 'Show a pairing code' }).click();
  await expect(page.getByTestId('pair-code')).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('apps found by name or address, in the order chosen (kept on this device); no dragging while searching', async ({ page }) => {
  await signIn(page);
  const app = (o: Partial<AppTab> & { id: number; name: string; url: string }): AppTab => ({ group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, newTab: false, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null, ...o });
  // Three apps as Burrow lists them, in the order set in Manage.
  const list = [
    app({ id: 9001, name: 'Zebra wiki', url: 'https://wiki.example.lan' }),
    app({ id: 9002, name: 'Media', url: 'https://jellyfin.example.lan', up: false, downSince: new Date().toISOString(), uptime: 0.5 }),
    app({ id: 9003, name: 'Accounts', url: 'https://books.example.lan' }),
  ];
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: list }) : r.fallback()));
  await page.goto('/#/apps');
  const names = () => page.getByTestId('app-tile').locator('.name').allTextContents();
  await expect.poll(names).toEqual(['Zebra wiki', 'Media', 'Accounts']);
  // By name, then the ones that are down first.
  await page.getByTestId('apps-sort').selectOption('name');
  await expect.poll(names).toEqual(['Accounts', 'Media', 'Zebra wiki']);
  await page.getByTestId('apps-sort').selectOption('down');
  await expect.poll(names).toEqual(['Media', 'Zebra wiki', 'Accounts']);
  // Kept on this device.
  await page.reload();
  await expect(page.getByTestId('apps-sort')).toHaveValue('down');
  // Found by a word of the address too; nothing found says so.
  await page.getByTestId('apps-search').fill('jellyfin');
  await expect.poll(names).toEqual(['Media']);
  await page.getByTestId('apps-search').fill('nothing like it');
  await expect(page.getByTestId('apps-none-found')).toContainText('No app matches "nothing like it"');
  await lookAt(page, 'desktop-apps-none-found');
  await page.getByTestId('apps-search').fill('');
  await page.getByTestId('apps-sort').selectOption('own');
  // In Manage the search narrows the list; the order cannot be dragged meanwhile.
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByTestId('apps-search').fill('wiki');
  await expect(page.getByTestId('app-row')).toHaveCount(1);
  await expect(page.getByTestId('app-grip')).toBeDisabled();
  await page.getByTestId('apps-search').fill('');
  await expect(page.getByTestId('app-row')).toHaveCount(3);
  await expect(page.getByTestId('app-grip').first()).toBeEnabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.unroute('**/api/apps');
});

test('in my own order the groups follow it too, not the alphabet; Change the order opens Manage', async ({ page }) => {
  await signIn(page);
  const app = (o: Partial<AppTab> & { id: number; name: string; url: string }): AppTab => ({ group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, newTab: false, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null, ...o });
  // Ordered in Manage: the media stack first, then the tools (the names say otherwise).
  const list = [
    app({ id: 9101, name: 'Jellyfin', url: 'https://jellyfin.example.lan', group: 'Media' }),
    app({ id: 9102, name: 'Audiobookshelf', url: 'https://abs.example.lan', group: 'Media' }),
    app({ id: 9103, name: 'Gitea', url: 'https://git.example.lan', group: 'Code' }),
  ];
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: list }) : r.fallback()));
  await page.goto('/#/apps');
  await page.getByTestId('apps-sort').selectOption('own');
  const heads = () => page.getByRole('heading', { level: 2 }).allTextContents();
  const names = () => page.getByTestId('app-tile').locator('.name').allTextContents();
  await expect.poll(heads).toEqual(['Media', 'Code']);
  await expect.poll(names).toEqual(['Jellyfin', 'Audiobookshelf', 'Gitea']);
  // By name: the groups by name too.
  await page.getByTestId('apps-sort').selectOption('name');
  await expect.poll(heads).toEqual(['Code', 'Media']);
  await expect.poll(names).toEqual(['Gitea', 'Audiobookshelf', 'Jellyfin']);
  // In my own order, the way to change it is right there.
  await page.getByTestId('apps-sort').selectOption('adjust');
  await expect(page.getByTestId('apps-manage')).toBeVisible();
  await expect(page.getByTestId('app-grip').first()).toBeEnabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Back in one's own order, not left on "Change the order".
  await expect(page.getByTestId('apps-sort')).toHaveValue('own');
  await page.unroute('**/api/apps');
});

test('an app whose certificate runs out soon says so, on its tile and in the list', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/apps', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const list = (await res.json()) as AppTab[];
    if (list[0]) list[0].certExpiresAt = new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString();
    if (list[1]) list[1].certExpiresAt = new Date(Date.now() - 86_400_000).toISOString();
    await r.fulfill({ response: res, json: list });
  });
  await page.goto('/#/apps');
  const certs = page.getByTestId('app-cert');
  await expect(certs.first()).toHaveText('Certificate: 5 days left');
  await expect(certs.nth(1)).toHaveText('Certificate expired');
  await lookAt(page, 'desktop-apps-cert');
  await page.getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByTestId('app-row').first()).toContainText('Certificate: 5 days left');
});

test('app tiles are all as high as each other when a name takes two lines', async ({ page }) => {
  // Reported (00ec50): "Sparkyfitness Frontend" over two lines made its row taller than the others.
  await signIn(page);
  await page.setViewportSize({ width: 343, height: 711 });
  const app = (id: number, name: string): AppTab => ({ id, name, url: `https://${id}.example.lan`, group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, newTab: false, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null });
  const list = [app(9101, 'Sonarr'), app(9102, 'Sparkyfitness Frontend'), app(9103, 'Spottarr'), app(9104, 'Technitium'), app(9105, 'Termix'), app(9106, 'Uptime Kuma')];
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: list }) : r.fallback()));
  await page.goto('/#/apps');
  await expect(page.getByTestId('app-tile')).toHaveCount(6);
  const boxes = await page.getByTestId('app-tile').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(1);
  // The states on one line across a row (the tiles of a row start at the same height).
  const rows = await page.getByTestId('app-tile').evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().top), Math.round(e.querySelector('[data-testid=app-state]')!.getBoundingClientRect().top)]));
  for (const [top, state] of rows) for (const [top2, state2] of rows) if (top === top2) expect(state2).toBe(state);
  await lookAt(page, 'phone-apps-long-name');
  await page.unroute('**/api/apps');
});

test('several apps changed at once in Manage: picked, a group and "in a new tab" set for all, the rest kept; deleted together', async ({ page }) => {
  await signIn(page);
  const app = (o: Partial<AppTab> & { id: number; name: string; url: string }): AppTab => ({ group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, newTab: false, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null, ...o });
  let list = [
    app({ id: 9101, name: 'Alpha', url: 'https://alpha.example.lan', monitor: false }),
    app({ id: 9102, name: 'Beta', url: 'https://beta.example.lan', group: 'Old' }),
    app({ id: 9103, name: 'Gamma', url: 'https://gamma.example.lan' }),
  ];
  const puts: { id: number; body: Record<string, unknown> }[] = [];
  const dels: number[] = [];
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: list }) : r.fallback()));
  await page.route(/\/api\/apps\/91\d\d$/, async (r) => {
    const id = Number(r.request().url().split('/').pop());
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      puts.push({ id, body });
      list = list.map((a) => (a.id === id ? { ...a, ...body } as AppTab : a));
      return r.fulfill({ json: list.find((a) => a.id === id) });
    }
    if (r.request().method() === 'DELETE') {
      dels.push(id);
      list = list.filter((a) => a.id !== id);
      return r.fulfill({ status: 204, body: '' });
    }
    return r.fallback();
  });
  await page.goto('/#/apps');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const row = (name: string) => page.getByTestId('app-row').filter({ hasText: name });
  await row('Alpha').getByTestId('app-pick').check();
  await row('Beta').getByTestId('app-pick').check();
  const bar = page.getByTestId('apps-bulk-bar');
  await expect(bar).toContainText('2 apps picked');
  // All, and none again: one button that keeps its place, its word the other way round (report b2340c).
  const all = page.getByTestId('apps-pick-all');
  await expect(all).toHaveText('All');
  const at = await all.boundingBox();
  await all.click();
  await expect(bar).toContainText('3 apps picked');
  await expect(all).toHaveText('None');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(await all.boundingBox()).toEqual(at);
  await all.click();
  await expect(bar).toHaveCount(0);
  await expect(all).toHaveText('All');
  await row('Alpha').getByTestId('app-pick').check();
  await row('Beta').getByTestId('app-pick').check();
  await bar.getByTestId('apps-bulk-edit').click();
  const dialog = page.getByRole('dialog', { name: 'Change 2 apps' });
  await dialog.getByTestId('apps-bulk-set-group').check();
  await dialog.getByTestId('apps-bulk-group').fill('Media');
  await dialog.getByTestId('apps-bulk-newTab').selectOption('yes');
  await expect(dialog.getByTestId('apps-bulk-pinned')).toHaveValue('');
  await expect(dialog.getByTestId('apps-bulk-monitor')).toHaveValue('');
  await lookAt(page, 'desktop-apps-bulk');
  await dialog.getByTestId('apps-bulk-save').click();
  await expect(page.getByText('2 apps changed.')).toBeVisible();
  // Each got the group and the new tab; what was left "as it is" stayed its own.
  expect(puts.map((p) => [p.id, p.body.group, p.body.newTab, p.body.monitor, p.body.pinned])).toEqual([
    [9101, 'Media', true, false, true],
    [9102, 'Media', true, true, true],
  ]);
  await expect(bar).toHaveCount(0);
  // Cancel sends nothing; opened again, it starts from "as it is" (shown and watched off for one).
  await row('Gamma').getByTestId('app-pick').check();
  await bar.getByTestId('apps-bulk-edit').click();
  const one = page.getByRole('dialog', { name: 'Change 1 app' });
  await one.getByTestId('apps-bulk-pinned').selectOption('no');
  await one.getByRole('button', { name: 'Cancel' }).click();
  await expect(one).toBeHidden();
  expect(puts).toHaveLength(2);
  await bar.getByTestId('apps-bulk-edit').click();
  await expect(one.getByTestId('apps-bulk-pinned')).toHaveValue('');
  await one.getByTestId('apps-bulk-pinned').selectOption('no');
  await one.getByTestId('apps-bulk-monitor').selectOption('no');
  await one.getByTestId('apps-bulk-save').click();
  await expect(page.getByText('1 app changed.')).toBeVisible();
  expect([puts[2]!.id, puts[2]!.body.group, puts[2]!.body.newTab, puts[2]!.body.monitor, puts[2]!.body.pinned]).toEqual([9103, null, false, false, false]);
  await expect(bar).toHaveCount(0);
  // Deleted together, after a yes.
  await row('Alpha').getByTestId('app-pick').check();
  await row('Gamma').getByTestId('app-pick').check();
  await sayYes(page);
  await bar.getByTestId('apps-bulk-delete').click();
  await expect(page.getByTestId('app-row')).toHaveCount(1);
  expect(dels.sort()).toEqual([9101, 9103]);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.unroute('**/api/apps');
  await page.unroute(/\/api\/apps\/91\d\d$/);
});
