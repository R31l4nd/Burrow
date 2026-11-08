import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// The time ranges of a merged view of many containers, on the real docker
// CLI: some running a while, some restarted (report c8d284: "since start"
// could not be chosen there, and an empty view did not say why).

const DOCKER_HOST = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';
const ALPINE = 'alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f';
const NAMES = Array.from({ length: 14 }, (_, k) => `burrowtest-many-${String(k + 1).padStart(2, '0')}`);
const RESTARTED = NAMES.slice(0, 4);
// One that said 6000 lines, one 3000, and one that says nothing.
const EXTRA = ['burrowtest-many-loud1', 'burrowtest-many-loud2', 'burrowtest-many-quiet'];

const api = <T,>(page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;

async function dockerHost(page: Page): Promise<number> {
  const known = await api<{ id: number; address: string }[]>(page, 'GET', '/api/hosts');
  const h = known.find((x) => x.address === DOCKER_HOST) ?? (await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'docker-real', address: DOCKER_HOST, username: 'tester', authMethod: 'password', password: 'burrow-test-password' }));
  let r = await api<{ status: string; fingerprint?: string }>(page, 'POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') {
    await api(page, 'POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
    r = await api(page, 'POST', `/api/hosts/${h.id}/test`);
  }
  expect(r.status).toBe('ok');
  return h.id;
}

test('"since start" of many merged containers: each from its own last start; an empty view says why (report c8d284)', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const id = await dockerHost(page);
  const sh = async (command: string) => {
    const [r] = await api<{ exitCode: number; stdout: string; stderr: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [id], command });
    expect(r!.exitCode, `${command}: ${r!.stderr}`).toBe(0);
    return r!.stdout;
  };
  // Each says one line when it starts; four are restarted, so they said it twice.
  await sh(`docker rm -fv ${NAMES.join(' ')} >/dev/null 2>&1; for n in ${NAMES.join(' ')}; do docker run -d --label burrow.ignore=true --name $n ${ALPINE} sh -c 'echo "INFO started $HOSTNAME at $(date +%s%N)"; exec sleep 3600' >/dev/null || exit 1; done`);
  await sh(`sleep 1; docker restart -t 0 ${RESTARTED.join(' ')} >/dev/null`);
  await sh(`docker rm -fv ${EXTRA.join(' ')} >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name ${EXTRA[0]} ${ALPINE} sh -c 'seq 1 6000; exec sleep 3600' >/dev/null || exit 1; docker run -d --label burrow.ignore=true --name ${EXTRA[1]} ${ALPINE} sh -c 'seq 1 3000; exec sleep 3600' >/dev/null || exit 1; docker run -d --label burrow.ignore=true --name ${EXTRA[2]} ${ALPINE} sleep 3600 >/dev/null`);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/logs?t=${NAMES.map((n) => `${id}:${n}`).join(',')}`);
    const lines = page.getByTestId('log-line');
    // The latest lines: both starts of the restarted ones.
    await expect(lines).toHaveCount(NAMES.length + RESTARTED.length, { timeout: 30_000 });
    const range = page.getByRole('combobox', { name: 'Time range' });
    // Since start: one line each, the restarted ones' first start left out.
    await range.selectOption('start');
    await expect(lines).toHaveCount(NAMES.length, { timeout: 30_000 });
    // The other ranges hold both starts.
    for (const r of ['15m', '1h', '24h']) {
      await range.selectOption(r);
      await expect(lines).toHaveCount(NAMES.length + RESTARTED.length, { timeout: 30_000 });
    }

    // Every level off (the report's filter badge): said, with the way back.
    await range.selectOption('start');
    await expect(lines).toHaveCount(NAMES.length, { timeout: 30_000 });
    // On a computer the filters are always there; on a phone behind their button.
    if (await page.getByTestId('log-filters').isVisible()) await page.getByTestId('log-filters').click();
    for (const l of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'no level']) await page.locator('.logview .chips .chip', { hasText: new RegExp(`^${l}$`) }).click();
    await expect(page.getByTestId('log-count')).toHaveText(`0 of ${NAMES.length} lines`);
    await expect(page.getByTestId('log-filtered-out')).toContainText(`All ${NAMES.length} lines are hidden by the filters.`);
    await lookAt(page, 'logs-filtered-out');
    await page.getByTestId('log-show-all').click();
    await expect(lines).toHaveCount(NAMES.length);
    await expect(page.getByTestId('log-filtered-out')).toHaveCount(0);

    // More lines of one source in the range than are kept: its oldest left out, and said; the
    // other's all kept, not pushed out by the loud one (decision 3: 5000 a source, not in all).
    await page.goto(`/#/logs?t=${EXTRA.slice(0, 2).map((n) => `${id}:${n}`).join(',')}`);
    await page.getByRole('combobox', { name: 'Time range' }).selectOption('start');
    await expect(page.getByTestId('log-dropped')).toHaveText('More than 5000 lines of one source in this range: its oldest are not shown. Choose a shorter range.', { timeout: 30_000 });
    // 5000 + 3000 kept, 2000 of them shown.
    await expect(page.getByText('6000 older lines not shown; narrow the filters or the time range.')).toBeVisible();
    await expect(lines).toHaveCount(2000);

    // Nothing in the range is not "no lines yet", and a read that failed is not "nothing there".
    await page.goto(`/#/logs?t=${id}:${EXTRA[2]}`);
    await page.getByRole('combobox', { name: 'Time range' }).selectOption('15m');
    await expect(page.getByTestId('log-empty')).toHaveText('No lines in this time range so far.');
    await page.goto(`/#/logs?t=${id}:burrowtest-many-nosuch`);
    const failed = page.getByTestId('log-empty-failed');
    await expect(failed).toBeVisible({ timeout: 30_000 });
    // Said once, in words, where the lines would be: not docker's own text in a box above and a
    // red bar across the log below it (report 931cd0).
    await expect(failed).toContainText('These logs could not be read');
    await expect(failed).toContainText('This container no longer exists on its host.');
    await expect(page.getByText(/Error response from daemon/)).toHaveCount(0);
    await expect(page.locator('.logview .alert.error')).toHaveCount(0);
    // Tried again: read again, the same said.
    await failed.getByTestId('log-retry').click();
    await expect(failed).toContainText('This container no longer exists on its host.', { timeout: 30_000 });
    await page.getByRole('combobox', { name: 'Time range' }).selectOption('start');
    await expect(page.getByTestId('log-empty-failed')).toBeVisible({ timeout: 30_000 });
    await lookAt(page, 'logs-empty-failed');
  } finally {
    await sh(`docker rm -fv ${[...NAMES, ...EXTRA].join(' ')} >/dev/null 2>&1; true`);
  }
});
