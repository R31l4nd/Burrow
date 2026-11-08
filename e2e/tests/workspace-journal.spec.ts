import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// A host's systemd services, their journals read like container logs: one or
// several in one timeline, and the ones watched for the alert rules and the
// reports. The test sshd has stand-ins for systemctl and journalctl
// (server/test/sshd), its user in the journal's group.

const SSHD_HOST = process.env.SSHD_HOST ?? 'burrow-e2e-sshd';
const MENU = 'Menu for test-sshd';
const LLM_URL = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

test("system logs: a host's services, failed first; two journals in one timeline; one watched for alerts and reports", async ({ page }) => {
  await signIn(page);
  const hosts = await api<{ id: number; name: string; address: string }[]>(page, 'GET', '/api/hosts');
  const host = hosts.find((h) => h.name === 'test-sshd' && h.address === SSHD_HOST)!;
  // The fake model, as the alerts spec sets it (the same values, whoever sets them first).
  await api(page, 'PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: LLM_URL, model: 'fake-model' } });

  // From the host's sheet.
  await page.goto('/#/hosts');
  await page.getByRole('button', { name: MENU, exact: true }).first().click();
  await page.locator('dialog[data-tour=host-sheet]').getByTestId('host-journal').click();
  await expect(page).toHaveURL(new RegExp(`#/hosts/${host.id}/journal$`));
  const rows = page.getByTestId('journal-unit');
  await expect(rows).toHaveCount(4, { timeout: 20_000 });
  // The failed one first, marked.
  await expect(rows.first()).toContainText('wg-quick@wg0.service');
  await expect(rows.first()).toContainText('failed');
  // Its state once when systemd says the same twice (it read "failed, failed").
  await expect(rows.first()).not.toContainText('failed, failed');
  await lookAt(page, 'desktop-journal');

  await page.getByTestId('journal-search').fill('cron');
  await expect(rows).toHaveCount(1);
  await page.getByTestId('journal-search').fill('nothing like it');
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No service matches.')).toBeVisible();
  await page.getByTestId('journal-search').fill('');
  // All of those the search shows, or none (the same as every long list).
  await page.getByTestId('journal-all').click();
  await expect(page.getByTestId('journal-show')).toHaveText('Show 4 logs');
  await page.getByTestId('journal-search').fill('cron');
  await page.getByTestId('journal-none').click();
  await expect(page.getByTestId('journal-show')).toHaveText('Show 3 logs');
  await page.getByTestId('journal-search').fill('');
  await page.getByTestId('journal-none').click();

  // Two of them in one timeline: their lines, without the host's name, and new ones as they come.
  await expect(page.getByTestId('journal-show')).toHaveCount(0);
  await page.getByLabel('Choose burrowtest-app.service').check();
  await page.getByLabel('Choose cron.service').check();
  await expect(page.getByTestId('journal-show')).toHaveText('Show 2 logs');
  await page.getByTestId('journal-show').click();
  await expect(page).toHaveURL(/#\/logs\?t=/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('burrowtest-app.service (journal), cron.service (journal)');
  await expect(page.getByTestId('log-line').filter({ hasText: 'listening on :8080' })).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('log-line').filter({ hasText: 'ERROR: could not reach the database' })).toHaveCount(2);
  // Its own level word after Burrow's level: dimmed, still in the line (live UI round).
  await expect(page.getByTestId('log-line').filter({ hasText: 'could not reach the database' }).first().getByTestId('log-dup')).toHaveText('ERROR: ');
  await expect(page.getByTestId('log-line').filter({ hasText: 'listening on :8080' }).first().getByTestId('log-dup')).toHaveCount(0);
  await expect(page.getByTestId('log-line').filter({ hasText: /tick \d+/ }).first()).toBeVisible({ timeout: 20_000 });
  // In time order, without the host's name, and without the unit's own name: its label says it already.
  const msgs = await page.getByTestId('log-line').locator('.msg').allTextContents();
  const of = (text: string) => msgs.findIndex((m) => m.trim() === text);
  expect(of('started two days ago')).toBeGreaterThanOrEqual(0);
  expect(of('started two days ago')).toBeLessThan(of('listening on :8080'));
  expect(msgs.filter((m) => m.includes('.service[100]:'))).toEqual([]);
  // A host's own logs: the rail marks Hosts, not Containers.
  await expect(page.locator('nav.bottomnav [aria-current=page]')).toHaveText('Hosts');
  // The search narrows them to the error lines (both journals).
  await page.getByPlaceholder('Search').first().fill('could not reach');
  await expect(page.getByTestId('log-line')).toHaveCount(2);
  await page.getByPlaceholder('Search').first().fill('');
  // The error line is recognised as one, and the level filter works on it: errors off, those lines go,
  // the others stay (AUDIT2 TEST-14: a class alone proved no filter).
  await expect(page.getByTestId('log-line').filter({ hasText: 'could not reach' }).first()).toHaveClass(/lvl-error/);
  const errorChip = page.locator('.chips .chip.lvl-error').first();
  await errorChip.click();
  await expect(errorChip).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('log-line').filter({ hasText: 'could not reach' })).toHaveCount(0);
  await expect(page.getByTestId('log-line').filter({ hasText: 'listening on :8080' })).toHaveCount(2);
  await errorChip.click();
  await expect(page.getByTestId('log-line').filter({ hasText: 'could not reach' })).toHaveCount(2);
  await lookAt(page, 'desktop-journal-logs');
  // On a phone the long dotted names wrap after a dot, not between two letters (lookAt: wordsWhole).
  await page.setViewportSize({ width: 412, height: 860 });
  await expect(page.getByTestId('log-line').filter({ hasText: 'BaseItemAnalyzerTask' }).first()).toBeVisible();
  await lookAt(page, 'phone-journal-logs');
  // Its filters opened: more chips than fit, the rest said by a fade at the edge (lookAt: rowsReachable).
  await page.getByTestId('log-filters').click();
  await expect(page.getByTestId('log-source').first()).toBeAttached();
  await lookAt(page, 'phone-journal-filters');
  await page.setViewportSize({ width: 1280, height: 720 });
  // Analysed like container logs (AUDIT2 J-01: journal sources were refused).
  await page.getByTestId('analyze-open').click();
  const analysis = page.locator('dialog[open]');
  await analysis.getByTestId('analyze-run').click();
  await expect(analysis.getByTestId('analysis')).toContainText('Likely cause', { timeout: 30_000 });
  await expect(analysis.getByTestId('analysis')).toContainText('ERROR: could not reach the database');
  await page.keyboard.press('Escape');
  await expect(analysis).toHaveCount(0);
  await page.goBack();

  // Watched: kept for the alert rules and the reports, and still so after a reload.
  const cron = rows.filter({ hasText: 'cron.service' });
  await cron.getByTestId('journal-keep').click();
  await expect(cron.getByTestId('journal-keep')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('cron.service is watched now.')).toBeVisible();
  let files = await api<{ container: string; path: string }[]>(page, 'GET', `/api/docker/${host.id}/logfiles?container=`);
  expect(files.some((f) => f.container === '' && f.path === 'journal:cron.service')).toBe(true);
  await page.reload();
  await expect(rows.filter({ hasText: 'cron.service' }).getByTestId('journal-keep')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  await rows.filter({ hasText: 'cron.service' }).getByTestId('journal-keep').click();
  await expect(rows.filter({ hasText: 'cron.service' }).getByTestId('journal-keep')).toHaveAttribute('aria-pressed', 'false');
  files = await api(page, 'GET', `/api/docker/${host.id}/logfiles?container=`);
  expect(files.some((f) => f.path === 'journal:cron.service')).toBe(false);

  // Watched but no longer listed by systemd (a removed unit): still shown, and can be unwatched (AUDIT2 J-06).
  await api(page, 'POST', `/api/docker/${host.id}/logfiles`, { container: '', path: 'journal:old.service' });
  await page.reload();
  const old = rows.filter({ hasText: 'old.service' });
  await expect(old).toContainText('not listed', { timeout: 20_000 });
  await old.getByTestId('journal-keep').click();
  await expect(old).toHaveCount(0);
  files = await api(page, 'GET', `/api/docker/${host.id}/logfiles?container=`);
  expect(files.some((f) => f.path === 'journal:old.service')).toBe(false);

  // Not a container's journal, and not an odd unit name.
  const status = (body: object) => page.evaluate(async ([id, b]) => (await fetch(`/api/docker/${id}/logfiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, [host.id, body] as const);
  expect(await status({ container: 'web', path: 'journal:cron.service' })).toBe(400);
  expect(await status({ container: '', path: "journal:cron'; reboot" })).toBe(400);
  expect(await status({ container: '', path: 'journal:a b.service' })).toBe(400);
});

test("a service's long description on a narrow phone: whole in its row, not over the next service (report e458b7)", async ({ page }) => {
  await signIn(page);
  const hosts = await api<{ id: number; name: string; address: string }[]>(page, 'GET', '/api/hosts');
  const host = hosts.find((h) => h.name === 'test-sshd' && h.address === SSHD_HOST)!;
  // The description of the report, on the test host's cron.
  await page.route('**/api/hosts/*/journal/units', async (r) => {
    const res = await r.fetch();
    const body = (await res.json()) as { units: { unit: string; description: string }[] };
    for (const u of body.units) if (u.unit === 'cron.service') u.description = 'Enable support for additional executable binary formats';
    await r.fulfill({ response: res, json: body });
  });
  await page.setViewportSize({ width: 343, height: 396 });
  await page.goto(`/#/hosts/${host.id}/journal`);
  const rows = page.getByTestId('journal-unit');
  await expect(rows.filter({ hasText: 'additional executable' })).toHaveCount(1, { timeout: 20_000 });
  // Each row holds its text: no line past the box it is drawn in (they ran over the row below).
  const over = await rows.evaluateAll((all) =>
    all.flatMap((r) => {
      const sub = r.querySelector<HTMLElement>('.sub')!;
      return sub.scrollHeight > sub.clientHeight + 1 || sub.getBoundingClientRect().bottom > r.getBoundingClientRect().bottom + 0.5 ? [(r.textContent ?? '').trim().slice(0, 30)] : [];
    }),
  );
  expect(over).toEqual([]);
  await expect(rows.filter({ hasText: 'additional executable' }).locator('.sub')).toContainText('binary formats');
  await lookAt(page, 'phone-journal-long-description');
  await page.unroute('**/api/hosts/*/journal/units');
  await page.setViewportSize({ width: 1280, height: 720 });
});
