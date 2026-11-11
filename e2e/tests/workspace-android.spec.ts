import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { lookAt } from './checks.js';
import { sayYes } from './confirm.js';
import { signIn } from './passkey.js';

// Settings as the Android app shows them: a stand-in for the app's bridge
// (BurrowAndroid) answers like the app does. The WireGuard card: import a
// configuration, see the state, choose what goes through the tunnel; the
// configuration goes to the phone only, never to Burrow.

const CONF = `[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.99.0.2/32

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = vpn.example.com:51820
AllowedIPs = 10.99.0.0/24, 192.168.1.0/24
`;

test('WireGuard in the app: import, state, what goes through', async ({ page }) => {
  // Nothing of the configuration may go to Burrow.
  // The private key's value in any form it could travel in, in the body,
  // the address or a header: the word "PrivateKey" alone let a key sent
  // under another name pass (AUDIT2 TEST-20).
  const key = /PrivateKey = (\S+)/.exec(CONF)![1]!;
  const raw = Buffer.from(key, 'base64');
  const forms = [key, encodeURIComponent(key), key.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), raw.toString('hex'), JSON.stringify(key).slice(1, -1)];
  const leaks: string[] = [];
  page.on('request', (r) => {
    const all = `${r.url()}\n${r.postData() ?? ''}\n${Object.values(r.headers()).join('\n')}`;
    if (forms.some((f) => all.includes(f)) || all.includes('PrivateKey')) leaks.push(r.url());
  });

  // Signed in as in a browser first (the app's own sign-in is its own test).
  await sayYes(page);
  await signIn(page);
  await page.addInitScript(() => {
    type State = { conf: string | null; viaBurrow: boolean; hosts: string[]; calls: string[]; shake: boolean; screenshots: boolean };
    const w = window as unknown as { BurrowAndroid: unknown; __wg: State };
    const state: State = { conf: null, viaBurrow: true, hosts: [], calls: [], shake: true, screenshots: false };
    w.__wg = state;
    const status = () => ({
      configured: state.conf !== null,
      active: state.conf !== null,
      viaBurrow: state.viaBurrow,
      hosts: state.hosts,
      error: null,
      proxyOverride: true,
      lastHandshake: state.conf ? Math.floor(Date.now() / 1000) - 20 : undefined,
      address: state.conf ? '10.99.0.2/32' : undefined,
      endpoint: state.conf ? 'vpn.example.com:51820' : undefined,
      allowedIps: state.conf ? '10.99.0.0/24, 192.168.1.0/24' : undefined,
    });
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        state.calls.push(method);
        let result: unknown = null;
        if (method === 'info') result = { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: state.screenshots, screenshotsFixed: false, shake: state.shake };
        else if (method === 'setShake') state.shake = Boolean(params.on);
        else if (method === 'setScreenshots') state.screenshots = Boolean(params.allow);
        else if (method === 'wgStatus') result = status();
        else if (method === 'wgSave') {
          state.conf = String(params.conf);
          result = { error: null };
        } else if (method === 'wgTargets') {
          state.viaBurrow = Boolean(params.viaBurrow);
          state.hosts = params.hosts as string[];
          result = status();
        } else if (method === 'wgRemove') state.conf = null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  // A long list of hosts to pick from: twelve more than there are.
  await page.route('**/api/hosts', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const real = (await res.json()) as { id: number; address: string; name: string }[];
    const more = Array.from({ length: 12 }, (_, i) => ({ ...real[0]!, id: 9000 + i, name: `extra-${i + 1}`, address: `extra-${i + 1}.lan` }));
    await r.fulfill({ response: res, json: [...real, ...more] });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings/android');
  await page.reload();
  const card = page.getByTestId('wireguard');
  await expect(card).toContainText('Not set up');
  await card.scrollIntoViewIfNeeded();
  await lookAt(page, 'phone-wireguard-none', { tips: true });

  await card.getByRole('button', { name: 'Paste' }).click();
  await card.getByTestId('wg-conf').fill(CONF);
  // Every toast written down as it shows: one lives three seconds, which a busy machine's check
  // could miss between two looks (the gate's flake, 2026-10-24).
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = seen;
    new MutationObserver(() => document.querySelectorAll('[data-testid=toasts] .toast').forEach((t) => seen.push(t.textContent ?? ''))).observe(document.body, { childList: true, subtree: true });
  });
  await card.getByTestId('wg-save').click();
  await expect(card.getByTestId('wg-state')).toContainText('Away: through the tunnel');
  expect((await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).join('|')).toContain('WireGuard saved on this phone.');
  await expect(card).toContainText('vpn.example.com:51820');
  await expect(card).not.toContainText('yAnz5TF');
  await lookAt(page, 'phone-wireguard-set');

  // A direct-route host through the tunnel too, found in the long list:
  // the first few and "Show all", a search, All and None.
  const pick = card.getByTestId('picklist');
  await expect(pick.getByRole('checkbox')).toHaveCount(5);
  await expect(card.getByTestId('pick-more')).toBeVisible();
  await card.getByTestId('pick-search').fill('test-sshd');
  await pick.getByRole('checkbox', { name: /test-sshd/ }).first().check();
  await card.getByTestId('pick-search').fill('');
  // Ticked ones come first.
  await expect(pick.getByRole('checkbox').first()).toBeChecked();
  await card.getByTestId('pick-more').click();
  await expect(card.getByTestId('pick-more')).toHaveCount(0);
  await card.getByTestId('pick-search').fill('extra-');
  await card.getByTestId('pick-all').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wg: { hosts: string[] } }).__wg.hosts.length)).toBe(13);
  await card.getByTestId('pick-none').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wg: { hosts: string[] } }).__wg.hosts.length)).toBe(1);
  await card.getByTestId('pick-search').fill('');
  expect(await page.evaluate(() => (window as unknown as { __wg: { hosts: string[] } }).__wg.hosts)).toContainEqual(expect.stringContaining('burrow-e2e-sshd'));
  await card.getByTestId('wg-burrow').uncheck();
  expect(await page.evaluate(() => (window as unknown as { __wg: { viaBurrow: boolean } }).__wg.viaBurrow)).toBe(false);

  // Screenshots of the app: allowed here (off by default).
  await page.getByTestId('allow-screenshots').check();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wg: { calls: string[] } }).__wg.calls)).toContain('setScreenshots');
  // And it stays on once the app's info is read again (the phone's answer, not the click).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wg: { screenshots: boolean } }).__wg.screenshots)).toBe(true);
  await expect(page.getByTestId('allow-screenshots')).toBeChecked();
  // A shake reports a problem: on by default, off here for this phone.
  const shake = page.getByTestId('shake-report');
  await expect(shake).toBeChecked();
  await shake.uncheck();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wg: { shake: boolean } }).__wg.shake)).toBe(false);
  await shake.check();
  // The app saw a shake: the report form, with the screen as it was.
  await page.evaluate(() => (window as unknown as { BurrowAndroid: { onmessage: (e: { data: string }) => void } }).BurrowAndroid.onmessage({ data: JSON.stringify({ event: 'shake', data: null }) }));
  const report = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(report).toBeVisible();
  await expect(report.getByRole('img', { name: 'The screen when you started the report' })).toBeVisible();
  await report.getByRole('button', { name: 'Cancel' }).click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await lookAt(page, 'desktop-wireguard-set');
  expect(leaks, 'the configuration went to Burrow').toEqual([]);
  // Off this phone again: the configuration goes, the tunnel with it.
  await card.getByRole('button', { name: 'Remove WireGuard from this phone' }).click();
  await expect(card).toContainText('Not set up');
});

test("the app's own downloads: progress in the busy pill, Retry and Stop, an update's progress in Settings", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    type D = { id: number; name: string; kind: string; state: string; done: number; total: number; error: string | null; secondsLeft: number | null };
    const w = window as unknown as { BurrowAndroid: unknown; __dl: { calls: string[]; list: D[]; push: () => void } };
    const list: D[] = [
      { id: 1, name: 'movie.mkv', kind: 'file', state: 'running', done: 50 * 1048576, total: 100 * 1048576, error: null, secondsLeft: 90 },
      { id: 2, name: 'notes.pdf', kind: 'file', state: 'failed', done: 0, total: -1, error: 'HTTP 502', secondsLeft: null },
    ];
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        state.calls.push(`${method}${params.id !== undefined ? `:${String(params.id)}` : ''}`);
        let result: unknown = null;
        if (method === 'info') result = { version: '1.9.0', versionCode: 10900, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: true };
        else if (method === 'downloads') result = state.list;
        else if (method === 'installUpdate') {
          // Under way: the progress comes as events; the answer later.
          state.list = [...state.list, { id: 3, name: 'burrow.apk', kind: 'update', state: 'running', done: 7 * 1048576, total: 28 * 1048576, error: null, secondsLeft: 12 }];
          state.push();
          return;
        }
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    const state = { calls: [] as string[], list, push: () => port.onmessage?.({ data: JSON.stringify({ event: 'downloads', data: state.list }) }) };
    w.__dl = state;
    w.BurrowAndroid = port;
  });
  await page.route('**/api/android', (r) => r.fulfill({ json: { apk: { versionName: '1.10.0', versionCode: 11000, sha256: 'a'.repeat(64), size: 28 * 1048576 } } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/containers');
  await page.reload();

  // One running (the failed one waits for Retry): the pill says so.
  const pill = page.getByTestId('transfers-pill');
  await expect(pill).toContainText('1 running');
  await pill.click();
  const items = page.getByTestId('native-download');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('movie.mkv');
  await expect(items.nth(0)).toContainText('50 MB / 100 MB, 2 min left');
  await expect(items.nth(0).locator('progress')).toHaveAttribute('value', '50');
  await expect(items.nth(1)).toContainText('HTTP 502');
  await lookAt(page, 'phone-native-downloads');
  await items.nth(1).getByTestId('download-retry').click();
  await items.nth(0).getByTestId('download-stop').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __dl: { calls: string[] } }).__dl.calls)).toEqual(expect.arrayContaining(['retryDownload:2', 'stopDownload:1']));

  // The app's answer to Stop: gone from the list.
  await page.evaluate(() => {
    const s = (window as unknown as { __dl: { list: { id: number }[]; push: () => void } }).__dl;
    s.list = s.list.filter((d) => d.id !== 1);
    s.push();
  });
  await expect(items).toHaveCount(1);
  await page.getByTestId('transfers').getByRole('button', { name: 'Close' }).click();

  // An app update: its progress under the button.
  await page.goto('/#/settings/android');
  await page.getByTestId('app-version').getByRole('button', { name: /Update the app/ }).click();
  const progress = page.getByTestId('app-update-progress');
  await expect(progress).toHaveAttribute('value', '25');
  await expect(page.getByTestId('app-version')).toContainText('7.0 MB / 28 MB');
  await lookAt(page, 'phone-app-update-progress');
});

test('in the app: the Apps page shows which apps are open as tabs, and opens them', async ({ page }) => {
  // Reported (050019): which apps were open showed only after opening one.
  await signIn(page);
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __opened: unknown[] };
    w.__opened = [];
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        let result: unknown = null;
        if (method === 'info') result = { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false };
        else if (method === 'openApps') result = [9302, 9304, 9305, 9306];
        else if (method === 'openApp') {
          w.__opened.push(params.id);
          // The app opened a tab: an effect of the click (fixtures.ts counts it as pressed).
          dispatchEvent(new Event('burrow-test-effect'));
        }
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  const app = (id: number, name: string) => ({ id, name, url: `https://${id}.example.lan`, group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null });
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: [app(9301, 'Radarr'), app(9302, 'Jellyfin'), app(9303, 'Sonarr'), app(9304, 'Audiomuse Ai Flask'), app(9305, 'Homepage'), app(9306, 'Lidarr')] }) : r.fallback()));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/apps');
  await page.reload();
  const row = page.getByTestId('apps-open-now');
  await expect(row.getByTestId('app-open')).toHaveText(['Jellyfin', 'Audiomuse Ai Flask', 'Homepage', 'Lidarr']);
  // More than fit: one row, sideways, not rows of their own above the tiles (report f1b358).
  const tops = await row.getByTestId('app-open').evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
  expect(tops).toBe(1);
  expect(await row.locator('.opened').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Marked on its tile too (and said so to a screen reader).
  await expect(page.getByTestId('app-tile').filter({ hasText: 'Jellyfin' })).toHaveClass(/open/);
  await expect(page.getByTestId('app-tile').filter({ hasText: 'Radarr' })).not.toHaveClass(/open/);
  await lookAt(page, 'phone-apps-open-now');
  await row.getByTestId('app-open').first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)).toEqual([9302]);
  await page.unroute('**/api/apps');
});

test("shared from another app: another host chosen while the first one's folder still loads, the files go to the new host's folder", async ({ page }) => {
  // Audit WP-01: the first host's late answer paired the new host with its folder.
  await signIn(page);
  await page.addInitScript(() => {
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        let result: unknown = null;
        if (method === 'info') result = { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false };
        else if (method === 'sharedFiles') result = [{ token: 't1', name: 'photo.jpg', size: 3, mime: 'image/jpeg' }];
        else if (method === 'read') result = { data: btoa('abc') };
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    (window as unknown as { BurrowAndroid: unknown }).BurrowAndroid = port;
    localStorage.removeItem('burrow.shareTarget');
  });
  await page.route('**/api/hosts', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const real = (await res.json()) as { id: number; name: string }[];
    await r.fulfill({ json: [{ ...real[0]!, id: 9401, name: 'share-a' }, { ...real[0]!, id: 9402, name: 'share-b' }] });
  });
  const folder = (path: string) => ({ path, parent: '/', entries: [] });
  // share-a's folder held until share-b's is shown, then let go (AUDIT2 TEST-10: a fixed wait proved nothing came).
  let releaseA!: () => void;
  const heldA = new Promise<void>((r) => (releaseA = r));
  await page.route('**/api/files/9401/list**', async (r) => {
    await heldA;
    await r.fulfill({ json: folder('/host-a') }).catch(() => {});
  });
  await page.route('**/api/files/9402/list**', (r) => r.fulfill({ json: folder('/host-b') }));
  const sent: { url: string; body: string }[] = [];
  await page.route('**/api/files/*/uploads', (r) => {
    sent.push({ url: r.request().url(), body: r.request().postData() ?? '' });
    return r.fulfill({ status: 503, json: { error: 'test', message: 'not in this test' } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/share');
  await page.reload();
  // share-a is chosen first and still loading: share-b now.
  await page.getByRole('combobox', { name: 'Host' }).selectOption({ label: 'share-b' });
  const go = page.getByRole('button', { name: /Upload 1/ });
  await expect(go).toContainText('/host-b');
  // share-a's answer comes after all: it changes nothing.
  // Answered, or given up by the page (aborted): either way over.
  const aAnswered = Promise.race([page.waitForResponse((r) => r.url().includes('/api/files/9401/list')), page.waitForEvent('requestfailed', (r) => r.url().includes('/api/files/9401/list'))]);
  releaseA();
  await aAnswered;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  await expect(go).toContainText('/host-b');
  await expect(page.getByText('/host-a')).toHaveCount(0);
  await go.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]!.url).toContain('/api/files/9402/uploads');
  expect(JSON.parse(sent[0]!.body)).toMatchObject({ dir: '/host-b' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('shared from another app, two files and one refused: the one that arrived is let go, the refused one stays held (AUDIT2 PAGE-27)', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __released: string[] };
    w.__released = [];
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params?: { token?: string } };
        let result: unknown = null;
        if (method === 'info') result = { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false };
        else if (method === 'sharedFiles') result = [{ token: 't1', name: 'ok.txt', size: 3, mime: 'text/plain' }, { token: 't2', name: 'refused.txt', size: 3, mime: 'text/plain' }];
        else if (method === 'read') result = { data: btoa('abc') };
        else if (method === 'release') w.__released.push(params?.token ?? '?');
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowAndroid = port;
    localStorage.removeItem('burrow.shareTarget');
  });
  await page.route('**/api/hosts', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const real = (await (await r.fetch()).json()) as { id: number; name: string }[];
    await r.fulfill({ json: [{ ...real[0]!, id: 9403, name: 'share-c' }] });
  });
  await page.route('**/api/files/9403/list**', (r) => r.fulfill({ json: { path: '/host-c', parent: '/', entries: [] } }));
  await page.route('**/api/files/9403/uploads', (r) => {
    const { name } = JSON.parse(r.request().postData() ?? '{}') as { name: string };
    return name === 'ok.txt' ? r.fulfill({ json: { id: 'up-ok', offset: 0, size: 3 } }) : r.fulfill({ status: 409, json: { error: 'exists', message: 'refused here' } });
  });
  await page.route('**/api/files/uploads/up-ok?offset=*', (r) => r.fulfill({ json: { id: 'up-ok', offset: 3, size: 3 } }));
  await page.route('**/api/files/uploads/up-ok/finish', (r) => r.fulfill({ json: { ok: true } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/share');
  await page.reload();
  await page.getByRole('button', { name: /Upload 2/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __released: string[] }).__released)).toEqual(['t1']);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __released: string[] }).__released)).toEqual(['t1']);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('WireGuard in the app: two hosts ticked before the phone answered both go through the tunnel', async ({ page }) => {
  // Audit WC-19: the second pick was sent without the first, which was lost.
  await signIn(page);
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __wg: { hosts: string[] } };
    const state = { hosts: [] as string[], viaBurrow: true };
    w.__wg = state;
    const status = () => ({ configured: true, active: true, viaBurrow: state.viaBurrow, hosts: [...state.hosts], error: null, proxyOverride: true, lastHandshake: Math.floor(Date.now() / 1000) - 20, address: '10.99.0.2/32', endpoint: 'vpn.example.com:51820', allowedIps: '10.99.0.0/24' });
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        let result: unknown = null;
        let wait = 5;
        if (method === 'info') result = { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false };
        else if (method === 'wgStatus') result = status();
        else if (method === 'wgTargets') {
          // A slow phone: the answer after a while.
          state.viaBurrow = Boolean(params.viaBurrow);
          state.hosts = params.hosts as string[];
          result = status();
          wait = 600;
        }
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), wait);
      },
    };
    w.BurrowAndroid = port;
  });
  await page.route('**/api/hosts', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const real = (await res.json()) as { id: number; address: string; name: string }[];
    await r.fulfill({ json: [{ ...real[0]!, id: 9501, name: 'wg-one', address: 'wg-one.lan' }, { ...real[0]!, id: 9502, name: 'wg-two', address: 'wg-two.lan' }] });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings/android');
  await page.reload();
  const pick = page.getByTestId('wireguard').getByTestId('picklist');
  await pick.getByRole('checkbox', { name: /wg-one/ }).check();
  await pick.getByRole('checkbox', { name: /wg-two/ }).check();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wg: { hosts: string[] } }).__wg.hosts.slice().sort()), { timeout: 5000 }).toEqual(['wg-one.lan', 'wg-two.lan']);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __wg: { hosts: string[] } }).__wg.hosts.slice().sort())).toEqual(['wg-one.lan', 'wg-two.lan']);
  await expect(pick.getByRole('checkbox', { name: /wg-one/ })).toBeChecked();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('WireGuard in the app: addresses of apps deleted since are not counted as chosen, and go from the phone (report 80f9de)', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __wg: { hosts: string[] } };
    // Chosen earlier: one host still there, two apps deleted since.
    const state = { hosts: ['wg-one.lan', 'gone-1.example.lan', 'gone-2.example.lan'], viaBurrow: true };
    w.__wg = state;
    const status = () => ({ configured: true, active: true, viaBurrow: state.viaBurrow, hosts: [...state.hosts], error: null, proxyOverride: true, lastHandshake: Math.floor(Date.now() / 1000) - 20, address: '10.99.0.2/32', endpoint: 'vpn.example.com:51820', allowedIps: '10.99.0.0/24' });
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        let result: unknown = null;
        if (method === 'info') result = { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false };
        else if (method === 'wgStatus') result = status();
        else if (method === 'wgTargets') {
          state.viaBurrow = Boolean(params.viaBurrow);
          state.hosts = params.hosts as string[];
          result = status();
        }
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  await page.route('**/api/hosts', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const real = (await res.json()) as { id: number; address: string; name: string }[];
    // Enough to make a long list, which says how many are chosen.
    await r.fulfill({ json: Array.from({ length: 12 }, (_, n) => ({ ...real[0]!, id: 9501 + n, name: n ? `wg-${n + 1}` : 'wg-one', address: n ? `wg-${n + 1}.lan` : 'wg-one.lan' })) });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings/android');
  await page.reload();
  const card = page.getByTestId('wireguard');
  await expect(card.getByTestId('picklist').getByRole('checkbox', { name: /wg-one/ })).toBeChecked();
  // Only what is on the list counts; the rest is let go on the phone too.
  await expect(card.getByTestId('picklist')).toContainText(/\b1 of \d+ chosen/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wg: { hosts: string[] } }).__wg.hosts)).toEqual(['wg-one.lan']);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('WireGuard in the app: app tabs that could not be read are said, not quietly missing from the list (A3-WEB-06)', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    const status = { configured: true, active: true, viaBurrow: true, hosts: [], error: null, proxyOverride: true, lastHandshake: Math.floor(Date.now() / 1000) - 20, address: '10.99.0.2/32', endpoint: 'vpn.example.com:51820', allowedIps: '10.99.0.0/24' };
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        const result = method === 'info' ? { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false } : method === 'wgStatus' ? status : null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    (window as unknown as { BurrowAndroid: unknown }).BurrowAndroid = port;
  });
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Apps not read.' } }) : r.fallback()));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings/android');
  await page.reload();
  await expect(page.getByTestId('wireguard').getByTestId('picklist')).toBeVisible();
  await expect(page.getByTestId('wg-apps-failed')).toContainText('Apps not read.');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test("Burrow's own push in the app: through the phone's distributor, its address told to Burrow; taken off in Burrow, the app lets go too (AUDIT2 WEB-10)", async ({ page }) => {
  await sayYes(page);
  await signIn(page);
  // A device's keys, as the app's distributor gives them with its address.
  const keys = await page.evaluate(async () => {
    const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  });
  const url = `https://ntfy.example.lan/up${keys.auth.slice(0, 10)}`;
  // The app's side: what it was asked (kept across reloads, as the phone keeps its registration), and the address it gives a moment after it is asked.
  await page.addInitScript(
    ([url, p256dh, auth]) => {
      type S = { sub: { url: string; p256dh: string; auth: string } | null; calls: string[]; vapid: string | null };
      const w = window as unknown as { BurrowAndroid: unknown; __push: S; __endpoint: (d: unknown) => void };
      const state = (JSON.parse(sessionStorage.getItem('__push') ?? 'null') as S | null) ?? { sub: null, calls: [], vapid: null };
      const keep = () => sessionStorage.setItem('__push', JSON.stringify(state));
      w.__push = state;
      const port = {
        onmessage: null as ((e: { data: string }) => void) | null,
        postMessage(raw: string) {
          const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
          let result: unknown = null;
          if (method === 'info') result = { version: '2.0.0', versionCode: 20000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false };
          else if (method === 'pushState') result = state.sub;
          else if (method === 'pushRegister') {
            state.vapid = String(params.vapid);
            state.sub = { url, p256dh, auth };
            setTimeout(() => w.__endpoint(state.sub), 50);
          } else if (method === 'pushUnregister') state.sub = null;
          state.calls.push(method);
          keep();
          setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
        },
      };
      w.__endpoint = (data) => port.onmessage?.({ data: JSON.stringify({ event: 'pushEndpoint', data }) });
      w.BurrowAndroid = port;
    },
    [url, keys.p256dh, keys.auth] as const,
  );
  const app = () => page.evaluate(() => (window as unknown as { __push: { sub: unknown; calls: string[]; vapid: string | null } }).__push);
  const list = () => page.evaluate(async () => (await (await fetch('/api/push/devices')).json()) as { id: number; kind: string; label: string }[]);
  const before = new Set((await list()).map((d) => d.id));
  const mine = async () => (await list()).filter((d) => !before.has(d.id));
  const card = page.getByTestId('push-card');
  const state = card.getByTestId('push-state');
  await page.goto('/#/settings?s=notify');
  await page.reload();
  await expect(state).toHaveText('Off on this device.');

  // On: the phone asked with Burrow's key; the address it gives a moment later goes to Burrow.
  await card.getByTestId('push-toggle').click();
  await expect(page.getByText('Asked the phone: it may ask which app carries them (ntfy).')).toBeVisible();
  await expect(state).toHaveText('On: alerts, reports and updates can reach this device.');
  expect((await app()).vapid).toBe((await page.evaluate(async () => (await (await fetch('/api/push/key')).json()) as { publicKey: string })).publicKey);
  await expect.poll(mine).toEqual([expect.objectContaining({ kind: 'unifiedpush', label: expect.stringMatching(/^Burrow app \| /) })]);
  const [d] = await mine();

  // The distributor takes it back: off here.
  await page.evaluate(() => (window as unknown as { __endpoint: (d: unknown) => void }).__endpoint(null));
  await expect(state).toHaveText('Off on this device.');
  // Opened again: the app still has an address, and Burrow is told it again (the same device, not a second).
  await page.reload();
  await expect(state).toHaveText('On: alerts, reports and updates can reach this device.');
  expect((await mine()).map((x) => x.id)).toEqual([d!.id]);

  // Removed in Burrow (from another device): the app lets go as well, not registered again behind the person's back.
  await page.evaluate(async (id) => void (await fetch(`/api/push/devices/${id}`, { method: 'DELETE' })), d!.id);
  const calls = (await app()).calls.length;
  await page.reload();
  await expect(state).toHaveText('Off on this device.');
  await expect.poll(async () => (await app()).calls.slice(calls)).toContain('pushUnregister');
  expect((await app()).sub).toBeNull();
  expect(await mine()).toEqual([]);

  // On and off again from here: unregistered on the phone and gone from Burrow.
  await card.getByTestId('push-toggle').click();
  await expect(state).toHaveText('On: alerts, reports and updates can reach this device.');
  await expect.poll(async () => (await mine()).length).toBe(1);
  await card.getByTestId('push-toggle').click();
  await expect(state).toHaveText('Off on this device.');
  expect((await app()).sub).toBeNull();
  expect(await mine()).toEqual([]);
});

test('the home screen widget in the app: how it gets its numbers away from home; by push only with notifications on, its push address then carries them', async ({ page }) => {
  await signIn(page);
  const keys = await page.evaluate(async () => {
    const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  });
  const url = `https://ntfy.example.lan/widget${keys.auth.slice(0, 10)}`;
  // The app: a widget not placed yet, notifications off at first.
  await page.addInitScript(
    ([url, p256dh, auth]) => {
      type S = { away: string; push: { url: string; p256dh: string; auth: string } | null; calls: string[] };
      const w = window as unknown as { BurrowAndroid: unknown; __widget: S };
      const state = (JSON.parse(sessionStorage.getItem('__widget') ?? 'null') as S | null) ?? { away: 'tunnel', push: null, calls: [] };
      w.__widget = state;
      const port = {
        onmessage: null as ((e: { data: string }) => void) | null,
        postMessage(raw: string) {
          const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
          let result: unknown = null;
          if (method === 'info') result = { version: '2.11.0', versionCode: 21100, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false, widget: true };
          else if (method === 'widgetState') result = { away: state.away, placed: false };
          else if (method === 'setWidgetAway') state.away = String(params.away);
          else if (method === 'pushState') result = state.push;
          else if (method === '__pushOn') state.push = { url, p256dh, auth };
          state.calls.push(method);
          sessionStorage.setItem('__widget', JSON.stringify(state));
          setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
        },
      };
      w.BurrowAndroid = port;
    },
    [url, keys.p256dh, keys.auth] as const,
  );
  const app = () => page.evaluate(() => (window as unknown as { __widget: { away: string; calls: string[] } }).__widget);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings/android');
  await page.reload();
  const away = page.getByTestId('widget-away');
  await expect(away).toHaveValue('tunnel');
  await expect(page.getByTestId('widget-none')).toContainText('No Burrow widget on a home screen yet');
  await away.scrollIntoViewIfNeeded();
  await lookAt(page, 'phone-android-widget');

  // The last numbers: told to the app.
  await away.selectOption('last');
  await expect(page.getByTestId('toasts')).toContainText('Widget setting saved.');
  await expect.poll(async () => (await app()).away).toBe('last');
  // By push without notifications on this phone: refused, said, left as it was.
  await away.selectOption('push');
  await expect(page.getByTestId('toasts')).toContainText('Turn on notifications on this phone first');
  await expect(away).toHaveValue('last');
  expect((await app()).away).toBe('last');

  // Notifications on (this phone's address known to Burrow): its push address carries the numbers.
  await page.evaluate(async ([url, p256dh, auth]) => void (await fetch('/api/push/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'unifiedpush', label: 'widget phone', endpoint: url, p256dh, auth, lang: 'en' }) })), [url, keys.p256dh, keys.auth] as const);
  await page.evaluate(() => (window as unknown as { BurrowAndroid: { postMessage: (s: string) => void } }).BurrowAndroid.postMessage(JSON.stringify({ id: 99999, method: '__pushOn', params: {} })));
  const told = page.waitForRequest((r) => r.url().endsWith('/api/widget/push') && r.method() === 'PUT');
  await away.selectOption('push');
  expect((await told).postDataJSON()).toEqual({ endpoint: url, on: true });
  await expect.poll(async () => (await app()).away).toBe('push');
  // Back to the tunnel: the push address no longer carries them.
  const off = page.waitForRequest((r) => r.url().endsWith('/api/widget/push') && r.method() === 'PUT');
  await away.selectOption('tunnel');
  expect((await off).postDataJSON()).toEqual({ endpoint: url, on: false });
  await expect.poll(async () => (await app()).away).toBe('tunnel');
  const mine = await page.evaluate(async () => ((await (await fetch('/api/push/devices')).json()) as { id: number; label: string }[]).find((d) => d.label === 'widget phone')?.id);
  if (mine) await page.evaluate(async (id) => void (await fetch(`/api/push/devices/${id}`, { method: 'DELETE' })), mine);
});

/** A QR code of a second configuration (10.99.0.3), as wg-easy shows one: made with qrcode (scale 4, level L). */
const QR_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAOQAAADkCAYAAACIV4iNAAAAAklEQVR4AewaftIAAA2cSURBVO3BQY4YybLgQDJR978yR0tfRSORJb34GDezP1hrXeFhrXWNh7XWNR7WWtd4WGtd42GtdY2HtdY1HtZa1/jhP6j8SxVfqLxRMalMFZPKVPGbVE4q3lD5TRVfqEwVk8pUcaIyVbyh8i9VnDysta7xsNa6xsNa6xo/vFTxm1ROVE4qpoo3VKaKN1Smiknlb1KZKqaKE5WTihOVk4qp4g2VN1SmijcqfpPKGw9rrWs8rLWu8bDWusYPH6m8UfFGxaQyqUwVJypTxaQyVbyhclLxmyomlaniC5Wp4qTii4pJZao4UflNKm9UfPGw1rrGw1rrGg9rrWv8cDmVqWJSeaPipGJSeaNiUplUpopJZaqYVE4qflPFpHKi8kbFScWkclIxqUwVN3tYa13jYa11jYe11jV+uFzFFypTxaQyVUwVb6hMFScqU8Wk8obK31RxovKFym+q+L/kYa11jYe11jUe1lrX+OGjir9JZaqYKiaVqWJS+U0qU8WJylTxRsUbKlPFicqkMlVMKlPFicqk8kbFpPI3VfxLD2utazysta7xsNa6xg8vqdxEZaqYVKaKSeVEZap4Q2WqmFSmijdUpoo3VKaKSeULlaliUpkqJpUvVKaKE5X/pYe11jUe1lrXeFhrXeOH/1Dxv1TxRcUXFV9UTCpTxRcV/5LKVPE3VUwqU8VJxUnFTR7WWtd4WGtd42GtdY0f/oPKb6qYVL6omFSmiknlRGWq+EJlqjhROVH5TRWTylTxhsq/pPJFxaQyVUwqU8WkMlW88bDWusbDWusaD2uta9gfHKhMFZPKScW/pDJVfKEyVfwmlZOKL1SmikllqphUTiomlTcqJpWp4kRlqvhfUjmpOHlYa13jYa11jYe11jXsDz5QOamYVE4q3lB5o+JE5YuKE5WTikllqphUTiomlaniDZU3KiaVLyq+UDmpmFSmikllqvjiYa11jYe11jUe1lrX+OEllaliUplUpooTlanijYovKiaV31RxonKiMlVMKr9JZar4ouJ/qWJSOamYVKaKSWWqeONhrXWNh7XWNR7WWtewP/iLVN6omFROKiaVqeINld9UMalMFScqU8Wk8kbFpHJSMalMFZPKScXfpDJVnKi8UTGpTBVfPKy1rvGw1rrGw1rrGj98pDJVvFHxN6m8UXGiMlVMKm+ofFExqZyo/EsVv0nlN1WcqEwqU8WJylRx8rDWusbDWusaD2uta9gf/CKVqeJEZap4Q+Wk4guVk4pJ5Y2K/0tU3qiYVE4qJpWpYlL5X6r4TQ9rrWs8rLWu8bDWusYP/0FlqvhCZaqYVKaKk4oTlZOKSeWLikllqphUpopJZao4UZkqTlSmii8qJpWTipOKLyomlTcqJpW/6WGtdY2HtdY1HtZa17A/OFA5qZhUTiomlaniC5WTit+k8kXFicpU8YXKVDGpTBUnKm9U/CaVqWJSmSpOVL6o+OJhrXWNh7XWNR7WWtewPzhQ+aLiN6lMFScqJxWTylQxqUwVb6icVEwqJxUnKm9UTCpTxRsqJxWTylQxqZxU/CaVqeINlani5GGtdY2HtdY1HtZa1/jhpYpJ5QuVk4qp4kRlqphUJpWp4qRiUpkqJpWpYlI5qZhUTlSmit+k8kbFicpUMamcVEwqU8WJylTxhspUMVW88bDWusbDWusaD2uta/zwkspUMam8UTGpnKhMFV9UTCpTxUnFpHKicqLyRcWJyknFGxW/SeWLikllqpgqJpWpYlKZKiaVk4qTh7XWNR7WWtd4WGtd44f/UDGpnFS8oTJVTCq/qeILlTcqJpWpYlJ5Q+Wk4g2VqWJSOVE5qZgqvlB5Q2WqOFGZKiaVqWJSeeNhrXWNh7XWNR7WWtf44aWKSeWNiqliUjmpeENlqphUpoq/qWJSeaNiUjlRmSomlanii4pJZVKZKiaVqWJSOan4omJSOan4TQ9rrWs8rLWu8bDWuob9wYHKVHGiclIxqbxRMan8popJZaqYVKaKSeWkYlKZKk5UporfpDJVTCpTxaQyVfwmlZOKSeWk4g2Vk4o3HtZa13hYa13jYa11DfuDD1ROKv4llaniROWk4guVk4oTlZOKN1ROKk5UTipOVKaKSeWk4g2VqeJE5Y2K3/Sw1rrGw1rrGg9rrWv88B9UpoqTiknlX6qYVP4mlaniC5U3VN6oOFGZKk4qJpUvKk5UvlD5omJSOal442GtdY2HtdY1HtZa17A/OFB5o2JSmSreUJkqJpWTii9UTiq+UJkqJpWp4g2V31TxL6n8poo3VH5TxcnDWusaD2utazysta7xw3+omFROVN5QmSpOVKaKE5Wp4kTlC5WpYlKZKr5QmSpOKiaVk4pJ5aTiROWLiknlC5Wp4ouKLx7WWtd4WGtd42GtdY0f/oPKScWk8kbFb1KZKt6omFROVKaKSeVvqnhDZaqYVCaVqWJSmVSmipOKE5VJ5aRiUjmp+KLiNz2sta7xsNa6xsNa6xr2Bwcqb1RMKr+p4guVqWJSOamYVKaKE5Wp4kTlN1WcqEwVb6icVJyoTBWTyk0qJpWTipOHtdY1HtZa13hYa13jh/9QcaIyqZxUvKEyqUwVk8pUcaIyVfxLKicVb6hMFZPKFypTxVQxqUwqU8WJyhsVk8r/UsUbD2utazysta7xsNa6xg//QeWLihOVL1TeqPhC5Q2VqWJSmSq+qJhUpooTlTdU3qiYVE4qJpUvKn6TylTxxcNa6xoPa61rPKy1rmF/cKAyVbyhMlWcqJxUTCpfVEwqJxWTylQxqUwVJypTxaTyRsWJylQxqUwVJypTxRsqJxWTyknFpHJScaIyVUwqJxUnD2utazysta7xsNa6hv3BgcpJxaQyVZyofFFxojJV/CaVLyreUJkqfpPKVDGpTBWTyhsVk8pUMamcVJyonFS8oXJS8cbDWusaD2utazysta7xw0cqU8WkMlVMFZPKVHGiMlWcqEwVk8pU8UbFicqk8oXKVHGi8i9VfKHyhsoXKm9UTCpfPKy1rvGw1rrGw1rrGvYHBypTxaRyUjGp/E0Vb6hMFV+oTBUnKlPFpDJVnKhMFV+oTBWTylQxqbxRcROVk4rf9LDWusbDWusaD2uta/zwkspU8UXFicpU8ZsqJpWp4o2KSeU3qUwVU8UbKlPFicpUcVIxqUwVk8pUcaJyM5Wp4uRhrXWNh7XWNR7WWtewPzhQmSomlaliUpkqJpWp4kRlqjhROamYVL6oOFGZKt5QmSomlTcqJpWpYlKZKiaVLyp+k8pJxYnKb6o4eVhrXeNhrXWNh7XWNewPLqLyRsWJyknFGyonFW+onFScqPymikllqvhfUnmj4guVqeJEZap442GtdY2HtdY1HtZa17A/eEHljYpJ5YuKN1S+qPhC5aTib1KZKk5UTiomlZOKSeWNikllqphUTipOVN6o+E0Pa61rPKy1rvGw1rrGDy9VvKFyUjGpfKFyUjGpTBWTylTxRsWkcqIyVUwqb1RMKlPFVHGiMlVMKm9UTCq/qeJE5aRiUvmbHtZa13hYa13jYa11DfuD/yGVqeJE5aRiUvmi4kTli4pJ5aTiROU3VUwqJxWTylTxL6mcVEwqU8WJyhsVJw9rrWs8rLWu8bDWusYPH6mcVJxUTConFScqJxVvqEwVJxVvqHyh8i9VnKicqEwVk8pUMamcVLyhMlVMKicVv+lhrXWNh7XWNR7WWtf44T+onFRMKpPKGxWTyhcVk8pUMan8JpWTijdU3qh4Q+UNlaniRGVSmSreqDipmFSmijcqJpWp4ouHtdY1HtZa13hYa13D/uAFlZOKm6hMFZPKVDGpTBWTyhsVk8pU8YXKVDGpTBUnKlPFFypvVEwqJxWTylQxqUwVJypTxW96WGtd42GtdY2HtdY17A9+kcpUcaJyUjGpvFHxhsq/VDGp/EsVb6j8poovVKaKSeU3VUwqb1ScPKy1rvGw1rrGw1rrGvYHF1M5qThRmSq+UJkq3lA5qZhUpoo3VN6omFSmihOVk4oTlZOKSeWNijdUpooTlanijYe11jUe1lrXeFhrXeOH/6DyL1X8popJ5W9SeaNiUnlDZao4qThReUPlN1VMKpPKVHGicqIyVZyonFR88bDWusbDWusaD2uta/zwUsVvUjmp+ELlpGJSmSreqPiXKv6mikllqnhDZao4qXhD5Y2KLyomlanijYe11jUe1lrXeFhrXeOHj1TeqHhD5Y2KN1SmihOVqeJE5aRiqphUJpUvVKaKL1TeqPibKiaVSeWLikllqvjiYa11jYe11jUe1lrX+OH/MxUnKlPFVDGpTBVTxYnKVPFGxRcqb1R8oTJVfKEyVZxUnKicqPxND2utazysta7xsNa6xg//x1ScqJyonFScqPxNKlPFicpUMamcVJyoTBVfVEwqU8WJylQxqUwVk8pU8UbFpHKiMlWcPKy1rvGw1rrGw1rrGj98VHGzijdUpoqbVfxLKlPFicpUcaIyVUwVk8pUMalMFV+oTBWTylTxxsNa6xoPa61rPKy1rvHDSyr/Syr/ksobKm9UnKhMFScqU8WkMqmcVEwqJypfVJyonKhMFZPKFxUnFV88rLWu8bDWusbDWusa9gdrrSs8rLWu8bDWusbDWusaD2utazysta7xsNa6xsNa6xr/Dyfz3/Tb6juBAAAAAElFTkSuQmCC';

test('WireGuard in the app: from a picture of its QR code, a .conf file or the camera; a picture without one, a refused file and a cancelled scan said', async ({ page }) => {
  await sayYes(page);
  await signIn(page);
  await page.addInitScript(() => {
    type State = { conf: string | null; calls: string[]; scans: { cancelled?: boolean; error?: string | null; conf?: string }[] };
    const w = window as unknown as { BurrowAndroid: unknown; __wg: State };
    const state: State = { conf: null, calls: [], scans: [{ cancelled: true }, { error: 'no [Peer] section' }, { conf: '[Interface]\nAddress = 10.99.0.4/32\n[Peer]\nEndpoint = cam.example.com:51820\n' }] };
    w.__wg = state;
    const status = () => ({ configured: state.conf !== null, active: false, viaBurrow: true, hosts: [], error: null, proxyOverride: false, address: /Address = (\S+)/.exec(state.conf ?? '')?.[1], endpoint: /Endpoint = (\S+)/.exec(state.conf ?? '')?.[1], allowedIps: '10.99.0.0/24' });
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        state.calls.push(method);
        let result: unknown = null;
        if (method === 'info') result = { version: '1.26.0', versionCode: 12600, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false, qrCamera: true };
        else if (method === 'wgStatus') result = status();
        else if (method === 'wgSave') {
          // The app's own check of what it is given.
          if (String(params.conf).includes('[Peer]')) state.conf = String(params.conf);
          result = { error: String(params.conf).includes('[Peer]') ? null : 'no [Peer] section' };
        } else if (method === 'wgScan') {
          const s = state.scans.shift()!;
          if (s.conf) state.conf = s.conf;
          result = { cancelled: !!s.cancelled, error: s.error ?? null };
        } else if (method === 'wgRemove') state.conf = null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  const wg = () => page.evaluate(() => (window as unknown as { __wg: { conf: string | null; calls: string[] } }).__wg);
  await page.goto('/#/settings/android');
  await page.reload();
  const card = page.getByTestId('wireguard');
  await expect(card).toContainText('Not set up');
  // An older WebView cannot send only some addresses through: said.
  await expect(card).toContainText("This phone's WebView is too old");
  const picture = card.locator('input[type=file][accept="image/*"]');
  const file = card.locator('input[type=file][accept=".conf,text/plain"]');

  // A picture without a QR code: said, nothing saved.
  await picture.setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  await expect(page.getByText('No WireGuard QR code found in that picture.')).toBeVisible();
  expect((await wg()).calls).not.toContain('wgSave');
  // The picture of the code: read here, the configuration to the phone.
  await picture.setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: Buffer.from(QR_PNG, 'base64') });
  await expect(page.getByText('WireGuard saved on this phone.')).toBeVisible();
  await expect(card).toContainText('10.99.0.3/32');
  expect((await wg()).conf).toContain('Endpoint = vpn.example.com:51820');
  await card.getByRole('button', { name: 'Remove WireGuard from this phone' }).click();
  await expect(card).toContainText('Not set up');

  // A .conf file the app refuses: its words; then a good one.
  await file.setInputFiles({ name: 'half.conf', mimeType: 'text/plain', buffer: Buffer.from('[Interface]\nAddress = 10.99.0.5/32\n') });
  await expect(page.getByText('Not a usable configuration: no [Peer] section')).toBeVisible();
  await expect(card).toContainText('Not set up');
  await file.setInputFiles({ name: 'phone.conf', mimeType: 'text/plain', buffer: Buffer.from('[Interface]\nAddress = 10.99.0.6/32\n[Peer]\nEndpoint = file.example.com:51820\n') });
  await expect(card).toContainText('file.example.com:51820');
  await card.getByRole('button', { name: 'Remove WireGuard from this phone' }).click();
  await expect(card).toContainText('Not set up');

  // The camera: cancelled is nothing at all; refused is said; read is saved.
  await expect(page.getByText('Not a usable configuration: no [Peer] section')).toHaveCount(0, { timeout: 10_000 });
  const scan = card.getByTestId('wg-scan');
  await scan.click();
  await expect.poll(async () => (await wg()).calls.filter((c) => c === 'wgScan').length).toBe(1);
  await expect(card).toContainText('Not set up');
  await scan.click();
  await expect(page.getByText('Not a usable configuration: no [Peer] section')).toBeVisible();
  await scan.click();
  await expect(card).toContainText('cam.example.com:51820');
});

test("the app paired with a code from a signed-in browser: signed in at once, and at its next start with its own key", async ({ page, browser }) => {
  await signIn(page);
  const { code } = await page.evaluate(async () => (await (await fetch('/api/account/devices/pair-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { code: string });
  // The phone: the app's key made and kept as Android's keystore does (EC P-256), signatures in DER as Java gives them.
  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  await phone.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __app: () => { calls: string[]; deviceId: number | null } };
    const load = <T,>(k: string): T | null => JSON.parse(localStorage.getItem(k) ?? 'null') as T | null;
    const keep = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));
    const calls: string[] = load<string[]>('__calls') ?? [];
    w.__app = () => ({ calls: load<string[]>('__calls') ?? [], deviceId: load<number>('__deviceId') });
    const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
    const der = (raw: Uint8Array) => {
      const int = (x: Uint8Array) => {
        let i = 0;
        while (i < x.length - 1 && x[i] === 0) i++;
        const v = x.slice(i);
        const body = v[0]! & 0x80 ? [0, ...v] : [...v];
        return [2, body.length, ...body];
      };
      const seq = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
      return new Uint8Array([0x30, seq.length, ...seq]);
    };
    const answer: Record<string, (p: Record<string, unknown>) => unknown> = {
      info: () => ({ version: '2.0.0', versionCode: 20000, deviceId: load<number>('__deviceId'), deviceName: 'Pixel 8', profiles: true, screenshots: false, screenshotsFixed: false, shake: false }),
      createKey: async () => {
        const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        keep('__key', await crypto.subtle.exportKey('jwk', k.privateKey));
        return { publicKey: b64(await crypto.subtle.exportKey('spki', k.publicKey)) };
      },
      saveDevice: (p) => keep('__deviceId', p.deviceId),
      sign: async (p) => {
        const key = await crypto.subtle.importKey('jwk', load<JsonWebKey>('__key')!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(String(p.message))));
        return { signature: b64(der(raw)) };
      },
    };
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        calls.push(method);
        keep('__calls', calls);
        void Promise.resolve()
          .then(() => (answer[method] ? answer[method](params) : method === 'sshPublicKey' ? Promise.reject(new Error('no key yet')) : null))
          .then(
            (result) => port.onmessage?.({ data: JSON.stringify({ id, result: result ?? null }) }),
            (e: Error) => port.onmessage?.({ data: JSON.stringify({ id, error: e.message }) }),
          );
      },
    };
    w.BurrowAndroid = port;
  });
  const app = () => phone.evaluate(() => (window as unknown as { __app: () => { calls: string[]; deviceId: number | null } }).__app());
  await phone.goto('/');
  await phone.getByRole('button', { name: 'Pair with a code' }).click();
  await phone.getByLabel('Pairing code').fill(code);
  await phone.getByRole('button', { name: 'Pair and sign in' }).click();
  await expect(phone.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  const { deviceId } = await app();
  expect(deviceId).toEqual(expect.any(Number));
  const listed = await page.evaluate(async () => (await (await fetch('/api/account/devices')).json()) as { id: number; name: string }[]);
  expect(listed.find((d) => d.id === deviceId)?.name).toBe('Pixel 8');

  // Signed out, the next start signs in with the phone's own key: no code, no passkey.
  await phone.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  await phone.reload();
  await expect(phone.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  expect((await app()).calls.filter((c) => c === 'sign')).toHaveLength(1);
  expect((await phone.evaluate(async () => (await (await fetch('/api/auth/state')).json()) as { deviceId: number | null })).deviceId).toBe(deviceId);

  await ctx.close();
  await page.evaluate((id) => fetch(`/api/account/devices/${id}`, { method: 'DELETE' }), deviceId);
});

test('two phones of the same model told apart: when each was paired, this device in both lists, a name of their own (UIA-15)', async ({ page, browser }) => {
  await signIn(page);
  const code = async () => (await page.evaluate(async () => (await (await fetch('/api/account/devices/pair-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { code: string })).code;
  const publicKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  // Two of the same model, the second this browser's own (as the app is, signed in by pairing).
  const ids: number[] = [];
  const contexts = [await browser.newContext(), await browser.newContext()];
  const phones = [];
  for (const ctx of contexts) {
    const phone = await ctx.newPage();
    await phone.goto('/');
    const c = await code();
    ids.push(await phone.evaluate(async ([c, k]) => ((await (await fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c, name: 'Twin phone sdk_gphone64_x86_64', publicKey: k }) })).json()) as { deviceId: number }).deviceId, [c, publicKey()] as const));
    phones.push(phone);
  }
  const phone = phones[1]!;
  // Signed in by the pairing: the page loaded before it asks again.
  await phone.goto('/#/settings/android');
  await phone.reload();
  const paired = phone.locator('.list-item', { hasText: 'Twin phone' }).filter({ has: phone.getByTestId('device-sub') });
  await expect(paired).toHaveCount(2);
  // When each was paired, beside when it was last used.
  for (const row of await paired.all()) await expect(row.getByTestId('device-sub')).toContainText(/^paired \d{1,2} \w{3} \d{4} \| last used /);
  // This device marked in the direct route's list too, not only under the paired phones.
  const direct = phone.getByTestId('direct-route').locator('.list-item', { hasText: 'Twin phone' });
  await expect(direct).toHaveCount(2);
  await expect(direct.filter({ hasText: 'this device' })).toHaveCount(1);
  await expect(paired.filter({ hasText: 'this device' })).toHaveCount(1);
  // On a phone too, with a model's long name: the mark whole beside it or under it, not cut off with the name.
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.getByTestId('direct-route').scrollIntoViewIfNeeded();
  await lookAt(phone, 'phone-paired-phones-alike');

  // Renamed from the computer (with its fresh step-up): the other one keeps its name.
  await page.goto('/#/settings/android');
  const first = page.locator('.list-item', { hasText: 'Twin phone' }).filter({ has: page.getByTestId('device-sub') }).first();
  await fromRowMenu(first, 'device-menu', 'device-rename');
  const ask = page.getByRole('dialog');
  await ask.getByLabel('Name').fill('Old twin');
  await ask.getByRole('button', { name: 'Save' }).click();
  await expect(ask).toBeHidden();
  await expect(page.locator('.list-item', { hasText: 'Old twin' }).filter({ has: page.getByTestId('device-sub') })).toHaveCount(1);
  await expect(page.locator('.list-item', { hasText: 'Twin phone' }).filter({ has: page.getByTestId('device-sub') })).toHaveCount(1);
  const names = await page.evaluate(async () => ((await (await fetch('/api/account/devices')).json()) as { name: string }[]).map((d) => d.name));
  expect(names.filter((n) => n === 'Old twin' || n === 'Twin phone sdk_gphone64_x86_64').sort()).toEqual(['Old twin', 'Twin phone sdk_gphone64_x86_64']);

  for (const ctx of contexts) await ctx.close();
  for (const id of ids) await page.evaluate((id) => fetch(`/api/account/devices/${id}`, { method: 'DELETE' }), id);
});

test("Settings -> Android app in the app with Burrow not answering: the app's own part still there, not a download said missing, the failure apart, and the direct route from it (report eedaac)", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __direct: unknown[] };
    w.__direct = [];
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params?: unknown };
        // The app called is the press's effect (e2e/tests/fixtures.ts): no page change follows it here.
        if (method === 'openDirect') {
          w.__direct.push(params ?? {});
          dispatchEvent(new Event('burrow-test-effect'));
        }
        const result = method === 'info' ? { version: '2.12.0', versionCode: 21200, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false } : method === 'wgStatus' ? { configured: false, active: false, viaBurrow: false, hosts: [], error: null, proxyOverride: true, lastHandshake: null, address: null, endpoint: null, allowedIps: null } : null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  await page.setViewportSize({ width: 698, height: 394 });
  await page.goto('/#/settings/android');
  // Burrow gone after the page was there: its reads get no answer at all.
  await page.route(/\/api\/(android|account\/devices)$/, (r) => r.abort('internetdisconnected'));
  await page.reload();
  const failed = page.getByTestId('load-failed');
  await expect(failed).toContainText('No connection with Burrow');
  // This app's own part is the phone's, not Burrow's: still shown.
  await expect(page.getByTestId('app-version')).toBeVisible();
  await expect(page.getByText('No app has been built for this server yet')).toHaveCount(0);
  await lookAt(page, 'foldable-android-unreachable');
  // The way to the hosts without Burrow: the phone's direct route, from where the failure is said.
  await failed.getByTestId('load-direct').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __direct: unknown[] }).__direct.length)).toBe(1);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('the app this Burrow offers is older than Burrow itself (after a self-update): said, with where a new one comes from', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/android', (r) => r.fulfill({ json: { apk: { versionName: '2.21.0', versionCode: 22100, sha256: 'a'.repeat(64), size: 28 * 1048576 } } }));
  await page.route('**/api/version', (r) => r.fulfill({ json: { server: '2.22.0' } }));
  await page.goto('/#/settings/android');
  await page.reload();
  const older = page.getByTestId('apk-older');
  await expect(older).toContainText('The app this Burrow offers (2.21.0) is older than Burrow itself (2.22.0)');
  await expect(older.getByRole('link', { name: 'Releases on GitHub' })).toHaveAttribute('href', 'https://github.com/R31l4nd/Burrow/releases');
  await lookAt(page, 'settings-android-apk-older');
  // The same version: nothing said.
  await page.unroute('**/api/version');
  await page.route('**/api/version', (r) => r.fulfill({ json: { server: '2.21.0' } }));
  await page.reload();
  const get = page.getByRole('link', { name: /Download the app \(2\.21\.0/ });
  await expect(get).toBeVisible();
  // The app itself, from this Burrow.
  await page.route('**/api/android/burrow.apk', (r) => r.fulfill({ body: 'apk', headers: { 'content-type': 'application/vnd.android.package-archive' } }));
  const [file] = await Promise.all([page.waitForEvent('download'), get.click()]);
  expect(file.suggestedFilename()).toBe('burrow.apk');
  await expect(older).toBeHidden();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test("the app this Burrow offers older than Burrow, or none: Burrow gets its own version's app from the release on GitHub and offers it (report a5ace5)", async ({ page }) => {
  await signIn(page);
  let apk: { versionName: string; versionCode: number; sha256: string; size: number } | null = { versionName: '2.21.0', versionCode: 22100, sha256: 'a'.repeat(64), size: 28 * 1048576 };
  await page.route('**/api/android', (r) => r.fulfill({ json: { apk } }));
  await page.route('**/api/version', (r) => r.fulfill({ json: { server: '2.22.0' } }));
  // Burrow's side of it (server/test/integration/android.test.ts): routed here, GitHub is not asked from a test.
  let asked = 0;
  let answer: () => Promise<void> = async () => {};
  await page.route('**/api/android/fetch-release', async (r) => {
    asked++;
    await answer();
    apk = { versionName: '2.22.0', versionCode: 22200, sha256: 'b'.repeat(64), size: 29 * 1048576 };
    await r.fulfill({ json: { apk } });
  });
  await page.goto('/#/settings/android');
  await page.reload();
  await expect(page.getByTestId('apk-older')).toBeVisible();
  const fetch = page.getByTestId('apk-fetch-release');
  await expect(fetch).toHaveText('Get the app 2.22.0 from GitHub');
  // Meanwhile said what it does and how long it takes.
  let done!: () => void;
  answer = () => new Promise<void>((resolve) => (done = resolve));
  await fetch.click();
  await expect(fetch).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Some 30 MB from the release on GitHub' })).toBeVisible();
  await lookAt(page, 'settings-android-fetching-release');
  done();
  await expect(page.getByText('The app 2.22.0 is ready: this Burrow offers it now.')).toBeVisible();
  expect(asked).toBe(1);
  await expect(page.getByTestId('apk-older')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Download the app \(2\.22\.0/ })).toBeVisible();
  // None offered at all: the same way to one.
  apk = null;
  answer = async () => {};
  await page.reload();
  await expect(page.getByText('No app has been built for this server yet')).toBeVisible();
  await page.getByTestId('apk-fetch-release').click();
  await expect(page.getByRole('link', { name: /Download the app \(2\.22\.0/ })).toBeVisible();
  expect(asked).toBe(2);
  // GitHub's answer when it went wrong: said in words, nothing else changed.
  await page.unroute('**/api/android/fetch-release');
  await page.route('**/api/android/fetch-release', (r) => r.fulfill({ status: 404, json: { error: 'no_release_apk', message: 'The release 2.22.0 on GitHub has no app (burrow.apk.json).' } }));
  apk = null;
  await page.reload();
  await page.getByTestId('apk-fetch-release').click();
  await expect(page.getByText('The release 2.22.0 on GitHub has no app (burrow.apk.json).')).toBeVisible();
  await expect(page.getByText('No app has been built for this server yet')).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test("the app's version while Burrow's side could not be read: no 'up to date' (audit 2026-11-09)", async ({ page }) => {
  // Failed is not empty: with /api/android failing it said the app was up to date.
  await signIn(page);
  await page.addInitScript(() => {
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        const result = method === 'info' ? { version: '2.0.0', versionCode: 20000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false } : null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    (window as unknown as { BurrowAndroid: unknown }).BurrowAndroid = port;
  });
  await page.route('**/api/android', (r) => r.fulfill({ status: 500, json: { error: 'internal', message: 'The list could not be read.' } }));
  await page.goto('/#/settings/android');
  await page.reload();
  await expect(page.getByTestId('load-failed')).toContainText('The list could not be read.');
  await expect(page.getByTestId('app-version')).toContainText('This app is version 2.0.0.');
  await expect(page.getByTestId('app-version')).not.toContainText('up to date');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
