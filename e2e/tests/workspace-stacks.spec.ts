import { expect, test, type Page, type WebSocketRoute } from './fixtures.js';
import { sayYes } from './confirm.js';
import { lookAt, SOME_PASSES } from './checks.js';
import { signIn } from './passkey.js';

// Phase 8, the criterion: change a compose file, look at the diff, deploy it
// with live output; an outdated image is reported and (on a test stack)
// updated automatically. The host has the real docker CLI and compose on
// this machine's Docker; the images come from a test registry on
// localhost:5001 (server/test/sshd/registry.sh).

const DOCKER_HOST = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';
const IMAGE = 'localhost:5001/burrowtest-app:latest';
const PROJECT = 'burrowtest-e2e';
const DIR = '/home/tester/e2e-stack';

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

test('edit a compose file, review the diff, deploy; an outdated image updated automatically', async ({ page }) => {
  test.setTimeout(600_000); // Real pulls and an update window: 6-7 min when the machine is busy.
  const asked = await sayYes(page);
  // The bulk update further on is answered by a stand-in operation; its socket is routed from the first page on
  // (Playwright routes only the sockets of pages loaded after this).
  const opSocket = new Promise<WebSocketRoute>((resolve) => void page.routeWebSocket(/\/api\/docker\/ops\/stand-in\/ws/, (ws) => resolve(ws)));
  // The container page's update that fails: a stand-in that ends with exit code 1.
  await page.routeWebSocket(/\/api\/docker\/ops\/stand-in-failed\/ws/, (ws) => ws.send(JSON.stringify({ t: 'exit', code: 1 })));
  await signIn(page);
  // The same Docker as the containers test: one host for it, as two hosts on one Docker would each report the update.
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
  const sh = async (command: string) => {
    const [res] = await api<{ exitCode: number; stdout: string; stderr: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [h.id], command });
    expect(res!.exitCode, `${command}: ${res!.stderr}`).toBe(0);
    return res!.stdout;
  };
  const publish = async (v: string) => {
    const running = (await sh(`docker inspect --format '{{.Image}}' ${PROJECT}-app-1 2>/dev/null || true`)).trim();
    await sh(`docker tag burrowtest-app:${v} ${IMAGE} && docker push -q ${IMAGE} >/dev/null`);
    if (running) await sh(`docker tag ${running} ${IMAGE}`);
  };
  await publish('v1');
  await sh(
    [
      `rm -rf ${DIR} && mkdir -p ${DIR}`,
      `printf 'services:\\n  app:\\n    image: ${IMAGE}\\n    restart: on-failure:3\\n    labels:\\n      burrow.ignore: "true"\\n' > ${DIR}/compose.yaml`,
      `cd ${DIR} && docker compose -p ${PROJECT} up -d --quiet-pull 2>&1`,
    ].join(' && '),
  );

  // From Containers to the stack (reloaded: the page knew the hosts before this one).
  await page.goto('/#/containers');
  await page.reload();
  await page.getByTestId('stack-link').filter({ hasText: PROJECT }).first().click();
  await expect(page.getByRole('heading', { name: PROJECT })).toBeVisible();
  await expect(page.getByTestId('stack-service')).toContainText('app');

  // Edit the compose file, then "Deploy" from the editor.
  await page.getByTestId('edit-compose').click();
  await expect(page.locator('.cm-content')).toContainText('restart: on-failure:3');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('    environment:\n      GREETING: hello\n');
  await page.getByTestId('to-deploy').click();

  // Back on the stack: the diff, the compose check, deploy with live output.
  const review = page.getByRole('dialog', { name: `Deploy ${PROJECT}` });
  await expect(review.getByTestId('diff')).toContainText('GREETING: hello', { timeout: 30_000 });
  await expect(review.getByTestId('compose-ok')).toBeVisible();
  await shoot(page, 'desktop-stack-review');
  // Changed after the review (elsewhere): not deployed; the review again, with the change.
  await sh(`printf '      EXTRA: one\\n' >> ${DIR}/compose.yaml`);
  await review.getByTestId('deploy').click();
  await expect(page.getByTestId('toasts').locator('.toast').filter({ hasText: 'changed since the review' })).toBeVisible();
  await expect(review.getByTestId('diff')).toContainText('EXTRA: one', { timeout: 30_000 });
  expect(await sh(`docker inspect --format '{{json .Config.Env}}' ${PROJECT}-app-1`)).not.toContain('GREETING');
  await review.getByTestId('deploy').click();
  // Watched for 60 s after compose ended, as an update is (decision 11), and only then done.
  await expect(page.getByTestId('op-watching')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('op-status')).toContainText('Deploy done', { timeout: 120_000 });
  // How far it got, from compose's own output: every container done.
  await expect(page.getByTestId('op-containers')).toContainText(/Containers (\d+) of \1/);
  // The raw output is one tap away.
  await page.getByTestId('op-log-toggle').click();
  await expect(page.getByTestId('op-output')).toContainText(`$ up ${PROJECT}`);
  await shoot(page, 'desktop-stack-op');
  expect(await sh(`docker inspect --format '{{json .Config.Env}}' ${PROJECT}-app-1`)).toContain('GREETING=hello');
  // Deployed: the next review compares with this version.
  await page.getByTestId('review-deploy').click();
  await expect(page.getByTestId('no-changes')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // A newer version under another tag (the registry has 2.0): named on the
  // stack, and "Use 2.0" changes that image line, then the same review.
  const name = IMAGE.slice(0, IMAGE.lastIndexOf(':'));
  const before = await sh(`cat ${DIR}/compose.yaml`);
  await page.route('**/api/docker/updates', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const o = (await res.json()) as { checks: { image: string; newerTag: string | null }[] };
    if (!o.checks.some((c) => c.image === IMAGE)) o.checks.push({ hostId: h.id, image: IMAGE, status: 'current', localDigest: null, remoteDigest: null, error: null, source: null, version: null, checkedAt: new Date().toISOString() } as never);
    for (const c of o.checks) if (c.image === IMAGE) c.newerTag = '2.0';
    await r.fulfill({ response: res, json: o });
  });
  // The stack again (without "?review=1" from the editor, which opens the review).
  await page.goto(page.url().replace(/\?.*$/, ''));
  await page.reload();
  await expect(page.getByTestId('newer-pill')).toHaveText('2.0 is out');
  const row = page.getByTestId('newer-version').filter({ hasText: IMAGE });
  await expect(row).toContainText('2.0 is out');
  await shoot(page, 'desktop-stack-newer');
  await row.getByTestId('use-tag').click();
  const retag = page.getByRole('dialog', { name: `Deploy ${PROJECT}` });
  await expect(retag.getByTestId('diff')).toContainText(`${name}:2.0`, { timeout: 30_000 });
  expect(await sh(`cat ${DIR}/compose.yaml`)).toContain(`image: ${name}:2.0`);
  // Not deployed here: the file back as it was.
  await retag.getByRole('button', { name: 'Cancel' }).click();
  await page.unroute('**/api/docker/updates');
  await sh(`echo ${Buffer.from(before).toString('base64')} | base64 -d > ${DIR}/compose.yaml`);

  // Its image's check failed: not "up to date", and which one says so (AUDIT2 PAGE-07).
  await page.route('**/api/docker/updates', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const o = (await res.json()) as { checks: { hostId: number; image: string }[] };
    o.checks = o.checks.filter((c) => !(c.hostId === h.id && c.image === IMAGE));
    o.checks.push({ hostId: h.id, image: IMAGE, status: 'unknown', localDigest: null, remoteDigest: null, error: 'registry said 429', source: null, version: null, newerTag: null, checkedAt: new Date().toISOString() } as never);
    await r.fulfill({ response: res, json: o });
  });
  await page.reload();
  await expect(page.getByTestId('stack-check')).toContainText('could not be checked');
  await expect(page.getByTestId('stack-check-failed')).toHaveAttribute('title', 'registry said 429');
  await page.unroute('**/api/docker/updates');

  // A newer image in the registry: reported on the stack, the rows and the tab.
  await publish('v2');
  await page.getByTestId('check-stack').click();
  await expect(page.getByTestId('stack-updates')).toContainText(IMAGE, { timeout: 30_000 });
  await expect(page.getByTestId('stack-updates')).toContainText('here: v1');
  // Updates are a dot of their own on the tab; the red count is only for new alerts.
  await expect(page.getByTestId('updates-badge')).toHaveAttribute('aria-label', '1 image update available');
  await expect(page.getByTestId('updates-badge')).toHaveText('');
  // The dot is whole: nothing cuts it off, on a desktop and on a phone.
  for (const size of [{ width: 1280, height: 720 }, { width: 360, height: 780 }]) {
    await page.setViewportSize(size);
    const clipped = await page.getByTestId('updates-badge').evaluate((b) => {
      // Points just inside each edge (not the rounded corners, which hit-testing leaves out).
      const r = b.getBoundingClientRect();
      const mx = (r.left + r.right) / 2;
      const my = (r.top + r.bottom) / 2;
      const corners = [
        [r.left + 3, my],
        [r.right - 3, my],
        [mx, r.top + 3],
        [mx, r.bottom - 3],
      ];
      return corners.filter(([x, y]) => !b.contains(document.elementFromPoint(x!, y!))).length + (b.scrollWidth > b.clientWidth ? 1 : 0);
    });
    expect(clipped, `updates badge cut off at ${size.width} px`).toBe(0);
    // With new alerts too, the two signs sit apart.
    if (await page.getByTestId('alerts-badge').count()) {
      const [a, u] = [await page.getByTestId('alerts-badge').boundingBox(), await page.getByTestId('updates-badge').boundingBox()];
      expect(a!.y + a!.height <= u!.y || u!.y + u!.height <= a!.y || a!.x + a!.width <= u!.x || u!.x + u!.width <= a!.x, 'alert count and update dot overlap').toBe(true);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  // What is new: the image's GitHub releases (answered here by a stand-in).
  await page.route('**/api/docker/*/changelog?*', (route) =>
    route.fulfill({
      json: {
        url: 'https://github.com/burrow-test/app/releases',
        matched: true,
        breaking: 1,
        releases: [
          {
            tag: 'v2.1',
            name: 'v2.1',
            publishedAt: '2026-09-29T00:00:00Z',
            body: '### Fixes\n- Logs keep their colours\n- Security fix for the `/api` token (see [the advisory](https://github.com/burrow-test/app/security))\n\nThe new menu:\n![](https://github.com/user-attachments/assets/b011c1a2-b81c-47a8-b3d8-159d829fcf82 "=428x659")',
            url: 'https://github.com/burrow-test/app/releases/tag/v2.1',
            flags: { breaking: [], important: ['Security fix for the /api token'], major: false },
          },
          {
            tag: 'v2',
            name: 'v2',
            publishedAt: '2026-09-27T00:00:00Z',
            body: '## Breaking changes\n- PORT is now HTTP_PORT\n\n## Changes\n- Faster start\n- <b>not bold</b>',
            url: 'https://github.com/burrow-test/app/releases/tag/v2',
            flags: { breaking: ['PORT is now HTTP_PORT'], important: [], major: false },
          },
          {
            tag: 'v1.9',
            name: 'v1.9',
            publishedAt: '2026-09-20T00:00:00Z',
            body: 'Small things.',
            url: 'https://github.com/burrow-test/app/releases/tag/v1.9',
            flags: { breaking: [], important: [], major: false },
          },
        ],
      },
    }),
  );
  // Its pictures come from GitHub through Burrow (report 64498b: they showed as text); a stand-in here too.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAAE0lEQVR4nGPQzfInCTGMaqCFBgABsHMBBNt++QAAAABJRU5ErkJggg==', 'base64');
  await page.route('**/api/changelog/image?*', (route) => route.fulfill({ contentType: 'image/png', body: png }));
  await page.getByTestId('whats-new').click();
  const notes = page.getByTestId('changelog');
  await expect(notes).toContainText('3 newer versions: v1.9 to v2.1');
  // Formatted: headings and lists as such, a link to its site; HTML in the notes stays text.
  const v2 = notes.getByTestId('release').filter({ has: page.getByTestId('release-breaking') });
  await expect(v2.locator('h3', { hasText: /^Changes$/ })).toBeVisible();
  await expect(v2.locator('li', { hasText: 'Faster start' })).toBeVisible();
  await expect(notes).toContainText('<b>not bold</b>');
  await expect(notes.locator('b')).toHaveCount(0);
  await expect(notes.getByRole('link', { name: 'the advisory' })).toHaveAttribute('href', 'https://github.com/burrow-test/app/security');
  const shot = notes.getByTestId('changelog-body').locator('img').first();
  await expect(shot).toHaveAttribute('src', `/api/changelog/image?url=${encodeURIComponent('https://github.com/user-attachments/assets/b011c1a2-b81c-47a8-b3d8-159d829fcf82')}`);
  await expect.poll(() => shot.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(16);
  await expect(notes).not.toContainText('![](');
  // What to read first: said once, with its version; worth knowing apart.
  await expect(notes.getByTestId('changelog-breaking')).toContainText('Read before updating');
  await expect(notes.getByTestId('changelog-breaking')).toContainText('v2 PORT is now HTTP_PORT');
  await expect(notes.getByTestId('changelog-important')).toContainText('v2.1 Security fix for the /api token');
  await expect(notes.getByTestId('release-breaking')).toBeVisible();
  // Open: the newest and the breaking one; the rest folded, opened on a tap.
  const v19 = notes.getByTestId('release').filter({ hasText: 'v1.9' });
  await expect(v19).not.toHaveAttribute('open', '');
  await shoot(page, 'desktop-stack-changelog');
  await v19.getByTestId('release-head').click();
  await expect(v19.getByText('Small things.')).toBeVisible();
  // Folded and opened again by its head.
  await v2.getByTestId('release-head').click();
  await expect(v2).not.toHaveAttribute('open', '');
  await v2.getByTestId('release-head').click();
  await expect(v2).toHaveAttribute('open', '');
  // On a phone too (the layout checks run on the shot).
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, 'phone-stack-changelog');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('dialog', { name: 'What is new: burrowtest-app' }).getByRole('button', { name: 'Close' }).click();

  await page.goto('/#/containers');
  await expect(page.getByTestId('container-row').filter({ hasText: `${PROJECT}-app-1` }).first().getByTestId('row-update')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('updates-count')).toHaveText('1');
  await expect(page.getByTestId('updates-count')).toHaveAttribute('title', '1 image update available');
  // The menu shows only what has an update.
  await page.getByTestId('updates-menu').click();
  await page.getByTestId('show-updates').click();
  await expect(page.getByTestId('containers-filter')).toHaveValue('state:update');
  await expect(page.getByTestId('container-row')).toHaveCount(await page.getByTestId('row-update').count());
  await expect(page.getByTestId('container-row').filter({ hasText: `${PROJECT}-app-1` }).first()).toBeVisible();
  await page.getByTestId('containers-filter').selectOption('all');
  // Picked with others: Update asks only for the one with an update, by its
  // stack and service (the operation itself answered by a stand-in here: the
  // outdated image is needed further on).
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByTestId('container-row').filter({ hasText: `${PROJECT}-app-1` }).first().click();
  await page.getByTestId('container-row').filter({ hasText: 'burrowtest-web' }).first().click();
  let bulkAsked: unknown = null;
  await page.route('**/api/docker/*/stacks/*/ops', (r) => ((bulkAsked = r.request().postDataJSON()), r.fulfill({ json: { id: 'stand-in', op: 'update', startedAt: new Date().toISOString(), exitCode: null, output: '' } })));
  // Its output and end as a stand-in too: followed to the end, its last line the progress (report c28922).
  await page.getByTestId('bulk-update').click();
  const bulk = page.getByRole('dialog');
  await expect(bulk.getByTestId('bulk-skip')).toContainText('burrowtest-webno update');
  await bulk.getByTestId('bulk-go').click();
  await expect(bulk.getByTestId('bulk-state').first()).toHaveText('update started', { timeout: 30_000 });
  const ws = await opSocket;
  ws.send(JSON.stringify({ t: 'output', d: 'Pulling app\n' }));
  await expect(bulk.getByTestId('bulk-act')).toContainText('Pulling app');
  // Not "done" while it runs.
  await expect(bulk.getByTestId('bulk-done')).toHaveCount(0);
  await expect(bulk.getByTestId('bulk-close')).toBeDisabled();
  ws.send(JSON.stringify({ t: 'exit', code: 0 }));
  await expect(bulk.getByTestId('bulk-done')).toHaveText('1 done, 0 failed');
  await expect(bulk.getByTestId('bulk-state').first()).toHaveText('done');
  expect(bulkAsked).toEqual({ op: 'update', services: ['app'] });
  await bulk.getByTestId('bulk-close').click();
  await page.unroute('**/api/docker/*/stacks/*/ops');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // What is new in several images at once (reports 26c0fa, bd2d76: each
  // changelog had to be opened on its own). A second update as a stand-in:
  // burrowtest-web's image, with notes of its own.
  const webImage = (await sh(`docker inspect --format '{{.Config.Image}}' burrowtest-web`)).trim();
  const webName = webImage.replace(/@.*$/, '').replace(/:[^/:]*$/, '').split('/').pop()!;
  await page.route('**/api/docker/updates', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const o = (await res.json()) as { checks: { hostId: number; image: string }[] };
    o.checks = o.checks.filter((c) => !(c.hostId === h.id && c.image === webImage));
    o.checks.push({ hostId: h.id, image: webImage, status: 'update', localDigest: 'sha256:aaaa', remoteDigest: 'sha256:bbbb', error: null, source: 'https://github.com/burrow-test/web', version: '1.0', newerTag: null, checkedAt: new Date().toISOString() } as never);
    await r.fulfill({ response: res, json: o });
  });
  await page.route('**/api/docker/*/changelog?*', (route) =>
    new URL(route.request().url()).searchParams.get('image') !== webImage
      ? route.fallback()
      : route.fulfill({
          json: {
            url: 'https://github.com/burrow-test/web/releases',
            matched: true,
            breaking: 1,
            releases: [
              { tag: '3.0', name: '3.0', publishedAt: '2026-09-30T00:00:00Z', body: '## Breaking\n- The config moved to /etc/web', url: 'https://github.com/burrow-test/web/releases/tag/3.0', flags: { breaking: ['The config moved to /etc/web'], important: [], major: true } },
              { tag: '2.4', name: '2.4', publishedAt: '2026-09-10T00:00:00Z', body: '- Faster pages', url: 'https://github.com/burrow-test/web/releases/tag/2.4', flags: { breaking: [], important: ['Needs a restart of the proxy', 'Public access to the <https://api.example.com/vpn/logicals-and-a-rather-long-path-of-its-own> endpoint is gone', 'Signed in again', 'A fourth line', 'A fifth line'], major: false } },
            ],
          },
        }),
  );
  await page.reload();
  await expect(page.getByTestId('updates-count')).toHaveText('2', { timeout: 30_000 });
  const overview = page.getByRole('dialog', { name: 'What is new in 2 images' });
  const checkOverview = async () => {
    // What to read first over all of them, each under its image's name, then each image's versions folded.
    await expect(overview.getByTestId('changelog-breaking')).toContainText('burrowtest-app v2 PORT is now HTTP_PORT');
    await expect(overview.getByTestId('changelog-breaking')).toContainText(`${webName} 3.0 The config moved to /etc/web`);
    await expect(overview.getByTestId('changelog-important')).toContainText(`${webName} 2.4 Needs a restart of the proxy`);
    // Grouped under the image and its version, a few lines each, the rest in its notes; a long address
    // wraps inside the box (report 588254: it ran off the screen).
    const worth = overview.getByTestId('changelog-important');
    await expect(worth.getByTestId('worth-group').filter({ hasText: `${webName} 2.4` }).locator('li')).toHaveCount(3);
    await expect(worth).toContainText('2 more lines in its notes');
    expect(await worth.evaluate((box) => [...box.querySelectorAll('li')].filter((li) => li.getBoundingClientRect().right > box.getBoundingClientRect().right + 1).length)).toBe(0);
    await expect(overview.getByTestId('changelog-image')).toHaveCount(2);
    await expect(overview.getByTestId('changelog-image').filter({ hasText: webImage })).toContainText('2 newer versions: 2.4 to 3.0');
    await expect(overview.getByTestId('release')).toHaveCount(5);
    await expect(overview.locator('details[open]')).toHaveCount(0);
    const web3 = overview.getByTestId('release').filter({ hasText: 'The config moved' });
    await web3.getByTestId('release-head').click();
    await expect(web3.getByTestId('changelog-body')).toBeVisible();
  };
  // From the updates menu: every update with notes.
  await page.getByTestId('updates-menu').click();
  await expect(page.getByTestId('updates-whats-new')).toHaveText('What is new in 2 updates');
  await page.getByTestId('updates-whats-new').click();
  await checkOverview();
  await shoot(page, 'desktop-changelogs');
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, 'phone-changelogs');
  await page.setViewportSize({ width: 1280, height: 720 });
  await overview.getByRole('button', { name: 'Close' }).click();
  await expect(overview).toBeHidden();
  // From a selection: only the picked ones.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByTestId('container-row').filter({ hasText: `${PROJECT}-app-1` }).first().click();
  await expect(page.getByTestId('bulk-whats-new')).toHaveText('What is new in 1 update');
  await page.getByTestId('container-row').filter({ hasText: 'burrowtest-web' }).first().click();
  await expect(page.getByTestId('bulk-whats-new')).toHaveText('What is new in 2 updates');
  await page.getByTestId('bulk-whats-new').click();
  await checkOverview();
  await overview.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // From a stack with both: one button for all its updates (a second service as a stand-in).
  await page.route(`**/api/docker/*/stacks/${PROJECT}`, async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const o = (await res.json()) as { services: { service: string; container: string; image: string; state: string }[] };
    o.services.push({ service: 'web', container: 'burrowtest-web', image: webImage, state: 'running' });
    await r.fulfill({ response: res, json: o });
  });
  await page.goto(`/#/stacks/${h.id}/${PROJECT}`);
  await expect(page.getByTestId('stack-updates')).toContainText(webImage, { timeout: 30_000 });
  await expect(page.getByTestId('whats-new')).toHaveCount(2);
  await page.getByTestId('stack-whats-new').click();
  await checkOverview();
  await overview.getByRole('button', { name: 'Close' }).click();
  await page.unroute(`**/api/docker/*/stacks/${PROJECT}`);
  // A stack of many services and a long history (the live Burrow: 60 services
  // made the page 7400 px on a phone): the first few, those needing a look
  // always, a filter; the latest three updates. Stand-ins for both.
  await page.route(`**/api/docker/*/stacks/${PROJECT}`, async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const o = (await res.json()) as { services: { service: string; container: string; image: string; state: string }[] };
    for (let i = 1; i <= 14; i++) o.services.push({ service: `extra${i}`, container: `burrowtest-extra${i}`, image: `extra:${i}`, state: i === 13 ? 'exited' : 'running' });
    await r.fulfill({ response: res, json: o });
  });
  await page.route(`**/api/docker/*/stacks/${PROJECT}/history`, (r) =>
    r.fulfill({ json: Array.from({ length: 5 }, (_, i) => ({ id: 900 + i, hostId: h.id, project: PROJECT, auto: false, result: 'updated', images: [{ image: `ghcr.io/example/a-rather-long-image-name-${i}:latest`, from: `sha256:${'a'.repeat(64)}`, to: `sha256:${'b'.repeat(64)}` }, { image: 'nginx:alpine', from: `sha256:${'c'.repeat(64)}`, to: `sha256:${'d'.repeat(64)}` }], detail: `stand-in ${i}`, startedAt: new Date(Date.now() - i * 86_400_000).toISOString(), finishedAt: new Date().toISOString() })) }),
  );
  await page.reload();
  const services = page.getByTestId('stack-service');
  await expect(services.filter({ hasText: 'extra13' })).toBeVisible({ timeout: 30_000 });
  await expect(services).toHaveCount(9);
  await expect(services.filter({ hasText: 'extra14' })).toHaveCount(0);
  const updates = page.getByTestId('stack-history-item');
  await expect(updates).toHaveCount(3);
  // Each update a block of its own, a line above the next (report be5cf2); its images listed under its head.
  expect(await updates.nth(1).evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('solid');
  await expect(updates.first().locator('.imgs li')).toHaveCount(2);
  // Its head's words never over the image under it (report 71a779: "| handmatig" over it in Dutch); its buttons fill their rows.
  await updates.first().scrollIntoViewIfNeeded();
  await lookAt(page, 'desktop-stack-history');
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, 'phone-stack-many');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByTestId('stack-services-filter').fill('extra14');
  await expect(services).toHaveCount(1);
  await page.getByTestId('stack-services-filter').fill('');
  await page.getByTestId('stack-services-more').click();
  await expect(services).toHaveCount(15);
  await page.getByTestId('stack-history-more').click();
  await expect(page.getByTestId('stack-history-item')).toHaveCount(5);
  await page.unroute(`**/api/docker/*/stacks/${PROJECT}`);
  await page.unroute(`**/api/docker/*/stacks/${PROJECT}/history`);
  await page.goto('/#/containers');
  await page.unroute('**/api/docker/updates');
  await page.reload();
  await expect(page.getByTestId('updates-count')).toHaveText('1', { timeout: 30_000 });

  // The container's own page updates it right there (reported: it only led
  // to the stack). The pill first, with the update refused by the host: said so.
  const version = async () => (await sh(`docker inspect --format '{{index .Config.Labels "burrowtest.version"}}' ${PROJECT}-app-1`)).trim();
  await page.goto(`/#/containers/${h.id}/${PROJECT}-app-1`);
  await page.route('**/api/docker/*/stacks/*/ops', (r) => r.fulfill({ status: 409, json: { error: 'op_running', message: 'Another operation on this stack is still running.' } }));
  // The pill beside the state, on one line (reported: "Update beschikbaar"
  // broke over two lines, a second row of buttons on a phone).
  const pill = page.getByTestId('container-update');
  const stateLine = (await page.getByTestId('container-info').boundingBox())!;
  const pillBox = (await pill.boundingBox())!;
  expect(Math.abs(pillBox.y + pillBox.height / 2 - (stateLine.y + stateLine.height / 2))).toBeLessThan(4);
  expect(await pill.evaluate((e) => e.getClientRects().length === 1 && e.getBoundingClientRect().height < 34)).toBe(true);
  await pill.click();
  // Asked first, with what is new at hand (reported: the changelog could not be seen from here).
  const ask = page.getByRole('dialog', { name: 'Update now' });
  await expect(ask).toContainText(`Update ${PROJECT}-app-1 now?`);
  await ask.getByTestId('container-whats-new').click();
  // In its place (one dialog at a time), and back to the question after.
  await expect(ask).toBeHidden();
  const whatsNew = page.getByRole('dialog', { name: 'What is new: burrowtest-app' });
  await expect(whatsNew.getByTestId('changelog-breaking')).toContainText('PORT is now HTTP_PORT');
  await shoot(page, 'desktop-container-update-notes');
  await whatsNew.getByRole('button', { name: 'Close' }).click();
  await expect(ask).toBeVisible();
  await shoot(page, 'desktop-container-update-ask');
  await ask.getByTestId('container-update-ok').click();
  await expect(page.getByText('Another operation on this stack is still running.')).toBeVisible();
  // On a wide screen the same from the button beside the title.
  const actions = page.getByTestId('container-actions');
  await page.getByText('Another operation on this stack is still running.').waitFor({ state: 'hidden', timeout: 15_000 });
  await actions.getByRole('button', { name: 'Update now', exact: true }).click();
  await ask.getByTestId('container-update-ok').click();
  await expect(page.getByText('Another operation on this stack is still running.')).toBeVisible();
  await page.unroute('**/api/docker/*/stacks/*/ops');
  // One that fails: said, and the update can be tried again right here (AUDIT2 PAGE-06: its buttons stayed off until another page).
  await page.route('**/api/docker/*/stacks/*/ops', (r) => r.fulfill({ json: { id: 'stand-in-failed', hostId: h.id, project: PROJECT, op: 'update', startedAt: new Date().toISOString(), exitCode: null } }));
  await actions.getByRole('button', { name: 'Update now', exact: true }).click();
  await ask.getByTestId('container-update-ok').click();
  await expect(page.getByTestId('op-status')).toContainText('Update failed (exit code 1)');
  await expect(actions.getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
  await page.unroute('**/api/docker/*/stacks/*/ops');
  // Then the menu's "Update now": asked, the release notes' warning, done here.
  await page.getByTestId('log-options').click();
  await page.getByTestId('container-update-menu').click();
  await ask.getByTestId('container-update-ok').click();
  await expect(page.getByTestId('op-status')).toHaveText('Update done', { timeout: 120_000 });
  // Done: one line under the state, its output a tap away in a wide dialog of its own, so the
  // logs keep their room (report 09ddbf: a narrow column beside the state line, which floated
  // half way down; inline at full width it left the logs a quarter of the screen).
  // Not at 343 px: a finished update's line over a log file's chips leaves the log under two thirds there (said in SOME_PASSES).
  await lookAt(page, 'desktop-container-update-done', { passes: SOME_PASSES['container-update-done']!.passes });
  await page.getByTestId('op-log-toggle').click();
  const output = page.locator('dialog[open][data-tour=op-log]');
  await expect(output.locator('pre')).not.toBeEmpty();
  await shoot(page, 'desktop-container-update-output');
  await page.keyboard.press('Escape');
  await expect(output).toHaveCount(0);
  // Done: one line (its output in the window above), not a block that takes the logs' room.
  expect((await page.getByTestId('op-output').boundingBox())!.height).toBeLessThan(48);
  const said = (await asked()).join('\n');
  // Under the image's own name, its versions with the warning (report 06354e: one run of text).
  expect(said).toContain('burrowtest-app:latest | v2: PORT is now HTTP_PORT');
  expect(await version()).toBe('v2');
  // The version it runs now, on its page (report eaa986).
  await expect(page.getByTestId('container-version')).toHaveText('| v2', { timeout: 30_000 });
  // An image that does not say where its notes are: said so in the question.
  const image = (await sh(`docker inspect --format '{{.Config.Image}}' ${PROJECT}-app-1`)).trim();
  await page.route('**/api/docker/updates', async (r) => {
    const o = (await (await r.fetch()).json()) as { checks: Record<string, unknown>[] };
    const check = { hostId: h.id, image, status: 'update', localDigest: null, remoteDigest: null, error: null, source: null, version: null, newerTag: null, checkedAt: new Date().toISOString() };
    await r.fulfill({ json: { ...o, checks: [check, ...o.checks.filter((c) => !(c.hostId === h.id && c.image === image))] } });
  });
  await page.reload();
  await page.getByTestId('container-update').click();
  await expect(ask.getByTestId('container-no-notes')).toHaveText('This image does not say where its release notes are.');
  await expect(ask.getByTestId('container-whats-new')).toHaveCount(0);
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(ask).toBeHidden();
  await page.unroute('**/api/docker/updates');
  // Then another image as the registry's latest (v1's), for the window.
  await publish('v1');
  await page.goto(`/#/stacks/${h.id}/${PROJECT}`);
  await page.getByTestId('check-stack').click();
  await expect(page.getByTestId('stack-updates')).toContainText(IMAGE, { timeout: 30_000 });
  // Which to update is chosen (reported: all or nothing): none ticked, nothing to do.
  await page.getByTestId('update-pick').uncheck();
  await expect(page.getByTestId('update-now')).toBeDisabled();
  await expect(page.getByTestId('update-now')).toHaveText('Update now (0)');
  await page.getByTestId('update-pick').check();
  await expect(page.getByTestId('update-now')).toHaveText('Update now (1)');
  // Pressed: asked about its notes first, then the stack's update of the
  // ticked service (the host's answer a stand-in: refused, and said so).
  let updateAsked: unknown = null;
  await page.route('**/api/docker/*/stacks/*/ops', (r) => ((updateAsked = r.request().postDataJSON()), r.fulfill({ status: 409, json: { error: 'op_running', message: 'Another operation on this stack is still running.' } })));
  await page.getByTestId('update-now').click();
  await expect(page.getByText('Another operation on this stack is still running.')).toBeVisible();
  expect(updateAsked).toEqual({ op: 'update', services: ['app'] });
  await page.unroute('**/api/docker/*/stacks/*/ops');

  // Opt in, then the maintenance window's work, now.
  await page.goto('/#/containers');
  await page.getByTestId('stack-link').filter({ hasText: PROJECT }).first().click();
  // Saved on the host's stack (read over SSH first): wait for the answer.
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/settings'));
  await page.getByTestId('auto-update').check();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId('auto-update')).toBeChecked();
  // A breaking change would hold it (answered here by stand-ins): said on
  // the stack, and released after reading.
  let released = false;
  await page.route('**/stacks/*/hold', (r) => r.fulfill({ json: { held: [`${IMAGE} v1`], released } }));
  await page.route('**/stacks/*/hold/release', (r) => ((released = true), r.fulfill({ json: { held: [`${IMAGE} v1`], released: true } })));
  await page.reload();
  // The stack is read over SSH again (slow beside the tour in the gate).
  await expect(page.getByTestId('hold')).toContainText('breaking change', { timeout: 30_000 });
  await page.getByTestId('hold-release').click();
  await expect(page.getByTestId('hold-released')).toBeVisible();
  await page.unroute('**/stacks/*/hold');
  await page.unroute('**/stacks/*/hold/release');
  await page.goto('/#/settings/updates');
  await page.getByTestId('run-window').click();
  await expect(page.getByText('Stacks updated or rolled back: 1.')).toBeVisible({ timeout: 200_000 });
  expect(await version()).toBe('v1');
  // The daily check and automatic updates can be turned off altogether.
  await page.getByTestId('updates-enabled').uncheck();
  await expect(page.getByTestId('run-window')).toBeHidden();
  // Saved at once, without a button.
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('updates-enabled')).not.toBeChecked();
  await expect(page.getByText('Off: no daily check')).toBeVisible();
  await page.getByTestId('updates-enabled').check();
  await expect.poll(async () => (await api<{ settings: { enabled: boolean } }>(page, 'GET', '/api/docker/updates')).settings.enabled).toBe(true);
  await page.goto(`/#/stacks/${h.id}/${PROJECT}`);
  await expect(page.getByTestId('stack-history')).toContainText('Updated');
  await expect(page.getByTestId('stack-history')).toContainText('automatic');
  await expect(page.getByTestId('updates-badge')).toHaveCount(0);
  await shoot(page, 'desktop-stack-updated');

  // A container: a shell inside it opens as a terminal session.
  await page.getByTestId('stack-service').first().click();
  // Its actions are in the Options menu, where the log download is too.
  await page.getByTestId('log-options').click();
  await expect(page.getByTestId('container-menu')).toContainText('Download');
  await page.getByTestId('container-shell').click();
  await expect(page).toHaveURL(/#\/term\//);
  const screen = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(screen).toContainText('/ #');
  // The shell of the container itself, not a host shell that typed a docker command.
  await expect(screen).not.toContainText('docker exec');
  await page.getByTestId('terminal').click();
  await page.keyboard.type('echo "in-$((6*7))"; cat /etc/alpine-release\n');
  await expect(screen).toContainText('in-42');
  await expect(screen).toContainText('3.22');
  await shoot(page, 'desktop-container-shell');

  // The container's own buttons: stop, start, delete; then the stack's
  // restart and down, each checked on Docker itself.
  const APP = `${PROJECT}-app-1`;
  // Docker on a busy machine can take half a minute to clean up a stopped
  // container, and answers nothing about it meanwhile: room for that.
  const state = async () => (await sh(`docker inspect -f '{{.State.Status}}' ${APP} 2>&1 || echo gone`)).trim();
  await page.goto(`/#/containers/${h.id}/${APP}`);
  await page.getByTestId('log-options').click();
  await page.getByTestId('container-menu').getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(state, { timeout: 90_000 }).toBe('exited');
  await page.getByTestId('log-options').click();
  await page.getByTestId('container-start').click();
  await expect.poll(state, { timeout: 90_000 }).toBe('running');
  // Restarted from its own menu, then the whole stack from the stack's page.
  const startedAt = async () => (await sh(`docker inspect -f '{{.State.StartedAt}}' ${APP}`)).trim();
  const first = await startedAt();
  await page.getByTestId('log-options').click();
  await page.getByTestId('container-menu').getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(startedAt, { timeout: 90_000 }).not.toBe(first);
  // The same three beside the title on a wide screen (a phone has the menu only).
  const top = page.getByTestId('container-actions');
  const second = await startedAt();
  await top.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(startedAt, { timeout: 90_000 }).not.toBe(second);
  await expect(top.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled({ timeout: 30_000 });
  await top.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(state, { timeout: 90_000 }).toBe('exited');
  // Stopped: Start in their place, once the page has seen it.
  await top.getByRole('button', { name: 'Start', exact: true }).click({ timeout: 30_000 });
  await expect.poll(state, { timeout: 90_000 }).toBe('running');
  await expect(top.getByRole('button', { name: 'Shell', exact: true })).toBeVisible({ timeout: 30_000 });
  await top.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(page).toHaveURL(/#\/term\//);
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('/ #');
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/#/containers/${h.id}/${APP}`);
  await expect(page.getByTestId('log-options')).toBeVisible();
  await expect(top).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  const started = await startedAt();
  await page.goto(`/#/stacks/${h.id}/${PROJECT}`);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(async () => (await sh(`docker inspect -f '{{.State.StartedAt}}' ${APP}`)).trim(), { timeout: 60_000 }).not.toBe(started);
  // Pull and Up from the stack's page: each an operation, its output to the end.
  for (const name of ['Pull', 'Up']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled({ timeout: 120_000 });
    await page.getByRole('button', { name, exact: true }).click();
    // Ended (Close is there while it runs too): else the Down below finds it
    // still running. This one's own words: right after the click the status
    // still said the one before ("Pull done").
    await expect(page.getByTestId('op-status')).toHaveText(`${name === 'Up' ? 'Deploy' : name} done`, { timeout: 120_000 });
    await page.getByRole('region', { name: 'Output' }).getByRole('button', { name: 'Close' }).click();
  }
  expect(await state()).toBe('running');
  await page.goto(`/#/containers/${h.id}/${APP}`);
  await page.getByTestId('log-options').click();
  await page.getByTestId('container-menu').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(state, { timeout: 90_000 }).toContain('gone');
  // Up again for Down to have something to take down (outside Burrow: with
  // its only container gone, the stack is not one Burrow sees).
  await sh(`cd ${DIR} && docker compose -p ${PROJECT} up -d 2>&1`);
  // Up outside Burrow: the open stack page shows it by itself.
  await page.goto(`/#/stacks/${h.id}/${PROJECT}`);
  await expect(page.getByTestId('stack-service').first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Down', exact: true }).click();
  await expect.poll(async () => (await sh(`docker ps -aq --filter label=com.docker.compose.project=${PROJECT}`)).trim(), { timeout: 60_000 }).toBe('');
});

test('an update said while watched: the new containers watched until when; a rollback said as one, not as "failed" (W-FUNC-10)', async ({ page }) => {
  await signIn(page);
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const real = hosts.find((h) => h.name === 'docker-real')!;
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/api\/docker\/ops\/watch-op\/ws/, (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ t: 'output', d: '$ update burrowtest\n Container burrowtest-web-1 Started\nWatching the containers for 60 s.\n' }));
  });
  await page.route('**/api/docker/*/stacks/*/ops', (r) =>
    r.request().method() !== 'POST' ? r.fallback() : r.fulfill({ json: { id: 'watch-op', hostId: real.id, project: 'burrowtest', op: 'update', startedAt: new Date().toISOString(), exitCode: null } }),
  );
  await page.goto(`/#/stacks/${real.id}/burrowtest`);
  await page.reload();
  await expect(page.getByTestId('stack-service').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Pull', exact: true }).click();
  await expect(page.getByTestId('op-watching')).toContainText(/Watching the new containers for 60 s \(until \d\d:\d\d:\d\d\)/);
  await expect.poll(() => socket !== null).toBe(true);
  socket!.send(JSON.stringify({ t: 'output', d: 'Not well: web exited with code 1. Putting the previous images back.\nThe previous images run again, and run well.\n' }));
  socket!.send(JSON.stringify({ t: 'exit', code: 1 }));
  await expect(page.getByTestId('op-rolled-back')).toHaveText('Rolled back (web exited with code 1): the previous images run again.');
  await expect(page.getByTestId('op-status')).not.toContainText('failed');
  await page.unroute('**/api/docker/*/stacks/*/ops');
});

test('a stack brought down from Burrow is listed as down, and brought up again from there (review 2026-10-24)', async ({ page }) => {
  test.setTimeout(240_000);
  await sayYes(page);
  await signIn(page);
  const project = 'burrowtest-down';
  const dir = '/home/tester/down-stack';
  const hosts = await api<{ id: number; address: string }[]>(page, 'GET', '/api/hosts');
  const h =
    hosts.find((x) => x.address === DOCKER_HOST) ??
    (await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'docker-real', address: DOCKER_HOST, username: 'tester', authMethod: 'password', password: 'burrow-test-password' }));
  const r = await api<{ status: string; fingerprint?: string }>(page, 'POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') {
    await api(page, 'POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
    expect((await api<{ status: string }>(page, 'POST', `/api/hosts/${h.id}/test`)).status).toBe('ok');
  }
  const sh = async (command: string) => {
    const [res] = await api<{ exitCode: number; stdout: string; stderr: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [h.id], command });
    expect(res!.exitCode, `${command}: ${res!.stderr}`).toBe(0);
    return res!.stdout;
  };
  await sh(
    [
      `rm -rf ${dir} && mkdir -p ${dir}`,
      `printf 'services:\\n  app:\\n    image: burrowtest-app:v1\\n    labels:\\n      burrow.ignore: "true"\\n' > ${dir}/compose.yaml`,
      `cd ${dir} && docker compose -p ${project} up -d 2>&1`,
    ].join(' && '),
  );
  try {
    await page.goto(`/#/stacks/${h.id}/${project}`);
    await expect(page.getByTestId('stack-service')).toContainText('app');
    await page.getByRole('button', { name: 'Down', exact: true }).click();
    // Gone from Docker, still here: said so, and Up is the way back.
    await expect(page.getByTestId('stack-is-down')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('stack-service')).toHaveCount(0);
    await shoot(page, 'stack-down');
    await page.goto('/#/containers');
    const row = page.getByTestId('stack-down').filter({ hasText: project });
    await expect(row).toContainText('down for');
    await expect(page.getByTestId('stacks-down')).toBeVisible();
    await shoot(page, 'containers-stack-down');
    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/stacks/${h.id}/${project}$`));
    await page.getByTestId('stack-up').click();
    await expect(page.getByTestId('stack-service')).toContainText('running', { timeout: 90_000 });
    await expect(page.getByTestId('stack-is-down')).toHaveCount(0);
    expect((await sh(`docker inspect --format '{{.State.Status}}' ${project}-app-1`)).trim()).toBe('running');
  } finally {
    await sh(`cd ${dir} && docker compose -p ${project} down 2>&1 || true`);
  }
});
