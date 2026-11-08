import { devices, expect, test, type Page } from './fixtures.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// The panel under a workspace and on a stack's page: terminals in the
// folder, the logs of the containers that belong to it (picked by itself,
// or chosen), kept as it was left. One tab for files, a shell and the logs.

const DOCKER_HOST = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';
const PROJECT = 'burrowtest-panel';
const DIR = '/home/tester/e2e-panel';

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b === undefined ? (m === 'GET' ? undefined : '{}') : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

const panel = (page: Page) => page.getByTestId('panel');
/** The room under the panel, in its column: none, it is at the bottom. */
const panelGap = (page: Page) => panel(page).evaluate((p) => Math.round(p.parentElement!.getBoundingClientRect().bottom - p.getBoundingClientRect().bottom));
const screen = (page: Page) => panel(page).locator('[data-testid=terminal] .xterm-rows');
/** The panel's terminal: started by itself, or (sessions of other specs running on the host) a new one chosen. */
async function newTerminal(page: Page) {
  await expect(screen(page).or(panel(page).getByTestId('panel-running'))).toBeVisible({ timeout: 20_000 });
  if (await panel(page).getByTestId('panel-running').isVisible()) await panel(page).getByTestId('panel-pick-new').click();
  await expect(screen(page)).toContainText('$', { timeout: 20_000 });
}
async function type(page: Page, text: string) {
  await panel(page).getByTestId('terminal').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** The host on the real Docker, and a compose stack of one container in DIR. */
async function stackHost(page: Page): Promise<number> {
  const hosts = await api<{ id: number; address: string }[]>(page, 'GET', '/api/hosts');
  const h =
    hosts.find((x) => x.address === DOCKER_HOST) ??
    (await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'docker-real', address: DOCKER_HOST, username: 'tester', authMethod: 'password', password: 'burrow-test-password' }));
  let r = await api<{ status: string; fingerprint?: string }>(page, 'POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') {
    await api(page, 'POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
    r = await api(page, 'POST', `/api/hosts/${h.id}/test`);
  }
  expect(r.status).toBe('ok');
  const [res] = await api<{ exitCode: number; stderr: string }[]>(page, 'POST', '/api/snippets/run', {
    hostIds: [h.id],
    command: [
      `rm -rf ${DIR} && mkdir -p ${DIR}`,
      `printf 'services:\\n  web:\\n    image: burrowtest-app:v1\\n    labels:\\n      burrow.ignore: "true"\\n' > ${DIR}/compose.yaml`,
      `cd ${DIR} && docker compose -p ${PROJECT} up -d 2>&1`,
    ].join(' && '),
  });
  expect(res!.exitCode, res!.stderr).toBe(0);
  return h.id;
}

test('workspace panel: a terminal in the folder, its stack logs picked by itself or chosen, kept after a reload', async ({ page }) => {
  test.setTimeout(240_000);
  const asked = await sayYes(page);
  await signIn(page);
  const hostId = await stackHost(page);
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId, root: DIR });
  const ids = async () => (await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).map((x) => x.id);
  const had = await ids();
  const before = had.length;

  await page.goto(`/#/ws/${ws.id}`);
  await expect(page.getByTestId('panel')).toHaveCount(0);
  await page.getByTestId('panel-toggle').click();
  await expect(page.getByTestId('panel-toggle')).toHaveAttribute('aria-pressed', 'true');
  // At the bottom, no file open too: it sat in the middle under the empty editor, with room left below it (2.3.1 tour).
  expect(await panelGap(page)).toBeLessThanOrEqual(1);
  // Opened with no terminal: one starts by itself, in the workspace's folder.
  await newTerminal(page);
  await type(page, 'pwd; echo panel-$((6*7))');
  await expect(screen(page)).toContainText(DIR);
  await expect(screen(page)).toContainText('panel-42');
  await lookAt(page, 'desktop-workspace-panel');

  // A second one; the numbers switch between them; the one in front closes.
  await page.getByTestId('panel-term-add').click();
  // Others' sessions on this host are offered first: a new one asked for.
  const ways = page.locator('dialog[open][data-tour=panel-new]');
  if (await ways.waitFor({ timeout: 1500 }).then(() => true, () => false)) await ways.getByTestId('panel-new-ways').getByRole('button', { name: 'New session' }).click();
  await expect(page.getByTestId('panel-session')).toHaveCount(2);
  await expect(page.getByTestId('panel-session').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(screen(page)).not.toContainText('panel-42');
  await page.getByTestId('panel-session').first().click();
  await expect(screen(page)).toContainText('panel-42');
  expect((await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).length).toBe(before + 2);
  await page.getByTestId('panel-session').nth(1).click();
  await page.getByTestId('panel-term-close').click();
  await expect(page.getByTestId('panel-session')).toHaveCount(0);
  await expect(screen(page)).toContainText('panel-42');
  await expect.poll(async () => (await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).length).toBe(before + 1);
  expect((await asked()).some((q) => q.includes('Close session'))).toBe(true);
  // Another way, as the terminal page's + offers it (report 776450): a right click (a long press on a phone), then without tmux.
  const hadIds = new Set((await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).map((s) => s.id));
  await page.getByTestId('panel-term-add').click({ button: 'right' });
  await expect(page.getByTestId('panel-new-ways')).toBeVisible();
  await lookAt(page, 'desktop-panel-new');
  await page.getByTestId('panel-new-tmux').click();
  await expect(page.getByTestId('panel-session')).toHaveCount(2);
  const made = (await api<{ id: string; mode: string }[]>(page, 'GET', '/api/terminal/sessions')).filter((s) => !hadIds.has(s.id));
  expect(made.map((s) => s.mode)).toEqual(['tmux']);
  await page.getByTestId('panel-term-close').click();
  await expect(page.getByTestId('panel-session')).toHaveCount(0);
  // Without tmux, and the default way: each starts its own session.
  for (const [way, mode] of [['Without tmux (ends when it closes)', 'memory'], ['New session', null]] as const) {
    const seen = new Set((await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).map((s) => s.id));
    await page.getByTestId('panel-term-add').click({ button: 'right' });
    await page.getByTestId('panel-new-ways').getByRole('button', { name: way, exact: true }).click();
    await expect(page.getByTestId('panel-session')).toHaveCount(2);
    const fresh = (await api<{ id: string; mode: string }[]>(page, 'GET', '/api/terminal/sessions')).filter((s) => !seen.has(s.id));
    expect(fresh).toHaveLength(1);
    if (mode) expect(fresh[0]!.mode).toBe(mode);
    await page.getByTestId('panel-term-close').click();
    await expect(page.getByTestId('panel-session')).toHaveCount(0);
  }

  // Higher with the arrow keys on the grip.
  const grip = page.getByTestId('panel-grip');
  const was = Number(await grip.getAttribute('aria-valuenow'));
  await grip.focus();
  await page.keyboard.press('ArrowUp');
  await expect(grip).toHaveAttribute('aria-valuenow', String(was + 5));

  // Logs: the stack in this folder, without a choice.
  await page.getByTestId('panel-tab-logs').click();
  await expect(panel(page)).toContainText('v1 up', { timeout: 30_000 });
  // What is shown said on the one button that changes it: "Automatic" beside a Choose read as two more tabs
  // and touched it (reports eeff05, UIA-11).
  await expect(page.getByTestId('panel-logs-choose')).toHaveText('Automatic');
  await expect(page.getByTestId('panel-logs-choose')).toHaveAccessibleName('Choose: Automatic');
  await page.getByTestId('panel-logs-choose').click();
  const dialog = page.locator('dialog[open]');
  // Many containers on the host: a filter narrows the list.
  await dialog.getByTestId('panel-logs-filter').fill('panel-web');
  await expect(dialog.getByTestId('panel-logs-choice')).toHaveCount(1);
  const mine = dialog.getByTestId('panel-logs-choice').filter({ hasText: `${PROJECT}-web-1` });
  await expect(mine).toContainText('Automatic');
  await expect(mine.locator('input')).toBeChecked();
  await lookAt(page, 'desktop-panel-logs');
  // All or none of those the filter shows (the same as every long list).
  await dialog.getByTestId('panel-logs-none').click();
  await expect(mine.locator('input')).not.toBeChecked();
  await dialog.getByTestId('panel-logs-all').click();
  await expect(mine.locator('input')).toBeChecked();
  // Unticked: nothing left to show, and the empty panel says how to choose.
  await mine.locator('input').uncheck();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(panel(page)).toContainText('No containers here');
  await page.getByTestId('panel-logs-empty-choose').click();
  await page.locator('dialog[open]').getByTestId('panel-logs-auto').click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();
  await expect(panel(page)).toContainText('v1 up', { timeout: 30_000 });

  // Kept as it was left: open, on the logs, at that height.
  await page.reload();
  await expect(panel(page)).toContainText('v1 up', { timeout: 30_000 });
  await expect(page.getByTestId('panel-tab-logs')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('panel-grip')).toHaveAttribute('aria-valuenow', String(was + 5));

  // On its own page: the same logs, then the terminal.
  await page.getByTestId('panel-full').click();
  await expect(page).toHaveURL(new RegExp(`#/logs\\?t=${hostId}%3A${PROJECT}-web-1`));
  await page.goBack();
  await page.getByTestId('panel-tab-term').click();
  await expect(screen(page)).toContainText('panel-42');
  await page.getByTestId('panel-full').click();
  await expect(page).toHaveURL(/#\/term\//);
  await page.goBack();

  // The last one closed: the panel offers a new one.
  await page.getByTestId('panel-term-close').click();
  await expect(page.getByTestId('panel-term-new')).toBeVisible();
  await expect.poll(async () => (await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).length).toBe(before);
  await page.getByTestId('panel-term-new').click();
  await expect(screen(page)).toContainText('$', { timeout: 20_000 });

  // Hidden, and still hidden after a reload; its terminal stays on the server.
  await page.getByTestId('panel-hide').click();
  await expect(panel(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('panel-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(panel(page)).toHaveCount(0);
  const left = (await ids()).filter((x) => !had.includes(x));
  expect(left).toHaveLength(1);
  for (const id of left) await api(page, 'DELETE', `/api/terminal/sessions/${id}`);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('workspace panel: a session already running on the host is opened from it, not a new one each time (report eca78a)', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const hostId = await stackHost(page);
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId, root: DIR });
  const ids = async () => (await api<{ id: string; hostId: number }[]>(page, 'GET', '/api/terminal/sessions')).filter((s) => s.hostId === hostId).map((s) => s.id);
  // Two sessions on the host, started elsewhere (the terminal page).
  const one = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId, cwd: DIR });
  const two = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId, cwd: DIR });
  const running = await ids();

  await page.goto(`/#/ws/${ws.id}`);
  await page.getByTestId('panel-toggle').click();
  // Offered, nothing started by itself.
  const rows = panel(page).getByTestId('panel-running').getByTestId('panel-running-open');
  await expect(rows).toHaveCount(running.length);
  await page.waitForTimeout(1500);
  expect(await ids()).toEqual(running);
  await lookAt(page, 'desktop-panel-running');
  // One opened: in the panel, its own shell (no new session).
  await panel(page).getByTestId('panel-running').locator(`[data-session="${one.id}"]`).click();
  await type(page, 'echo opened-$((20+3))');
  await expect(screen(page)).toContainText('opened-23');
  expect(await ids()).toEqual(running);

  // + with more running: the others first, a new one on request.
  await page.getByTestId('panel-term-add').click();
  const dlg = page.locator('dialog[open][data-tour=panel-new]');
  await expect(dlg.locator(`[data-session="${two.id}"]`)).toBeVisible();
  await expect(dlg.locator(`[data-session="${one.id}"]`)).toHaveCount(0);
  await dlg.locator(`[data-session="${two.id}"]`).click();
  await expect(page.getByTestId('panel-session')).toHaveCount(2);
  expect(await ids()).toEqual(running);
  // Others' sessions on this host (other specs) into the panel too, then none
  // is left that is not in it: + starts a new one at once.
  const others = running.filter((x) => x !== one.id && x !== two.id);
  for (let i = 0; i < others.length; i++) {
    await page.getByTestId('panel-term-add').click();
    await dlg.getByTestId('panel-running-open').first().click();
  }
  await expect(page.getByTestId('panel-session')).toHaveCount(running.length);
  await page.getByTestId('panel-term-add').click();
  await expect(page.getByTestId('panel-session')).toHaveCount(running.length + 1);
  await expect(dlg).toHaveCount(0);

  for (const id of await ids()) if (!others.includes(id)) await api(page, 'DELETE', `/api/terminal/sessions/${id}`);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test("workspace panel: the host's stored password typed at a prompt, as on the terminal page (report 35ba91)", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  // docker-real signs in with a password, so Burrow has one to type.
  const hostId = await stackHost(page);
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId, root: DIR });
  const s = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId, cwd: DIR, tmux: 'never' });
  await page.goto(`/#/ws/${ws.id}`);
  await page.getByTestId('panel-toggle').click();
  await panel(page).getByTestId('panel-running').locator(`[data-session="${s.id}"]`).click();
  await expect(screen(page)).toContainText('$', { timeout: 20_000 });
  // A prompt that does not echo, as sudo's: the password typed into it, Enter by the person.
  await type(page, 'read -s pw; echo "got:${#pw}"');
  await panel(page).getByTestId('panel-password').click();
  await expect(page.getByTestId('toasts')).toContainText('Password typed');
  await panel(page).getByTestId('terminal').click();
  await page.keyboard.press('Enter');
  await expect(screen(page)).toContainText(`got:${'burrow-test-password'.length}`);
  await api(page, 'DELETE', `/api/terminal/sessions/${s.id}`);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('workspace panel: the list of sessions could not be read: said with Try again, no shell started by itself (AUDIT2 UI-02)', async ({ page }) => {
  await signIn(page);
  const hostId = await stackHost(page);
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId, root: DIR });
  const before = (await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).map((x) => x.id);
  let fail = true;
  let posts = 0;
  await page.route('**/api/terminal/sessions', (r) => {
    if (r.request().method() === 'POST') posts += 1;
    return fail && r.request().method() === 'GET' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Sessions not read.' } }) : r.fallback();
  });
  await page.goto(`/#/ws/${ws.id}`);
  await page.reload();
  await page.getByTestId('panel-toggle').click();
  await expect(panel(page).getByText('Sessions not read.')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(posts).toBe(0);
  fail = false;
  await panel(page).getByRole('button', { name: 'Try again' }).click();
  await expect(panel(page).getByText('Sessions not read.')).toHaveCount(0);
  await page.unroute('**/api/terminal/sessions');
  await page.getByTestId('panel-toggle').click();
  for (const x of await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')) if (!before.includes(x.id)) await api(page, 'DELETE', `/api/terminal/sessions/${x.id}`);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('stack panel on a low phone screen: the sessions already running scroll in the panel, the last one opened (report ffef5f)', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const hostId = await stackHost(page);
  const had = (await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).map((x) => x.id);
  // More running than the panel's height shows.
  const made: string[] = [];
  for (let i = 0; i < 5; i++) made.push((await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId, cwd: '/tmp' })).id);
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 343, height: 436 }, baseURL: new URL(page.url()).origin });
  const phone = await phoneCtx.newPage();
  await signIn(phone);
  await phone.goto(`/#/stacks/${hostId}/${PROJECT}`);
  await phone.getByTestId('panel-toggle').click();
  const list = panel(phone).getByTestId('panel-running');
  await expect(list.getByTestId('panel-running-open')).not.toHaveCount(0);
  await lookAt(phone, 'phone-stack-panel-running');
  // The last one reached by scrolling the panel, at the height it has, and opened.
  const last = list.locator(`[data-session="${made[made.length - 1]}"]`);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  const body = (await panel(phone).locator('.pbody').boundingBox())!;
  const row = (await last.boundingBox())!;
  expect(row.y + row.height).toBeLessThanOrEqual(body.y + body.height + 1);
  await last.click();
  await expect(screen(phone)).toContainText('$', { timeout: 20_000 });
  await phoneCtx.close();
  for (const s of await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')) if (!had.includes(s.id)) await api(page, 'DELETE', `/api/terminal/sessions/${s.id}`);
});

test('stack panel: docked over the page, a terminal in the stack folder, its containers logs; on a phone too', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await sayYes(page);
  await signIn(page);
  const hostId = await stackHost(page);
  const had = (await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')).map((x) => x.id);
  await page.goto(`/#/stacks/${hostId}/${PROJECT}`);
  await expect(page.getByRole('heading', { name: PROJECT })).toBeVisible();
  await page.getByTestId('panel-toggle').click();
  await newTerminal(page);
  await type(page, 'pwd');
  await expect(screen(page)).toContainText(DIR);
  await page.getByTestId('panel-tab-logs').click();
  await expect(panel(page)).toContainText('v1 up', { timeout: 30_000 });
  // The log's own controls work in the panel as on the logs page.
  const p = panel(page);
  for (const l of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
    const b = p.getByRole('button', { name: l, exact: true });
    const was = await b.getAttribute('aria-pressed');
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', String(was));
  }
  // The line has no level and is stdout: hidden by those filters, back with them undone.
  await p.getByRole('button', { name: 'no level', exact: true }).click();
  await expect(p).not.toContainText('v1 up');
  await p.getByRole('button', { name: 'no level', exact: true }).click();
  await expect(p).toContainText('v1 up');
  await p.getByRole('button', { name: 'stderr', exact: true }).click();
  await expect(p).not.toContainText('v1 up');
  await p.getByRole('button', { name: 'stdout', exact: true }).click();
  await expect(p).toContainText('v1 up');
  await p.getByRole('button', { name: 'all', exact: true }).click();
  await expect(p).toContainText('v1 up');
  await p.getByLabel('Time range').selectOption('1h');
  await expect(p).toContainText('v1 up');
  const rx = p.getByRole('button', { name: 'Regular expression' });
  await rx.click();
  await expect(rx).toHaveAttribute('aria-pressed', 'true');
  await rx.click();
  const download = page.waitForEvent('download');
  await p.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(/^logs-.*\.log$/);
  // The page's end stays reachable above the docked panel.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const box = (await page.locator('.page section.card').last().boundingBox())!;
  const dock = (await panel(page).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(dock.y + 1);
  await lookAt(page, 'desktop-stack-panel');
  await page.getByTestId('panel-hide').click();
  await expect(panel(page)).toHaveCount(0);

  // On a phone: the panel over the page above the tab bar, the terminal with its key bar.
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], baseURL: new URL(page.url()).origin });
  const phone = await phoneCtx.newPage();
  await signIn(phone);
  await phone.goto(`/#/stacks/${hostId}/${PROJECT}`);
  await phone.getByTestId('panel-toggle').click();
  await newTerminal(phone);
  const keys = phone.getByRole('toolbar', { name: 'Extra keys' });
  await expect(keys).toBeVisible();
  // The key bar's keys reach the shell from the panel too.
  const key = (name: string) => keys.getByRole('button', { name, exact: true });
  await panel(phone).getByTestId('terminal').click();
  await phone.keyboard.type('echo a');
  for (const k of ['~', '-', '/']) await key(k).click();
  await key('Left').click();
  await key('Right').click();
  await phone.keyboard.type(' ');
  await key('|').click();
  await phone.keyboard.type(' rev');
  await phone.keyboard.press('Enter');
  // Only the output has it backwards.
  await expect(screen(phone)).toContainText('/-~a');
  await phone.keyboard.type('ech');
  await key('Tab').click();
  await key('Esc').click();
  await key('Ctrl').click();
  await expect(key('Ctrl')).toHaveClass(/\bon\b/);
  await phone.keyboard.type('c');
  await expect(key('Ctrl')).not.toHaveClass(/\bon\b/);
  await expect(screen(phone)).toContainText('^C');
  await key('Alt').click();
  await expect(key('Alt')).toHaveClass(/\bon\b/);
  await key('Alt').click();
  await expect(key('Alt')).not.toHaveClass(/\bon\b/);
  const nav = (await phone.locator('nav.bottomnav').boundingBox())!;
  const docked = (await panel(phone).boundingBox())!;
  expect(docked.y + docked.height).toBeLessThanOrEqual(nav.y + 1);
  await lookAt(phone, 'phone-stack-panel');
  // The keyboard up (e03c6e/f18108 class, untested in the panel): the panel's
  // terminal keeps a few rows, the line being typed and the key bar in sight.
  await phone.keyboard.type('echo kb-$((20+1))');
  await phone.setViewportSize({ width: 412, height: 450 });
  await expect(keys).toBeInViewport();
  // The panel takes the screen while typing there, as the terminal page keeps its height (it left three rows).
  await expect.poll(async () => (await panel(phone).getByTestId('terminal').boundingBox())?.height ?? 0, { message: 'room for the panel terminal' }).toBeGreaterThan(450 * 0.55);
  const cursorSeen = async () => {
    const t = (await panel(phone).getByTestId('terminal').boundingBox())!;
    const c = (await panel(phone).locator('.xterm-helper-textarea').boundingBox())!;
    return c.y >= t.y - 1 && c.y + 10 <= t.y + t.height && t.y + t.height <= 450;
  };
  await expect.poll(cursorSeen, { message: 'the typed line in sight' }).toBe(true);
  await lookAt(phone, 'phone-stack-panel-keyboard');
  await phone.keyboard.press('Enter');
  await expect(screen(phone)).toContainText('kb-21');
  await phone.setViewportSize({ width: 412, height: 839 });
  // The keyboard down: docked above the tab bar again.
  await expect.poll(async () => (await panel(phone).boundingBox())!.y + (await panel(phone).boundingBox())!.height <= (await phone.locator('nav.bottomnav').boundingBox())!.y + 1).toBe(true);
  await phone.getByTestId('panel-tab-logs').click();
  await expect(panel(phone)).toContainText('v1 up', { timeout: 30_000 });
  // On a phone the source button is an icon beside the two tabs, whole, not a cut third tab (UIA-11).
  await expect(panel(phone).getByTestId('panel-logs-choose')).toBeInViewport({ ratio: 1 });
  await expect(panel(phone).getByTestId('panel-logs-choose')).toHaveText('', { useInnerText: true });
  await lookAt(phone, 'phone-stack-panel-logs');
  await phoneCtx.close();

  for (const s of await api<{ id: string }[]>(page, 'GET', '/api/terminal/sessions')) if (!had.includes(s.id)) await api(page, 'DELETE', `/api/terminal/sessions/${s.id}`);
  // Left as it was: the stack stopped, its folder gone.
  await api(page, 'POST', '/api/snippets/run', { hostIds: [hostId], command: `cd ${DIR} && docker compose -p ${PROJECT} down -v 2>&1; rm -rf ${DIR}` });
});
