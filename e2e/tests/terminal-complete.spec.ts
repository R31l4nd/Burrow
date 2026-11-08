import { expect, test, type Page } from './fixtures.js';
import { signIn } from './passkey.js';

// Phase 2: `docker lo` suggests logs, then the container names; a line that
// starts with # plus a question puts a command on the line.

const LLM_URL = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
const screen = (page: Page) => page.locator('[data-testid=terminal] .xterm-rows');
const chips = (page: Page) => page.getByTestId('suggestions').getByRole('option');

async function typeInTerminal(page: Page, text: string) {
  await page.getByTestId('terminal').click();
  await page.keyboard.type(text);
}

test('completion with the shell integration, then AI text to command', async ({ page }) => {
  await signIn(page);

  // Install the shell integration from the host menu.
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  // The section opener looks and works like a button.
  const opener = page.getByText('Completion and history');
  await expect(opener).toHaveCSS('border-top-style', 'solid');
  await opener.click();
  await page.getByTestId('install-integration').click();
  await expect(page.getByText('Shell integration is installed.')).toBeVisible();

  // A new session picks it up.
  await page.getByTestId('new-session').click();
  await expect(page).toHaveURL(/#\/term\//);
  await expect(screen(page)).toContainText('$');
  await expect(page.getByTestId('limited-badge')).toHaveCount(0);

  // On a computer the row for suggestions stays, empty: the terminal keeps
  // its height whether there are any or not (reported: it jumped up and down).
  const termHeight = () => page.getByTestId('terminal').evaluate((e) => Math.round(e.getBoundingClientRect().height));
  await expect(page.getByTestId('suggestions')).toBeVisible();
  const before = await termHeight();
  // `docker lo` -> logs.
  await typeInTerminal(page, 'docker lo');
  await expect(chips(page).filter({ hasText: /^logs$/ })).toBeVisible();
  expect(await termHeight()).toBe(before);
  // A computer has no key bar; the chips sit inside the window.
  await expect(page.getByRole('toolbar', { name: 'Extra keys' })).toHaveCount(0);
  const strip = (await page.getByTestId('suggestions').getByRole('option').first().boundingBox())!;
  expect(strip.y + strip.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await chips(page).filter({ hasText: /^logs$/ }).click();
  // Then the containers, from `docker ps` on the host.
  await expect(chips(page).filter({ hasText: /^radarr$/ })).toBeVisible();
  await expect(chips(page).filter({ hasText: /^sonarr$/ })).toBeVisible();
  await chips(page).filter({ hasText: /^radarr$/ }).click();
  await page.keyboard.press('Enter');
  await expect(screen(page)).toContainText('fake docker: logs radarr');

  // What was run is in the history, and offered as a whole line next time.
  await typeInTerminal(page, 'dock');
  await expect(chips(page).first()).toHaveText('docker logs radarr');
  await page.keyboard.press('Control+U');

  // AI: set up the provider (a stand-in OpenAI-compatible server).
  const termUrl = page.url();
  await page.goto('/#/settings/ai');
  // Off at first: switched on, the provider and its fields appear.
  await expect(page.getByRole('combobox', { name: /^Provider/ })).toHaveCount(0);
  await page.getByTestId('ai-enabled').check();
  await page.getByRole('combobox', { name: /^Provider/ }).selectOption('openai');
  await page.getByLabel('Server URL').fill(LLM_URL);
  await page.getByRole('button', { name: 'Load available models' }).click();
  await page.getByRole('combobox', { name: 'Model' }).selectOption('fake-model');
  // A local model may take its time: fifteen minutes.
  await page.getByTestId('ai-timeout').fill('15');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('AI settings saved.').first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('ai-timeout')).toHaveValue('15');

  // `# question` -> chip -> dialog -> command on the line, not run.
  await page.goto(termUrl);
  await expect(screen(page)).toContainText('$');
  await typeInTerminal(page, '# grootste mappen in /data');
  await page.getByRole('option', { name: /Ask AI/ }).click();
  await expect(page.getByRole('dialog', { name: 'AI' }).getByRole('textbox')).toHaveValue('grootste mappen in /data');
  await page.getByRole('button', { name: 'Suggest a command' }).click();
  await expect(page.getByTestId('ai-result')).toContainText('du -sh /data/*');
  await expect(page.getByTestId('ai-risk')).toHaveText('low risk');
  await page.getByRole('button', { name: 'Put on the command line' }).last().click();
  await expect(screen(page)).toContainText('$ du -sh /data/* 2>/dev/null | sort -h | tail -5');
  // Not run: no output line follows, the # question is gone.
  await expect(screen(page)).not.toContainText('# grootste mappen');
  await page.keyboard.press('Control+U');

  // Not run, seen on the host (AUDIT E2-07): the file the command makes is
  // not there while it waits on the line; Enter runs it, then it is.
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const onHost = (command: string) =>
    page.evaluate(async ([h, c]) => ((await (await fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [h], command: c }) })).json()) as { stdout: string }[])[0]!.stdout.trim(), [hostId, command] as const);
  const marked = () => onHost('test -e /tmp/burrow-ai-mark && echo yes || echo no');
  await onHost('rm -f /tmp/burrow-ai-mark');
  await page.getByRole('button', { name: 'AI' }).click();
  await page.getByRole('dialog', { name: 'AI' }).getByRole('textbox').fill('leave a mark');
  await page.getByRole('button', { name: 'Suggest a command' }).click();
  await expect(page.getByTestId('ai-result')).toContainText('touch /tmp/burrow-ai-mark');
  await page.getByRole('button', { name: 'Put on the command line' }).last().click();
  await expect(screen(page)).toContainText('$ touch /tmp/burrow-ai-mark');
  await page.waitForTimeout(1500);
  expect(await marked()).toBe('no');
  // The dialog had the focus: the terminal again, then Enter.
  await page.getByTestId('terminal').click();
  await page.keyboard.press('Enter');
  await expect.poll(marked, { timeout: 10_000 }).toBe('yes');
  await onHost('rm -f /tmp/burrow-ai-mark');

  // A destructive command the model called harmless is labelled high.
  await page.getByRole('button', { name: 'AI' }).click();
  await page.getByRole('dialog', { name: 'AI' }).getByRole('textbox').fill('clean up the temp folder');
  await page.getByRole('button', { name: 'Suggest a command' }).click();
  await expect(page.getByTestId('ai-risk')).toHaveText('HIGH RISK');
  // The dialog's Close (exact: the tab bar has "Close test-sshd" too).
  await page.getByRole('dialog', { name: 'AI' }).getByRole('button', { name: 'Close', exact: true }).click();

  // Leave no session behind for the next tests.
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: 'Close this session' }).click();
  await page.getByTestId('confirm-ok').click();
});

test('a command from history is offered once used often enough, as set in Settings (report 94c9eb)', async ({ page }) => {
  await signIn(page);
  const api = <T>(method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })).json(), [method, url, body] as const) as Promise<T>;
  const host = (await api<{ id: number; name: string }[]>('GET', '/api/hosts')).find((h) => h.name === 'test-sshd')!;
  // Two days ago: one command once, another twice (zsh's extended history), then read into Burrow's.
  await api('POST', '/api/snippets/run', { hostIds: [host.id], command: 't=$(( $(date +%s) - 172800 )); printf ": $t:0;oncecmd-burrow\\n: $t:0;twicecmd-burrow\\n: $t:0;twicecmd-burrow\\n" >> ~/.zsh_history' });
  const imported = await api<unknown>('POST', `/api/hosts/${host.id}/history/import`, {});
  const had = (await api<{ command: string; count: number }[]>('GET', `/api/hosts/${host.id}/history?limit=1000`)).filter((h) => h.command.includes('cmd-burrow'));
  expect(had, JSON.stringify(imported)).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'twicecmd-burrow', count: 2 }), expect.objectContaining({ command: 'oncecmd-burrow', count: 1 })]));
  const term = await api<{ id: string }>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 24 });
  await page.goto(`/#/term/${term.id}`);
  await expect(screen(page)).toContainText('$', { timeout: 20_000 });
  // Used twice: offered. Used once, two days ago: not (the default asks for two uses).
  await typeInTerminal(page, 'twicecm');
  await expect(chips(page).filter({ hasText: 'twicecmd-burrow' }).first()).toBeVisible();
  await page.keyboard.press('Control+U');
  await typeInTerminal(page, 'oncecm');
  await page.waitForTimeout(800);
  await expect(chips(page).filter({ hasText: 'oncecmd-burrow' })).toHaveCount(0);
  await page.keyboard.press('Control+U');
  // After one use, as chosen in Settings -> Terminal: offered too.
  await page.goto('/#/settings/terminal');
  await page.getByTestId('history-min').selectOption('1');
  await page.goto(`/#/term/${term.id}`);
  await expect(screen(page)).toContainText('$', { timeout: 20_000 });
  await typeInTerminal(page, 'oncecm');
  await expect(chips(page).filter({ hasText: 'oncecmd-burrow' }).first()).toBeVisible();
  await page.keyboard.press('Control+U');
  await page.goto('/#/settings/terminal');
  await page.getByTestId('history-min').selectOption('2');
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), term.id);
});
