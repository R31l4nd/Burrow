import { expect, test, type Page } from './fixtures.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// Log files beside a container's own output (and on the host): kept with
// the container, suggested from its mounts, shown together with the output
// or alone, opened from Files, and named in an alert.

const DOCKER_HOST = 'burrow-e2e-docker';
const ALPINE = 'alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f';

const api = <T,>(page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;

test.beforeEach(async ({ page }) => {
  await sayYes(page);
  await signIn(page);
});

test('a log file kept with a container: suggested from its mount, shown with the output or alone, removed again', async ({ page }) => {
  test.setTimeout(120_000);
  const hosts = await api<{ id: number; address: string }[]>(page, 'GET', '/api/hosts');
  const id = hosts.find((h) => h.address === DOCKER_HOST)!.id;
  const sh = async (command: string) => {
    const [r] = await api<{ exitCode: number; stdout: string; stderr: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [id], command });
    expect(r!.exitCode, `${command}: ${r!.stderr}`).toBe(0);
    return r!.stdout;
  };
  const now = new Date().toISOString();
  await sh(
    `mkdir -p /tmp/burrowtest-lf && printf '%s INFO app started\\n%s ERROR cannot write cache\\n' ${now} ${now} > /tmp/burrowtest-lf/app.log && docker rm -fv burrowtest-lf >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name burrowtest-lf -v /tmp/burrowtest-lf:/data ${ALPINE} sh -c 'echo container output line; sleep 600' >/dev/null`,
  );
  await page.goto(`/#/containers/${id}/burrowtest-lf`);
  await expect(page.getByTestId('log-line').filter({ hasText: 'container output line' })).toBeVisible({ timeout: 20_000 });
  // Found in its mount, added with a tap.
  await page.getByTestId('logfiles-manage').click();
  const dialog = page.getByRole('dialog', { name: 'Log files of burrowtest-lf' });
  const suggestion = dialog.getByTestId('logfile-suggestion').filter({ hasText: '/data/app.log' });
  await expect(suggestion).toBeVisible({ timeout: 20_000 });
  await lookAt(page, 'desktop-logfiles');
  await suggestion.click();
  await expect(page.getByText('app.log added.')).toBeVisible();
  // A path of its own: a wrong one is refused with the server's reason.
  await dialog.getByTestId('logfile-path').fill('/var/log/../../etc/shadow');
  await dialog.getByTestId('logfile-add').click();
  await expect(page.getByRole('status').or(page.locator('.toast')).filter({ hasText: /without ".."/ }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Output and file together, in one timeline.
  const source = page.getByTestId('logfile-source').filter({ hasText: 'app.log' });
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('log-line').filter({ hasText: 'cannot write cache' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('log-line').filter({ hasText: 'container output line' })).toBeVisible();
  // The file alone.
  await page.getByTestId('log-sources').getByRole('button', { name: 'Output', exact: true }).click();
  await expect(page.getByTestId('log-line').filter({ hasText: 'container output line' })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('log-line').filter({ hasText: 'cannot write cache' })).toBeVisible({ timeout: 20_000 });
  // The last one shown cannot be switched off.
  await source.click();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  // Followed: a line written now arrives.
  await sh(`echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WARN written just now" >> /tmp/burrowtest-lf/app.log`);
  await expect(page.getByTestId('log-line').filter({ hasText: 'written just now' })).toBeVisible({ timeout: 20_000 });
  await lookAt(page, 'desktop-container-logfile');
  // Removed: no longer a source.
  await page.getByTestId('logfiles-manage').click();
  await dialog.getByTestId('logfile-remove').click();
  await expect(dialog.getByTestId('logfile-suggestion').filter({ hasText: '/data/app.log' })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('logfile-source')).toHaveCount(0);
  await expect(page.getByTestId('log-line').filter({ hasText: 'container output line' })).toBeVisible({ timeout: 20_000 });
  expect(await api<unknown[]>(page, 'GET', `/api/docker/${id}/logfiles?container=burrowtest-lf`)).toEqual([]);
  // nginx's way: error.log a link to the container's own output. Not suggested, and opened it says so (report 71d6c5).
  await sh(`docker exec burrowtest-lf sh -c 'mkdir -p /var/log/nginx && ln -sf /dev/stderr /var/log/nginx/error.log && echo real > /var/log/real.log'`);
  const offered = await api<string[]>(page, 'GET', `/api/docker/${id}/containers/burrowtest-lf/logfile-suggestions`);
  expect(offered).toContain('/var/log/real.log');
  expect(offered).not.toContain('/var/log/nginx/error.log');
  await page.goto(`/#/logs?t=${id}:burrowtest-lf:${encodeURIComponent('/var/log/nginx/error.log')}`);
  await expect(page.getByTestId('log-is-output')).toContainText('a link to the container output', { timeout: 20_000 });
  await expect(page.locator('.logview .alert.error')).toHaveCount(0);
  await sh('docker rm -fv burrowtest-lf >/dev/null; rm -rf /tmp/burrowtest-lf');
});

test('a file on the host opened as a log from Files; an alert about a log file reads as the file and leads to it', async ({ page }) => {
  test.setTimeout(90_000);
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!;
  const [made] = await api<{ exitCode: number }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd.id], command: `printf '%s ERROR from a file on the host\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/burrowtest-files.log` });
  expect(made!.exitCode).toBe(0);
  await page.goto(`/#/files/${sshd.id}?p=/tmp`);
  await page.getByTestId('file-row').filter({ hasText: 'burrowtest-files.log' }).getByTestId('file-menu').click();
  await page.getByTestId('open-as-log').click();
  await expect(page).toHaveURL(/#\/logs\?t=/);
  await expect(page.getByRole('heading', { name: 'burrowtest-files.log' })).toBeVisible();
  await expect(page.getByTestId('log-line').filter({ hasText: 'from a file on the host' })).toBeVisible({ timeout: 20_000 });
  // An alert about that file (as the engine names it): its name, and its lines when opened.
  const subject = `:${encodeURIComponent('/tmp/burrowtest-files.log')}`;
  await page.route('**/api/alerts', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const list = (await res.json()) as unknown[];
    await r.fulfill({ response: res, json: [{ id: 999_001, ruleId: 1, ruleName: 'Errors in files', hostId: sshd.id, hostName: 'test-sshd', container: subject, title: 'log matches "ERROR"', detail: 'ERROR from a file on the host', at: new Date().toISOString(), count: 1, read: false, pushed: 'no' }, ...list] });
  });
  await page.goto('/#/alerts');
  const alert = page.getByTestId('alert').filter({ hasText: 'ERROR from a file on the host' });
  await expect(alert.getByText('burrowtest-files.log', { exact: true })).toBeVisible();
  await lookAt(page, 'desktop-alert-logfile');
  await alert.getByTestId('alert-open').click();
  await expect(page.getByTestId('log-line').filter({ hasText: 'from a file on the host' })).toBeVisible({ timeout: 20_000 });
  await page.unroute('**/api/alerts');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd.id], command: 'rm -f /tmp/burrowtest-files.log' });
});
