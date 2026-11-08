import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// Phase 6: containers and logs like Dozzle. The criterion: a whole stack of
// two hosts in one timeline, and sparklines that move. Hosts: the real
// docker CLI on this machine's Docker (burrowtest-web and -worker, from
// server/test/sshd/testcontainers.sh) and the two stand-in hosts, whose
// fake docker has burrowtest-db and -cache in the same stack.

const DOCKER_HOST = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';

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

test('a stack across hosts, live stats, one merged log timeline with filters', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  // One host for this Docker (the alerts test may have added it already).
  const known = await api<{ id: number; address: string }[]>(page, 'GET', '/api/hosts');
  const h =
    known.find((x) => x.address === DOCKER_HOST) ??
    (await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'docker-real', address: DOCKER_HOST, username: 'tester', authMethod: 'password', password: 'burrow-test-password' }));
  let r = await api<{ status: string; fingerprint?: string }>(page, 'POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') {
    await api(page, 'POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
    r = await api(page, 'POST', `/api/hosts/${h.id}/test`);
  }
  expect(r.status).toBe('ok');

  await page.goto('/#/hosts');
  await page.getByRole('link', { name: 'Containers' }).click();
  await expect(page.getByRole('heading', { name: 'Containers' })).toBeVisible();

  // One stack, three hosts.
  const stack = page.getByTestId('stack').filter({ has: page.getByRole('heading', { name: 'burrowtest' }) });
  await expect(stack).toBeVisible({ timeout: 30_000 });
  await expect(stack).toContainText('docker-real');
  await expect(stack).toContainText('test-sshd');
  const web = stack.getByTestId('container-row').filter({ hasText: 'burrowtest-web' });
  await expect(web).toContainText('up');
  await expect(stack.getByTestId('container-row').filter({ hasText: 'burrowtest-worker' })).toContainText('exited (3)');
  const db = stack.getByTestId('container-row').filter({ hasText: 'burrowtest-db' }).first();
  await expect(db).toContainText('up 2h | healthy | 1 restart');
  // Its recent CPU says its numbers (report 4af4ec: a line without values); before two samples, that it is collecting.
  await expect.poll(() => web.locator('svg.spark').first().getAttribute('aria-label'), { timeout: 40_000 }).toMatch(/: (now \d+\.\d%, highest \d+\.\d%|collecting)/);
  await expect.poll(() => web.locator('svg.spark').first().getAttribute('aria-label'), { timeout: 40_000 }).toMatch(/now \d+\.\d%, highest \d+\.\d%/);
  // Memory beside it, with its values too (report 428102: only CPU had a line).
  await expect.poll(() => web.getByTestId('mem-spark').locator('svg').getAttribute('aria-label'), { timeout: 40_000 }).toMatch(/^Memory of burrowtest-web: now [\d.]+ \w+, highest [\d.]+ \w+$/);

  // A stack folded away (reported: a long page on a phone), what needs a
  // look still said; kept after a reload; a search opens it again.
  await stack.getByTestId('stack-fold').click();
  await expect(stack.getByTestId('stack-fold')).toHaveAttribute('aria-expanded', 'false');
  await expect(web).toBeHidden();
  await expect(stack.getByTestId('stack-troubled')).toHaveText(/\| \d+ needs? a look/);
  await shoot(page, 'phone-containers-folded');
  await page.reload();
  await expect(stack).toBeVisible({ timeout: 30_000 });
  await expect(stack.getByTestId('stack-fold')).toHaveAttribute('aria-expanded', 'false');
  await expect(web).toBeHidden();
  await page.getByTestId('containers-search').fill('burrowtest-web');
  await expect(web.first()).toBeVisible();
  await expect(stack.getByTestId('stack-fold')).toHaveCount(0);
  await page.getByTestId('containers-search').fill('');
  await expect(web).toBeHidden();
  await stack.getByTestId('stack-fold').click();
  await expect(stack.getByTestId('stack-fold')).toHaveAttribute('aria-expanded', 'true');
  await expect(stack.getByTestId('stack-troubled')).toHaveCount(0);
  // All stacks at once, folded and opened again (report 44c246).
  const folds = page.getByTestId('stack-fold');
  await page.getByTestId('stacks-fold-all').click();
  await expect.poll(async () => (await folds.evaluateAll((els) => els.map((e) => e.getAttribute('aria-expanded')))).every((v) => v === 'false')).toBe(true);
  await page.getByTestId('stacks-fold-all').click();
  await expect.poll(async () => (await folds.evaluateAll((els) => els.map((e) => e.getAttribute('aria-expanded')))).every((v) => v === 'true')).toBe(true);

  // Sparklines fill and move (a sample every few seconds): CPU and memory.
  await expect(web.locator('svg polyline')).toHaveCount(2, { timeout: 30_000 });
  const line = web.locator('svg polyline').first();
  const first = await line.getAttribute('points');
  await expect.poll(async () => line.getAttribute('points'), { timeout: 30_000 }).not.toBe(first);
  await shoot(page, 'phone-less-containers');

  // The whole stack in one timeline.
  await stack.getByTestId('stack-logs').click();
  // The heading names them all.
  await expect(page.getByRole('heading', { name: /burrowtest-web.*burrowtest-worker|burrowtest-worker.*burrowtest-web/ })).toBeVisible();
  const lines = page.getByTestId('log-line');
  await expect.poll(async () => new Set(await lines.evaluateAll((els) => els.map((e) => e.getAttribute('data-src')))).size, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const keys = await lines.evaluateAll((els) => els.map((e) => e.getAttribute('data-ts')!));
  expect(keys, 'one timeline, oldest first').toEqual([...keys].sort());
  // Live: more lines keep coming.
  const count = await lines.count();
  await expect.poll(async () => lines.count(), { timeout: 15_000 }).toBeGreaterThan(count);
  await shoot(page, 'logs-merged');

  // Filters, like Dozzle: level, stream, search.
  await page.getByRole('button', { name: 'error', exact: true }).click();
  await expect(page.locator('[data-testid=log-line].lvl-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'error', exact: true }).click();
  await page.getByRole('button', { name: 'stderr', exact: true }).click();
  await expect.poll(async () => page.locator('[data-testid=log-line]:not(.err)').count()).toBe(0);
  await expect(page.locator('[data-testid=log-line].err').first()).toBeVisible();
  await page.getByRole('button', { name: 'all', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search' }).fill('timeout \\d+');
  await page.getByRole('button', { name: 'Regular expression' }).click();
  await expect.poll(async () => (await lines.allTextContents()).every((x) => /timeout \d+/.test(x))).toBe(true);
  await expect(lines.first()).toBeVisible();

  // A permalink to a line opens around it with the line marked.
  await lines.first().click();
  await page.getByRole('button', { name: 'Copy link' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('#/logs?');
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page.locator('.line.marked')).toBeVisible({ timeout: 20_000 });

  // A line chosen on a narrow phone in Dutch with the phone's text a size up (Android's font size):
  // its three actions on one row inside the log, each one line high (report 41947e: Kopieren cut
  // off at the right, Link kopieren over two lines; then not on a second row either: the user).
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 343, height: 711 });
  await page.evaluate(() => localStorage.setItem('burrow.locale', 'nl'));
  await page.reload();
  await page.addStyleTag({ content: 'html { font-size: 125% }' });
  await page.locator('.line.marked').click();
  const acts = page.locator('.line.marked .actions .btn');
  await expect(acts).toHaveCount(3);
  const edge = (await page.locator('.line.marked').boundingBox())!;
  const tops = new Set<number>();
  for (const b of await acts.all()) {
    const r = (await b.boundingBox())!;
    const name = (await b.getAttribute('aria-label'))!;
    expect(r.x + r.width, name).toBeLessThanOrEqual(edge.x + edge.width + 1);
    expect(r.height, `${name} one line high`).toBeLessThan(52);
    tops.add(Math.round(r.y));
  }
  expect(tops.size, 'the three on one row').toBe(1);
  await lookAt(page, 'phone-nl-log-line-chosen', { passes: [] });
  await expect(page.locator('.line.marked .actions .btn').first()).toHaveAttribute('aria-label', 'Vastpinnen');
  await page.evaluate(() => localStorage.setItem('burrow.locale', 'en'));
  await page.setViewportSize(size);
  await page.reload();

  // One container: what it is, and its logs since it started.
  await page.goto('/#/containers');
  await stack.getByTestId('container-row').filter({ hasText: 'burrowtest-worker' }).click();
  await expect(page.getByRole('heading', { name: 'burrowtest-worker' })).toBeVisible();
  await expect(page.getByText('exited', { exact: true })).toBeVisible();
  await expect(page.getByTestId('log-line').filter({ hasText: 'WARN worker starting' })).toBeVisible({ timeout: 20_000 });
  // Since its last start: the same two lines (it started once).
  await page.getByRole('combobox', { name: 'Time range' }).selectOption({ label: 'Since start' });
  await expect(page.getByTestId('log-line').filter({ hasText: 'INFO job done' })).toBeVisible({ timeout: 20_000 });
  // Nothing hidden by a filter: no count, just the two lines.
  await expect(page.getByTestId('log-line')).toHaveCount(2);
  await expect(page.getByTestId('log-count')).toHaveCount(0);
  await shoot(page, 'container-detail');
});

test('many logs at once: their source chips behind one, side by side beside the search (report eeff05)', async ({ page }) => {
  // Live logs and the layout checks over them in every pass (more checks since 2.1.0) take longer than a usual test.
  test.setTimeout(300_000);
  await signIn(page);
  const [hostId, names] = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const id = hosts.find((h) => h.name === 'docker-real')!.id;
    const { containers } = (await (await fetch(`/api/docker/${id}/containers`)).json()) as { containers: { name: string }[] };
    return [id, containers.map((c) => c.name).slice(0, 11)] as const;
  });
  // As many as the test host shows (its own containers only, at least eight), up to eleven.
  expect(names.length).toBeGreaterThanOrEqual(8);
  await page.goto(`/#/logs?t=${names.map((n) => `${hostId}:${n}`).join(',')}`);
  await expect(page.getByTestId('log-sources-toggle')).toHaveText(`${names.length} of ${names.length} sources`);
  await expect(page.getByTestId('log-source')).toHaveCount(0);
  await page.getByTestId('log-sources-toggle').click();
  await expect(page.getByTestId('log-source')).toHaveCount(names.length);
  // Side by side is a button beside the search: no line of its own below the filters.
  await expect(page.getByTestId('log-side-by-side')).toBeVisible();
  await expect(page.locator('.logview .bar')).toHaveCount(0);
  await lookAt(page, 'desktop-logs-many');
});

test('Containers while one host has not answered yet: that host named, the counts said to be so far (UIB-04)', async ({ page }) => {
  await signIn(page);
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const real = hosts.find((h) => h.name === 'docker-real')!;
  // docker-real's snapshots held back, as from a slow host; the others pass.
  await page.routeWebSocket(/\/api\/docker\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const j = JSON.parse(String(m)) as { host?: { hostId?: number }; hostId?: number };
      if ((j.host?.hostId ?? j.hostId) === real.id) return;
      ws.send(m);
    });
  });
  await page.goto('/#/containers');
  await page.reload();
  await expect(page.getByTestId('host-pending')).toContainText('docker-real');
  await expect(page.getByTestId('stack').filter({ hasText: 'burrowtest' }).getByTestId('stack-partial')).toBeVisible();
  // Where it answers (a page without the hold-back): neither is said.
  const other = await page.context().newPage();
  await other.goto('/#/containers');
  await expect(other.getByTestId('stack').filter({ hasText: 'burrowtest' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(other.getByTestId('host-pending')).toHaveCount(0, { timeout: 20_000 });
  await expect(other.getByTestId('stack-partial')).toHaveCount(0);
  await other.close();
});

test('a big stack takes one of the two columns like the others, not both (report 2018c4); a state with its health on one line (report 6fa349)', async ({ page }) => {
  await signIn(page);
  // In Dutch, its longest words: "draait 14 dagen | gezond" broke over two lines beside room enough (6fa349).
  await page.evaluate(() => localStorage.setItem('burrow.locale', 'nl'));
  // The first host's snapshot with a stack of 20 beside its own: what a homelab's "data" stack is.
  let into: number | null = null;
  await page.routeWebSocket(/\/api\/docker\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const j = JSON.parse(String(m)) as { t: string; host?: { hostId: number; containers: unknown[] }; d?: { hostId: number } };
      if (j.t === 'host' && j.host && (into === null || into === j.host.hostId)) {
        into = j.host.hostId;
        const at = new Date(Date.now() - 14 * 86_400_000).toISOString();
        j.host.containers.push(...Array.from({ length: 20 }, (_, i) => ({ id: `big${i}`, name: `bigstack-svc-${i}`, image: 'nginx:1', imageId: 'sha256:big', state: 'running', health: 'healthy', restarts: 0, startedAt: at, finishedAt: null, exitCode: 0, oomKilled: false, createdAt: at, project: 'bigstack', service: `svc-${i}`, configFiles: null, workingDir: null })));
        return ws.send(JSON.stringify(j));
      }
      // That host's later changes would take the stand-ins away again: left out.
      if (j.t === 'delta' && j.d?.hostId === into) return;
      ws.send(m);
    });
  });
  await page.setViewportSize({ width: 1912, height: 914 });
  await page.goto('/#/containers');
  await page.reload();
  const big = page.getByTestId('stack').filter({ hasText: 'bigstack' });
  await expect(big.getByTestId('container-row')).toHaveCount(20);
  const others = page.getByTestId('stack').filter({ hasNotText: 'bigstack' });
  expect(await others.count()).toBeGreaterThan(0);
  // As wide as each of the others, and one of them beside it.
  const width = (await big.boundingBox())!.width;
  const boxes = await Promise.all((await others.all()).map((s) => s.boundingBox()));
  for (const b of boxes) expect(Math.abs(b!.width - width)).toBeLessThan(3);
  const bx = (await big.boundingBox())!.x;
  expect(boxes.some((b) => Math.abs(b!.x - bx) > width / 2)).toBe(true);
  // Each state on one line: the column as wide as its words, the update column only as wide as a flag in it.
  await expect(big.locator('.c-state').first()).toContainText('gezond');
  const states = await big.locator('.c-state').evaluateAll((els) =>
    els.map((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return { text: e.textContent!.trim(), lines: new Set([...r.getClientRects()].filter((x) => x.width > 1).map((x) => Math.round(x.top))).size };
    }),
  );
  expect(states.filter((s) => s.lines > 1)).toEqual([]);
  // A restart said too, in the other stack: still one line.
  const all = await page.locator('.c-state').evaluateAll((els) =>
    els.map((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return { text: e.textContent!.trim(), lines: new Set([...r.getClientRects()].filter((x) => x.width > 1).map((x) => Math.round(x.top))).size };
    }),
  );
  expect(all.filter((s) => s.lines > 1)).toEqual([]);
  await lookAt(page, 'containers-big-stack');
  await page.evaluate(() => localStorage.setItem('burrow.locale', 'en'));
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("a container's details open on a phone held sideways: they scroll in their own part, the log stays in reach (report 5d0b33)", async ({ page }) => {
  await signIn(page);
  const hosts = await api<{ id: number; address: string }[]>(page, 'GET', '/api/hosts');
  const id = hosts.find((h) => h.address === DOCKER_HOST)!.id;
  // The phone of the report, sideways.
  await page.setViewportSize({ width: 698, height: 434 });
  await page.goto(`/#/containers/${id}/burrowtest-web`);
  await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('container-info').click();
  await expect(page.getByTestId('container-history')).toBeVisible();
  // The log below the details: on screen, with room for its lines.
  const log = page.locator('[data-main]').first();
  const box = (await log.boundingBox())!;
  // As lookAt's check has it (mainReachable): 140 px, or 30% of a low screen.
  expect(Math.min(box.y + box.height, 434) - Math.max(box.y, 0)).toBeGreaterThanOrEqual(Math.min(140, 434 * 0.3));
  await expect(page.getByTestId('log-line').last()).toBeInViewport();
  // The details' last line reached by scrolling them, the log staying where it is.
  const more = page.getByTestId('container-more');
  await more.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await expect(more.getByText('Started', { exact: true })).toBeInViewport();
  expect((await log.boundingBox())!.y).toBeCloseTo(box.y, 0);
  // The line that closes them still at their top.
  await expect(page.getByTestId('container-info')).toBeInViewport();
  await lookAt(page, 'phone-sideways-container-info');
  // The history as wide as the details around it, its range filling the line it is on (report a6548d:
  // 640 px of the 674 there, the search under it the whole width).
  const room = await more.evaluate((e) => e.clientWidth - parseFloat(getComputedStyle(e).paddingLeft) - parseFloat(getComputedStyle(e).paddingRight));
  expect((await page.getByTestId('container-history').boundingBox())!.width).toBeCloseTo(room, 0);
  const range = (await page.getByTestId('container-history-range').boundingBox())!;
  const kept = (await page.getByTestId('container-history').boundingBox())!;
  expect(range.x + range.width).toBeCloseTo(kept.x + kept.width, 0);
  await page.getByTestId('container-info').click();
  await expect(page.getByTestId('container-history')).toHaveCount(0);
});
