import { expect, test, type Page } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// Phase 10, the criterion: the weekly report arrives by push, e-mail and
// Discord, and is in the app. Push: the ntfy test server; e-mail: Mailpit;
// Discord: the stand-in server, which keeps what it gets.

const DOCKER_HOST = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';
const LLM_URL = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
const STAND_IN = process.env.APPS_BASE ?? 'http://127.0.0.1:8191';
const NTFY_READ = 'http://127.0.0.1:5002';
const MAIL_API = 'http://127.0.0.1:8025';
const TOPIC = `burrow-report-${Date.now().toString(36)}`;

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

/** A screenshot for review, with every check of checks.ts on what is shown. */
async function shoot(page: Page, name: string) {
  await lookAt(page, name);
}

test('the weekly report arrives by push, e-mail and Discord, and is in the app', async ({ page }) => {
  test.setTimeout(180_000);
  await sayYes(page);
  await signIn(page);
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
  await api(page, 'PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: LLM_URL, model: 'fake-model' } });
  await fetch(`${MAIL_API}/api/v1/messages`, { method: 'DELETE' });

  // Channels, set up in Settings: push for reports, e-mail, Discord.
  await page.goto('/#/settings?s=channels');
  await page.reload();
  await page.getByTestId('add-channel').click();
  await page.getByTestId('add-ntfy').click();
  await page.getByTestId('ntfy-url').fill('http://burrowtest-ntfy');
  await page.getByTestId('ntfy-topic').fill(TOPIC);
  await page.getByTestId('ntfy-open-in').selectOption('browser');
  for (const x of ['alerts', 'updates', 'problems']) await page.getByTestId(`topic-${x}`).uncheck();
  await page.getByTestId('channel-save').click();

  await page.getByTestId('add-channel').click();
  await page.getByTestId('add-email').click();
  // While no channel takes problem reports, a new one does by default: they reach someone (W-FUNC-11).
  const taken = (await api<{ topics: string[] }[]>(page, 'GET', '/api/channels')).some((c) => c.topics.includes('problems'));
  await expect(page.getByTestId('topic-problems')).toBeChecked({ checked: !taken });
  await page.getByTestId('smtp-host').fill('burrowtest-mailpit');
  await page.getByTestId('smtp-port').fill('1025');
  await page.getByTestId('mail-from').fill('burrow@example.com');
  await page.getByTestId('mail-to').fill('me@example.com');
  await page.getByTestId('channel-save').click();

  await page.getByTestId('add-channel').click();
  await page.getByTestId('add-discord').click();
  await page.getByTestId('discord-url').fill('http://burrow-e2e-llm:8000/discord');
  await page.getByTestId('channel-save').click();
  await expect(page.getByTestId('channel').filter({ hasText: 'E-mail' })).toContainText('me@example.com');
  await expect(page.getByTestId('channel').filter({ hasText: 'Discord' })).toContainText('reports, image updates');
  await shoot(page, 'desktop-channels');

  // The weekly report: there, off; switched on for the test stack.
  await page.goto('/#/reports');
  const weekly = page.getByTestId('schedule').filter({ hasText: 'Weekly report' });
  await expect(weekly).toContainText('off');
  await fromRowMenu(weekly, 'schedule-menu', 'edit-schedule');
  await page.getByTestId('schedule-day').selectOption('1');
  await page.getByTestId('schedule-time').fill('08:00');
  // Only these two containers: the default rule off, a rule for each.
  await page.getByTestId('logsel-only-below').check();
  for (const name of ['burrowtest-web', 'burrowtest-worker']) {
    await page.getByTestId('logsel-add').click();
    const rule = page.getByTestId('logsel-rule').last();
    await rule.getByTestId('logsel-kind').selectOption('container');
    await rule.getByTestId('logsel-name').fill(name);
  }
  // On or off only on its row, not in the form (reports 56d146, e2d7d2).
  await expect(page.getByTestId('schedule-enabled')).toHaveCount(0);
  await page.getByTestId('schedule-save').click();
  // Off as it was (opening it no longer switches it on): on, by hand, on its row.
  await expect(weekly.getByTestId('schedule-on')).not.toBeChecked();
  await weekly.getByTestId('schedule-on').check();
  await expect(weekly).toContainText(/every Monday at 08:00 | next: /);

  await fromRowMenu(weekly, 'schedule-menu', 'run-report');
  await expect(page).toHaveURL(/#\/reports\/\d+$/, { timeout: 90_000 });
  await expect(page.getByTestId('report-summary')).toContainText('1 problem');
  const worker = page.getByTestId('container-report').filter({ hasText: 'burrowtest-worker' });
  await expect(worker).toContainText('exited with code 3');
  const web = page.getByTestId('container-report').filter({ hasText: 'burrowtest-web' });
  await expect(web).toContainText('The upstream keeps timing out.');
  await expect(web).toContainText('ERROR upstream timeout');
  // What the explanations used, as an analysis says it (18efc8 class: reports did not).
  await expect(page.getByTestId('report-by')).toHaveText(/^Explanations by openai:fake-model\. Check before you act on them\. \| \d[\d,]*00 in, \d[\d,]*0 out tokens/);
  await shoot(page, 'desktop-report');
  // Its switch over the content, not at the screen's left beside it; on a very wide screen the
  // containers in two columns, not one with the rest of the screen empty (report ddc5ea).
  const centre = async (id: string) => page.getByTestId(id).evaluate((e) => { const r = e.getBoundingClientRect(); return Math.round(r.left + r.width / 2); });
  await page.getByRole('tab', { name: /^All/ }).click();
  for (const width of [1280, 1920, 2560, 3432]) {
    await page.setViewportSize({ width, height: 1080 });
    expect(Math.abs((await centre('report-switch')) - (await centre('report-summary'))), `at ${width}`).toBeLessThanOrEqual(2);
    const lefts = new Set(await page.getByTestId('container-report').evaluateAll((all) => all.map((e) => Math.round(e.getBoundingClientRect().left))));
    expect(lefts.size, `columns at ${width}`).toBe(width >= 1700 ? 2 : 1);
  }
  await lookAt(page, 'wide-report');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('tab', { name: /^Needs a look/ }).click();

  // Package updates waiting on its hosts (the packages spec checked
  // test-sshd before), folded; each host's name leads to its page.
  const updates = page.getByTestId('report-updates');
  const unfold = async () => {
    if (!(await updates.evaluate((d) => (d as HTMLDetailsElement).open))) await page.getByTestId('report-updates-open').click();
  };
  await expect(updates.locator('ul')).toBeHidden();
  await unfold();
  await expect(updates.locator('li').filter({ has: page.getByRole('link', { name: 'test-sshd', exact: true }) })).toContainText('3 updates | 2 security');
  const reportAt = page.url();
  for (const link of await updates.getByRole('link').all()) {
    const href = (await link.getAttribute('href'))!;
    await link.click();
    await expect.poll(() => new URL(page.url()).hash).toBe(href);
    await expect(page.getByTestId('packages')).toBeVisible({ timeout: 20_000 });
    await page.goto(reportAt);
    await expect(page.getByTestId('report-summary')).toContainText('1 problem');
    await unfold();
  }

  // A fix from the report, carried out by hand: the command as suggested,
  // its risk, and its output. Nothing ran before the button.
  const fixes = web.getByTestId('report-fix');
  await expect(fixes).toHaveCount(2);
  // On a small phone the command stays whole on one line (it scrolls):
  // broken anywhere it read "fixed-by-burro / w".
  await page.setViewportSize({ width: 320, height: 780 });
  for (const code of await fixes.locator('code').all()) {
    // The lines the text is laid out on.
    const lines = await code.evaluate((c) => {
      const r = document.createRange();
      r.selectNodeContents(c);
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    });
    expect(lines, (await code.textContent()) ?? '').toBe(1);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await fixes.nth(0).getByTestId('fix-open').click();
  await expect(page.getByTestId('fix-command')).toHaveValue('echo fixed-by-burrow');
  await expect(page.getByTestId('fix-risk')).toHaveText('low risk');
  await expect(page.getByTestId('fix-result')).toHaveCount(0);
  // Edited, the command is judged again.
  await page.getByTestId('fix-command').fill('sudo echo fixed-by-burrow');
  await expect(page.getByTestId('fix-risk')).toHaveText('medium risk');
  // With a trace it leaves: none before the button, there after it (AUDIT2 TEST-15).
  const mark = `/tmp/burrow-fix-${Date.now()}`;
  const marked = async () => (await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [h.id], command: `test -e ${mark} && echo yes || echo no` }))[0]!.stdout.trim();
  await page.getByTestId('fix-command').fill(`touch ${mark}; echo fixed-by-burrow`);
  expect(await marked()).toBe('no');
  await page.getByTestId('fix-confirm').click();
  await expect(page.getByTestId('fix-result')).toContainText('fixed-by-burrow', { timeout: 30_000 });
  expect(await marked()).toBe('yes');
  await shoot(page, 'desktop-fix-run');
  await page.keyboard.press('Escape');
  // Burrow's rules raise the model's "medium": a high risk needs a tick first.
  await fixes.nth(1).getByTestId('fix-open').click();
  await expect(page.getByTestId('fix-risk')).toHaveText('HIGH RISK');
  await expect(page.getByTestId('fix-confirm')).toBeDisabled();
  await page.getByTestId('fix-understood').check();
  await expect(page.getByTestId('fix-confirm')).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, 'phone-report');
  await page.setViewportSize({ width: 1280, height: 720 });

  // Push, e-mail and Discord all got it.
  const title = /^Weekly report: 1 problem, \d+ attention, \d+ ok$/;
  await expect
    .poll(async () => {
      const res = await fetch(`${NTFY_READ}/${TOPIC}/json?poll=1&since=all`);
      return (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).title as string)
        .some((x) => title.test(x ?? ''));
    })
    .toBe(true);
  await expect.poll(async () => ((await (await fetch(`${MAIL_API}/api/v1/messages`)).json()) as { messages: { Subject: string }[] }).messages.map((m) => m.Subject).some((s) => title.test(s))).toBe(true);
  await expect
    .poll(async () => ((await (await fetch(`${STAND_IN}/discord`)).json()) as { embeds: { title: string; url: string }[] }[]).some((m) => title.test(m.embeds[0]!.title) && /#\/reports\/\d+$/.test(m.embeds[0]!.url)))
    .toBe(true);

  // In the app: the list of reports.
  await page.goto('/#/reports');
  await expect(page.getByTestId('report').first()).toContainText('1 problem, ');
  await shoot(page, 'desktop-reports');
});

test('a host the report could not read is named, and the report is a problem', async ({ page }) => {
  await signIn(page);
  const report = {
    id: 9999,
    scheduleId: null,
    name: 'Daily',
    createdAt: '2026-10-05T08:00:00.000Z',
    from: '2026-10-04T08:00:00.000Z',
    to: '2026-10-05T08:00:00.000Z',
    status: 'problem',
    counts: { ok: 0, attention: 0, problem: 0 },
    summary: 'Could not be read: nas; their containers are missing.',
    lang: 'en',
    containers: [],
    model: null,
    unreachable: [{ hostId: 1, hostName: 'nas', error: 'connect ECONNREFUSED 192.168.1.20:22' }],
    trend: {},
  };
  let deleted = false;
  await page.route(/\/api\/reports\/9999(\?.*)?$/, (r) => (r.request().method() === 'DELETE' ? ((deleted = true), r.fulfill({ status: 204 })) : r.fulfill({ json: report })));
  await page.goto('/#/reports/9999');
  const box = page.getByTestId('report-unreachable');
  await expect(box).toContainText('This host could not be read');
  await expect(box).toContainText('nas: connect ECONNREFUSED');
  await lookAt(page, 'desktop-report-unreachable');
  // Deleted from its page, after a yes (report aafaba): back to the list.
  await page.getByTestId('report-delete').click();
  await expect(page.getByTestId('confirm-text')).toContainText('Delete the report Daily');
  await page.getByTestId('confirm-ok').click();
  await expect(page).toHaveURL(/#\/reports$/);
  expect(deleted).toBe(true);
});

test('a schedule opened and saved keeps what it had: off, UTC, its hosts; none of the channels is refused', async ({ page }) => {
  // Audit WP-05, WP-06, WP-18.
  await signIn(page);
  const api = <T,>(method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, json: r.status === 204 ? null : await r.json() };
    }, [method, url, body] as const) as Promise<{ status: number; json: T }>;
  const hosts = (await api<{ id: number; name: string }[]>('GET', '/api/hosts')).json;
  const sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  // An older one: off, never run, in UTC, for one container on one host.
  const made = await api<{ id: number }>('POST', '/api/reports/schedules', { name: 'Kept as it was', enabled: false, kind: 'daily', day: 1, time: '07:15', timeZone: 'UTC', hostIds: [sshd], containers: ['burrowtest-web'] });
  expect(made.status).toBe(200);
  // None of the channels, said explicitly: refused, not "all".
  expect((await api('PUT', `/api/reports/schedules/${made.json.id}`, { name: 'x', enabled: false, kind: 'daily', day: 1, time: '07:15', timeZone: 'UTC', channelIds: [] })).status).toBe(400);
  await page.goto('/#/reports');
  const row = page.getByTestId('schedule').filter({ hasText: 'Kept as it was' });
  await expect(row.getByTestId('schedule-on')).not.toBeChecked();
  await fromRowMenu(row, 'schedule-menu', 'edit-schedule');
  // The same refusal in the form.
  await page.getByTestId('schedule-all-channels').uncheck();
  await page.getByTestId('schedule-save').click();
  await expect(page.getByText('Choose at least one channel, or send to all channels.')).toBeVisible();
  await page.getByTestId('schedule-all-channels').check();
  await page.getByRole('textbox', { name: 'Name' }).fill('Kept as it was, renamed');
  await page.getByTestId('schedule-save').click();
  await expect(page.getByTestId('schedule').filter({ hasText: 'Kept as it was, renamed' })).toBeVisible();
  const s = (await api<{ id: number; enabled: boolean; timeZone: string; selection: { rules: { skip: boolean; target: { hostId: number | null; container: string | null; project: string | null } }[] } }[]>('GET', '/api/reports/schedules')).json.find((x) => x.id === made.json.id)!;
  expect(s).toMatchObject({ enabled: false, timeZone: 'UTC' });
  // The container on that host only, not on every host.
  const named = s.selection.rules.filter((r) => !r.skip);
  expect(named.length).toBeGreaterThan(0);
  expect(named.every((r) => r.target.hostId === sshd)).toBe(true);
  await api('DELETE', `/api/reports/schedules/${made.json.id}`);
});
