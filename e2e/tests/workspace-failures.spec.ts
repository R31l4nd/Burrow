import { expect, test, type Page } from './fixtures.js';
import { failureShown, lookAt } from './checks.js';
import { signIn } from './passkey.js';
import { concretePages } from './pages.js';

// Every page when Burrow's API fails, three ways: an error (500), no answer
// at all (the network gone), and another page in its place with status 200
// (a reverse proxy's own page while Burrow restarts; reported: that broke
// the Terminal tab in the app for good). A page may say it could not load;
// it must not throw, and it must not go blank.

const KINDS = ['error', 'offline', 'proxy page'] as const;

async function urls(page: Page): Promise<string[]> {
  const api = async <T,>(url: string) => page.evaluate(async (u) => (await (await fetch(u)).json()) as unknown, url) as Promise<T>;
  const first = async (url: string) => (await api<{ id: number | string }[]>(url))[0]?.id;
  const hosts = await api<{ id: number; name: string }[]>('/api/hosts');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  return concretePages({
    sshd,
    // The test host's stand-in docker answers at once: this is about the API failing, not a slow host.
    docker: sshd,
    group: await first('/api/groups'),
    session: await first('/api/terminal/sessions'),
    workspace: await first('/api/workspaces'),
    report: await first('/api/reports'),
    app: await first('/api/apps'),
    container: 'burrowtest-web',
    stack: 'burrowtest',
    file: '/home/tester/.profile',
  })
    .filter((p) => !p.missing)
    .map((p) => p.url);
}

test('every page, with the API failing three ways: no error in the page, never blank', async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  const list = await urls(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  for (const kind of KINDS) {
    await test.step(kind, async () => {
      // Signed in stays answered (else every page is the sign-in page).
      await page.route('**/api/**', (r) => {
        if (new URL(r.request().url()).pathname === '/api/auth/state') return r.continue();
        if (kind === 'offline') return r.abort('internetdisconnected');
        if (kind === 'error') return r.fulfill({ status: 500, json: { error: 'internal', message: 'Something broke.' } });
        return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Domein niet beschikbaar</title><p>404</p>' });
      });
      for (const url of list) {
        await page.goto(url);
        await page.reload();
        await page.waitForTimeout(800);
        // The page's own part, not the rail and bars around it: those alone were enough before (AUDIT2 TEST-08).
        const text = await page.evaluate(() => (document.querySelector('main')?.innerText ?? '').trim().length);
        expect(text, `${kind}: ${url} is blank`).toBeGreaterThan(0);
      }
      await page.unroute('**/api/**');
    });
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test("with the API failing, no page says Loading... for ever; it says why and tries again", async ({ page }) => {
  // Audit WP-07: a failed read left "Loading..." on screen, or looked like no data.
  test.setTimeout(300_000);
  await signIn(page);
  // A workspace of its own (other specs may not have made one yet).
  const own = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const hostId = hosts.find((h) => h.name === 'test-sshd')!.id;
    const r = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId, root: '/tmp', name: 'load-failed' }) });
    return ((await r.json()) as { id: number }).id;
  });
  const list = await urls(page);
  const stuck: string[] = [];
  await page.route('**/api/**', (r) => {
    if (new URL(r.request().url()).pathname === '/api/auth/state') return r.continue();
    return r.fulfill({ status: 500, json: { error: 'internal', message: 'Something broke.' } });
  });
  for (const url of list) {
    await page.goto(url);
    await page.reload();
    await page.waitForTimeout(1500);
    // Its words, or the shimmering shape that stands for them (Skeleton).
    if ((await page.getByText('Loading...', { exact: true }).filter({ visible: true }).count()) || (await page.getByTestId('skeleton').count())) stuck.push(url);
  }
  expect(stuck, stuck.join('\n')).toEqual([]);
  // A workspace that failed to load: why, and Try again loads it once Burrow answers.
  await page.goto(`/#/ws/${own}`);
  await page.reload();
  await expect(page.getByTestId('load-failed')).toContainText('Something broke.');
  await lookAt(page, 'desktop-load-failed');
  await page.unroute('**/api/**');
  await page.getByTestId('load-retry').click();
  await expect(page.getByTestId('load-failed')).toHaveCount(0);
  await expect(page.getByTestId('ws-quick')).toBeVisible();
  await page.evaluate((id) => fetch(`/api/workspaces/${id}`, { method: 'DELETE' }), own);
});

// Pages that read nothing of their own: there is no failure to say.
const READS_NOTHING: Record<string, string> = {
  '/#/settings': 'the list of the parts of Settings, written in the page',
  '/#/settings/appearance': 'theme, accent and size: kept in this browser',
  '/#/settings/report': 'the problem report button: arming it reads nothing',
  '/#/settings/terminal': 'the key bar, completion and text size: kept in this browser',
  '/#/settings/shortcuts': 'the keyboard shortcuts: a list in the app itself',
  '/#/logs': 'no logs chosen: nothing is read to show',
};

test("every page with Burrow's proxy answering 502: the failure stays on the page, in words (A3-WEB-01, A3-WEB-05)", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const list = await urls(page);
  await page.route('**/api/**', (r) => {
    if (new URL(r.request().url()).pathname === '/api/auth/state') return r.continue();
    return r.fulfill({ status: 502, contentType: 'text/html', body: '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>' });
  });
  for (const url of list) {
    if (READS_NOTHING[url]) continue;
    await page.goto(url);
    await page.reload();
    await page.waitForTimeout(1200);
    await failureShown(page, url);
  }
  await page.unroute('**/api/**');
});

test('a log the server refuses: said in the log with its reason, not "No lines yet." (A3-WEB-01)', async ({ page }) => {
  await signIn(page);
  const sshd = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  for (const [code, reason, said] of [
    [4403, 'not allowed', 'You may not read these logs.'],
    [4401, 'signed out', 'Signed out: sign in again to read these logs.'],
    [4000, 'bad request', 'Not a log source here.'],
  ] as const) {
    await page.routeWebSocket(/\/api\/docker\/logs\/ws/, (ws) => {
      if (code === 4000) ws.send(JSON.stringify({ t: 'error', i: -1, message: 'Not a log source here.' }));
      ws.close({ code, reason });
    });
    await page.goto(`/#/logs?t=${sshd}:burrowtest-db`);
    await page.reload();
    await expect(page.getByTestId('log-refused')).toContainText(said);
    await expect(page.getByText('No lines yet.')).toHaveCount(0);
    await page.waitForTimeout(7000);
    // Still there once the toast is gone.
    await expect(page.getByTestId('log-refused')).toContainText(said);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('nginx -t: waiting for the containers shows their shape, a failed read says so with Try again, never "no running containers" (A3-WEB-03)', async ({ page }) => {
  await signIn(page);
  const sshd = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.evaluate(async (id) => {
    await fetch(`/api/files/${id}/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/home/tester/ngx', kind: 'dir' }) });
    await fetch(`/api/files/${id}/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/home/tester/ngx/nginx.conf', content: 'events {}\n', baseHash: null }) });
  }, sshd);
  let release!: () => void;
  let held = new Promise<void>((r) => (release = r));
  let mode: 'slow' | 'fail' | 'docker' | 'ok' = 'slow';
  await page.route(/\/api\/docker\/\d+\/containers$/, async (r) => {
    if (mode === 'slow') {
      await held;
      return r.fallback();
    }
    if (mode === 'fail') return r.fulfill({ status: 500, json: { error: 'internal', message: 'Containers not read.' } });
    if (mode === 'docker') return r.fulfill({ json: { hostId: sshd, hostName: 'test-sshd', containers: [], stats: {}, history: {}, error: 'docker is not answering', at: new Date().toISOString() } });
    return r.fallback();
  });
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/home/tester/ngx/nginx.conf')}`);
  await expect(page.locator('.cm-line').first()).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'nginx -t' });
  const open = async () => (await page.getByTestId('editor-menu').click(), await page.getByTestId('nginx-test').click(), await expect(dialog).toBeVisible());
  await open();
  await expect(dialog.getByTestId('skeleton')).toBeVisible();
  await expect(dialog.getByText('No running containers on this host.')).toHaveCount(0);
  release();
  await expect(dialog.getByRole('button', { name: 'burrowtest-db' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Failed: why, and Try again; the list of the opening before is not shown.
  mode = 'fail';
  await open();
  await expect(dialog.getByTestId('load-failed')).toContainText('Containers not read.');
  await expect(dialog.getByRole('button', { name: 'burrowtest-db' })).toHaveCount(0);
  await expect(dialog.getByText('No running containers on this host.')).toHaveCount(0);
  mode = 'ok';
  await dialog.getByTestId('load-retry').click();
  await expect(dialog.getByRole('button', { name: 'burrowtest-db' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Docker did not answer on the host: that, not "none".
  mode = 'docker';
  await open();
  await expect(dialog.getByTestId('load-failed')).toContainText('docker is not answering');
  await expect(dialog.getByText('No running containers on this host.')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  held = Promise.resolve();
});

test('a host Burrow cannot sign in to: each page says so, nothing breaks', async ({ page }) => {
  await signIn(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  const SSHD_HOST = process.env.SSHD_HOST ?? 'burrow-e2e-sshd';
  const host = await page.evaluate(async (address) => {
    const r = await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'wrong-password', address, username: 'tester', authMethod: 'password', password: 'not-the-password' }) });
    return (await r.json()) as { id: number };
  }, SSHD_HOST);
  try {
    // Its key trusted, so what fails is the password.
    await page.evaluate(async (id) => {
      const r = (await (await fetch(`/api/hosts/${id}/test`, { method: 'POST' })).json()) as { status: string; fingerprint?: string };
      if (r.status === 'unknown_host_key') await fetch(`/api/hosts/${id}/trust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: r.fingerprint }) });
    }, host.id);
    // A terminal: refused, with the reason.
    await page.goto('/#/hosts');
    await page.getByTestId('host-row').filter({ hasText: 'wrong-password' }).first().click();
    await expect(page.getByText(/authentication|password|sign in/i).first()).toBeVisible({ timeout: 20_000 });
    // Its files and its containers: a message, not an empty page.
    for (const url of [`/#/files/${host.id}?p=~`, `/#/hosts/${host.id}/stats`]) {
      await page.goto(url);
      await expect(page.locator('.alert.error, [role=alert]').first()).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    await page.evaluate((id) => fetch(`/api/hosts/${id}`, { method: 'DELETE' }), host.id);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a workspace that loads slowly keeps the tabs remembered on this device', async ({ page }) => {
  // Audit WP-03: the empty start was saved over them while the workspace still loaded.
  await signIn(page);
  const own = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const hostId = hosts.find((h) => h.name === 'test-sshd')!.id;
    const r = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId, root: '/etc', name: 'slow-tabs' }) });
    return ((await r.json()) as { id: number }).id;
  });
  await page.evaluate((id) => localStorage.setItem(`burrow.ws.${id}`, JSON.stringify({ tabs: ['/etc/hostname', '/etc/hosts'], current: '/etc/hosts' })), own);
  await page.route(`**/api/workspaces/${own}`, async (r) => {
    await new Promise((w) => setTimeout(w, 1500));
    await r.continue().catch(() => {});
  });
  await page.goto(`/#/ws/${own}`);
  await page.reload();
  await page.waitForTimeout(500);
  // Still loading: what was remembered is still there.
  expect(await page.evaluate((id) => JSON.parse(localStorage.getItem(`burrow.ws.${id}`) ?? '{}').tabs, own)).toEqual(['/etc/hostname', '/etc/hosts']);
  await expect(page.getByTestId('ws-tab')).toHaveText(['hostname', 'hosts']);
  await page.unroute(`**/api/workspaces/${own}`);
  await page.evaluate((id) => fetch(`/api/workspaces/${id}`, { method: 'DELETE' }), own);
});

test('an address with a broken escape: said so, the app keeps working', async ({ page }) => {
  // Audit WP-04: "%" in a container's or stack's name threw while the page was drawn.
  await signIn(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const url of ['/#/containers/1/%E0%A4%A', '/#/stacks/1/%', '/#/containers/abc/web']) {
    await page.goto(url);
    await expect(page.getByTestId('bad-address')).toBeVisible();
  }
  await lookAt(page, 'desktop-bad-address');
  await page.getByTestId('bad-address').getByRole('link', { name: 'Hosts' }).click();
  await expect(page.getByRole('heading', { name: 'Hosts', level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a rule switched or a sign-out that Burrow refuses: said so, and the switch goes back', async ({ page }) => {
  // Audit WP-08: the failure was lost in the click handler; the checkbox stayed as clicked.
  await signIn(page);
  await page.goto('/#/alerts');
  const box = page.getByRole('checkbox', { name: /^Rule .* on$/ }).first();
  await expect(box).toBeVisible();
  const was = await box.isChecked();
  await page.route('**/api/alerts/rules/*', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Rule not saved.' } }) : r.fallback()));
  await box.click();
  await expect(page.getByText('Rule not saved.')).toBeVisible();
  await expect(box).toBeChecked({ checked: was });
  await page.unroute('**/api/alerts/rules/*');
  // A channel switched off and refused: the switch back on (AUDIT2 UI-22).
  await page.goto('/#/settings/channels');
  const ch = page.getByRole('checkbox', { name: /^Channel .* on$/ }).first();
  await expect(ch).toBeVisible();
  const chWas = await ch.isChecked();
  await page.route('**/api/channels/*', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Channel not saved.' } }) : r.fallback()));
  await ch.click();
  await expect(page.getByText('Channel not saved.')).toBeVisible();
  await expect(ch).toBeChecked({ checked: chWas });
  await page.unroute('**/api/channels/*');
  // Signing out refused: said, and still signed in.
  await page.route('**/api/auth/logout', (r) => r.fulfill({ status: 500, json: { error: 'internal', message: 'Not signed out.' } }));
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Not signed out.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.unroute('**/api/auth/logout');
});

test('a search answered late does not replace the search made after it', async ({ page }) => {
  // Audit WP-14: the older, slower answer showed its names under the new words.
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  // The slow answer held until the quick one is shown, then let go, and looked at after it came (AUDIT2 TEST-10: a fixed wait proved neither).
  let releaseSlow!: () => void;
  const slowHeld = new Promise<void>((r) => (releaseSlow = r));
  await page.route(/\/api\/files\/\d+\/search/, async (r) => {
    const name = new URL(r.request().url()).searchParams.get('name');
    if (name === 'slow') await slowHeld;
    await r.fulfill({ json: [`/tmp/${name}-result.txt`] }).catch(() => {});
  });
  await page.goto(`/#/files/${hostId}?p=%2Ftmp`);
  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Search' });
  await expect(dlg).toContainText('/tmp');
  const field = dlg.getByRole('textbox');
  const go = dlg.getByRole('button', { name: 'Search', exact: true });
  await field.fill('slow');
  await go.click();
  await field.fill('quick');
  await go.click();
  await expect(dlg.getByText('/tmp/quick-result.txt', { exact: true })).toBeVisible();
  const isSlow = (url: string) => /\/search/.test(url) && new URL(url).searchParams.get('name') === 'slow';
  // Answered, or given up by the page (aborted): either way over.
  const slowAnswered = Promise.race([page.waitForResponse((r) => isSlow(r.url())), page.waitForEvent('requestfailed', (r) => isSlow(r.url()))]);
  releaseSlow();
  await slowAnswered;
  // A frame after the late answer arrived: whatever it was going to change, it has.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  await expect(dlg.getByText('/tmp/slow-result.txt', { exact: true })).toHaveCount(0);
  await expect(dlg.getByText('/tmp/quick-result.txt', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a workspace with nothing open, on a phone: "Go to file" and "Files" lead there', async ({ page }) => {
  await signIn(page);
  const own = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const hostId = hosts.find((h) => h.name === 'test-sshd')!.id;
    const r = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId, root: '/etc', name: 'nothing-open' }) });
    return ((await r.json()) as { id: number }).id;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/ws/${own}`);
  await page.getByTestId('ws-empty-quick').click();
  await expect(page.getByRole('dialog', { name: 'Go to file' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('ws-empty-files').click();
  await expect(page.getByTestId('ws-drawer')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('tree-node').filter({ hasText: 'hostname' })).toBeVisible();
  await page.evaluate((id) => fetch(`/api/workspaces/${id}`, { method: 'DELETE' }), own);
});

test("a group's or All hosts' defaults the form does not show stay when it is saved", async ({ page }) => {
  // Audit WP-13: a terminal type and an encoding set through the API were dropped.
  await signIn(page);
  const api = <T,>(method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return (r.status === 204 ? null : await r.json()) as unknown;
    }, [method, url, body] as const) as Promise<T>;
  const g = await api<{ id: number }>('POST', '/api/groups', { name: 'Old terminals', parentId: null, defaults: { username: 'alice', term: 'vt100', encoding: 'ISO-8859-1' } });
  await page.goto(`/#/groups/${g.id}/edit`);
  await page.getByRole('textbox', { name: 'Name' }).fill('Old terminals, renamed');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/#\/hosts$/);
  await expect.poll(async () => (await api<{ id: number; name: string }[]>('GET', '/api/groups')).find((x) => x.id === g.id)?.name).toBe('Old terminals, renamed');
  const saved = (await api<{ id: number; defaults: Record<string, unknown> }[]>('GET', '/api/groups')).find((x) => x.id === g.id)!;
  expect(saved.defaults).toMatchObject({ username: 'alice', term: 'vt100', encoding: 'ISO-8859-1' });
  await api('DELETE', `/api/groups/${g.id}`);
  // All hosts the same way (put back as it was after).
  const before = await api<Record<string, unknown>>('GET', '/api/host-defaults');
  await api('PUT', '/api/host-defaults', { ...before, term: 'xterm-direct' });
  await page.goto('/#/settings/hosts');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved for every host.')).toBeVisible();
  expect((await api<Record<string, unknown>>('GET', '/api/host-defaults')).term).toBe('xterm-direct');
  await api('PUT', '/api/host-defaults', before);
});

test('a sign-in setting changed while its save is on its way stays changed and unsaved', async ({ page }) => {
  // Audit WC-07: the answer marked what was typed meanwhile as saved.
  await signIn(page);
  // Answered slowly, with what was sent (Burrow's own settings stay as they are).
  await page.route('**/api/settings/oidc', async (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    const b = r.request().postDataJSON() as Record<string, unknown>;
    await new Promise((w) => setTimeout(w, 1500));
    await r.fulfill({ json: { ...b, hasSecret: true, redirectUri: 'https://burrow.example/api/auth/oidc/callback' } }).catch(() => {});
  });
  await page.goto('/#/settings/sso');
  await page.getByTestId('sso-enabled').check();
  await page.getByTestId('sso-issuer').fill('https://first.example');
  await page.getByTestId('sso-label').fill('First');
  await page.getByTestId('sso-save').click();
  // While it is on its way: another label.
  await page.getByTestId('sso-label').fill('Second');
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByTestId('sso-label')).toHaveValue('Second');
  await expect(page.getByTestId('sso-unsaved')).toBeVisible();
  await page.unroute('**/api/settings/oidc');
});

test('an AI setting changed while its save is on its way stays changed and unsaved', async ({ page }) => {
  // Audit WC-08: the answer filled the form again over what was typed meanwhile.
  await signIn(page);
  await page.route('**/api/settings/ai', async (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    const b = r.request().postDataJSON() as { provider: string; ollama: object; anthropic: { model: string }; openai: { url: string; model: string }; timeoutMinutes: number };
    await new Promise((w) => setTimeout(w, 1500));
    await r.fulfill({ json: { provider: b.provider, ollama: b.ollama, anthropic: { model: b.anthropic.model, hasKey: false }, openai: { url: b.openai.url, model: b.openai.model, hasKey: false }, timeoutMinutes: b.timeoutMinutes } }).catch(() => {});
  });
  await page.goto('/#/settings/ai');
  await page.reload();
  // On (the form only; what is saved is answered above, not stored).
  if (!(await page.getByTestId('ai-enabled').isChecked())) await page.getByTestId('ai-enabled').check();
  await page.getByTestId('ai-timeout').fill('20');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.getByTestId('ai-timeout').fill('25');
  await expect(page.getByText('AI settings saved.').first()).toBeVisible();
  await expect(page.getByTestId('ai-timeout')).toHaveValue('25');
  await expect(page.getByTestId('ai-unsaved')).toBeVisible();
  await page.unroute('**/api/settings/ai');
});

test('keys and snippets that could not be read: said so with Try again, not "none yet" (AUDIT2 PAGE-08)', async ({ page }) => {
  await signIn(page);
  for (const [url, api, empty] of [
    ['/#/keys', '**/api/keys', 'No keys yet.'],
    ['/#/snippets', '**/api/snippets', 'No snippets yet.'],
  ] as const) {
    let fail = true;
    await page.route(api, (r) => (fail && r.request().method() === 'GET' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Could not read.' } }) : r.fallback()));
    await page.goto(url);
    await page.reload();
    await expect(page.getByText('Could not read.')).toBeVisible();
    await expect(page.getByText(empty)).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('Could not read.')).toHaveCount(0);
    await page.unroute(api);
  }
});

test('models listed for the address typed, not the old settings, and nothing saved on the way; the first one chosen (AUDIT2 UI-20, W-FUNC-07)', async ({ page }) => {
  await signIn(page);
  let saves = 0;
  let asked: { provider?: string; url?: string } = {};
  await page.route('**/api/settings/ai', (r) => (r.request().method() === 'PUT' ? ((saves += 1), r.fulfill({ status: 500, json: { error: 'internal', message: 'AI settings not saved.' } })) : r.fallback()));
  await page.route('**/api/settings/ai/models', (r) => ((asked = r.request().postDataJSON() as typeof asked), r.fulfill({ json: ['first-model', 'second-model'] })));
  await page.goto('/#/settings/ai');
  await page.reload();
  if (!(await page.getByTestId('ai-enabled').isChecked())) await page.getByTestId('ai-enabled').check();
  await page.getByRole('combobox', { name: /^Provider/ }).selectOption('openai');
  await page.getByLabel('Server URL').fill('http://typed.invalid:8000/v1');
  await page.getByRole('button', { name: 'Load available models' }).click();
  // A list to choose from, the first chosen (it showed an empty choice, saved as no model at all).
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('first-model');
  expect(asked).toMatchObject({ provider: 'openai', url: 'http://typed.invalid:8000/v1' });
  expect(saves).toBe(0);
  await page.unroute('**/api/settings/ai');
  await page.unroute('**/api/settings/ai/models');
});

test('a sign-in setting typed before the settings arrived stays (AUDIT2 UI-21)', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/settings/oidc', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    await new Promise((w) => setTimeout(w, 1500));
    await r.fallback().catch(() => {});
  });
  await page.goto('/#/settings/sso');
  await page.reload();
  // Whatever an earlier spec left stored: the fields show once it is on, Save not yet usable.
  await page.getByTestId('sso-enabled').check();
  await expect(page.getByTestId('sso-save')).toBeDisabled();
  await page.getByTestId('sso-label').fill('Typed early');
  await expect(page.getByTestId('sso-save')).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('sso-label')).toHaveValue('Typed early');
  await expect(page.getByTestId('sso-unsaved')).toBeVisible();
  await page.unroute('**/api/settings/oidc');
});

test('sign-in settings that could not be read: said, and nothing can be saved over them (AUDIT2 UI-21)', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/settings/oidc', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Settings not read.' } }) : r.fallback()));
  await page.goto('/#/settings/sso');
  await page.reload();
  await expect(page.getByText('Settings not read.')).toBeVisible();
  await page.getByTestId('sso-enabled').check();
  await expect(page.getByTestId('sso-save')).toBeDisabled();
  await page.unroute('**/api/settings/oidc');
});

test('channels that could not be read: said with Try again, not "no channels" (AUDIT2 UI-29)', async ({ page }) => {
  await signIn(page);
  let fail = true;
  await page.route('**/api/channels', (r) => (fail && r.request().method() === 'GET' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Channels not read.' } }) : r.fallback()));
  await page.goto('/#/settings/channels');
  await page.reload();
  await expect(page.getByText('Channels not read.')).toBeVisible();
  await expect(page.getByText('No channels yet.', { exact: false })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Channels not read.')).toHaveCount(0);
  await page.unroute('**/api/channels');
});

test("the app's code did not load (the network changed while loading): a way to reload, not a blank page (gate 2.3.1)", async ({ page }) => {
  await signIn(page);
  // The first load of the app's own script fails, as Chromium's net::ERR_NETWORK_CHANGED did in the 2.3.1 gate.
  let failed = 0;
  const entry = /\/assets\/index-[^/]+\.js$/;
  await page.goto('/#/hosts');
  await page.route(entry, (r) => (failed++ === 0 ? r.abort('internetdisconnected') : r.fallback()));
  await page.reload();
  await expect(page.getByTestId('boot')).toBeVisible();
  await expect(page.getByTestId('boot-late')).toHaveCSS('opacity', '1', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Reload the page' }).click();
  await expect(page.getByRole('link', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByTestId('boot')).toHaveCount(0);
  expect(failed).toBe(2);
  await page.unroute(entry);
});

test('who is signed in could not be read at the start: said with Try again, and that gets in (AUDIT2 UX-10)', async ({ page }) => {
  await signIn(page);
  let fail = true;
  await page.route('**/api/auth/state', (r) => (fail ? r.fulfill({ status: 502, contentType: 'text/html', body: '<h1>502 Bad Gateway</h1>' }) : r.fallback()));
  await page.goto('/#/hosts');
  await page.reload();
  await expect(page.getByTestId('load-failed')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  fail = false;
  await page.getByTestId('load-retry').click();
  await expect(page.getByRole('link', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByTestId('load-failed')).toHaveCount(0);
  await page.unroute('**/api/auth/state');
});

test('reads that turned a failure into "none": SMART, earlier checks, the history, earlier analyses, the channels of a schedule (A3-WEB-06)', async ({ page }) => {
  await signIn(page);
  const sshd = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const fail = (r: import('@playwright/test').Route) => (r.request().method() === 'GET' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Not read.' } }) : r.fallback());
  // SMART and its kept checks, and the history behind the charts.
  await page.route(/\/api\/hosts\/\d+\/smart$/, fail);
  await page.route(/\/api\/hosts\/\d+\/smart\/history$/, fail);
  await page.route(/\/api\/hosts\/\d+\/stats\/history/, fail);
  await page.goto(`/#/hosts/${sshd}/stats`);
  await page.reload();
  await expect(page.getByTestId('smart')).toContainText('SMART could not be read: Not read.');
  await expect(page.getByTestId('smart')).not.toContainText('Not checked yet');
  await expect(page.getByText('No history yet', { exact: false })).toHaveCount(0);
  await expect(page.getByTestId('load-failed').filter({ hasText: 'Not read.' }).first()).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // A container's earlier analyses.
  await page.route('**/api/ai/analyses?*', fail);
  await page.goto(`/#/logs?t=${sshd}:burrowtest-db`);
  await page.reload();
  await page.getByTestId('analyze-open').click();
  await expect(page.getByTestId('analyze')).toContainText('The earlier analyses could not be read: Not read.');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // A report schedule's channels.
  await page.route('**/api/channels', fail);
  await page.goto('/#/reports');
  await page.reload();
  await page.getByTestId('new-schedule').click();
  await page.getByTestId('schedule-all-channels').uncheck();
  const form = page.locator('dialog[open]');
  await expect(form.getByTestId('load-failed')).toContainText('Not read.');
  await expect(form.getByText('No channels yet', { exact: false })).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('the terminal list not read on a folded-open phone: the words across the line, Try again beside them (report a3c513)', async ({ page }) => {
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.setViewportSize({ width: 698, height: 698 });
  await page.route('**/api/terminal/sessions', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }) : r.continue()));
  await page.goto(`/#/term/${s.id}`);
  const failed = page.locator('.listfail');
  await expect(failed).toBeVisible();
  const words = (await failed.locator('span').boundingBox())!;
  const retry = (await failed.getByRole('button').boundingBox())!;
  const row = (await failed.boundingBox())!;
  expect(words.width).toBeGreaterThan(row.width / 2);
  expect(retry.width).toBeLessThan(words.width);
  expect(retry.height).toBeLessThan(60);
  await lookAt(page, 'foldable-term-list-failed');
  await page.unroute('**/api/terminal/sessions');
  await failed.getByRole('button').click();
  await expect(failed).toHaveCount(0);
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("a container's history, kept log files and suggested ones that could not be read: said with Try again, not as none (audit 2026-11-05)", async ({ page }) => {
  await signIn(page);
  // The real Docker's host (workspace-containers made it): burrowtest-web runs there.
  const docker = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'docker-real')!.id);
  let fail = true;
  const failing = (r: import('@playwright/test').Route) => (fail && r.request().method() === 'GET' ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Not read.' } }) : r.fallback());
  await page.route(/\/api\/docker\/\d+\/containers\/[^/]+\/history\?/, failing);
  await page.route(/\/api\/docker\/\d+\/logfiles\?/, failing);
  await page.route(/\/api\/docker\/\d+\/containers\/[^/]+\/logfile-suggestions$/, failing);
  await page.goto(`/#/containers/${docker}/burrowtest-web`);
  await page.reload();
  // Its kept log files: said, not left out as if it had none.
  // Said in the page's summary (and again in its log files' part).
  await expect(page.getByTestId('load-failed').filter({ hasText: 'The log files kept for this container could not be read: Not read.' }).first()).toBeVisible();
  // The history with the details: not "not enough yet for a chart".
  await page.getByTestId('container-info').click();
  const history = page.getByTestId('container-history');
  await expect(history.getByTestId('load-failed')).toContainText('Not read.');
  await expect(history).not.toContainText('not enough yet');
  // What its mounts suggest: not "No *.log files found".
  await page.getByTestId('logfiles-manage').click();
  const dlg = page.locator('dialog[open][data-tour=logfiles]');
  await expect(dlg.getByTestId('load-failed').filter({ hasText: 'could not be searched for log files: Not read.' })).toBeVisible();
  await expect(dlg.getByTestId('logfiles-none')).toHaveCount(0);
  await lookAt(page, 'desktop-logfiles-failed');
  // Try again, now that they answer: each read again, the failures gone.
  fail = false;
  await expect(dlg.getByTestId('load-retry')).toHaveCount(2);
  await dlg.getByTestId('load-retry').first().click();
  await expect(dlg.getByTestId('load-retry')).toHaveCount(1);
  await dlg.getByTestId('load-retry').click();
  await expect(dlg.getByTestId('load-failed')).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByTestId('load-failed').filter({ hasText: 'log files kept' })).toHaveCount(0);
  await history.getByTestId('load-retry').click();
  await expect(history.getByTestId('load-failed')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
