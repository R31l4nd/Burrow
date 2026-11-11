import { expect, test, type Page } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// Phase 9, the criterion: an alert on a crash arrives through push, and
// "Analyse" gives a cause. Push goes to a real ntfy server (burrowtest-ntfy,
// read here on localhost:5002); the model is the stand-in server.

const DOCKER_HOST = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';
const LLM_URL = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
const NTFY_READ = 'http://127.0.0.1:5002';
const TOPIC = `burrow-e2e-${Date.now().toString(36)}`;
const ALPINE = 'alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f';

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

async function pushes(): Promise<{ title: string; message: string; click?: string; actions?: { label: string; url: string }[] }[]> {
  const res = await fetch(`${NTFY_READ}/${TOPIC}/json?poll=1&since=all`);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((m) => m.event === 'message');
}

test('a crash arrives as a push; Analyse gives a cause', async ({ page }) => {
  test.setTimeout(120_000);
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
  // The hosts here are containers on this machine and show its real sensors:
  // under the load of a test run its CPU passed 85 C once, a second alert
  // beside the crash. Out of the way for this test only.
  const all = await api<{ id: number }[]>(page, 'GET', '/api/hosts');
  const limits = (on: boolean) => Promise.all(all.map((x) => api(page, 'PUT', `/api/hosts/${x.id}/limits`, on ? { cpuCelsius: 120, diskCelsius: 90, diskPercent: 100 } : { cpuCelsius: null, diskCelsius: null, diskPercent: null })));
  await limits(true);
  await api(page, 'PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: LLM_URL, model: 'fake-model' } });

  // No channel gets alerts: the Alerts tab says so and leads straight to the setting.
  await page.goto('/#/alerts');
  await page.reload();
  await page.getByTestId('set-up-push').click();
  await expect(page.getByTestId('add-channel')).toBeInViewport();
  // Push: an ntfy channel in Settings, and a test message arrives.
  await page.getByTestId('add-channel').click();
  await page.getByTestId('add-ntfy').click();
  // No server filled in for you: the public ntfy.sh would carry host and container names (decision 10).
  await expect(page.getByTestId('ntfy-url')).toHaveValue('');
  await expect(page.getByTestId('ntfy-url')).toHaveAttribute('required', '');
  await page.getByTestId('ntfy-url').fill('http://burrowtest-ntfy');
  await page.getByTestId('ntfy-topic').fill(TOPIC);
  // The browser here; the Android app has a test of its own for burrow:// links.
  await page.getByTestId('ntfy-open-in').selectOption('browser');
  await page.getByTestId('channel-save').click();
  const channel = page.getByTestId('channel').filter({ hasText: 'ntfy' });
  await expect(channel).toContainText('alerts, reports, image updates');
  await fromRowMenu(channel, 'channel-menu', 'channel-test');
  await expect(page.getByText('Sent to ntfy.')).toBeVisible();
  await expect.poll(async () => (await pushes()).map((m) => m.title)).toContain('Burrow test');
  await channel.scrollIntoViewIfNeeded();
  await shoot(page, 'desktop-channels');

  // The test hosts offer two security updates (a local apt repository: workspace-packages), and each
  // host says so in a Host health alert once, when its packages are first checked: with the
  // statistics, at a moment of their own. Checked now, before the Alerts tab reads them all: one
  // came after it in a gate, and the count said 3 for the one crash (2026-11-11).
  await Promise.allSettled(all.map((x) => api(page, 'POST', `/api/hosts/${x.id}/packages`)));

  // The Alerts tab: Docker on the host is watched.
  await page.goto('/#/alerts');
  await expect(page.getByTestId('watching')).toContainText('docker-real', { timeout: 20_000 });
  await page.waitForTimeout(1500);

  // A container crashes.
  const [run] = await api<{ exitCode: number; stderr: string }[]>(page, 'POST', '/api/snippets/run', {
    hostIds: [h.id],
    command: `docker rm -fv burrowtest-e2ecrash >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name burrowtest-e2ecrash ${ALPINE} sh -c 'echo "INFO starting"; echo "ERROR cannot reach database at db:5432 (password=hunter2)"; sleep 1; exit 2' >/dev/null`,
  });
  expect(run!.exitCode, run!.stderr).toBe(0);
  await expect.poll(async () => (await pushes()).map((m) => m.title), { timeout: 30_000 }).toContain('burrowtest-e2ecrash on docker-real: exited with code 2');
  const push = (await pushes()).find((m) => m.title.startsWith('burrowtest-e2ecrash'))!;
  expect(push.actions?.map((a) => a.label)).toEqual(['Logs', 'Analyse']);

  // In the app: the count on the tab, the alert in the list.
  await page.goto('/#/hosts');
  await page.reload();
  await expect(page.getByTestId('alerts-badge')).toHaveText('1');
  await page.goto('/#/alerts');
  const alert = page.getByTestId('alert').filter({ hasText: 'burrowtest-e2ecrash' });
  await expect(alert).toContainText('exited with code 2');
  await expect(page.getByTestId('alerts-badge')).toHaveCount(0);
  await shoot(page, 'desktop-alerts');

  // The push's "Analyse": the logs of that moment, the analysis once tapped (a link never sends by itself, A3-WEB-07).
  const analyse = new URL(push.actions!.find((a) => a.label === 'Analyse')!.url);
  await page.goto(`/${analyse.hash}`);
  const dialog = page.getByRole('dialog', { name: 'Analyse with AI' });
  await expect(dialog.getByTestId('analyze-sends')).toContainText('burrowtest-e2ecrash');
  await dialog.getByTestId('analyze-run').click();
  await expect(dialog.getByTestId('analysis')).toContainText('Likely cause', { timeout: 30_000 });
  await expect(dialog.getByTestId('analysis')).toContainText('cannot reach database');
  // The model never saw the password: in nothing it was sent, not only not in its answer (AUDIT2 TEST-19).
  await expect(dialog.getByTestId('analysis')).not.toContainText('hunter2');
  await expect(dialog.getByTestId('analysis')).toContainText('password=<secret>');
  const seen = async (q: string) => (await (await page.request.get(`${process.env.APPS_BASE ?? 'http://localhost:8191'}/llm-seen?q=${encodeURIComponent(q)}`)).json()) as { requests: number; with: number };
  expect(await seen('hunter2')).toMatchObject({ with: 0 });
  expect((await seen('cannot reach database')).with).toBeGreaterThan(0);
  await shoot(page, 'desktop-analysis');
  // Asked further (report 0a86b2): the question with the logs and the answer before it, masked as they were.
  await dialog.getByTestId('analyze-question').fill('Which line says it? My password=hunter2 is set.');
  await dialog.getByTestId('analyze-question').press('Control+Enter');
  await expect(dialog.getByTestId('analysis-question')).toHaveCount(1);
  await expect(dialog.getByTestId('analysis-question')).toContainText('Which line says it? My password=<secret> is set.');
  await expect(dialog.getByTestId('analysis-reply')).toContainText('With the logs and the analysis before it', { timeout: 30_000 });
  expect(await seen('hunter2')).toMatchObject({ with: 0 });
  // Asked again, by the button: both kept, in order.
  await dialog.getByTestId('analyze-question').fill('And how do I fix it?');
  await dialog.getByTestId('analyze-ask').click();
  await expect(dialog.getByTestId('analysis-reply')).toHaveCount(2, { timeout: 30_000 });
  await expect(dialog.getByTestId('analysis-reply').last()).toContainText('Asked further: And how do I fix it?');
  await expect(dialog.getByTestId('analyze-question')).toHaveValue('');
  await lookAt(page, 'desktop-analysis-asked');
  // Closed, it stays closed (AUDIT2 UI-04: each new line opened it again).
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(2000);
  await expect(dialog).toBeHidden();

  // A reload (or a dropped connection) loses nothing: the analysis ran on
  // the server, comes back, and is among the container's earlier ones.
  const logsUrl = page.url().replace(/[?&]analyze=1/, '');
  await page.goto(logsUrl);
  await page.reload();
  await page.getByTestId('analyze-open').click();
  await expect(dialog.getByTestId('analysis')).toContainText('Likely cause', { timeout: 15_000 });
  await expect(dialog.getByTestId('analysis-question')).toHaveCount(2);
  await expect(dialog.getByTestId('analyze-history')).toContainText('Earlier analyses (1)');
  // The earlier one, opened from the list.
  await dialog.getByTestId('analyze-history').locator('summary').click();
  await dialog.getByTestId('analyze-history').locator('.list-item').first().click();
  await expect(dialog.getByTestId('analysis')).toContainText('Likely cause');

  // From the alert's own row: the same analysis.
  await page.goto('/#/alerts');
  await fromRowMenu(page.getByTestId('alert').filter({ hasText: 'burrowtest-e2ecrash' }), 'alert-menu', 'alert-analyze');
  await expect(dialog.getByTestId('analysis')).toContainText('Likely cause', { timeout: 15_000 });

  // A container muted for an hour, then unmuted.
  await page.goto('/#/alerts');
  await fromRowMenu(page.getByTestId('alert').filter({ hasText: 'burrowtest-e2ecrash' }), 'alert-menu', 'alert-mute');
  await shoot(page, 'desktop-alert-mute');
  await page.getByRole('button', { name: 'For an hour' }).click();
  const muted = page.locator('section', { has: page.getByRole('heading', { name: 'Muted' }) });
  await expect(muted).toContainText('burrowtest-e2ecrash');
  expect((await api<{ container: string }[]>(page, 'GET', '/api/alerts/mutes')).map((m) => m.container)).toContain('burrowtest-e2ecrash');
  await muted.getByRole('button', { name: 'Unmute' }).click();
  await expect(muted).toHaveCount(0);

  // Alerts can be deleted: one, and all. First, on a phone, a row's three
  // buttons leave its title readable.
  await page.setViewportSize({ width: 360, height: 780 });
  // Two at least, so a row's Delete and Clear all are both pressed: a stand-in beside the crash's
  // when it made one only (Clear all went unpressed in a gate).
  await page.route(/\/api\/alerts$/, async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const real = (await (await r.fetch()).json()) as { id: number; container: string; title: string }[];
    await r.fulfill({ json: real.length === 1 ? [...real, { ...real[0]!, id: 999_999, container: 'burrowtest-standin', title: 'stand-in alert' }] : real });
  });
  await page.goto('/#/alerts');
  // Read again with the stand-in: the page may be on the alerts already.
  await page.reload();
  const rows = page.getByTestId('alert');
  const title = rows.first().locator('.title');
  expect(await title.evaluate((e) => e.getBoundingClientRect().width), 'alert title width on a phone').toBeGreaterThan(120);
  await shoot(page, 'phone-alerts-list');
  await page.setViewportSize({ width: 1280, height: 720 });
  const before = await rows.count();
  await fromRowMenu(rows.filter({ hasText: 'burrowtest-e2ecrash' }).first(), 'alert-menu', 'alert-delete');
  await expect(rows).toHaveCount(before - 1);
  expect(before).toBeGreaterThan(1);
  await page.getByTestId('alerts-clear').click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No alerts.', { exact: false })).toBeVisible();
  await page.unroute(/\/api\/alerts$/);

  await api(page, 'POST', '/api/snippets/run', { hostIds: [h.id], command: 'docker rm -fv burrowtest-e2ecrash >/dev/null 2>&1; true' });
  await limits(false);
});
