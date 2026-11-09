import { expect, test, type Page } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { addAuthenticator, fillSettled, hostNamed, saveCredential, signIn, type Authenticator } from './passkey.js';
import { openPush, vapidClaims } from './webpush.js';

// What the other tests make, changed and removed again through the screens:
// every edit and delete button is pressed once somewhere.

const api = <T,>(page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;

let auth: Authenticator;
test.beforeEach(async ({ page }) => {
  // A prompt (the new passkey's name) gets a name; the rest a yes.
  await sayYes(page, 'Second test key');
  auth = await signIn(page);
});

test('a host: copied, renamed, deleted', async ({ page }) => {
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page).toHaveURL(/#\/hosts\/\d+\/edit/);
  // "Inherit" says what it inherits (here Burrow's default for tmux).
  await expect(page.locator('select option', { hasText: 'Inherit: Use when available' })).toHaveCount(1);
  await fillSettled(page.getByLabel('Name'), 'crud-host');
  await page.getByRole('button', { name: 'Save' }).click();
  const row = page.getByTestId('host-row').filter({ hasText: 'crud-host' });
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Menu for crud-host' }).first().click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await api<{ name: string }[]>(page, 'GET', '/api/hosts')).map((h) => h.name)).not.toContain('crud-host');
});

test('a host saved while it is changed again: the later change stays unsaved, the icon it had stays (AUDIT2 PAGE-01, PAGE-30)', async ({ page }) => {
  const h = await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'crud-held', address: '127.0.0.1', icon: 'server' });
  await page.goto(`/#/hosts/${h.id}/edit`);
  await expect(page.getByLabel('Name')).toHaveValue('crud-held');
  let release!: () => void;
  let sending!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent = new Promise<void>((r) => (sending = r));
  await page.route(`**/api/hosts/${h.id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    sending();
    await held;
    await route.continue();
  });
  await fillSettled(page.getByLabel('Name'), 'crud-held-2');
  await page.getByRole('button', { name: 'Save' }).click();
  await sent;
  await page.getByLabel('Startup command').fill('echo later');
  release();
  // Saved as sent, the form still open with the later change, which is not saved.
  await expect.poll(async () => (await api<{ name: string }>(page, 'GET', `/api/hosts/${h.id}`)).name).toBe('crud-held-2');
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(new RegExp(`#/hosts/${h.id}/edit`));
  await expect(page.getByLabel('Startup command')).toHaveValue('echo later');
  const saved = await api<{ startupCommand: string | null; icon: string | null }>(page, 'GET', `/api/hosts/${h.id}`);
  expect(saved.startupCommand).toBeNull();
  expect(saved.icon).toBe('server');
  await page.unroute(`**/api/hosts/${h.id}`);
  // Saved again: the later change too, and the list.
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/#\/hosts$/);
  expect((await api<{ startupCommand: string | null; icon: string | null }>(page, 'GET', `/api/hosts/${h.id}`)).startupCommand).toBe('echo later');
  await api(page, 'DELETE', `/api/hosts/${h.id}`);
});

test('a changed host form and only the query of its address changed: asked first, as the page is made anew (AUDIT2 PAGE-10)', async ({ page }) => {
  const h = await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'crud-query', address: '127.0.0.1' });
  await page.goto(`/#/hosts/${h.id}/edit`);
  await expect(page.getByLabel('Name')).toHaveValue('crud-query');
  await fillSettled(page.getByLabel('Name'), 'crud-query-changed');
  await page.evaluate((id) => (location.hash = `#/hosts/${id}/edit?from=x`), h.id);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? [])).toContain('You have changes that are not saved. Leave anyway?');
  await api(page, 'DELETE', `/api/hosts/${h.id}`);
});

test('a copy made while the person went to another page: they stay there (AUDIT2 PAGE-17)', async ({ page }) => {
  const h = await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'crud-from', address: '127.0.0.1' });
  await page.reload();
  let release!: () => void;
  let sending!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent = new Promise<void>((r) => (sending = r));
  await page.route(`**/api/hosts/${h.id}/copy`, async (route) => {
    sending();
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Menu for crud-from' }).first().click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await sent;
  await page.evaluate(() => (location.hash = '#/alerts'));
  await expect(page).toHaveURL(/#\/alerts$/);
  release();
  await expect.poll(async () => (await api<{ name: string }[]>(page, 'GET', '/api/hosts')).some((x) => x.name === 'crud-from (copy)')).toBe(true);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/alerts$/);
  await page.unroute(`**/api/hosts/${h.id}/copy`);
  for (const x of await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts')) if (x.name.startsWith('crud-from')) await api(page, 'DELETE', `/api/hosts/${x.id}`);
});

test("the app's shortcut to a host with a step-up on the way: one session, not two (AUDIT2 PAGE-16)", async ({ page }) => {
  const sshd = (await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts')).find((h) => h.name === 'test-sshd')!;
  const h = await api<{ id: number }>(page, 'POST', `/api/hosts/${sshd.id}/copy`);
  await api(page, 'PUT', `/api/hosts/${h.id}`, { ...(await api<Record<string, unknown>>(page, 'GET', `/api/hosts/${h.id}`)), name: 'crud-shortcut' });
  let posts = 0;
  await page.route('**/api/terminal/sessions', (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    posts += 1;
    return posts === 1 ? r.fulfill({ status: 403, json: { error: 'step_up_required' } }) : r.continue();
  });
  await page.goto(`/#/hosts?connect=${h.id}`);
  // A link never acts by itself: the question naming the host first (A3-WEB-07), answered yes by sayYes.
  const confirm = page.getByRole('dialog', { name: "Confirm it's you" });
  await confirm.getByRole('button', { name: 'Confirm with passkey' }).click();
  await expect(confirm).toBeHidden();
  await saveCredential(auth);
  await expect(page).toHaveURL(/#\/term\//, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(posts).toBe(2);
  await page.unroute('**/api/terminal/sessions');
  const mine = (await api<{ id: string; hostId: number }[]>(page, 'GET', '/api/terminal/sessions')).filter((x) => x.hostId === h.id);
  expect(mine).toHaveLength(1);
  for (const x of mine) await api(page, 'DELETE', `/api/terminal/sessions/${x.id}`);
  await page.goto('/#/hosts');
  await api(page, 'DELETE', `/api/hosts/${h.id}`);
});

test("a host's connection test still on its way when another host's menu opens: its result not shown there (AUDIT2 UI-18)", async ({ page }) => {
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const a = hosts.find((h) => h.name === 'test-sshd')!;
  const b = hosts.find((h) => h.id !== a.id && !h.name.startsWith('crud-'))!;
  let release!: () => void;
  let sending!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent = new Promise<void>((r) => (sending = r));
  await page.route(`**/api/hosts/${a.id}/test`, async (route) => {
    sending();
    await held;
    await route.continue();
  });
  const sheet = page.locator('dialog[open][data-tour=host-sheet]');
  await page.getByRole('button', { name: `Menu for ${a.name}` }).first().click();
  await sheet.getByTestId('test-connection').click();
  await sent;
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: `Menu for ${b.name}` }).first().click();
  await expect(sheet).toContainText(b.name);
  release();
  await page.waitForTimeout(1500);
  await expect(sheet.getByTestId('test-ok')).toHaveCount(0);
  await page.unroute(`**/api/hosts/${a.id}/test`);
  await page.keyboard.press('Escape');
});

test('a group: made, renamed, deleted', async ({ page }) => {
  await api(page, 'POST', '/api/groups', { name: 'crud-group' });
  await page.reload();
  const edit = (name: string) => page.locator('.group-head', { hasText: name }).getByRole('button', { name: 'Edit group' }).click();
  await edit('crud-group');
  await expect(page.getByLabel('Name')).toHaveValue('crud-group');
  await fillSettled(page.getByLabel('Name'), 'crud-group-2');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('crud-group-2')).toBeVisible();
  await edit('crud-group-2');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('crud-group-2')).toHaveCount(0);
});

test('groups six deep on a phone: one step in per level (AUDIT2 PAGE-31)', async ({ page }) => {
  const ids: number[] = [];
  for (let i = 1; i <= 6; i++) ids.push((await api<{ id: number }>(page, 'POST', '/api/groups', { name: `crud-deep-${i}`, parentId: ids.at(-1) ?? null })).id);
  await page.setViewportSize({ width: 343, height: 640 });
  await page.reload();
  const left = async (name: string) => (await page.locator('.group-head', { hasText: name }).first().boundingBox())!.x;
  expect(Math.round((await left('crud-deep-6')) - (await left('crud-deep-1')))).toBe(5 * 12);
  for (const id of ids.reverse()) await api(page, 'DELETE', `/api/groups/${id}`);
});

test('a snippet: changed and deleted', async ({ page }) => {
  await api(page, 'POST', '/api/snippets', { name: 'crud-snippet', command: 'echo one' });
  await page.goto('/#/snippets');
  // A tap on the row edits; so does Edit in its menu.
  await page.getByTestId('snippet-row').filter({ hasText: 'crud-snippet' }).locator('.pick').click();
  await page.getByLabel('Command').fill('echo two');
  await page.getByRole('button', { name: 'Save' }).click();
  const row = page.getByTestId('snippet-row').filter({ hasText: 'crud-snippet' });
  await expect(row).toContainText('echo two');
  await fromRowMenu(row, 'snippet-menu', 'snippet-edit');
  await expect(page.getByLabel('Command')).toHaveValue('echo two');
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('commands typed often: saved as a snippet, or not suggested again', async ({ page }) => {
  // Reported (8f829d): derive often used commands and suggest them.
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!;
  // The history itself is what the terminals typed; here the list as the server would give it.
  let offered = [
    { command: 'docker compose -f /srv/media/compose.yaml logs -f sonarr', count: 7, hostIds: [sshd.id], lastAt: new Date().toISOString() },
    { command: 'sudo apt update && sudo apt upgrade -y', count: 4, hostIds: hosts.slice(0, 2).map((h) => h.id), lastAt: new Date().toISOString() },
  ];
  let hidden: unknown = null;
  await page.route('**/api/snippets/suggestions', (r) => r.fulfill({ json: offered }));
  await page.route('**/api/snippets/suggestions/dismiss', async (r) => {
    hidden = r.request().postDataJSON();
    const res = await r.fetch();
    offered = offered.filter((o) => o.command !== (hidden as { command: string }).command);
    await r.fulfill({ response: res });
  });
  await page.goto('/#/snippets');
  const items = page.getByTestId('snippet-suggestion');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('typed 7 times | test-sshd');
  await lookAt(page, 'desktop-snippet-suggestions');
  // On a small phone the command keeps a line of its own, not a word a line beside the buttons (report 4ed704).
  await page.setViewportSize({ width: 343, height: 640 });
  const cmd = items.first().locator('.cmd');
  expect((await cmd.boundingBox())!.width).toBeGreaterThan(220);
  await lookAt(page, 'phone-small-snippet-suggestions');
  await page.setViewportSize({ width: 1280, height: 720 });
  // Not suggested again: asked of the server, gone from the list.
  await fromRowMenu(items.filter({ hasText: 'apt upgrade' }), 'suggestion-menu', 'suggestion-hide');
  await expect(items).toHaveCount(1);
  expect(hidden).toEqual({ command: 'sudo apt update && sudo apt upgrade -y' });
  // Saved: the form filled in, for the one host it was typed on.
  await fromRowMenu(items.first(), 'suggestion-menu', 'suggestion-keep');
  const form = page.locator('dialog[open]');
  await expect(form.getByLabel('Command')).toHaveValue('docker compose -f /srv/media/compose.yaml logs -f sonarr');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('docker compose -f /srv/media/compose.yaml');
  await expect(form.getByRole('combobox')).toHaveValue(`h${sshd.id}`);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  // Or by a tap on its row, as a saved one's: changed before it is saved (report 76b6df).
  await items.first().getByTestId('suggestion-open').click();
  await expect(form.getByLabel('Command')).toHaveValue('docker compose -f /srv/media/compose.yaml logs -f sonarr');
  await form.getByLabel('Command').fill('docker compose -f /srv/media/compose.yaml logs --tail 100 sonarr');
  await fillSettled(form.getByLabel('Name', { exact: true }), 'sonarr logs');
  offered = [];
  await form.getByRole('button', { name: 'Save' }).click();
  const row = page.getByTestId('snippet-row').filter({ hasText: 'sonarr logs' });
  await expect(row).toContainText('test-sshd');
  await expect(row).toContainText('--tail 100 sonarr');
  await expect(items).toHaveCount(0);
  await page.unroute('**/api/snippets/suggestions');
  await page.unroute('**/api/snippets/suggestions/dismiss');
  // Cleaned up.
  await fromRowMenu(row, 'snippet-menu', 'snippet-remove');
  await expect(row).toHaveCount(0);
});

test('a channel: renamed and deleted', async ({ page }) => {
  await page.goto('/#/settings/channels');
  await page.getByTestId('add-channel').click();
  await page.getByTestId('add-webhook').click();
  await fillSettled(page.locator('dialog[open]').getByLabel('Name', { exact: true }), 'crud-hook');
  await page.getByTestId('webhook-url').fill('https://example.com/hook');
  await page.getByTestId('channel-save').click();
  const row = page.getByTestId('channel').filter({ hasText: 'crud-hook' });
  await expect(row).toBeVisible();
  await fromRowMenu(row, 'channel-menu', 'channel-edit');
  // On or off only on its row, not in the form as well (report e2d7d2: two places for one switch).
  const form = page.locator('#channel-form');
  await expect(form.getByLabel('On', { exact: true })).toHaveCount(0);
  await fillSettled(page.locator('dialog[open]').getByLabel('Name', { exact: true }), 'crud-hook-2');
  await page.getByTestId('channel-save').click();
  const renamed = page.getByTestId('channel').filter({ hasText: 'crud-hook-2' });
  await expect(renamed).toBeVisible();
  await expect(renamed.getByRole('checkbox', { name: 'crud-hook-2' })).toBeChecked();
  await renamed.getByRole('checkbox', { name: 'crud-hook-2' }).uncheck();
  await page.reload();
  await expect(renamed.getByRole('checkbox', { name: 'crud-hook-2' })).not.toBeChecked();
  await fromRowMenu(renamed, 'channel-menu', 'channel-remove');
  await expect(renamed).toHaveCount(0);
});

test('an alert rule: changed, off, deleted', async ({ page }) => {
  await page.goto('/#/alerts');
  await page.getByTestId('new-rule').click();
  await page.getByTestId('rule-name').fill('crud-rule');
  await page.getByTestId('rule-pattern').fill('PANIC');
  await page.getByTestId('rule-save').click();
  const rule = page.getByTestId('rule').filter({ hasText: 'crud-rule' });
  await expect(rule).toBeVisible();
  await fromRowMenu(rule, 'rule-menu', 'rule-edit');
  await page.getByTestId('rule-pattern').fill('FATAL');
  await page.getByTestId('rule-save').click();
  await expect(rule).toContainText('FATAL');
  // Another kind: events of one container.
  await fromRowMenu(rule, 'rule-menu', 'rule-edit');
  await page.getByTestId('rule-kind').selectOption('event');
  await page.locator('dialog[open]').getByRole('checkbox').first().check();
  await page.getByTestId('rule-container').fill('db');
  await page.getByTestId('rule-save').click();
  await expect
    .poll(async () => (await api<{ name: string; kind: string; container: string | null }[]>(page, 'GET', '/api/alerts/rules')).find((r) => r.name === 'crud-rule'))
    .toMatchObject({ kind: 'event', container: 'db' });
  // Docker's events and the host's own problems are two kinds: no heat
  // under "Docker reports a problem", and a host rule for any host.
  await fromRowMenu(rule, 'rule-menu', 'rule-edit');
  await expect(page.getByTestId('rule-kind')).toHaveValue('event');
  await expect(page.locator('dialog[open] [data-testid=rule-event][value=hot]')).toHaveCount(0);
  await page.getByTestId('rule-kind').selectOption('host');
  // disk_full, smart, hot, busy, package updates, a scheduled command that failed (2.11.0), unreachable (2.22.0).
  await expect(page.locator('dialog[open] [data-testid=rule-event]')).toHaveCount(7);
  await expect(page.getByTestId('rule-container')).toHaveCount(0);
  // For one host: any host may be chosen for its own problems.
  const sshd = (await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts')).find((h) => h.name === 'test-sshd')!;
  await page.getByTestId('rule-host').selectOption({ label: 'test-sshd' });
  await page.getByTestId('rule-save').click();
  await expect
    .poll(async () => (await api<{ name: string; kind: string; events: string[]; container: string | null; hostId: number | null }[]>(page, 'GET', '/api/alerts/rules')).find((r) => r.name === 'crud-rule'))
    .toMatchObject({ kind: 'event', events: ['disk_full', 'smart', 'hot', 'busy', 'updates', 'scheduled', 'unreachable'], container: null, hostId: sshd.id });
  // Opened again: a host rule.
  await fromRowMenu(rule, 'rule-menu', 'rule-edit');
  await expect(page.getByTestId('rule-kind')).toHaveValue('host');
  await page.keyboard.press('Escape');
  await rule.getByRole('checkbox').uncheck();
  await expect.poll(async () => (await api<{ name: string; enabled: boolean }[]>(page, 'GET', '/api/alerts/rules')).find((r) => r.name === 'crud-rule')?.enabled).toBe(false);
  await fromRowMenu(rule, 'rule-menu', 'rule-remove');
  await expect(rule).toHaveCount(0);
});

test('an alert rule saved twice while the first is on its way: one rule; a rule opened meanwhile stays open (AUDIT2 PAGE-11, PAGE-12)', async ({ page }) => {
  await page.goto('/#/alerts');
  let release!: () => void;
  let sending!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent = new Promise<void>((r) => (sending = r));
  let posts = 0;
  await page.route('**/api/alerts/rules', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    sending();
    await held;
    await route.continue();
  });
  await page.getByTestId('new-rule').click();
  await page.getByTestId('rule-name').fill('crud-twice');
  await page.getByTestId('rule-pattern').fill('PANIC');
  await page.getByTestId('rule-pattern').press('Enter');
  await sent;
  await page.getByTestId('rule-pattern').press('Enter');
  // Closed, and another one opened before the first is saved: that one stays.
  await page.keyboard.press('Escape');
  // Gone before the next opens: a click while it still closed reached nothing (once in the gate).
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.getByTestId('new-rule').click();
  await page.getByTestId('rule-name').fill('crud-second');
  release();
  const rule = page.getByTestId('rule').filter({ hasText: 'crud-twice' });
  await expect(rule).toHaveCount(1);
  await expect(page.getByTestId('rule-name')).toHaveValue('crud-second');
  expect(posts).toBe(1);
  await page.unroute('**/api/alerts/rules');
  await page.keyboard.press('Escape');
  expect((await api<{ name: string }[]>(page, 'GET', '/api/alerts/rules')).filter((r) => r.name === 'crud-twice')).toHaveLength(1);
  await fromRowMenu(rule, 'rule-menu', 'rule-remove');
  await expect(rule).toHaveCount(0);
});

test('a changed dialog form closed by Escape, its X or the backdrop: asked first; unchanged it just closes (AUDIT2 PAGE-09)', async ({ page }) => {
  await page.goto('/#/alerts');
  const asked = () => page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? []);
  const q = 'You have changes that are not saved. Close anyway?';
  const form = page.locator('dialog[open][data-tour=alert-rule]');
  // Unchanged: closes without a question.
  await page.getByTestId('new-rule').click();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  expect(await asked()).not.toContain(q);
  // Changed: Escape, X and the backdrop each ask (and the yes closes it).
  for (const close of ['escape', 'x', 'backdrop'] as const) {
    const before = (await asked()).filter((x) => x === q).length;
    await page.getByTestId('new-rule').click();
    await page.getByTestId('rule-name').fill('crud-draft');
    if (close === 'escape') await page.keyboard.press('Escape');
    else if (close === 'x') await form.getByRole('button', { name: 'Close' }).first().click();
    else await page.mouse.click(5, 5);
    await expect.poll(async () => (await asked()).filter((x) => x === q).length).toBe(before + 1);
    await expect(form).toHaveCount(0);
  }
});

test('a report schedule: changed and deleted', async ({ page }) => {
  await page.goto('/#/reports');
  await page.getByTestId('new-schedule').click();
  await fillSettled(page.locator('dialog[open]').getByLabel('Name', { exact: true }), 'crud-schedule');
  await page.getByTestId('schedule-time').fill('06:30');
  await page.getByTestId('schedule-save').click();
  const row = page.getByTestId('schedule').filter({ hasText: 'crud-schedule' });
  await expect(row).toBeVisible();
  await fromRowMenu(row, 'schedule-menu', 'edit-schedule');
  await page.getByTestId('schedule-time').fill('07:45');
  await page.getByTestId('schedule-save').click();
  await expect(row).toContainText('07:45');
  await fromRowMenu(row, 'schedule-menu', 'edit-schedule');
  await page.getByTestId('schedule-kind').selectOption('daily');
  await page.getByTestId('schedule-save').click();
  await expect.poll(async () => (await api<{ name: string; kind: string }[]>(page, 'GET', '/api/reports/schedules')).find((x) => x.name === 'crud-schedule')?.kind).toBe('daily');

  // Its own choices: only one stack (its errors of the last 200 lines), one
  // channel, quiet when all is well, no AI, its own thresholds.
  await fromRowMenu(row, 'schedule-menu', 'edit-schedule');
  await page.getByTestId('logsel-only-below').check();
  await page.getByTestId('logsel-add').click();
  const rule = page.getByTestId('logsel-rule').first();
  await rule.getByTestId('logsel-kind').selectOption('stack');
  await rule.getByTestId('logsel-name').fill('burrowtest');
  // The stack of that name on one host only (it may run on several).
  await rule.getByTestId('logsel-on-host').selectOption({ index: 1 });
  await rule.getByTestId('logsel-window').selectOption('lines');
  await rule.getByTestId('logsel-n').fill('200');
  // Warnings off (errors and fatal stay).
  await rule.getByTestId('logsel-level').filter({ hasText: /^warn/i }).click();
  // A host rule, left out, then taken away again: one exception stays.
  await page.getByTestId('logsel-add').click();
  const second = page.getByTestId('logsel-rule').nth(1);
  await second.getByTestId('logsel-host').selectOption({ index: 0 });
  await second.getByTestId('logsel-skip').check();
  await second.getByTestId('logsel-remove').click();
  await expect(page.getByTestId('logsel-rule')).toHaveCount(1);
  await page.getByTestId('schedule-all-channels').uncheck();
  await page.getByTestId('schedule-channel').first().check();
  await page.getByTestId('schedule-only-attention').check();
  await page.getByTestId('schedule-ai').uncheck();
  await page.locator('dialog[open] details.more summary').click();
  await page.getByTestId('schedule-errors').fill('25');
  await page.getByTestId('schedule-warnings').fill('250');
  await page.getByTestId('schedule-save').click();
  await expect
    .poll(async () => (await api<Record<string, unknown>[]>(page, 'GET', '/api/reports/schedules')).find((x) => x.name === 'crud-schedule'))
    .toMatchObject({
      onlyAttention: true,
      ai: false,
      errorsAttention: 25,
      warningsAttention: 250,
      channelIds: [expect.any(Number)],
      selection: { rules: [{ target: null, skip: true }, { target: { project: 'burrowtest', hostId: expect.any(Number) }, window: { kind: 'lines', n: 200 }, skip: false }] },
    });
  const saved = (await api<{ name: string; selection: { rules: { levels: string[] }[] } }[]>(page, 'GET', '/api/reports/schedules')).find((x) => x.name === 'crud-schedule')!;
  expect(saved.selection.rules[1]!.levels).not.toContain('warn');

  // Made now from its dialog: its progress shows. Leaving the page, it goes
  // on in the busy pill, which opens the report when it is ready.
  await fromRowMenu(row, 'schedule-menu', 'edit-schedule');
  await page.getByTestId('schedule-run').click();
  // Its progress, or, made quicker than that is seen (SSH without delayed ACKs, OPS-W-01), the report itself.
  const progress = page.getByTestId('report-progress').first();
  await expect(progress.or(page.getByRole('heading', { name: 'crud-schedule', level: 1 }))).toBeVisible({ timeout: 30_000 });
  if (await progress.isVisible()) {
    await page.getByRole('link', { name: 'Hosts' }).click();
    await page.getByTestId('transfers-pill').click();
    await page.getByTestId('report-progress-open').click({ timeout: 120_000 });
  }
  await expect(page).toHaveURL(/#\/reports\/\d+$/);
  await page.goto('/#/reports');
  await row.getByTestId('schedule-on').uncheck();
  await expect.poll(async () => (await api<{ name: string; enabled: boolean }[]>(page, 'GET', '/api/reports/schedules')).find((x) => x.name === 'crud-schedule')?.enabled).toBe(false);
  await fromRowMenu(row, 'schedule-menu', 'schedule-remove');
  await expect(row).toHaveCount(0);
});

test('the account: a second passkey, a password, new recovery codes, other sessions out', async ({ page, browser }) => {
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

test('All hosts: a user for every host that sets none, below its groups; a part of Settings (report 5c1209)', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByTestId('settings-section').filter({ hasText: 'All hosts' }).click();
  await expect(page).toHaveURL(/#\/settings\/hosts$/);
  await expect(page.getByRole('heading', { name: 'All hosts', level: 2 })).toBeVisible();
  // Not a group's words: nothing above it to inherit from, only Burrow's own defaults.
  await expect(page.getByRole('heading', { name: 'For every host' })).toBeVisible();
  await expect(page.locator('option', { hasText: /^Inherit/ })).toHaveCount(0);
  await expect(page.locator('option', { hasText: 'Default: Use when available' })).toHaveCount(1);
  // Every empty choice says what it means, never a bare "Default" (report d07225).
  await expect(page.getByLabel('Authentication').locator('option').first()).toHaveText('Default: automatic');
  await expect(page.getByTestId('auth-auto-help')).toHaveText('The key if one is chosen, else the stored password.');
  await expect(page.getByLabel(/^Key/).locator('option').first()).toHaveText('Default: None');
  await expect(page.locator('option').filter({ hasText: /^Default$/ })).toHaveCount(0);
  // No name or parent here: this is above every group.
  await expect(page.getByLabel('Name')).toHaveCount(0);
  await page.getByLabel('User').fill('everyone');
  await page.getByRole('button', { name: 'Save' }).click();
  // Saved, and still in Settings.
  await expect(page.getByText('Saved for every host.')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings\/hosts$/);
  // Its old address leads there.
  await page.goto('/#/groups/all');
  await expect(page).toHaveURL(/#\/settings\/hosts$/);
  // A new host without a group says where its user comes from; in a group
  // that sets its own, the group's wins.
  await page.goto('/#/hosts/new');
  await expect(page.getByText('from All hosts: everyone')).toBeVisible();
  await page.getByLabel('Group').selectOption({ label: 'Home' });
  await expect(page.getByText('from group Home: tester')).toBeVisible();
  // Back to nothing set for all hosts (the other tests' hosts are left as they were).
  expect(await api(page, 'PUT', '/api/host-defaults', {})).toEqual({});
});

test("Burrow's own push: a device, a test to it, taken off again", async ({ page, request }) => {
  // A stand-in push service (e2e/fake-llm.mjs), and a device's keys as a browser makes them.
  const device = await page.evaluate(async () => {
    const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
    const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // The private half too, to open what arrives (the test is the device here).
    const d = (await crypto.subtle.exportKey('jwk', k.privateKey)).d!;
    return { p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))), d };
  });
  const llm = new URL(process.env.LLM_URL ?? 'http://localhost:8191/v1').origin;
  await api(page, 'POST', '/api/push/devices', { kind: 'webpush', label: 'Test browser', endpoint: `${llm}/push`, p256dh: device.p256dh, auth: device.auth, lang: 'en' });
  await page.goto('/#/settings?s=notify');
  await page.reload();
  const card = page.getByTestId('push-card');
  // This browser itself has it off (the device above is another one).
  await expect(card.getByTestId('push-state')).toHaveText('Off on this device.');
  await expect(card.getByTestId('push-toggle')).toHaveText('Turn on');
  await expect(card.getByTestId('push-device')).toContainText('Test browser');
  await expect(card.getByTestId('push-device')).toContainText('nothing delivered yet');
  await card.getByTestId('push-test').click();
  await expect(page.getByText('Sent to 1 device.')).toBeVisible();
  // It came encrypted for this device and signed (VAPID): opened with the
  // device's keys, its signature checked with the key it names, for the
  // push service it went to (AUDIT2 TEST-21: the header alone proved nothing).
  const got = (await (await request.get(`${process.env.APPS_BASE ?? 'http://localhost:8191'}/push`)).json()) as { encoding: string; vapid: boolean; bytes: number; body: string; authorization: string; endpoint: string }[];
  const last = got.at(-1)!;
  expect(last).toMatchObject({ encoding: 'aes128gcm', vapid: true });
  expect(JSON.parse(openPush(Buffer.from(last.body, 'base64'), device))).toMatchObject({ title: 'Burrow test', topic: 'test' });
  const claims = vapidClaims(last.authorization);
  expect(claims.aud).toBe(new URL(last.endpoint).origin);
  expect(claims.exp * 1000).toBeGreaterThan(Date.now());
  expect(claims.key).toBe((await api<{ publicKey: string }>(page, 'GET', '/api/push/key')).publicKey);
  // A channel for it says how many devices it reaches.
  await page.goto('/#/settings?s=channels');
  await page.reload();
  await page.getByRole('button', { name: 'Add a channel' }).click();
  await page.getByRole('button', { name: /Burrow's own push/ }).click();
  await expect(page.getByText('Goes to every device where notifications are on')).toBeVisible();
  await page.keyboard.press('Escape');
  // Taken off: the list is empty again.
  await page.goto('/#/settings?s=notify');
  await page.reload();
  // (The question is answered by sayYes in beforeEach.)
  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(card.getByTestId('push-device')).toHaveCount(0);
});

test("this browser's own push: blocked said, turned on, a test reaches it, off again; taken off elsewhere it reads off (AUDIT2 WEB-10)", async ({ page, context, request }) => {
  // The device's keys, and the browser's push service: a stand-in (headless
  // Chromium reaches none). Its subscription is these keys at the stand-in
  // push service (e2e/fake-llm.mjs), kept across reloads as a browser keeps it.
  const llm = new URL(process.env.LLM_URL ?? 'http://localhost:8191/v1').origin;
  const device = await page.evaluate(async () => {
    const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
    const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))), d: (await crypto.subtle.exportKey('jwk', k.privateKey)).d! };
  });
  const endpoint = `${llm}/push`;
  await page.addInitScript(
    ([endpoint, p256dh, auth]) => {
      const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
      const make = () => ({
        endpoint,
        getKey: (n: string) => bytes(n === 'p256dh' ? p256dh : auth),
        unsubscribe: async () => {
          localStorage.removeItem('__sub');
          localStorage.setItem('__unsubscribed', String(Number(localStorage.getItem('__unsubscribed') ?? 0) + 1));
          return true;
        },
      });
      PushManager.prototype.subscribe = async function (o?: PushSubscriptionOptionsInit) {
        localStorage.setItem('__sub', btoa(String.fromCharCode(...new Uint8Array(o!.applicationServerKey as ArrayBuffer))));
        return make() as unknown as PushSubscription;
      };
      PushManager.prototype.getSubscription = async () => (localStorage.getItem('__sub') ? (make() as unknown as PushSubscription) : null);
    },
    [endpoint, device.p256dh, device.auth] as const,
  );
  // This browser's device in Burrow's list: the one it remembers (no other test adds one meanwhile: the desktop specs run one at a time).
  const list = () => api<{ id: number; kind: string; label: string }[]>(page, 'GET', '/api/push/devices');
  const before = new Set((await list()).map((x) => x.id));
  const mine = async () => (await list()).filter((x) => !before.has(x.id));
  const card = page.getByTestId('push-card');
  const toggle = card.getByTestId('push-toggle');
  await page.goto('/#/settings?s=notify');
  await page.reload();
  await expect(card.getByTestId('push-state')).toHaveText('Off on this device.');

  // Blocked in the browser: said how to allow it, nothing registered.
  await context.clearPermissions();
  await page.evaluate(() => Object.defineProperty(Notification, 'requestPermission', { value: async () => 'denied' }));
  await toggle.click();
  await expect(page.getByText('Notifications are blocked for Burrow: allow them in the browser settings.')).toBeVisible();
  expect(await mine()).toEqual([]);

  // Allowed: subscribed with Burrow's own key, and Burrow told this device's address and keys.
  await context.grantPermissions(['notifications']);
  await page.reload();
  await toggle.click();
  await expect(card.getByTestId('push-state')).toHaveText('On: alerts, reports and updates can reach this device.');
  await expect(toggle).toHaveText('Turn off');
  const [d] = await mine();
  expect(d).toMatchObject({ kind: 'webpush', label: expect.stringMatching(/^Chrome \| /) });
  expect(await page.evaluate(() => localStorage.getItem('burrow.pushDevice'))).toBe(String(d!.id));
  await expect(card.getByTestId('push-device').filter({ hasText: d!.label })).toBeVisible();
  const serverKey = (await api<{ publicKey: string }>(page, 'GET', '/api/push/key')).publicKey;
  expect(await page.evaluate(() => localStorage.getItem('__sub'))).toBe(Buffer.from(serverKey, 'base64url').toString('base64'));

  // A test reaches it: opened with this device's keys.
  await card.getByTestId('push-test').click();
  await expect(page.getByText(/^Sent to \d+ devices?\.$/)).toBeVisible();
  await expect
    .poll(async () => {
      const got = (await (await request.get(`${process.env.APPS_BASE ?? 'http://localhost:8191'}/push`)).json()) as { body: string }[];
      // Only a push for this device opens with its keys.
      const opened = got.flatMap((g) => {
        try {
          return [JSON.parse(openPush(Buffer.from(g.body, 'base64'), device)) as { title: string }];
        } catch {
          return [];
        }
      });
      return opened.at(-1)?.title ?? null;
    })
    .toBe('Burrow test');

  // Still on after a reload; taken off from another device (Settings there), this one reads off and lets go of its subscription.
  await page.reload();
  await expect(card.getByTestId('push-state')).toHaveText('On: alerts, reports and updates can reach this device.');
  await api(page, 'DELETE', `/api/push/devices/${d!.id}`);
  await page.reload();
  await expect(card.getByTestId('push-state')).toHaveText('Off on this device.');
  expect(await page.evaluate(() => [localStorage.getItem('__sub'), localStorage.getItem('__unsubscribed')])).toEqual([null, '1']);

  // On again, then off here: unsubscribed, and gone from Burrow.
  await toggle.click();
  await expect(toggle).toHaveText('Turn off');
  expect(await mine()).toHaveLength(1);
  await toggle.click();
  await expect(card.getByTestId('push-state')).toHaveText('Off on this device.');
  expect(await mine()).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('__unsubscribed'))).toBe('2');
});

test("a Proxmox node's guests: stopped and started again, shut down, rebooted, one added as a host with its address (F5)", async ({ page }) => {
  // The test sshd's qm and pct are stand-ins whose guests keep their state (signed in by beforeEach).
  const sshd = await hostNamed(page, 'test-sshd');
  await page.goto(`/#/hosts/${sshd}/stats`);
  const card = page.getByTestId('pve-guests');
  await expect(card.getByTestId('pve-guest')).toHaveCount(3, { timeout: 20_000 });
  const guest = (name: string) => card.getByTestId('pve-guest').filter({ hasText: name });
  const ct = guest('burrowtest-ct');
  await expect(ct).toContainText('Container 200');
  await expect(ct.getByTestId('pve-status')).toHaveText('Running');
  await lookAt(page, 'desktop-pve-guests');
  // What can be done with a guest in its menu (report e6fc13: two lines of buttons under it on a phone).
  await ct.getByTestId('pve-menu').click();
  await lookAt(page, 'desktop-pve-menu');
  await page.keyboard.press('Escape');

  // Stop (asked first), then Start: each seen in the list read again.
  await fromRowMenu(ct, 'pve-menu', 'pve-stop');
  await expect(ct.getByTestId('pve-status')).toHaveText('Stopped');
  await expect(page.getByText('burrowtest-ct stopped.')).toBeVisible();
  await fromRowMenu(ct, 'pve-menu', 'pve-start');
  await expect(ct.getByTestId('pve-status')).toHaveText('Running');
  // A VM: shut down, started, rebooted.
  const vm = guest('burrowtest-vm');
  await fromRowMenu(vm, 'pve-menu', 'pve-shutdown');
  await expect(vm.getByTestId('pve-status')).toHaveText('Stopped');
  await fromRowMenu(vm, 'pve-menu', 'pve-start');
  await expect(vm.getByTestId('pve-status')).toHaveText('Running');
  await fromRowMenu(vm, 'pve-menu', 'pve-reboot');
  await expect(page.getByText('burrowtest-vm rebooted.')).toBeVisible();
  await expect(vm.getByTestId('pve-status')).toHaveText('Running');

  // Added as a host: the form with its name and the address the node knows.
  await fromRowMenu(ct, 'pve-menu', 'pve-add-host');
  await expect(page).toHaveURL(/#\/hosts\/new\?/);
  await expect(page.locator('input[name=name]')).toHaveValue('burrowtest-ct');
  await expect(page.locator('input[name=address]')).toHaveValue('10.99.1.200');
});
