import { expect, test } from './fixtures.js';
import { signIn } from './passkey.js';

// Many of everything: a homelab that grew. 600 hosts, and three hosts with
// 150 containers each. The pages must open quickly, find what is typed,
// and not throw. The API and the containers' live socket answer with
// stand-ins (the rest of the tests use the real thing).

// Without the code coverage: taking it from a page this full outlasts a test.
test.use({ cover: false });

const HOSTS = 600;
const host = (i: number) => ({
  id: 1000 + i,
  name: `host-${String(i).padStart(3, '0')}`,
  address: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`,
  groupId: null,
  port: null,
  username: 'admin',
  authMethod: 'password',
  keyId: null,
  hasPassword: true,
  startupCommand: null,
  tmux: null,
  term: null,
  encoding: null,
  tags: i % 7 === 0 ? ['backup'] : [],
  color: null,
  icon: null,
  favorite: false,
  lastUsedAt: null,
  facts: null,
});

test('600 hosts: the list shows quickly, search finds one, nothing throws', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  const hosts = Array.from({ length: HOSTS }, (_, i) => host(i));
  await page.route('**/api/hosts', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: hosts }) : r.continue()));
  await page.route('**/api/hosts/status', (r) => r.fulfill({ json: hosts.map((h, i) => ({ hostId: h.id, reachable: i % 5 !== 0, latencyMs: 3, checkedAt: new Date().toISOString() })) }));
  const started = Date.now();
  await page.goto('/#/hosts');
  await page.reload();
  await expect(page.getByTestId('host-row').filter({ hasText: 'host-599' })).toHaveCount(1, { timeout: 15_000 });
  const shown = Date.now() - started;
  expect(shown, `600 hosts took ${shown} ms`).toBeLessThan(8000);
  // Search: one by name, a group of them by tag.
  const search = page.getByPlaceholder('Search name, address or tag');
  await search.fill('host-421');
  await expect(page.getByTestId('host-row')).toHaveCount(1);
  await search.fill('backup');
  await expect(page.getByTestId('host-row')).toHaveCount(Math.ceil(HOSTS / 7));
  await search.fill('');
  expect(errors).toEqual([]);
});

test('450 containers on three hosts: the list shows, filters, nothing throws', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  const now = new Date().toISOString();
  const box = (h: number, i: number) => ({
    id: `c${h}x${i}`,
    name: `app-${h}-${String(i).padStart(3, '0')}`,
    image: `ghcr.io/example/app${i % 20}:latest`,
    imageId: `sha256:${String(i).padStart(64, '0')}`,
    state: i % 11 === 0 ? 'exited' : 'running',
    health: i % 3 === 0 ? 'healthy' : null,
    restarts: 0,
    startedAt: now,
    finishedAt: null,
    exitCode: i % 11 === 0 ? 1 : 0,
    oomKilled: false,
    createdAt: now,
    project: `stack${i % 15}`,
    service: `svc${i}`,
    configFiles: null,
    workingDir: null,
  });
  const ids = [9001, 9002, 9003];
  const facts = { os: 'Debian', kernel: '6.12', shell: 'bash', hasTmux: true, hasDocker: true, checkedAt: now };
  const hosts = ids.map((id, i) => ({ ...host(i), id, name: `docker-${i}`, facts }));
  await page.route('**/api/hosts', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: hosts }) : r.continue()));
  await page.route('**/api/hosts/status', (r) => r.fulfill({ json: [] }));
  let asks = 0;
  await page.routeWebSocket('**/api/docker/ws', (ws) => {
    // Once a socket: the page asks again as hosts come in, and an answer to
    // every ask fed itself until the test ran out of time (flaky in the gate).
    let sent = false;
    ws.onMessage(() => {
      asks++;
      if (sent) return;
      sent = true;
      for (const id of ids) {
        const containers = Array.from({ length: 150 }, (_, i) => box(id, i));
        ws.send(JSON.stringify({ t: 'host', host: { hostId: id, hostName: `docker-${id}`, containers, stats: {}, history: {}, error: null, at: now } }));
      }
    });
  });
  const started = Date.now();
  await page.goto('/#/containers');
  await page.reload();
  await expect(page.getByTestId('container-row').filter({ hasText: 'app-9003-149' })).toHaveCount(1, { timeout: 15_000 });
  const shown = Date.now() - started;
  expect(shown, `450 containers took ${shown} ms`).toBeLessThan(8000);
  expect(await page.getByTestId('container-row').count()).toBeGreaterThanOrEqual(450);
  // Asked once a socket (and once again after the reload): a snapshot coming in is no reason to
  // ask again (each one sent another "watch" to the server, every poll, from every open page).
  await page.waitForTimeout(500);
  expect(asks).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});
