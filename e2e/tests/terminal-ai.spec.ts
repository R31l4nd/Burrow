import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { hostNamed, signIn } from './passkey.js';

// Report 411dbe: the terminal's AI dialog worked, but an earlier suggestion
// could not be found again or followed up on. Now a conversation kept with
// the session on the server: newest last, a follow-up goes with the turns
// before it (masked), any suggestion back on the line; never run.

const LLM_URL = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
const screen = (page: Page) => page.locator('[data-testid=terminal] .xterm-rows');

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

test('the AI dialog keeps its questions and suggestions with the session: a follow-up with the ones before, an earlier one back on the line (report 411dbe)', async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  await api(page, 'PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: LLM_URL, model: 'fake-model' } });
  const sshd = await hostNamed(page, 'test-sshd');
  const term = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId: sshd, cols: 80, rows: 24 });
  try {
    await page.goto(`/#/term/${term.id}`);
    await expect(screen(page)).toContainText('$');
    const dialog = page.getByRole('dialog', { name: 'AI' });
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await dialog.getByRole('textbox').fill('grootste mappen in /data');
    await dialog.getByRole('button', { name: 'Suggest a command' }).click();
    await expect(dialog.getByTestId('ai-result')).toContainText('du -sh /data/*');
    // A follow-up: only understood with the turn before it, which went along.
    await expect(dialog.getByRole('textbox')).toHaveValue('');
    await expect(dialog.getByText('Ask a follow-up, or something new')).toBeVisible();
    await dialog.getByRole('textbox').fill('make it recursive');
    await dialog.getByRole('button', { name: 'Suggest a command' }).click();
    await expect(dialog.getByTestId('ai-result')).toContainText('du -ah /data');
    await expect(dialog.getByTestId('ai-turn')).toHaveCount(2);
    // A secret typed in a question is kept as it went: masked.
    await dialog.getByRole('textbox').fill('leave a mark with password=hunter2');
    await dialog.getByRole('button', { name: 'Suggest a command' }).click();
    await expect(dialog.getByTestId('ai-turn')).toHaveCount(3);
    await expect(dialog.getByTestId('ai-turn').nth(2)).not.toContainText('hunter2');
    await lookAt(page, 'terminal-ai-conversation');

    // Closed and opened again, and after a reload (as on another device): all there, newest last.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await expect(screen(page)).toContainText('$');
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await expect(dialog.getByTestId('ai-turn')).toHaveCount(3);
    await expect(dialog.getByTestId('ai-turn').first()).toContainText('grootste mappen in /data');
    // Copied as it is, also an earlier one.
    await dialog.getByTestId('ai-turn').nth(1).getByRole('button', { name: 'Copy' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('du -ah /data 2>/dev/null | sort -h | tail -5');
    // The first suggestion again, onto the line; not run.
    await dialog.getByTestId('ai-turn').first().getByTestId('ai-use').click();
    await expect(dialog).toBeHidden();
    await expect(screen(page)).toContainText('$ du -sh /data/* 2>/dev/null | sort -h | tail -5');
    await page.getByTestId('terminal').click();
    await page.keyboard.press('Control+U');

    // Start over: gone here and on the server.
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await dialog.getByTestId('ai-start-over').click();
    await expect(dialog.getByTestId('ai-turn')).toHaveCount(0);
    expect(await api(page, 'GET', `/api/terminal/sessions/${term.id}/ai`)).toEqual([]);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await api(page, 'DELETE', `/api/terminal/sessions/${term.id}`);
    // Off again: terminal-complete.spec switches it on itself, from off.
    await api(page, 'PUT', '/api/settings/ai', { provider: 'none', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: LLM_URL, model: '' } });
  }
  // Gone with the session.
  const gone = await page.evaluate(async (id) => (await fetch(`/api/terminal/sessions/${id}/ai`)).status, term.id);
  expect(gone).toBe(404);
});
