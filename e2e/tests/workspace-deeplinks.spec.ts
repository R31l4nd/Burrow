import { expect, test, type Page } from './fixtures.js';
import { signIn } from './passkey.js';

// A link into Burrow (a chat, a mail, another site, the Android app's
// shortcuts and pushes) opens the right page and never acts by itself: a
// terminal session, an AI analysis or a command only after a tap on a
// question that names the host, the logs or the command (A3-WEB-07, with
// A3-AND-05 on the app's side).

const hostId = (page: Page, name: string) => page.evaluate(async (n) => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === n)!.id, name);

test('#/hosts?connect=<id>: a terminal only after "Open terminal" on a question naming the host (A3-WEB-07)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostId(page, 'test-sshd');
  let posts = 0;
  page.on('request', (r) => r.method() === 'POST' && /\/api\/terminal\/sessions$/.test(r.url()) && (posts += 1));
  const before = (await page.evaluate(async () => (await (await fetch('/api/terminal/sessions')).json()) as { id: string }[])).map((s) => s.id);
  await page.goto('/#/settings');
  await page.reload();
  await page.goto(`/#/hosts?connect=${sshd}`);
  const ok = page.getByTestId('confirm-ok');
  await expect(ok).toHaveText('Open terminal');
  await expect(page.locator('dialog[open]')).toContainText('test-sshd');
  await page.waitForTimeout(1500);
  expect(posts).toBe(0);
  // Turned down: nothing opened, and the link's question is not asked again on a reload.
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/#\/hosts$/);
  await page.reload();
  await page.waitForTimeout(1000);
  await expect(ok).toBeHidden();
  expect(posts).toBe(0);
  // Said yes: the terminal of that host.
  await page.goto(`/#/hosts?connect=${sshd}`);
  await ok.click();
  await expect(page).toHaveURL(/#\/term\//, { timeout: 20_000 });
  const made = (await page.evaluate(async () => (await (await fetch('/api/terminal/sessions')).json()) as { id: string }[])).filter((s) => !before.includes(s.id));
  for (const s of made) await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});

test('#/logs?...&analyze=1: the analysis dialog names the logs and the model; nothing is sent until Analyse is tapped (A3-WEB-07)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostId(page, 'test-sshd');
  await page.route('**/api/ai/analyze/options', (r) => r.fulfill({ json: { available: true, deep: false, prices: { input: null, output: null, currency: 'USD' }, model: 'openai:fake-model' } }));
  let sent = 0;
  await page.route('**/api/ai/analyses', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    sent += 1;
    return r.fulfill({ json: { id: 7777 } });
  });
  const now = new Date().toISOString();
  await page.route('**/api/ai/analyses/7777', (r) => r.fulfill({ json: { id: 7777, targets: [{ hostId: sshd, container: 'burrowtest-db' }], lines: 3, provider: 'openai:fake-model', status: 'done', text: '### Likely cause\nNothing.', error: null, createdAt: now, finishedAt: now, tokens: null, ask: null, followUps: [], canAsk: false } }));
  await page.goto(`/#/logs?t=${sshd}:burrowtest-db&analyze=1`);
  await page.reload();
  const dialog = page.getByRole('dialog', { name: 'Analyse with AI' });
  await expect(dialog.getByTestId('analyze-sends')).toContainText('burrowtest-db');
  await expect(dialog.getByTestId('analyze-sends')).toContainText('openai:fake-model');
  await page.waitForTimeout(2000);
  expect(sent).toBe(0);
  await expect(dialog.getByTestId('analysis')).toHaveCount(0);
  await dialog.getByTestId('analyze-run').click();
  await expect(dialog.getByTestId('analysis')).toContainText('Likely cause');
  expect(sent).toBe(1);
  // One kept from before questions could be asked further (no prompt kept): said, no question field (report 0a86b2).
  await expect(dialog.getByTestId('analyze-no-ask')).toHaveText('Made before questions could be asked: analyse again to ask about it.');
  await expect(dialog.getByTestId('analyze-question')).toHaveCount(0);
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('burrow.analysis:')).forEach((k) => localStorage.removeItem(k)));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('#/snippets?run=1: an empty command to type, nothing run by the link (A3-WEB-07)', async ({ page }) => {
  await signIn(page);
  let runs = 0;
  page.on('request', (r) => r.method() === 'POST' && /\/api\/snippets\/run$/.test(r.url()) && (runs += 1));
  await page.goto('/#/snippets?run=1');
  await page.reload();
  await expect(page.getByTestId('adhoc-command')).toBeVisible();
  await expect(page.getByTestId('adhoc-command')).toHaveValue('');
  await page.waitForTimeout(1000);
  expect(runs).toBe(0);
});
