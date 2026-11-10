import { devices, expect, test, type Page } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { lookAt, WIDE_ONLY } from './checks.js';
import { fillSettled, signIn } from './passkey.js';

// Phase 1: laptop and phone in the same session; closing the tab and
// opening it again shows the same screen.

const screen = (page: Page) => page.locator('[data-testid=terminal] .xterm-rows');

async function type(page: Page, text: string) {
  await page.getByTestId('terminal').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('laptop and phone share one session that survives closing the tab', async ({ page, browser }) => {
  await signIn(page);

  // One tap on the host opens a terminal.
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(page).toHaveURL(/#\/term\//);
  const url = page.url();
  await expect(page.locator('.badge', { hasText: 'tmux' })).toBeVisible();
  await type(page, 'echo laptop-$((6*7))');
  await expect(screen(page)).toContainText('laptop-42');
  // Searched in what the terminal shows: Ctrl+Shift+F (Ctrl+F stays the shell's).
  await page.getByTestId('terminal').click();
  await page.keyboard.press('Control+Shift+F');
  await page.getByTestId('term-search-input').fill('laptop-42');
  await expect(page.getByTestId('term-search')).toContainText(/1 of [12]/);
  await page.getByTestId('term-search-next').click();
  await lookAt(page, 'terminal-search');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('term-search')).toHaveCount(0);
  // And from the menu, as on a phone.
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('term-search-open').click();
  await expect(page.getByTestId('term-search-input')).toBeFocused();
  await page.keyboard.press('Escape');

  // The laptop's list of sessions stays open while the phone joins: it
  // shows both devices (it said "no device connected", read only once).
  await page.getByRole('button', { name: 'Sessions' }).click();
  const row = page.getByTestId('session-row').filter({ has: page.locator('.badge') });

  // The phone joins the same session and sees the same screen.
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], baseURL: new URL(url).origin });
  const phone = await phoneCtx.newPage();
  await signIn(phone);
  await phone.goto(url);
  await expect(screen(phone)).toContainText('laptop-42');
  await expect(page.getByTestId('viewer-count')).toHaveText('2 devices');
  await expect(row).toContainText(', ', { timeout: 10_000 });
  await expect(row).not.toContainText('no device connected');
  await page.keyboard.press('Escape');

  // What the phone types, the laptop sees.
  await type(phone, 'echo phone-$((2*3))');
  await expect(screen(page)).toContainText('phone-6');

  // Close the laptop tab, open it again: the same screen is back.
  const laptop = page.context();
  await page.close();
  const again = await laptop.newPage();
  await again.goto(url);
  await expect(screen(again)).toContainText('laptop-42');
  await expect(screen(again)).toContainText('phone-6');

  // The session list shows it once, with both devices' history intact.
  await again.getByRole('button', { name: 'Sessions' }).click();
  await expect(again.getByTestId('session-row')).toHaveCount(1);
  await again.getByRole('button', { name: 'Close', exact: true }).click();

  // The key bar: Ctrl then c interrupts a running command.
  await type(phone, 'sleep 30');
  await phone.getByRole('toolbar', { name: 'Extra keys' }).getByRole('button', { name: 'Ctrl' }).tap();
  await phone.getByTestId('terminal').click();
  await phone.keyboard.type('c');
  await type(phone, 'echo after-interrupt');
  await expect(screen(again)).toContainText('after-interrupt');

  await phoneCtx.close();
});

test('snippets with a variable run in the terminal and on several hosts', async ({ page }) => {
  await signIn(page);
  // Snippets moved from the main bar to Settings (and the terminal's snippet button).
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^Snippets/ }).click();
  await page.getByRole('button', { name: 'New snippet' }).click();
  await fillSettled(page.getByLabel('Name'), 'greet');
  await page.locator('textarea[name=command]').fill('echo hello-{{who}}');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('snippet-row')).toContainText('greet');

  // On several hosts at once, output per host.
  await fromRowMenu(page.getByTestId('snippet-row').filter({ hasText: 'greet' }), 'snippet-menu', 'snippet-run');
  await page.getByLabel('who').fill('everyone');
  await page.getByRole('dialog').locator('label', { hasText: 'test-sshd' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: /Run on 1 host\b/ }).click();
  await expect(page.getByTestId('run-result')).toContainText('hello-everyone');
  await page.getByRole('button', { name: 'Close' }).click();

  // Choices, a value to start with and one that may stay empty.
  await page.getByRole('button', { name: 'New snippet' }).click();
  await fillSettled(page.getByLabel('Name'), 'choose');
  await page.locator('textarea[name=command]').fill('echo {{mood=calm|loud}}-{{to=world}}-{{tail=}}end');
  await page.getByRole('button', { name: 'Save' }).click();
  await fromRowMenu(page.getByTestId('snippet-row').filter({ hasText: 'choose' }), 'snippet-menu', 'snippet-run');
  const vars = page.getByRole('dialog').getByTestId('snippet-var');
  await expect(vars).toHaveCount(3);
  await expect(page.getByLabel('mood')).toHaveValue('calm');
  await expect(page.getByLabel('to', { exact: true })).toHaveValue('world');
  await expect(page.getByLabel('tail (optional)')).toHaveValue('');
  await page.getByLabel('mood').selectOption('loud');
  await page.getByRole('dialog').locator('label', { hasText: 'test-sshd' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: /Run on 1 host\b/ }).click();
  await expect(page.getByTestId('run-result')).toContainText('loud-world-end');
  // A field changed after: the output says which command it is of (AUDIT2 PAGE-28).
  await expect(page.getByTestId('run-ran')).toHaveCount(0);
  await page.getByLabel('to', { exact: true }).fill('moon');
  await expect(page.getByTestId('run-ran')).toHaveText('Output of: echo loud-world-end');
  await page.getByRole('button', { name: 'Close' }).click();

  // {{container}}: the running containers of the hosts ticked, offered to pick from.
  const made = await page.evaluate(async () => (await (await fetch('/api/snippets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'container logs', command: 'docker logs --tail 5 {{container}}' }) })).json()) as { id: number });
  await page.reload();
  await fromRowMenu(page.getByTestId('snippet-row').filter({ hasText: 'container logs' }), 'snippet-menu', 'snippet-run');
  const offered = page.getByRole('dialog').locator('datalist option');
  await expect(offered).toHaveCount(0);
  await page.getByRole('dialog').locator('label', { hasText: 'test-sshd' }).getByRole('checkbox').check();
  await expect(page.getByRole('dialog').locator('datalist option[value="burrowtest-db"]')).toHaveCount(1);
  await expect(page.getByRole('dialog').getByTestId('snippet-var')).toHaveAttribute('list', /^snippet-containers-/);
  // Unticked: none offered again.
  await page.getByRole('dialog').locator('label', { hasText: 'test-sshd' }).getByRole('checkbox').uncheck();
  await expect(offered).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();
  await page.evaluate((id) => fetch(`/api/snippets/${id}`, { method: 'DELETE' }), made.id);

  // In the terminal, through the snippet button.
  await page.getByRole('link', { name: 'Terminal' }).click();
  await page.getByTestId('session-row').first().getByRole('button').first().click();
  await page.getByRole('button', { name: 'Snippets' }).click();
  await page.getByRole('button', { name: /greet/ }).click();
  await page.getByLabel('who').fill('terminal');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(screen(page)).toContainText('hello-terminal');

  // A name of its own: on its tab and in the list (with the host beside it).
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('term-rename').click();
  await page.getByTestId('confirm-input').fill('greetings');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByRole('tab', { selected: true })).toHaveText('greetings');
  await page.getByRole('button', { name: 'Sessions' }).click();
  // Spaced on both sides of the bar (report 0b970e: "Debian |lost on restart").
  await expect(page.getByTestId('session-row').filter({ hasText: 'greetings' })).toContainText(/test-sshd \| \S/);
  // Emptied: the host's name again.
  await page.getByTestId('term-rename').click();
  await expect(page.getByTestId('confirm-input')).toHaveValue('greetings');
  await page.getByTestId('confirm-input').fill('');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByRole('tab', { selected: true })).not.toHaveText('greetings');

  // Close the session for everyone.
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: 'Close this session' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page).toHaveURL(/#\/hosts/);
});

test('on the tabs: + opens another session on the host, a double click renames, X closes', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(page).toHaveURL(/#\/term\//);
  // The tabs drawn before they are counted (read at once, they were at times not there yet).
  await expect(page.getByTestId('term-tab').first()).toBeVisible();
  const before = await page.getByTestId('term-tab').count();
  // + : one more session on this host, in front.
  await page.getByTestId('term-new').click();
  await expect(page.getByTestId('term-tab')).toHaveCount(before + 1);
  const front = page.getByRole('tab', { selected: true });
  await expect(front).toHaveText(/test-sshd \d/);
  await lookAt(page, 'desktop-term-tabs');
  // A double click on the tab in front: its name.
  await front.dblclick();
  await page.getByTestId('confirm-input').fill('builds');
  await page.getByTestId('confirm-ok').click();
  await expect(front).toHaveText('builds');
  // Its X: asked, then gone (for everyone).
  await page.getByTestId('term-tab-close').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('term-tab')).toHaveCount(before);
  await expect(page.getByRole('tab', { name: 'builds' })).toHaveCount(0);
  // The X is part of the tab in front, not a button beside the tabs.
  await expect(page.getByRole('tab', { selected: true }).getByTestId('term-tab-close')).toHaveCount(1);
});

test("switching terminal tabs keeps each one connected: no new connection, and what came meanwhile shows at once", async ({ page }) => {
  // Report cfdea9: every switch connected again and drew the screen anew.
  const sockets: string[] = [];
  page.on('websocket', (ws) => {
    const m = /\/api\/terminal\/sessions\/([^/]+)\/ws/.exec(ws.url());
    if (m) sockets.push(m[1]!);
  });
  await signIn(page);
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(page).toHaveURL(/#\/term\//);
  const first = page.url().split('/term/')[1]!;
  // A command that answers after this tab is left.
  await type(page, 'sleep 2; echo later-$((2*3))');
  await page.getByTestId('term-new').click();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(/test-sshd \d/);
  const second = page.url().split('/term/')[1]!;
  expect(second).not.toBe(first);
  await type(page, 'echo second-$((3*3))');
  await expect(screen(page)).toContainText('second-9');
  // Back and forth a few times.
  for (const id of [first, second, first]) {
    await page.evaluate((to) => (location.hash = `#/term/${to}`), id);
    await expect(page).toHaveURL(new RegExp(`/term/${id}$`));
  }
  // What the first one printed while the second was in front.
  await expect(screen(page)).toContainText('later-6');
  await expect(page.getByText('Connecting')).toHaveCount(0);
  expect(sockets.filter((s) => s === first)).toHaveLength(1);
  expect(sockets.filter((s) => s === second)).toHaveLength(1);
  // Played again, not answered again: tmux's question what terminal this is
  // came with the output, and the answers landed in the shell as text.
  await page.evaluate((to) => (location.hash = `#/term/${to}`), second);
  await expect(screen(page)).toContainText('second-9');
  await page.waitForTimeout(500);
  await expect(screen(page)).not.toContainText(/\d;\d+c/);
  await page.evaluate((to) => (location.hash = `#/term/${to}`), first);
  await expect(screen(page)).toContainText('later-6');
  await page.waitForTimeout(500);
  await expect(screen(page)).not.toContainText(/\d;\d+c/);
  // Nor replayed over and over (a loop ran into the request limit).
  await expect(page.getByText('Too many requests')).toHaveCount(0);
  // Done: the second one closed again (other tests count the tabs).
  await page.evaluate((to) => (location.hash = `#/term/${to}`), second);
  const tabs = await page.getByTestId('term-tab').count();
  await page.getByTestId('term-tab-close').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('term-tab')).toHaveCount(tabs - 1);
  await expect(page).not.toHaveURL(new RegExp(`/term/${second}$`));
});

test('+ held: another host and another way; Delete on the tab in front closes it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(page).toHaveURL(/#\/term\//);
  await expect(page.getByRole('tab', { selected: true })).toBeVisible();
  const before = await page.getByTestId('term-tab').count();
  // Held (no click after it): the choice, with this host chosen.
  const plus = page.getByTestId('term-new');
  const box = (await plus.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('term-tab')).toHaveCount(before);
  await expect(dialog.getByTestId('new-host')).toHaveValue(/\d+/);
  await lookAt(page, 'desktop-term-new');
  // A host from the list (other specs add more; this one is always there), without tmux.
  await dialog.getByTestId('new-host').selectOption({ label: 'test-sshd' });
  await dialog.getByTestId('new-memory').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('term-tab')).toHaveCount(before + 1);
  const opened = await page.evaluate(async () => {
    const id = location.hash.split('/').pop();
    return ((await (await fetch('/api/terminal/sessions')).json()) as { id: string; hostName: string; mode: string }[]).find((x) => x.id === id);
  });
  expect(opened).toMatchObject({ hostName: 'test-sshd', mode: 'memory' });
  // Delete on the tab in front: asked, then gone. First the new session's
  // prompt: connecting it takes the focus (to its input), which took the
  // Delete away from the tab now and then.
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$');
  await page.getByRole('tab', { selected: true }).press('Delete');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('term-tab')).toHaveCount(before);
  // The other ways: with tmux, and the host's own; each opens one more, as asked.
  const hold = async () => {
    const b = (await plus.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(800);
    await page.mouse.up();
    await expect(dialog).toBeVisible();
  };
  const mode = () => page.evaluate(async () => ((await (await fetch('/api/terminal/sessions')).json()) as { id: string; mode: string }[]).find((x) => x.id === location.hash.split('/').pop())?.mode);
  await hold();
  await dialog.getByTestId('new-tmux').click();
  await expect(page.getByTestId('term-tab')).toHaveCount(before + 1);
  await expect.poll(mode).toBe('tmux');
  await hold();
  await dialog.getByTestId('new-default').click();
  await expect(page.getByTestId('term-tab')).toHaveCount(before + 2);
  for (let i = 0; i < 2; i++) {
    await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$');
    await page.getByRole('tab', { selected: true }).press('Delete');
    await page.getByTestId('confirm-ok').click();
    // Closed once its tmux session is seen ended on the host (AUDIT2 FS-14): then the next.
    await expect(page.getByTestId('term-tab')).toHaveCount(before + 1 - i, { timeout: 15_000 });
  }
});

test('Paste puts a multi-line snippet in the text box; nothing in it runs until sent', async ({ page }) => {
  await signIn(page);
  const marker = `/tmp/burrow-pasted-${Date.now()}`;
  const snippet = await page.evaluate(async (m) => {
    const r = await fetch('/api/snippets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'two lines', command: `touch ${m}\necho second-${'line'}`, description: null, hostId: null, groupId: null }) });
    return (await r.json()) as { id: number };
  }, marker);
  const hosts = await page.evaluate(async () => (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]);
  const host = hosts.find((h) => h.name === 'test-sshd')!.id;
  const exists = async () =>
    page.evaluate(
      async ([h, m]) => {
        const r = await fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [h], command: `test -e ${m} && echo yes || echo no` }) });
        return ((await r.json()) as { stdout: string }[])[0]!.stdout.trim();
      },
      [host, marker] as const,
    );
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(screen(page)).toContainText('$');
  await page.getByRole('button', { name: 'Snippets' }).click();
  await page.getByRole('button', { name: /two lines/ }).click();
  await page.getByRole('button', { name: 'Paste only', exact: true }).click();
  // In the text box, not run: the marker file does not exist (a line break
  // ran it). Not even as a marked paste: a tmux hands that over unmarked
  // when the shell in its pane does not ask (AUDIT2 TERM-02).
  await expect(page.getByTestId('compose')).toHaveValue(`touch ${marker}\necho second-line`);
  await page.waitForTimeout(1500);
  expect(await exists()).toBe('no');
  // Sent on purpose: then it runs, so the "no" above was the paste waiting,
  // not a paste that never arrived (AUDIT2 TEST-15).
  await page.getByTestId('compose-send').click();
  await expect.poll(exists, { timeout: 10_000 }).toBe('yes');
  await page.getByTestId('compose').fill('');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('compose-toggle').uncheck();
  await page.keyboard.press('Escape');
  await page.evaluate((id) => fetch(`/api/snippets/${id}`, { method: 'DELETE' }), snippet.id);
});

test('split terminals on a wide screen: panes side by side, kept after a reload, typing into all of them only on purpose', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const sent: string[] = [];
  page.on('websocket', (ws) => {
    const session = /\/sessions\/([^/]+)\/ws/.exec(ws.url())?.[1];
    if (session) ws.on('framesent', (f) => typeof f.payload === 'string' && /"t":"(input|resize)"/.test(f.payload) && sent.push(`${session.slice(0, 8)} ${f.payload}`));
  });
  await signIn(page);
  const pane = (i: number) => page.getByTestId('term-pane').nth(i);
  const rows = (i: number) => pane(i).locator('[data-testid=terminal] .xterm-rows');
  // Clicked, then typed once the pane's terminal has the keyboard: on a busy machine the first key went out before it did.
  const into = async (i: number) => {
    await pane(i).getByTestId('terminal').click();
    await expect(pane(i).locator('.xterm-helper-textarea')).toBeFocused();
  };
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(page).toHaveURL(/#\/term\//);
  // A session of its own: the host's button opens the one open there, another spec's.
  const opened = page.url();
  await page.getByTestId('term-new').click();
  await expect(page).not.toHaveURL(opened);
  await expect(rows(0)).toContainText('$', { timeout: 20_000 });
  // Split: one more terminal beside it (a new session on this host when all are shown).
  const had = await page.getByTestId('term-tab').count();
  await page.getByTestId('term-split').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(2);
  await expect(page.getByTestId('term-tab')).toHaveCount(Math.max(had, 2));
  // With other specs' sessions open the split shows the first of them: once one of
  // terminal-history's, left in tmux's copy mode with no prompt (gate 2026-11-06).
  // This test types only into its own: + puts a new one in the pane typed into.
  if (had > 1) {
    await expect(pane(1)).toHaveClass(/active/);
    await page.getByTestId('term-new').click();
    await expect(page.getByTestId('term-tab')).toHaveCount(had + 1);
    await expect(page.getByTestId('term-pane')).toHaveCount(2);
  }
  await expect(rows(1)).toContainText('$', { timeout: 20_000 });
  const own = [(await pane(0).getAttribute('aria-label'))!, (await pane(1).getAttribute('aria-label'))!];
  // Each pane its own session: typed into the one clicked.
  await into(1);
  await page.keyboard.type('echo pane-$((1+1))\n');
  await expect(rows(1)).toContainText('pane-2');
  await into(0);
  await page.keyboard.type('echo pane-$((0+1))\n');
  // Twice under load the first key of this line was lost ('cho pane-1') with the field focused:
  // what went out on the sessions' sockets, said with a failure, tells the browser from the server.
  await expect(rows(0)).toContainText('pane-1').catch((e: Error) => {
    throw new Error(`${e.message}\ninput sent (session, frame): ${sent.slice(-40).join('\n')}`);
  });
  await expect(rows(1)).not.toContainText('pane-1');
  await expect(pane(0)).toHaveClass(/active/);
  // The address follows the pane typed into.
  const first = page.url();
  await into(1);
  await expect(page).not.toHaveURL(first);
  await lookAt(page, 'desktop-term-split', { passes: WIDE_ONLY });
  // The divider, moved with the keyboard: kept with the panes after a reload.
  await page.getByTestId('term-divider-x').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('term-divider-x')).toHaveAttribute('aria-valuenow', '45');
  await page.reload();
  await expect(page.getByTestId('term-pane')).toHaveCount(2);
  await expect(page.getByTestId('term-divider-x')).toHaveAttribute('aria-valuenow', '45');
  await expect(rows(0)).toContainText('pane-1', { timeout: 20_000 });
  await expect(rows(1)).toContainText('pane-2', { timeout: 20_000 });
  // Typing into all panes: only on purpose, with a red bar the whole time.
  await expect(page.getByTestId('broadcast-bar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('broadcast-toggle').check();
  await expect(page.getByTestId('broadcast-bar')).toContainText('Typing goes to all 2 terminals shown');
  await lookAt(page, 'desktop-term-broadcast', { passes: WIDE_ONLY });
  await into(0);
  await page.keyboard.type('echo both-$((20+1))\n');
  await expect(rows(0)).toContainText('both-21');
  await expect(rows(1)).toContainText('both-21');
  await page.getByTestId('broadcast-stop').click();
  await expect(page.getByTestId('broadcast-bar')).toHaveCount(0);
  await page.keyboard.type('echo alone-$((3+4))\n');
  await expect(rows(0)).toContainText('alone-7');
  await page.waitForTimeout(500);
  await expect(rows(1)).not.toContainText('alone-7');
  // A tab dragged onto the first: the tabs' order, kept.
  const names = async () => (await page.getByTestId('term-tab').allTextContents()).map((n) => n.trim());
  const before = await names();
  await page.getByTestId('term-tab').last().dragTo(page.getByTestId('term-tab').first());
  await expect.poll(names).toEqual([before.at(-1)!, ...before.slice(0, -1)]);
  await page.reload();
  await expect.poll(names).toEqual([before.at(-1)!, ...before.slice(0, -1)]);
  // Or by keyboard, as a workspace's tabs (report 50a6f6): the focused one a place to the right and back.
  const moved = [before.at(-1)!, ...before.slice(0, -1)];
  await page.getByTestId('term-tab').first().focus();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect.poll(names).toEqual([moved[1]!, moved[0]!, ...moved.slice(2)]);
  await expect(page.getByTestId('term-tab').nth(1)).toBeFocused();
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await expect.poll(names).toEqual(moved);
  // Three panes: two above, one below; both dividers dragged with the mouse.
  // Split already, the button is the layout: so many panes, no session opened unasked (report 1d2fd4).
  const sessions = async () => (await page.request.get('/api/terminal/sessions').then((r) => r.json())).length as number;
  const before3 = await sessions();
  await page.getByTestId('term-split').click();
  const panes = page.getByRole('dialog', { name: 'Panes' });
  await expect(panes.getByTestId('term-layout-n').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await lookAt(page, 'desktop-term-layout', { passes: WIDE_ONLY });
  expect(await sessions()).toBe(before3);
  // One pane, and back to two from the open sessions: still none made.
  await panes.getByTestId('term-layout-n').first().click();
  await expect(page.locator('[data-testid=term-pane]:visible')).toHaveCount(1);
  await page.getByTestId('term-split').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(2);
  expect(await sessions()).toBe(before3);
  // The one beside it is the first open one, maybe another spec's (sized by its own viewer:
  // once its suggestions lay over a pane's head, gate 2026-11-05): this test's own again,
  // picked from the tabs into the pane typed into.
  const left = await pane(0).getAttribute('aria-label');
  const mine = own.find((n) => n !== left)!;
  await page.getByTestId('term-tab').filter({ hasText: new RegExp(`^\\s*${mine}\\s*$`) }).click();
  await expect(pane(1)).toHaveAttribute('aria-label', mine);
  await expect(pane(0)).toHaveAttribute('aria-label', left!);
  expect(await sessions()).toBe(before3);
  // A third: a new one asked for by name (an open one could be another spec's).
  await page.getByTestId('term-split').click();
  await panes.getByTestId('term-layout-new').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(3);
  await expect(rows(2)).toContainText('$', { timeout: 20_000 });
  const dragBy = async (testid: string, dx: number, dy: number) => {
    // Held a quarter along, away from where the two dividers cross.
    const b = (await page.getByTestId(testid).boundingBox())!;
    const [sx, sy] = [b.x + (b.width > b.height ? b.width / 4 : b.width / 2), b.y + (b.height > b.width ? b.height / 4 : b.height / 2)];
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + dx, sy + dy, { steps: 5 });
    await page.mouse.up();
  };
  await dragBy('term-divider-x', 160, 0);
  await expect.poll(async () => Number(await page.getByTestId('term-divider-x').getAttribute('aria-valuenow'))).toBeGreaterThan(50);
  await dragBy('term-divider-y', 0, -120);
  await expect.poll(async () => Number(await page.getByTestId('term-divider-y').getAttribute('aria-valuenow'))).toBeLessThan(45);
  const top = (await pane(0).boundingBox())!;
  const bottom = (await pane(2).boundingBox())!;
  expect(bottom.y).toBeGreaterThan(top.y + top.height - 2);
  expect(bottom.width).toBeGreaterThan(top.width * 1.5);
  await lookAt(page, 'desktop-term-split-3', { passes: WIDE_ONLY });
  // One pane alone over the whole area, and back to the split as it was (report 42f337).
  const area = (await page.getByTestId('term-panes').boundingBox())!;
  await pane(2).getByTestId('term-pane-zoom').click();
  await expect(page.locator('[data-testid=term-pane]:visible')).toHaveCount(1);
  const alone = (await page.locator('[data-testid=term-pane]:visible').boundingBox())!;
  expect(alone.width).toBeGreaterThan(area.width - 4);
  expect(alone.height).toBeGreaterThan(area.height - 4);
  await expect(page.getByTestId('term-divider-x')).toHaveCount(0);
  await lookAt(page, 'desktop-term-zoomed', { passes: WIDE_ONLY });
  // Still connected behind it: the others answer once back.
  await page.locator('[data-testid=term-pane]:visible').getByTestId('term-pane-zoom').click();
  await expect(page.locator('[data-testid=term-pane]:visible')).toHaveCount(3);
  await expect(rows(0)).toContainText('alone-7');
  // A double click on a pane's head does the same.
  await pane(1).locator('.pane-head').dblclick();
  await expect(page.locator('[data-testid=term-pane]:visible')).toHaveCount(1);
  await pane(1).locator('.pane-head').dblclick();
  await expect(page.locator('[data-testid=term-pane]:visible')).toHaveCount(3);
  await pane(2).getByTestId('term-pane-close').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(2);
  // A pane taken out: its session stays in the tabs.
  const tabs = await page.getByTestId('term-tab').count();
  await pane(1).getByTestId('term-pane-close').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(1);
  await expect(page.getByTestId('term-tab')).toHaveCount(tabs);
  // On a phone one pane, whatever was split.
  await page.getByTestId('term-split').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(2);
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.getByTestId('term-pane')).toHaveCount(1);
  await expect(page.getByTestId('term-split')).toHaveCount(0);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.getByTestId('term-pane')).toHaveCount(2);
});

test('a larger text size keeps the terminal and what it shows; it is not built afresh (AUDIT2 TERM-04)', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(page).toHaveURL(/#\/term\//);
  await type(page, 'echo zoom-$((5*5))');
  await expect(screen(page)).toContainText('zoom-25');
  const xterm = page.locator('[data-testid=terminal] .xterm');
  await xterm.evaluate((el) => ((el as HTMLElement & { kept?: boolean }).kept = true));
  const before = await xterm.evaluate((el) => getComputedStyle(el.querySelector('.xterm-rows')!).fontSize);
  // In the session menu (the ... in the head).
  await page.getByRole('button', { name: 'Sessions and more', exact: true }).click();
  await page.getByRole('button', { name: 'Larger text' }).click();
  await expect.poll(() => xterm.evaluate((el) => getComputedStyle(el.querySelector('.xterm-rows')!).fontSize)).not.toBe(before);
  expect(await xterm.evaluate((el) => (el as HTMLElement & { kept?: boolean }).kept === true)).toBe(true);
  await expect(screen(page)).toContainText('zoom-25');
  // Back to the size it had, for the specs after this one.
  await page.getByRole('button', { name: 'Smaller text' }).click();
  await expect.poll(() => xterm.evaluate((el) => getComputedStyle(el.querySelector('.xterm-rows')!).fontSize)).toBe(before);
  await page.keyboard.press('Escape');
});

test('a session the server cannot open: its reason said with Try again, no reconnecting for ever (A3-WEB-02)', async ({ page }) => {
  await signIn(page);
  const id = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const r = await fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: hosts.find((h) => h.name === 'test-sshd')!.id, cols: 80, rows: 24 }) });
    return ((await r.json()) as { id: string }).id;
  });
  let fail = true;
  let tries = 0;
  await page.routeWebSocket(new RegExp(`/api/terminal/sessions/${id}/ws`), (ws) => {
    tries += 1;
    if (!fail) return void ws.connectToServer();
    ws.send(JSON.stringify({ t: 'exit', reason: 'error', message: 'The host does not answer.' }));
    ws.close({ code: 4000, reason: 'attach failed' });
  });
  await page.goto(`/#/term/${id}`);
  await page.reload();
  await expect(page.getByTestId('term-failed')).toContainText('The host does not answer.');
  await page.waitForTimeout(10_000);
  expect(tries).toBe(1);
  fail = false;
  await page.getByTestId('term-retry').click();
  await expect(page.getByTestId('term-failed')).toHaveCount(0);
  await expect(page.locator('.xterm-rows').first()).toContainText('$', { timeout: 15_000 });
  expect(tries).toBe(2);
  await page.evaluate((s) => fetch(`/api/terminal/sessions/${s}`, { method: 'DELETE' }), id);
});

test("tmux typed in a session: in Burrow's own tmux it starts the person's own; inside a tmux of theirs Burrow says so", async ({ page }) => {
  // Report 7340bb: "tmux" in a session gave "sessions should be nested with
  // care, unset $TMUX to force", and nothing said why or what to do.
  await signIn(page);
  const open = async (tmux: 'always' | 'never') => {
    const id = await page.evaluate(async (tmux) => {
      const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
      const r = await fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: hosts.find((h) => h.name === 'test-sshd')!.id, cols: 100, rows: 30, tmux }) });
      return ((await r.json()) as { id: string }).id;
    }, tmux);
    await page.goto(`/#/term/${id}`);
    await expect(screen(page)).toContainText('$', { timeout: 20_000 });
    return id;
  };
  // In Burrow's own tmux (no status bar or prefix of its own): a plain tmux is the person's own,
  // on its default server, its status bar showing (review 2026-10-24; it was refused before).
  const notice = page.getByTestId('term-nested');
  const inBurrows = await open('always');
  await type(page, 'tmux');
  await expect(screen(page)).toContainText('[0]');
  await type(page, 'echo "own=$TMUX"');
  await expect(screen(page)).toContainText(/own=\/tmp\/tmux-\d+\/default,/);
  await expect(notice).toHaveCount(0);
  // tmux again inside that one: refused, and said whose tmux it is.
  await type(page, 'tmux');
  await expect(notice).toContainText('already runs in a tmux of your own');
  await lookAt(page, 'terminal-nested-tmux');
  await page.getByTestId('term-nested-close').click();
  await type(page, 'tmux kill-server');
  await page.evaluate((s) => fetch(`/api/terminal/sessions/${s}`, { method: 'DELETE' }), inBurrows);

  // Without Burrow's tmux, inside a tmux of the person's own: that one is said.
  const inOwn = await open('never');
  await type(page, 'tmux -L nested -f /dev/null new -s mine');
  await expect(screen(page)).toContainText('[mine]');
  await type(page, 'tmux');
  await expect(notice).toContainText('already runs in a tmux of your own');
  await page.getByTestId('term-nested-close').click();
  await expect(notice).toHaveCount(0);
  await type(page, 'tmux -L nested kill-server');
  await page.evaluate((s) => fetch(`/api/terminal/sessions/${s}`, { method: 'DELETE' }), inOwn);
});

test("the mouse wheel in Burrow's tmux goes back through tmux's history, as a finger does (review 2026-10-24)", async ({ page }) => {
  await signIn(page);
  const id = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const r = await fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: hosts.find((h) => h.name === 'test-sshd')!.id, cols: 100, rows: 30, tmux: 'always' }) });
    return ((await r.json()) as { id: string }).id;
  });
  await page.goto(`/#/term/${id}`);
  await expect(screen(page)).toContainText('$', { timeout: 20_000 });
  // Fast output: tmux redraws the screen instead of scrolling it, so only tmux's history has it all.
  await type(page, 'seq 1 2000');
  await expect(screen(page)).toContainText('2000');
  const box = (await page.getByTestId('terminal').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  // The history layer (2.19.0): tmux's whole history at once, scrolled by the browser itself,
  // its first lines too.
  const layer = page.getByTestId('term-history');
  await expect(layer).toBeVisible();
  // Each line's text: the parts out of sight are not drawn (content-visibility), innerText leaves them out.
  expect(await layer.locator('.line').allTextContents()).toContain('1');
  // The wheel over it scrolls it natively, up to its top.
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => layer.evaluate((el) => el.scrollTop)).toBe(0);
  // Typing ends it and reaches the shell (the terminal kept the keyboard; the layer lies over it).
  await page.keyboard.type('echo back-$((40+2))');
  await expect(layer).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(screen(page)).toContainText('back-42');
  await page.evaluate((s) => fetch(`/api/terminal/sessions/${s}`, { method: 'DELETE' }), id);
});

test('without tmux, the wheel over a full-screen program without the mouse is arrow keys for it (review 2026-10-24)', async ({ page }) => {
  await signIn(page);
  const id = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const r = await fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: hosts.find((h) => h.name === 'test-sshd')!.id, cols: 100, rows: 30, tmux: 'never' }) });
    return ((await r.json()) as { id: string }).id;
  });
  await page.goto(`/#/term/${id}`);
  await expect(screen(page)).toContainText('$', { timeout: 20_000 });
  // On its alternate screen, reading keys as a pager does.
  await type(page, `printf '\\033[?1049h'; read -rsn3 k; printf '\\033[?1049l'; printf 'got:%q\\n' "$k"`);
  await page.waitForTimeout(500);
  const box = (await page.getByTestId('terminal').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await expect(screen(page)).toContainText("got:$'\\E[A'");
  await page.evaluate((s) => fetch(`/api/terminal/sessions/${s}`, { method: 'DELETE' }), id);
});

test('many sessions on a narrow screen: the tab on screen is scrolled into sight in its strip (UIB-03)', async ({ page }) => {
  await signIn(page);
  const ids = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const host = hosts.find((h) => h.name === 'test-sshd')!;
    const out: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: host.id, cols: 80, rows: 24 }) });
      const id = ((await r.json()) as { id: string }).id;
      await fetch(`/api/terminal/sessions/${id}/title`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `many ${i}` }) });
      out.push(id);
    }
    return out;
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/term/${ids.at(-1)}`);
    const tab = page.locator('[role=tab][aria-selected=true]');
    await expect(tab).toContainText('many 9');
    await expect(tab).toBeInViewport({ ratio: 0.9 });
    // And another picked from the sessions list: in sight too.
    await page.goto(`/#/term/${ids[0]}`);
    await expect(page.locator('[role=tab][aria-selected=true]')).toContainText('many 0');
    await expect(page.locator('[role=tab][aria-selected=true]')).toBeInViewport({ ratio: 0.9 });
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
    for (const id of ids) await page.evaluate((x) => fetch(`/api/terminal/sessions/${x}`, { method: 'DELETE' }), id);
  }
});

test("back to the page's own session after its pane was closed: the tab opens it (audit 2026-11-09)", async ({ page }) => {
  // The address followed the pane typed into without the router: going back to the session the
  // page was opened for did nothing, the router thought it was there already.
  await page.setViewportSize({ width: 1600, height: 900 });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const make = () => page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  const a = await make();
  const b = await make();
  await page.goto('/#/hosts');
  await page.evaluate(() => localStorage.removeItem('burrow.termSplit'));
  const nameOf = async (sid: string) => {
    await page.goto(`/#/term/${sid}`);
    await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
    return (await page.getByRole('tab', { selected: true }).textContent())!.replace(/\s+/g, ' ').trim();
  };
  const nameB = await nameOf(b.id);
  const nameA = await nameOf(a.id);
  const tab = (name: string) => page.getByTestId('term-tab').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });
  const pane = (i: number) => page.getByTestId('term-pane').nth(i);
  // Split, B in the pane typed into: the address is B's.
  await page.getByTestId('term-split').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(2);
  await tab(nameB).click();
  await expect(page).toHaveURL(new RegExp(`#/term/${b.id}$`));
  await expect(pane(1)).toHaveAttribute('aria-label', nameB);
  // A's pane taken out; then A's tab: A on screen again.
  await pane(0).getByTestId('term-pane-close').click();
  await expect(page.getByTestId('term-pane')).toHaveCount(1);
  await tab(nameA).click();
  await expect(page).toHaveURL(new RegExp(`#/term/${a.id}$`));
  await expect(pane(0)).toHaveAttribute('aria-label', nameA);
  for (const s of [a, b]) await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});
