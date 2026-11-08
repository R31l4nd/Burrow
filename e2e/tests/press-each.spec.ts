import { expect, test, type Page } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { sayYes } from './confirm.js';
import { signIn } from './passkey.js';
import { lookAt, SOME_PASSES } from './checks.js';

const ALPINE = 'alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f';

// The controls no other test pressed (e2e/controls-todo.json), each pressed
// on purpose and what it does checked: after all the other tests, so what
// they made is there (alerts, analyses, apps, workspaces), and before
// press-all, which removes things.

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

let real = 0;
let sshd = 0;
test.beforeEach(async ({ page }) => {
  await sayYes(page);
  await signIn(page);
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  real = hosts.find((h) => h.name === 'docker-real')?.id ?? sshd;
});

test('a press counts only with an effect: a button that does nothing is not pressed (AUDIT2 TEST-06)', async ({ page }) => {
  // A page of the test's own on Burrow's origin, so nothing else moves meanwhile: one button does nothing, one changes the page.
  await page.route('**/press-probe.html', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><button type="button" aria-label="Probe nothing">a</button><button type="button" aria-label="Probe something" onclick="this.nextElementSibling.textContent = 1">b</button><span></span></body></html>' }));
  await page.goto('/press-probe.html');
  const effective = () => page.evaluate(() => (window as unknown as { __effective: string[] }).__effective);
  await page.getByRole('button', { name: 'Probe nothing' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Probe something' }).click();
  await expect.poll(effective).toContain('hosts:button:Probe something');
  expect(await effective()).not.toContain('hosts:button:Probe nothing');
  await page.unroute('**/press-probe.html');
});

// A folder of this spec's own on test-sshd, with a compose file in it.
const OWN = '/home/tester/press-each';
async function ownFolder(page: Page): Promise<void> {
  const [r] = await api<{ exitCode: number; stderr: string }[]>(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: `mkdir -p ${OWN} && printf 'services:\\n  web:\\n    image: nginx\\n' > ${OWN}/compose.yaml`,
  });
  expect(r!.exitCode, r!.stderr).toBe(0);
}

test('alerts: the row, its last lines, muting for a while', async ({ page }) => {
  // An alert of its own: a container on docker-real that crashes.
  const crash = 'docker rm -fv burrowtest-e2ecrash >/dev/null 2>&1';
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [real],
    command: `${crash}; docker run -d --label burrow.ignore=true --name burrowtest-e2ecrash ${ALPINE} sh -c 'echo "ERROR lost the queue"; sleep 1; exit 4' >/dev/null`,
  });
  await expect.poll(async () => (await api<{ container: string }[]>(page, 'GET', '/api/alerts')).some((a) => a.container === 'burrowtest-e2ecrash'), { timeout: 30_000 }).toBe(true);
  await api(page, 'POST', '/api/snippets/run', { hostIds: [real], command: `${crash}; true` });
  await page.goto('/#/alerts');
  const row = page.getByTestId('alert').first();
  await expect(row).toBeVisible();
  // The last lines open the logs at that moment; so does the row.
  await row.getByTestId('alert-detail').click();
  await expect(page).toHaveURL(/#\/logs\?/);
  await page.goto('/#/alerts');
  await page.getByTestId('alert').first().getByTestId('alert-open').click();
  await expect(page).toHaveURL(/#\/logs\?/);
  // Muted for a while, each length once; the mute is listed and lifted again.
  for (const length of [/^For \d+ hours?$/, /^For a day$/, /^Until I unmute it$/]) {
    await page.goto('/#/alerts');
    await fromRowMenu(page.getByTestId('alert').first(), 'alert-menu', 'alert-mute');
    await page.getByRole('dialog').getByRole('button', { name: length }).first().click();
    await expect(page.getByRole('button', { name: 'Unmute' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Unmute' }).first().click();
  }
});

test('apps: edit, the form left alone, tiles, the order, discovery by host', async ({ page }) => {
  await page.goto('/#/apps');
  // A tile opens its app (framed here, in its own tab there).
  const popup = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await page.getByTestId('app-tile').first().click();
  await popup.then((p) => p?.close());
  await page.goto('/#/apps');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByTestId('app-edit').first().click();
  const form = page.getByRole('dialog');
  await form.getByRole('checkbox', { name: 'Show on the apps page' }).click();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toBeHidden();
  // The grip moves an app with the arrow keys, and back: the order changes and comes back (AUDIT2 TEST-06: pressed, not seen to work).
  const names = () => page.getByTestId('app-edit').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const before = await names();
  const grip = page.getByTestId('app-grip').first();
  await grip.click();
  await grip.press('ArrowDown');
  await expect.poll(names).toEqual([before[1], before[0], ...before.slice(2)]);
  await page.getByTestId('app-grip').nth(1).press('ArrowUp');
  await expect.poll(names).toEqual(before);
  // Found in containers, on one host: added.
  await page.getByRole('button', { name: 'Find in containers' }).click();
  const found = page.getByRole('dialog');
  // A host to choose only when apps were found on more than one.
  const pick = found.getByTestId('discover-host');
  if (await pick.count()) await pick.selectOption({ index: 1 });
  const add = found.getByRole('button', { name: 'Add', exact: true }).first();
  if (await add.count()) {
    const had = (await names()).length;
    await add.click();
    await expect.poll(async () => (await names()).length).toBe(had + 1);
  }
});

test('a container: its state line, its logs as JSON, downloaded, the earlier analyses', async ({ page }) => {
  await page.goto(`/#/containers/${real}/burrowtest-web`);
  await page.getByTestId('container-info').click();
  await expect(page.getByTestId('container-info')).toHaveAttribute('aria-expanded', 'true');
  // Its CPU and memory kept on the server (report 428102): by now the five-minute sampler has
  // run on this host, so both charts; asked for a week, the same samples.
  const kept = page.getByTestId('container-history');
  await expect(kept.getByTestId('container-chart')).toHaveCount(2, { timeout: 15_000 });
  const asked = page.waitForResponse((r) => r.url().includes('/containers/burrowtest-web/history?range=week'));
  await kept.getByTestId('container-history-range').selectOption('week');
  expect((await asked).ok()).toBe(true);
  await expect(kept.getByTestId('container-chart')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByTestId('log-options').click();
  await page.getByTestId('container-menu').getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(/burrowtest-web.*\.(log|txt)$/);
  // A line that is JSON opens up (the web service logs JSON).
  const json = page.getByTestId('log-json').first();
  await expect(json).toBeVisible({ timeout: 15_000 });
  await json.click();
  const close = page.getByTestId('log-json-close');
  await expect(close).toHaveCount(1);
  await close.click();
  await expect(close).toHaveCount(0);
});

test('a log address with a time that is none: the latest lines, and said so (AUDIT2 PAGE-34)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const at of ['not-a-time', '%2B275760-09-13T00:00:00Z']) {
    await page.goto(`/#/logs?t=${sshd}:burrowtest-trace&at=${at}`);
    await expect(page.getByTestId('logs-bad-time')).toBeVisible();
    await expect(page.getByTestId('log-line').filter({ hasText: 'INFO next' })).toBeVisible({ timeout: 20_000 });
  }
  expect(errors).toEqual([]);
});

test("a stack trace is one event: its frames folded under its first line, opened by a tap", async ({ page }) => {
  // The test sshd's docker logs a Java stack trace for a container named so.
  await page.goto(`/#/logs?t=${sshd}:burrowtest-trace`);
  const head = page.getByTestId('log-line').filter({ hasText: 'IllegalStateException' });
  await expect(head).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('log-line').filter({ hasText: 'INFO next' })).toBeVisible();
  await expect(page.getByTestId('log-line').filter({ hasText: 'B.java:1' })).toHaveCount(0);
  const more = head.getByTestId('log-stack');
  await expect(more).toHaveText('+3 lines');
  await more.click();
  await expect(page.getByTestId('log-line').filter({ hasText: 'B.java:1' })).toBeVisible();
  await expect(page.getByTestId('log-line').filter({ hasText: 'Caused by' })).toBeVisible();
  await lookAt(page, 'desktop-log-stack');
  await more.click();
  await expect(page.getByTestId('log-line').filter({ hasText: 'B.java:1' })).toHaveCount(0);
});

test("live logs whose connection drops: said so, connected again, nothing shown twice", async ({ page }) => {
  // Audit WC-10: the lines stayed on screen as if live, and no more came.
  const sockets: { close(): void }[] = [];
  const urls: string[] = [];
  await page.routeWebSocket(/\/api\/docker\/logs\/ws/, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
    urls.push(ws.url());
  });
  // A new document: the route takes only sockets of pages loaded after it.
  await page.goto(`/#/logs?t=${sshd}:burrowtest-trace`);
  // Only the reloaded document's: one of the page before could be closed
  // instead, and nothing would show (AUDIT2 TEST-11).
  sockets.length = 0;
  await page.reload();
  const next = page.getByTestId('log-line').filter({ hasText: 'INFO next' });
  await expect(next).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('log-reconnecting')).toHaveCount(0);
  expect(sockets).toHaveLength(1);
  // Gone from under it (a restart, the network).
  sockets[0]!.close();
  await expect(page.getByTestId('log-reconnecting')).toBeVisible();
  // Back by itself: the badge goes, the same lines once.
  await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('log-reconnecting')).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await expect(next).toHaveCount(1);
  // From where the lines stopped, not the last 500 again (AUDIT2 UI-09).
  expect(new URL(urls.at(-1)!).searchParams.get('since')).toMatch(/^\d{4}-\d\d-\d\dT/);
  await page.unrouteAll();
});

test('one log that fails and then ends: the failure stays said; one that just ends says no more lines come (AUDIT2 UI-10)', async ({ page }) => {
  let mode: 'error' | 'end' = 'error';
  await page.routeWebSocket(/\/api\/docker\/logs\/ws/, (ws) => {
    if (mode === 'error') ws.send(JSON.stringify({ t: 'error', i: 0, message: 'docker logs failed here' }));
    ws.send(JSON.stringify({ t: 'end', i: 0 }));
  });
  await page.goto(`/#/logs?t=${sshd}:burrowtest-trace`);
  await page.reload();
  await expect(page.getByText('docker logs failed here')).toBeVisible();
  await expect(page.getByTestId('log-ended')).toHaveCount(0);
  mode = 'end';
  await page.reload();
  await expect(page.getByTestId('log-ended')).toBeVisible();
  await page.unrouteAll();
});

test('a log line picked with the keyboard: arrows, then its Pin with Enter (AUDIT2 UI-27)', async ({ page }) => {
  await page.goto(`/#/logs?t=${sshd}:burrowtest-trace`);
  await expect(page.getByTestId('log-line').filter({ hasText: 'INFO next' })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('log').focus();
  await page.keyboard.press('ArrowDown');
  const picked = page.locator('[data-testid=log-line].sel');
  await expect(picked).toHaveCount(1);
  // Its actions are buttons a keyboard reaches; Pin pressed with Enter.
  await picked.getByRole('button', { name: 'Pin', exact: true }).press('Enter');
  await expect(picked.getByRole('img', { name: 'pinned' })).toBeVisible();
  await page.getByTestId('log').focus();
  await page.keyboard.press('Escape');
  await expect(picked).toHaveCount(0);
});

test('the merged log: one source hidden and shown again', async ({ page }) => {
  await page.goto(`/#/logs?t=${real}:burrowtest-web,${real}:burrowtest-worker`);
  const src = page.getByTestId('log-source').first();
  // Its lines go and come back, the other source's stay (AUDIT2 TEST-06: aria-pressed alone proved no filter).
  const own = page.locator('[data-testid=log-line][data-src="0"]');
  const other = page.locator('[data-testid=log-line][data-src="1"]');
  await expect(own.first()).toBeVisible({ timeout: 20_000 });
  await expect(other.first()).toBeVisible({ timeout: 20_000 });
  await src.click();
  await expect(src).toHaveAttribute('aria-pressed', 'false');
  await expect(own).toHaveCount(0);
  await expect(other.first()).toBeVisible();
  await src.click();
  await expect(src).toHaveAttribute('aria-pressed', 'true');
  await expect(own.first()).toBeVisible();
});

test('a question about the logs in words: the model sets the same filters, the note says so, Undo puts them back (N6)', async ({ page }) => {
  await api(page, 'PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1', model: 'fake-model' } });
  await page.goto(`/#/logs?t=${real}:burrowtest-web,${real}:burrowtest-worker`);
  const own = page.locator('[data-testid=log-line][data-src="0"]');
  const other = page.locator('[data-testid=log-line][data-src="1"]');
  await expect(own.first()).toBeVisible({ timeout: 20_000 });
  await expect(other.first()).toBeVisible({ timeout: 20_000 });
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/ai/logfilter'));
  // On a wide screen the filters are open; the ask button is among them.
  await page.getByTestId('log-ask-open').click();
  await page.getByTestId('log-ask').fill('timeouts from the web container');
  await page.getByTestId('log-ask-go').click();
  // Only the question and the source names went out, no line.
  const body = (await sent).postDataJSON() as { prompt: string; sources: string[] };
  expect(body.prompt).toBe('timeouts from the web container');
  expect(body.sources).toHaveLength(2);
  expect(JSON.stringify(body)).not.toContain('upstream timeout');
  // The fake model: "timeout", errors only, the first source. Set on the controls themselves.
  await expect(page.getByTestId('log-ask-note')).toContainText('Errors with timeout from the first source.');
  await expect(page.locator('.lsearch input')).toHaveValue('timeout');
  await expect(page.getByTestId('log-source').nth(1)).toHaveAttribute('aria-pressed', 'false');
  await expect(other).toHaveCount(0);
  await expect(own.first()).toContainText('timeout');
  await lookAt(page, 'desktop-log-asked', { passes: SOME_PASSES['log-asked']!.passes });
  // On a phone the note is cut to its line; a tap shows all of it.
  await page.getByTestId('log-ask-text').click();
  await expect(page.getByTestId('log-ask-note')).toHaveClass(/open/);
  await page.getByTestId('log-ask-undo').click();
  await expect(page.getByTestId('log-ask-note')).toHaveCount(0);
  await expect(page.locator('.lsearch input')).toHaveValue('');
  await expect(other.first()).toBeVisible();
});

test('the editor on a phone: its tools and find and replace', async ({ page }) => {
  await ownFolder(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent(`${OWN}/compose.yaml`)}`);
  await expect(page.locator('.cm-line').first()).toBeVisible();
  for (const name of ['Fold everything', 'Unfold everything', 'Format', 'Find in this file']) {
    await page.getByTestId('editor-menu').click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  }
  // The find panel (Find in this file opened it): every option and way.
  const panel = page.locator('.cm-search');
  await expect(panel).toBeVisible();
  await panel.locator('input[name=search]').fill('image');
  // The options are toggles: pressed on, pressed off again.
  for (const name of ['Match case', 'Regular expression', 'Whole words']) {
    const toggle = panel.getByRole('button', { name, exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  }
  const count = page.getByTestId('editor-find-count');
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(count).toHaveText('1 of 1');
  await page.locator('.cm-content').press('Control+Home');
  await expect(count).toHaveText('1 match');
  await panel.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(count).toHaveText('1 of 1');
  await expect(page.locator('.cm-searchMatch').first()).toBeVisible();
  // Alt+Enter in the field: every match selected (VS Code's way; the panel has no button for it).
  await panel.locator('input[name=search]').press('Alt+Enter');
  await expect(page.locator('.cm-selectionBackground').first()).toBeVisible();
  // Replace is a row of its own, asked for; This one takes one, All the rest: different words, so the text shows it.
  await expect(panel.locator('input[name=replace]')).toHaveCount(0);
  await panel.getByTestId('editor-find-replace').click();
  const text = page.locator('.cm-content');
  await panel.locator('input[name=replace]').fill('picture');
  await panel.getByRole('button', { name: 'Replace this one', exact: true }).click();
  await expect(text).toContainText('picture');
  await panel.locator('input[name=replace]').fill('photo');
  await panel.locator('input[name=search]').fill('picture');
  await panel.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(text).toContainText('photo');
  await expect(text).not.toContainText('picture');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
});

test("a report's fix: its dialog closed without running", async ({ page }) => {
  const reports = await api<{ id: number }[]>(page, 'GET', '/api/reports');
  for (const r of reports) {
    await page.goto(`/#/reports/${r.id}`);
    const fix = page.getByTestId('fix-open').first();
    if (!(await fix.isVisible().catch(() => false))) continue;
    await fix.click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('button.btn', { hasText: 'Close' }).click();
    await expect(dlg).toBeHidden();
    return;
  }
  throw new Error('no report with a fix to open');
});

test('a workspace: quick open, its tabs switched and closed', async ({ page }) => {
  // The editor spec's own workspace by its folder, not whichever is first (other specs add theirs).
  const ws = (await api<{ id: number; root: string }[]>(page, 'GET', '/api/workspaces')).find((w) => w.root.endsWith('/proj'))!;
  await page.goto(`/#/ws/${ws.id}`);
  await page.getByTestId('ws-quick').click();
  const list = page.getByRole('dialog');
  const first = list.locator('.list-item').first();
  const name = (await first.textContent())!.trim();
  await first.click();
  await expect(list).toBeHidden();
  await expect(page.getByTestId('ws-tab')).toHaveCount(1);
  // Another file than the one open: the list may put the recent one first (it went flaky taking the second row).
  await page.getByTestId('ws-quick').click();
  await expect(list.locator('.list-item').nth(1)).toBeVisible();
  await list.locator('.list-item').filter({ hasNotText: name }).first().click();
  await expect(page.getByTestId('ws-tab')).toHaveCount(2);
  await page.getByTestId('ws-tab').first().click();
  await page.getByTestId('ws-tab-close').first().click();
  await expect(page.getByTestId('ws-tab')).toHaveCount(1);
});

test('the paired phone: choosing its hosts, then not', async ({ page }) => {
  await page.goto('/#/settings/android');
  await page.getByRole('button', { name: 'Choose hosts' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toBeHidden();
});

test('a problem report without its picture', async ({ page }) => {
  await page.goto('/#/hosts');
  await page.keyboard.press('Control+Shift+B');
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  await form.getByRole('checkbox', { name: 'Send this screenshot along' }).uncheck();
  await expect(form.getByRole('img', { name: 'The screen when you started the report' })).toHaveCount(0);
  await form.getByRole('button', { name: 'Cancel' }).click();
});

test("an e-mail channel's topics", async ({ page }) => {
  await page.goto('/#/settings?s=channels');
  // The channels' own rows (the side column's "Notification channels" says e-mail too).
  await fromRowMenu(page.getByTestId('channel').filter({ hasText: 'E-mail' }).first(), 'channel-menu', 'channel-edit');
  const form = page.getByRole('dialog');
  const topic = form.getByRole('checkbox', { name: 'image updates' });
  const was = await topic.isChecked();
  await topic.click();
  await expect(topic).toBeChecked({ checked: !was });
  await topic.click();
  await expect(topic).toBeChecked({ checked: was });
  const tls = form.getByRole('checkbox', { name: /^TLS from the start/ });
  await tls.click();
  await tls.click();
  await form.getByRole('button', { name: 'Cancel' }).click();
});

test('asked to confirm, not now: nothing happens', async ({ page }) => {
  await page.route('**/api/docker/*/containers/*/inspect', (r) => r.fulfill({ status: 403, json: { error: 'step_up_required' } }));
  await page.goto(`/#/containers/${real}/burrowtest-web`);
  await page.getByTestId('log-options').click();
  await page.getByRole('button', { name: 'Inspect' }).click();
  const ask = page.getByRole('dialog', { name: "Confirm it's you" });
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
});

test("a terminal's search, and the host's stored password typed", async ({ page }) => {
  // docker-real signs in with a password, so Burrow has one to type.
  const s = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId: real, tmux: 'never' });
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.getByTestId('terminal').click();
  await page.keyboard.type('echo find-me; echo Find-Me\n');
  await page.keyboard.press('Control+Shift+F');
  const bar = page.getByTestId('term-search');
  await bar.getByRole('textbox').fill('find-me');
  await bar.getByRole('button', { name: 'Match case' }).click();
  await bar.getByRole('button', { name: 'Previous' }).click();
  await bar.getByRole('button', { name: 'Close' }).click();
  await expect(bar).toHaveCount(0);
  // The stored password, typed into a prompt that does not echo it.
  await page.getByTestId('terminal').click();
  await page.keyboard.type('read -s pw; echo "got:${#pw}"\n');
  await page.getByRole('button', { name: 'Type stored password' }).click();
  await page.keyboard.press('Enter');
  // Its length, the whole of it: got:0 (nothing typed) fails (AUDIT2 TEST-16).
  await expect(rows).toContainText(`got:${'burrow-test-password'.length}`);
  await api(page, 'DELETE', `/api/terminal/sessions/${s.id}`);
});

test("a stack's logs, and the activity list closed", async ({ page }) => {
  await page.goto(`/#/stacks/${real}/burrowtest`);
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page).toHaveURL(/#\/logs\?/);
  await page.route('**/api/docker/activity', (r) => r.fulfill({ json: { ops: [{ id: 'x1', hostId: real, project: 'burrowtest', op: 'pull', startedAt: new Date().toISOString(), exitCode: null }], check: null } }));
  await page.goto('/#/hosts');
  await page.getByTestId('transfers-pill').click({ timeout: 15_000 });
  await page.getByTestId('transfers').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('transfers')).toHaveCount(0);
});

test('the question taken to Claude or ChatGPT: each link takes the click and opens there', async ({ page, context }) => {
  // Reported: on a desktop the links did nothing. Here they get the click
  // (nothing on top of them) and open the site with the masked question.
  await context.route(/^https:\/\/(claude\.ai|chatgpt\.com)\//, (r) => r.fulfill({ contentType: 'text/html', body: '<title>away</title>' }));
  await page.goto(`/#/logs?t=${real}:burrowtest-web,${real}:burrowtest-worker`);
  await page.getByTestId('analyze-open').click();
  for (const [name, url] of [['Claude', /^https:\/\/claude\.ai\/new\?q=.+/], ['ChatGPT', /^https:\/\/chatgpt\.com\/\?q=.+/]] as const) {
    const link = page.getByTestId('analyze-elsewhere').getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('href', url, { timeout: 15_000 });
    const popup = context.waitForEvent('page');
    await link.click();
    const opened = await popup;
    expect(opened.url()).toMatch(url);
    await opened.close();
  }
});

test('a server newer than this page: Reload loads the new one', async ({ page }) => {
  await page.route('**/api/version', (r) => r.fulfill({ json: { server: '99.0.0' } }));
  await page.goto('/#/settings/about');
  await page.evaluate(() => ((window as unknown as { before: boolean }).before = true));
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { before?: boolean }).before ?? false)).toBe(false);
});

test("a folder's menu: hidden files, the grid, the order, upload, a terminal there", async ({ page }) => {
  await page.goto(`/#/files/${sshd}?p=~`);
  const list = page.getByTestId('file-list');
  await expect(list).toBeVisible();
  const menu = async () => (await page.getByRole('button', { name: 'Folder menu' }).click(), page.getByRole('dialog'));
  // The dot files come and go.
  let sheet = await menu();
  await sheet.getByRole('checkbox', { name: 'Show hidden files' }).check();
  await page.keyboard.press('Escape');
  await expect(list.getByText(/^\.\w/).first()).toBeVisible();
  sheet = await menu();
  await sheet.getByRole('checkbox', { name: 'Show hidden files' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(list.getByText(/^\.\w/)).toHaveCount(0);
  // The grid, and back to the list.
  sheet = await menu();
  await sheet.getByRole('checkbox', { name: 'Grid view' }).check();
  await page.keyboard.press('Escape');
  await expect(list).toHaveClass(/grid/);
  sheet = await menu();
  await sheet.getByRole('checkbox', { name: 'Grid view' }).uncheck();
  // The order, and back to by name.
  await sheet.getByLabel('Sort by').selectOption('size');
  await sheet.getByLabel('Sort by').selectOption('name');
  await page.keyboard.press('Escape');
  await expect(list).not.toHaveClass(/grid/);
  // Upload asks for files.
  sheet = await menu();
  const chooser = page.waitForEvent('filechooser');
  await sheet.getByRole('button', { name: 'Upload', exact: true }).click();
  await chooser;
  // A terminal in this folder.
  sheet = await menu();
  await sheet.getByRole('button', { name: 'Terminal here' }).click();
  await expect(page).toHaveURL(/#\/term\/[\w-]+/);
  const id = page.url().split('/term/')[1]!.split(/[?#]/)[0]!;
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  await api(page, 'DELETE', `/api/terminal/sessions/${id}`);
});

test('a command of its own, from the snippets: the hosts chosen and not', async ({ page }) => {
  await page.goto('/#/snippets');
  await page.getByTestId('adhoc-run').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByTestId('adhoc-command')).toBeVisible();
  const host = dlg.getByRole('checkbox', { name: /test-sshd/ }).first();
  await host.check();
  await expect(dlg.getByRole('button', { name: /^Run on 1 host\b/ })).toBeVisible();
  await host.uncheck();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
});

test('a workspace removed from the list; its folder stays', async ({ page }) => {
  await ownFolder(page);
  const made = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: OWN });
  await page.goto('/#/files');
  const before = await api<{ id: number }[]>(page, 'GET', '/api/workspaces');
  await page.getByTestId('ws-remove').nth(before.findIndex((w) => w.id === made.id)).click();
  await expect.poll(async () => (await api<{ id: number }[]>(page, 'GET', '/api/workspaces')).some((w) => w.id === made.id)).toBe(false);
});

test('on a phone: a framed app reloaded, a folder\'s menu and a workspace from the files', async ({ page }) => {
  await ownFolder(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // The framed app: Reload puts a fresh frame in.
  const apps = await api<{ id: number; embeddable: string }[]>(page, 'GET', '/api/apps');
  const framed = apps.find((a) => a.embeddable === 'yes');
  if (framed) {
    await page.goto(`/#/apps/${framed.id}`);
    const frame = page.locator('iframe').first();
    await expect(frame).toBeVisible();
    await frame.evaluate((f) => ((f as HTMLIFrameElement & { old?: boolean }).old = true));
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect.poll(() => page.locator('iframe').first().evaluate((f) => (f as HTMLIFrameElement & { old?: boolean }).old ?? false)).toBe(false);
  }
  // A folder's own menu, from its row.
  await page.goto(`/#/files/${sshd}?p=~`);
  const row = page.getByTestId('file-row').filter({ hasText: 'press-each' });
  await row.getByTestId('file-menu').click();
  await expect(page.getByRole('dialog', { name: 'press-each' })).toBeVisible();
  await page.keyboard.press('Escape');
  // And the folder itself, opened from its row.
  await row.getByTestId('file-open').click();
  await expect(page).toHaveURL(/press-each/);
  // A workspace, opened from the files' start.
  const ws = await api<{ id: number; name: string }[]>(page, 'GET', '/api/workspaces');
  await page.goto('/#/files');
  await page.getByRole('button', { name: new RegExp(`^${ws[0]!.name}\\b`) }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/ws/${ws[0]!.id}`));
});

test('a file compressed from its menu', async ({ page }) => {
  await ownFolder(page);
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: `rm -f ${OWN}/compose.yaml.tar.gz` });
  await page.goto(`/#/files/${sshd}?p=${encodeURIComponent(OWN)}`);
  await page.getByTestId('file-row').filter({ has: page.getByText('compose.yaml', { exact: true }) }).getByTestId('file-menu').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Compress (.tar.gz)' }).click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'compose.yaml.tar.gz' })).toBeVisible({ timeout: 20_000 });
});

test('not Burrow answering (a proxy page while it restarts): an error, then the sessions again', async ({ page }) => {
  // Reported: SWAG's "domain not available" page (status 200) came back for
  // the list while Burrow restarted; the app kept it and the tab stayed broken.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let proxy = true;
  await page.route('**/api/terminal/sessions', (r) =>
    proxy ? r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Domein niet beschikbaar</title>' }) : r.continue(),
  );
  await page.goto('/#/term');
  await expect(page.getByTestId('sessions-error')).toBeVisible();
  // Burrow back: the next read (every few seconds) shows the list again.
  proxy = false;
  await expect(page.getByTestId('sessions-error')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  expect(errors).toEqual([]);
});
