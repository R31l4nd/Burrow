import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { hostNamed, signIn } from './passkey.js';

// The ways around the usual: a session unlike the host's tmux setting, the
// phone's own direct session, waking a sleeping host, a command on several
// hosts at once, an app's uptime, the backups' state, and Burrow updating
// itself (with the host side stood in for).

const hostId = async (page: Page, name: string) =>
  (await page.evaluate(async () => (await fetch('/api/hosts')).json() as Promise<{ id: number; name: string }[]>)).find((h) => h.name === name)!.id;

test('a session this once without tmux, from the menu by "New session"', async ({ page }) => {
  await signIn(page);
  const asked: unknown[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/terminal/sessions')) asked.push(r.postDataJSON());
  });
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByTestId('session-options').click();
  await expect(page.getByTestId('session-tmux')).toBeVisible();
  // Not in a browser: the phone's own route is the app's.
  await expect(page.getByTestId('direct-session')).toHaveCount(0);
  await lookAt(page, 'session-options');
  await page.getByTestId('session-memory').click();
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
  expect(asked).toContainEqual(expect.objectContaining({ tmux: 'never' }));
  // Its tip beside the badge, next to the rail: over the rail, not under it (report 6779f4).
  await expect(page.getByTestId('memory-badge')).toBeVisible();
  await lookAt(page, 'desktop-terminal-memory', { tips: true, axe: false });
});

test('in the app: the direct session for this host', async ({ page }) => {
  await signIn(page);
  const id = await hostId(page, 'test-sshd');
  // A paired phone with test-sshd on its direct route.
  await page.route('**/api/auth/state', async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), deviceId: 77 } });
  });
  await page.route('**/api/account/devices/77/hosts', (r) => r.fulfill({ json: { hostIds: [id] } }));
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __calls: { method: string; params: unknown }[] };
    w.__calls = [];
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown };
        w.__calls.push({ method, params });
        const result = method === 'info' ? { version: '1.2.0', versionCode: 10200, deviceId: 77, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: true } : null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  await page.reload();
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByTestId('session-options').click();
  await page.getByTestId('direct-session').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __calls: { method: string; params: unknown }[] }).__calls.filter((c) => c.method === 'openDirect')))
    .toEqual([{ method: 'openDirect', params: { hostId: id } }]);
  // From the terminal tabs too: + held, "Direct session".
  const s = await page.evaluate((h) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: h, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), id);
  await page.goto(`/#/term/${s.id}`);
  const plus = page.getByTestId('term-new');
  const box = (await plus.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await page.getByTestId('new-direct').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __calls: { method: string; params: unknown }[] }).__calls.filter((c) => c.method === 'openDirect').length))
    .toBe(2);
  await page.evaluate((sid) => fetch(`/api/terminal/sessions/${sid}`, { method: 'DELETE' }), s.id);
});

test('a sleeping host is woken from its menu', async ({ page }) => {
  await signIn(page);
  const id = await hostId(page, 'test-sshd');
  // Asleep, and Burrow knows its MAC address from when it was up.
  await page.route('**/api/hosts/status', async (r) => {
    const res = await r.fetch();
    const list = (await res.json()) as { hostId: number; reachable: boolean }[];
    await r.fulfill({ response: res, json: list.map((s) => (s.hostId === id ? { ...s, reachable: false } : s)) });
  });
  await page.route('**/api/hosts', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const list = (await res.json()) as { id: number; facts: Record<string, unknown> | null }[];
    await r.fulfill({ response: res, json: list.map((h) => (h.id === id ? { ...h, facts: { ...h.facts, mac: '02:42:ac:11:00:02' } } : h)) });
  });
  let woken = 0;
  await page.route(`**/api/hosts/${id}/wake`, (r) => ((woken += 1), r.fulfill({ json: { relay: 'docker-real' } })));
  await page.reload();
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await lookAt(page, 'host-wake');
  await page.getByTestId('host-wake').click();
  await expect(page.getByText(/docker-real/).first()).toBeVisible();
  expect(woken).toBe(1);
});

test('Wake-on-LAN chosen on the host: from Burrow itself, to a MAC address of its own, kept with the host', async ({ page }) => {
  await signIn(page);
  // A host Burrow never reached: no address learned, set by hand.
  const nas = await page.evaluate(async () => (await (await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sleeping-nas', address: '192.0.2.60', username: 'me' }) })).json()) as { id: number });
  await page.goto(`/#/hosts/${nas.id}/edit`);
  await expect(page.getByTestId('host-wake-mac')).toHaveAttribute('placeholder', 'aa:bb:cc:dd:ee:ff');
  await page.getByTestId('host-wake-via').selectOption({ label: 'Burrow itself' });
  await page.getByTestId('host-wake-mac').fill('0A-1B-2C-3D-4E-5F');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/#\/hosts$/);
  await page.goto(`/#/hosts/${nas.id}/edit`);
  await expect(page.getByTestId('host-wake-mac')).toHaveValue('0a:1b:2c:3d:4e:5f');
  await expect(page.getByTestId('host-wake-via')).toHaveValue('burrow');
  // Down (192.0.2.x answers nothing): woken from its menu, through Burrow, no other host needed.
  await expect
    .poll(async () => page.evaluate(async (id) => ((await (await fetch('/api/hosts/status')).json()) as { hostId: number; reachable: boolean }[]).find((s) => s.hostId === id)?.reachable, nas.id), { timeout: 30_000 })
    .toBe(false);
  await page.goto('/#/hosts');
  await page.getByRole('button', { name: 'Menu for sleeping-nas' }).first().click();
  await page.getByTestId('host-wake').click({ timeout: 20_000 });
  await expect(page.getByText('Wake-up sent through Burrow').first()).toBeVisible();
  await page.evaluate((id) => fetch(`/api/hosts/${id}`, { method: 'DELETE' }), nas.id);
});

test('a command on several hosts at once, from the hosts page', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('hosts-adhoc').click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('adhoc-command').fill('echo adhoc-$((6*7))');
  await dialog.getByText('test-sshd', { exact: true }).click();
  await lookAt(page, 'adhoc-run');
  await dialog.getByRole('button', { name: /^Run on 1 host\b/ }).click();
  await expect(page.getByText('adhoc-42').first()).toBeVisible({ timeout: 30_000 });
});

test('an app that is watched shows whether it is up', async ({ page }) => {
  await signIn(page);
  // The stand-in app server of the apps test, reachable from Burrow.
  const url = `${process.env.APPS_BASE ?? 'http://localhost:8191'}/app-ok?uptime=1`;
  const app = await page.evaluate(async (u) => {
    const r = await fetch('/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Uptime probe', url: u, monitor: true }) });
    return (await r.json()) as { id: number; up: boolean | null };
  }, url);
  expect(app.up).toBe(true);
  await page.goto('/#/apps');
  const tile = page.locator('.tile-wrap', { hasText: 'Uptime probe' }).first();
  await expect(tile.getByTestId('app-state')).toHaveText('100%');
  await lookAt(page, 'apps-uptime');
  await page.evaluate(async (id) => void (await fetch(`/api/apps/${id}`, { method: 'DELETE' })), app.id);
});

test('Settings -> Backups: one made now, and the newest downloaded', async ({ page }) => {
  // Reported (445f22): no way to make a backup now or to download one.
  await signIn(page);
  const last = new Date(Date.now() - 3_600_000).toISOString();
  let status: Record<string, unknown> = { ok: true, at: last, file: 'burrow-20261007T080000Z.tar.gz.enc', bytes: 7_000_000, count: 30, remote: true, error: null };
  let requestedAt: string | null = null;
  let download: { file: string; bytes: number } | null = null;
  await page.route('**/api/backup/status', (r) => r.fulfill({ json: { status, staleAfterMs: 172_800_000, requestedAt, download } }));
  await page.route('**/api/backup/now', (r) => {
    requestedAt = new Date(Date.now() - 1000).toISOString();
    return r.fulfill({ json: { requestedAt } });
  });
  await page.goto('/#/settings/backups');
  const backups = page.getByTestId('backups');
  // Not mounted: no download, and said how.
  await expect(backups.getByTestId('backup-no-download')).toContainText('mount the backups folder');
  await backups.getByTestId('backup-now').click();
  await expect(backups.getByTestId('backup-busy')).toContainText('starts within seconds');
  await expect(backups.getByTestId('backup-now')).toBeDisabled();
  await lookAt(page, 'settings-backup-busy');
  // Taken by the service (its request marker gone), the round still running:
  // still busy, and the last round from before is not called the new one
  // (AUDIT2 PAGE-04: it said "Backup made." here).
  requestedAt = null;
  await expect(backups.getByTestId('backup-busy')).toContainText('Making the backup', { timeout: 10_000 });
  await page.waitForTimeout(3500);
  await expect(page.getByText('Backup made.')).toHaveCount(0);
  await expect(backups.getByTestId('backup-now')).toBeDisabled();
  // The service made it: said so, and the newest offered for download.
  status = { ...status, at: new Date().toISOString(), count: 30 };
  download = { file: 'burrow-20261007T090000Z.tar.gz.enc', bytes: 7_100_000 };
  await expect(page.getByText('Backup made.')).toBeVisible({ timeout: 10_000 });
  await expect(backups.getByTestId('backup-busy')).toHaveCount(0);
  await expect(backups.getByTestId('backup-now')).toBeEnabled();
  await page.reload();
  const link = backups.getByTestId('backup-download');
  await expect(link).toContainText('Download the newest (6.8 MB)');
  await page.route('**/api/backup/download', (r) => r.fulfill({ body: 'encrypted', headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="burrow-20261007T090000Z.tar.gz.enc"' } }));
  const [file] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(file.suggestedFilename()).toBe('burrow-20261007T090000Z.tar.gz.enc');
  // Asked, never taken: after a minute the page says the service may not run.
  status = { ...status, at: new Date(Date.now() - 180_000).toISOString() };
  requestedAt = new Date(Date.now() - 120_000).toISOString();
  await page.reload();
  await expect(backups.getByTestId('backup-busy')).toContainText('has not taken the request after a minute');
  await lookAt(page, 'settings-backup-stuck');
  requestedAt = null;
  await page.unroute('**/api/backup/status');
  await page.unroute('**/api/backup/now');
  await page.unroute('**/api/backup/download');
});

test('Settings: the backups, and Burrow updating itself', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.route('**/api/backup/status', (r) =>
    r.fulfill({ json: { status: { ok: false, at: new Date(Date.now() - 3 * 86_400_000).toISOString(), file: null, bytes: null, count: 4, remote: true, error: 'rclone: 403 Forbidden' }, staleAfterMs: 172_800_000 } }),
  );
  let version = '1.1.0';
  await page.route('**/api/version', (r) => r.fulfill({ json: { server: version } }));
  let started = 0;
  await page.route('**/api/system/update', (r) => {
    if (r.request().method() === 'POST') {
      started += 1;
      // The server restarts: the next version answers a moment later.
      setTimeout(() => (version = '1.2.0'), 1000);
      return r.fulfill({ json: { started: true, from: '1.1.0' } });
    }
    return r.fulfill({
      json: {
        target: { hostId: sshd, hostName: 'docker-real', dir: '/opt/burrow', container: 'burrow', service: 'burrow' },
        running: '1.1.0',
        mode: 'git',
        available: '1.2.0',
        behind: 3,
        subject: 'feat: 1.2.0',
        last: { state: 'rolledback', at: new Date(Date.now() - 86_400_000).toISOString(), message: 'The new version did not become healthy; the old one runs again' },
        problem: null,
        breaking: ['1.2.0: BURROW_PORT is now PORT: change it in your .env first.'],
      },
    });
  });
  await page.goto('/#/settings/backups');
  const backups = page.getByTestId('backups');
  await expect(backups).toContainText('rclone: 403 Forbidden');

  await page.goto('/#/settings/about');
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-state')).toContainText('1.2.0 is available');
  await expect(page.getByTestId('update-state')).toContainText('rolled back');
  // What the CHANGELOG calls breaking in between: shown, and in the question.
  await expect(page.getByTestId('update-breaking')).toContainText('BURROW_PORT is now PORT');
  await page.getByTestId('about').scrollIntoViewIfNeeded();
  await lookAt(page, 'settings-update');
  await page.getByTestId('update-start').click();
  // The question names the breaking change, in red; yes.
  await expect(page.getByTestId('confirm-text')).toContainText('BURROW_PORT is now PORT');
  await expect(page.getByTestId('confirm-ok')).toHaveClass(/danger/);
  const reloaded = page.waitForEvent('load');
  await page.getByTestId('confirm-ok').click();
  await reloaded;
  expect(started).toBe(1);
});

test('an analysis goes on when the app was away for a moment', async ({ page }) => {
  await signIn(page);
  const hosts = await page.evaluate(async () => (await fetch('/api/hosts')).json() as Promise<{ id: number; address: string }[]>);
  const id = hosts.find((h) => h.address === (process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker'))?.id;
  test.skip(!id, 'no Docker host');
  await page.goto(`/#/logs?t=${id}:burrowtest-web`);
  await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 20_000 });
  // The first two looks at the running analysis get no answer at all, as
  // when Android pauses the app.
  let dropped = 0;
  await page.route(/\/api\/ai\/analyses\/\d+$/, (r) => (dropped < 2 ? ((dropped += 1), r.abort('internetdisconnected')) : r.fallback()));
  await page.getByTestId('analyze-open').click();
  const dialog = page.getByRole('dialog', { name: 'Analyse with AI' });
  // First the question for another AI, copied: the logs of this container.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByTestId('analyze-copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).toContain('burrowtest-web');
  await dialog.getByTestId('analyze-run').click();
  await expect(dialog.getByTestId('analysis')).toContainText('Likely cause', { timeout: 30_000 });
  expect(dropped).toBe(2);
  await expect(dialog.getByText('Failed to fetch')).toHaveCount(0);

});

test("Reports: the AI's analyses beside the reports, one read, then its logs", async ({ page }) => {
  await signIn(page);
  await page.goto('/#/reports');
  await page.getByTestId('made-analyses').click();
  // The one run earlier in this file (the app away for a moment).
  const row = page.getByTestId('analysis-row').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByTestId('analysis-text')).toContainText('Likely cause');
  await page.getByTestId('analysis-logs').click();
  await expect(page).toHaveURL(/#\/logs\?t=/);
  await page.goto('/#/reports');
  await page.getByTestId('made-reports').click();
  await expect(page.getByTestId('analysis-row')).toHaveCount(0);
  // Deleted, after a yes (report aafaba): gone from the list. The server's side is in the integration tests;
  // here the deletion is answered by the page, so the tour still has this analysis to show.
  const deleted: string[] = [];
  await page.route('**/api/ai/analyses/*', (r) => (r.request().method() === 'DELETE' ? (deleted.push(r.request().url()), r.fulfill({ status: 204 })) : r.fallback()));
  await page.getByTestId('made-analyses').click();
  // Counted once the list is there (counted at once it was 0 now and then).
  await expect(page.getByTestId('analysis-row').first()).toBeVisible();
  const before = await page.getByTestId('analysis-row').count();
  await page.getByTestId('analysis-row').first().click();
  await page.getByTestId('analysis-delete').click();
  await expect(page.getByTestId('confirm-text')).toContainText('Delete the analysis of');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('analysis-row')).toHaveCount(before - 1);
  expect(deleted).toHaveLength(1);
  await page.unroute('**/api/ai/analyses/*');

  // Stand-ins: one of a host's log file, and one still being written that is followed to its end.
  const at = new Date().toISOString();
  const base = { lines: 10, provider: 'ollama:test', error: null, createdAt: at, finishedAt: null, tokens: null, ask: null, followUps: [], canAsk: false };
  const ofFile = { ...base, id: 900001, targets: [{ hostId: 1, container: '', file: '/var/log/syslog' }], status: 'done', text: 'From the file' };
  const writing = { ...base, id: 900002, targets: [{ hostId: 1, container: 'burrowtest-web' }], status: 'running', text: 'So far' };
  let looks = 0;
  await page.route(/\/api\/ai\/analyses\?limit=/, (r) => r.fulfill({ json: [writing, ofFile] }));
  await page.route('**/api/ai/analyses/900002', (r) => ((looks += 1), r.fulfill({ json: looks < 2 ? writing : { ...writing, status: 'done', text: 'So far, and done', finishedAt: at } })));
  await page.goto('/#/reports?view=analyses');
  await page.reload();
  // By what it is, not as stdout of a container named '' (AUDIT2 PAGE-20).
  const fileRow = page.getByTestId('analysis-row').filter({ hasText: 'syslog' });
  await expect(fileRow).toBeVisible();
  await fileRow.click();
  await page.getByTestId('analysis-logs').click();
  await expect(page).toHaveURL(new RegExp(`t=${encodeURIComponent(`1::${encodeURIComponent('/var/log/syslog')}`)}`));
  await page.goto('/#/reports?view=analyses');
  await page.reload();
  await page.getByTestId('analysis-row').filter({ hasText: 'burrowtest-web' }).click();
  await expect(page.getByTestId('analysis-text')).toHaveText('So far, and done', { timeout: 15_000 });
  await page.unroute(/\/api\/ai\/analyses\?limit=/);
  await page.unroute('**/api/ai/analyses/900002');

  // Its commands each with Copy and Run..., as a report's fixes (report a7532e); the steps
  // numbered on after each command, not 1 again.
  const sshd = await hostId(page, 'test-sshd');
  const cmds = { ...base, id: 900003, targets: [{ hostId: sshd, container: 'burrowtest-web' }], status: 'done', text: '1. **Check the client**\n```\necho analysis-cmd-one\n```\n2. **Then the path**\n```\necho analysis-cmd-two\n```' };
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route(/\/api\/ai\/analyses\?limit=/, (r) => r.fulfill({ json: [cmds] }));
  await page.goto('/#/reports?view=analyses');
  await page.reload();
  await page.getByTestId('analysis-row').first().click();
  const answer = page.getByTestId('analysis-text');
  await expect(answer.getByTestId('answer-copy')).toHaveCount(2);
  await expect(answer.locator('ol[start="2"]')).toContainText('Then the path');
  await answer.getByTestId('answer-copy').nth(1).click();
  await expect(page.getByText('Copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('echo analysis-cmd-two');
  await answer.getByTestId('answer-run').first().click();
  // Under its command, in the answer: the answer is in a dialog, and no second dialog opens over it.
  const run = answer.getByTestId('fix-inline');
  await expect(run.getByTestId('fix-command')).toHaveValue('echo analysis-cmd-one');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await run.getByTestId('fix-confirm').click();
  await expect(run.getByTestId('fix-result')).toContainText('analysis-cmd-one', { timeout: 20_000 });
  await lookAt(page, 'desktop-analysis-commands');
  // Close puts it away again; the answer stays.
  await run.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(answer.getByTestId('fix-inline')).toHaveCount(0);
  await expect(answer.getByTestId('answer-copy')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.unroute(/\/api\/ai\/analyses\?limit=/);
});

test('unsaved work in the editor, a workspace and the host and group forms: any other page asks first, once', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const asks = async () => {
    await expect(page.getByTestId('confirm-text')).toContainText('not saved');
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-text')).toBeHidden();
  };
  await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: "rm -rf ~/unsaved && mkdir -p ~/unsaved && printf 'one\\n' > ~/unsaved/u.txt" }) }), sshd);

  // The editor: the rail, another file's route, and its own Back (one question, then gone).
  const file = `/#/edit/${sshd}?p=${encodeURIComponent('/home/tester/unsaved/u.txt')}`;
  await page.goto(file);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('two');
  await expect(page.getByTestId('dirty')).toBeVisible();
  await page.getByRole('link', { name: 'Hosts' }).click();
  await asks();
  await page.evaluate((id) => (location.hash = `/edit/${id}?p=${encodeURIComponent('/home/tester/unsaved/other.txt')}`), sshd);
  await asks();
  await expect(page.locator('.cm-content')).toContainText('two');
  expect(page.url()).toContain(encodeURIComponent('/home/tester/unsaved/u.txt'));
  await page.getByRole('button', { name: 'Back', exact: true }).first().click();
  await expect(page.getByTestId('confirm-text')).toContainText('not saved');
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await expect(page.getByTestId('confirm-text')).toBeHidden();

  // A workspace: its terminal button and the browser's history.
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester`);
  await page.getByRole('button', { name: 'Menu for unsaved', exact: true }).click();
  await page.getByTestId('open-workspace').click();
  await page.getByTestId('tree-node').filter({ hasText: 'u.txt' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('three');
  await expect(page.getByTestId('ws-tabbar-item').getByTestId('dirty')).toBeVisible();
  await page.goBack();
  await asks();
  await expect(page.locator('.cm-content')).toContainText('three');
  await page.goBack();
  await page.getByTestId('confirm-ok').click();
  await expect(page).toHaveURL(/#\/files\/1/);

  // A host's form and a new group: changed fields ask; back as they were, nothing to ask.
  await page.goto(`/#/hosts/${sshd}/edit`);
  const hostName = page.locator('form[data-unsaved] input').first();
  await expect(hostName).not.toHaveValue('');
  await expect(page.getByTestId('confirm-text')).toBeHidden();
  const was = await hostName.inputValue();
  await hostName.fill(`${was}x`);
  await page.getByRole('link', { name: 'Hosts' }).click();
  await asks();
  await expect(hostName).toHaveValue(`${was}x`);
  await hostName.fill(was);
  await page.getByRole('link', { name: 'Hosts' }).click();
  await expect(page).toHaveURL(/#\/hosts$/);
  await page.goto('/#/groups/new');
  await page.locator('form[data-unsaved] input[name=name]').fill('Draft group');
  await page.getByRole('link', { name: 'Hosts' }).click();
  await asks();
  await page.getByRole('link', { name: 'Hosts' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page).toHaveURL(/#\/hosts$/);
});

test('Settings: unsaved AI settings are not lost without a question', async ({ page }) => {
  await signIn(page);
  // A provider with its fields, whatever the specs before did (one of its own fields is changed below).
  await page.evaluate(
    (url) => fetch('/api/settings/ai', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url, model: 'fake-model' } }) }),
    process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1',
  );
  // Came from Hosts: Back after a refused page goes there, not to the page refused (AUDIT2 WEB-13).
  await page.goto('/#/hosts');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/#/settings/ai');
  const ai = page.locator('form[data-unsaved]').first();
  await expect(page.getByTestId('ai-unsaved')).toHaveCount(0);
  const field = ai.locator('input:not([type=password]):not([type=checkbox])').first();
  const was = await field.inputValue();
  await field.fill(`${was}x`);
  await expect(page.getByTestId('ai-unsaved')).toBeVisible();
  // Another page: asked; staying keeps the change.
  await page.getByRole('link', { name: 'Hosts' }).click();
  // The app's own question (not the browser's), and a button that says what it does.
  await expect(page.getByTestId('confirm-text')).toContainText('not saved');
  await expect(page.getByTestId('confirm-ok')).toHaveText('Leave without saving');
  await page.getByTestId('confirm-cancel').click();
  await expect(page).toHaveURL(/#\/settings\/ai$/);
  await expect(field).toHaveValue(`${was}x`);
  // Another part from the list beside it leaves this part's page too: asked as well.
  await page.getByTestId('settings-section').filter({ hasText: 'Appearance' }).click();
  await expect(page.getByTestId('confirm-text')).toContainText('not saved');
  await page.getByTestId('confirm-cancel').click();
  await expect(page).toHaveURL(/#\/settings\/ai$/);
  await expect(field).toHaveValue(`${was}x`);
  // Back as it was: nothing to ask.
  await field.fill(was);
  await expect(page.getByTestId('ai-unsaved')).toHaveCount(0);
  // The refused pages left no entries of their own: one Back is the page before.
  await page.goBack();
  await expect(page).toHaveURL(/#\/hosts$/);
});

test('a stack and a folder opened again show what was seen at once, then the fresh answer', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.goto('/#/containers');
  await page.getByTestId('stack-link').first().click();
  await expect(page.getByTestId('stack-service').first()).toBeVisible({ timeout: 20_000 });
  const stackUrl = page.url();
  // The second time the answer is slow: what was seen shows meanwhile, marked.
  await page.route('**/api/docker/*/stacks/*', async (r) => (await new Promise((w) => setTimeout(w, 3000)), r.fallback()));
  await page.getByRole('link', { name: 'Hosts' }).first().click();
  // Really left (the hash changes at once, the page a moment later).
  await expect(page.getByRole('heading', { name: 'Hosts', level: 1 })).toBeVisible();
  await page.goto(stackUrl);
  await expect(page.getByTestId('stack-stale')).toBeVisible();
  await expect(page.getByTestId('stack-service').first()).toBeVisible({ timeout: 1000 });
  await expect(page.getByTestId('stack-stale')).toHaveCount(0, { timeout: 15_000 });
  await page.unrouteAll();
  // A folder: its entries at once.
  await page.goto(`/#/files/${sshd}?p=%2Fetc`);
  await expect(page.getByTestId('file-row').first()).toBeVisible({ timeout: 20_000 });
  await page.route('**/api/files/*/list?*', async (r) => (await new Promise((w) => setTimeout(w, 3000)), r.fallback()));
  await page.getByRole('link', { name: 'Hosts' }).first().click();
  // Really left (the hash changes at once, the page a moment later).
  await expect(page.getByRole('heading', { name: 'Hosts', level: 1 })).toBeVisible();
  await page.goto(`/#/files/${sshd}?p=%2Fetc`);
  await expect(page.getByTestId('file-row').first()).toBeVisible({ timeout: 1000 });
  await page.unrouteAll();
});

test('a container opened again shows its last known state at once, then the fresh one', async ({ page }) => {
  // The containers' socket: through to Burrow at first, later answering
  // nothing, so what shows is what was seen. Routed before the page loads (a
  // route set halfway missed a socket now and then).
  let silent = false;
  await page.routeWebSocket('**/api/docker/ws', (ws) => {
    if (!silent) ws.connectToServer();
  });
  await signIn(page);
  await page.goto('/#/containers');
  const row = page.getByTestId('container-row').filter({ hasText: 'burrowtest-web' }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  silent = true;
  // The list itself, opened again: what was seen, and that it is refreshing.
  await page.getByRole('link', { name: 'Hosts' }).first().click();
  // Really left (the hash changes at once, the page a moment later).
  await expect(page.getByRole('heading', { name: 'Hosts', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: /Containers/ }).first().click();
  await expect(page.getByTestId('containers-stale')).toBeVisible();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('container-stale')).toBeVisible();
  // A running one says how long it is up (report eaa986's page: "up 9m"), another its state.
  await expect(page.locator('.info-toggle')).toContainText(/\bup \d|exited/, { timeout: 1000 });
});

test('a host that stops answering while its connection stays up is said to, not shown as current (OPS-W-04)', async ({ page }) => {
  await signIn(page);
  // The containers' socket: one snapshot of the real host, then nothing (a hung host sends nothing at all).
  await page.routeWebSocket('**/api/docker/ws', (ws) => {
    const server = ws.connectToServer();
    const seen = new Set<number>();
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { t: string; host?: { hostId: number } };
      if (msg.t !== 'host' || seen.has(msg.host!.hostId)) return;
      seen.add(msg.host!.hostId);
      ws.send(String(m));
    });
  });
  await page.clock.install();
  await page.goto('/#/containers');
  const row = page.getByTestId('container-row').filter({ hasText: 'burrowtest-web' }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.clock.fastForward(26_000);
  // Every host on the page went silent here (the stand-in passes one snapshot of each): one line each.
  const said = page.locator('.alert.warn').filter({ hasText: /has not answered for \d+ s/ });
  await expect(said.first()).toBeVisible();
  await lookAt(page, 'containers-silent');
});

test('the keyboard shortcuts: a part of Settings on a computer (report 5c1209), "?" anywhere; not on a phone', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/settings');
  await page.getByTestId('settings-section').filter({ hasText: 'Keyboard shortcuts' }).click();
  await expect(page).toHaveURL(/#\/settings\/shortcuts$/);
  const list = page.locator('.sections').getByTestId('shortcuts');
  await expect(list).toContainText('Ctrl+Shift+F');
  await expect(list).toContainText('Go to file');
  // "?" opens them in a dialog, from any page.
  await page.goto('/#/hosts');
  await page.locator('body').press('?');
  const dialog = page.getByRole('dialog').getByTestId('shortcuts');
  await expect(dialog).toContainText('Go to file');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // A phone has no keys to list.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings');
  await expect(page.getByTestId('settings-section').filter({ hasText: 'Appearance' })).toBeVisible();
  await expect(page.getByTestId('settings-section').filter({ hasText: 'Keyboard shortcuts' })).toHaveCount(0);
});

test('what an analysis used: its tokens and an estimated cost; the usage in Settings, prices set there', async ({ page }) => {
  // Reported (18efc8): show tokens and cost, as the ChatGPT and Claude apps do.
  await signIn(page);
  const call = <T,>(method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return (r.status === 204 ? null : await r.json()) as unknown;
    }, [method, url, body] as const) as Promise<T>;
  // The Docker host (another spec may have added it already).
  const dockerHost = process.env.DOCKER_HOST_SSHD ?? 'burrow-e2e-docker';
  const hosts = await call<{ id: number; address: string }[]>('GET', '/api/hosts');
  const id = hosts.find((h) => h.address === dockerHost)?.id ?? (await call<{ id: number }>('POST', '/api/hosts', { name: 'docker-real', address: dockerHost, username: 'tester', authMethod: 'password', password: 'burrow-test-password' })).id;
  const probe = await call<{ status: string; fingerprint?: string }>('POST', `/api/hosts/${id}/test`);
  if (probe.status === 'unknown_host_key') await call('POST', `/api/hosts/${id}/trust`, { fingerprint: probe.fingerprint });
  type Ai = { provider: string; ollama: { url: string; model: string }; anthropic: { model: string }; openai: { url: string; model: string }; timeoutMinutes: number; prices: { input: number | null; output: number | null; currency: string } };
  const before = await call<Ai>('GET', '/api/settings/ai');
  const llm = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
  const input = (a: Ai, prices: Ai['prices']) => ({ provider: a.provider, ollama: a.ollama, anthropic: { model: a.anthropic.model }, openai: { url: a.openai.url, model: a.openai.model }, timeoutMinutes: a.timeoutMinutes, prices });
  await call('PUT', '/api/settings/ai', input({ ...before, provider: 'openai', openai: { url: llm, model: 'fake-model' } }, { input: 3, output: 15, currency: 'USD' }));
  await page.goto(`/#/logs?t=${id}:burrowtest-web`);
  await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('analyze-open').click();
  const dialog = page.getByRole('dialog', { name: 'Analyse with AI' });
  await dialog.getByTestId('analyze-run').click();
  await expect(dialog.getByTestId('analysis')).toContainText('Likely cause', { timeout: 30_000 });
  // 1200 read, 80 written: 1200 x 3 + 80 x 15 per million = 0.0048.
  await expect(dialog.getByTestId('analysis-by')).toContainText('1,200 in, 80 out tokens | about 0.0048 USD');
  await page.keyboard.press('Escape');
  // Settings -> AI: the prices as saved, the use of this month; a price changed there is kept.
  await page.goto('/#/settings/ai');
  await expect(page.getByTestId('ai-price-in')).toHaveValue('3');
  await expect(page.getByTestId('ai-usage')).toContainText(/This month: [\d,]+ in, [\d,]+ out tokens \| about [\d.]+ USD/);
  await lookAt(page, 'desktop-ai-usage');
  await page.getByTestId('ai-price-in').fill('4');
  await page.getByTestId('ai-price-out').fill('16');
  await page.getByTestId('ai-currency').fill('EUR');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('AI settings saved.').first()).toBeVisible();
  expect((await call<Ai>('GET', '/api/settings/ai')).prices).toEqual({ input: 4, output: 16, currency: 'EUR' });
  // The use is said in that currency now.
  await expect(page.getByTestId('ai-usage')).toContainText('EUR');
  await call('PUT', '/api/settings/ai', input(before, before.prices));
});

test('Settings -> AI: a key is kept write-only and removed alone; off and on again keeps the provider; no models is said', async ({ page }) => {
  await signIn(page);
  const call = <T,>(method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return (r.status === 204 ? null : await r.json()) as unknown;
    }, [method, url, body] as const) as Promise<T>;
  type Ai = { provider: string; ollama: { url: string; model: string }; anthropic: { model: string; hasKey: boolean }; openai: { url: string; model: string; hasKey: boolean }; timeoutMinutes: number; prices: { input: number | null; output: number | null; currency: string } };
  const before = await call<Ai>('GET', '/api/settings/ai');
  const llm = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
  const input = (a: Ai) => ({ provider: a.provider, ollama: a.ollama, anthropic: { model: a.anthropic.model }, openai: { url: a.openai.url, model: a.openai.model }, timeoutMinutes: a.timeoutMinutes, prices: a.prices });
  await call('PUT', '/api/settings/ai', { ...input(before), provider: 'openai', openai: { url: llm, model: 'fake-model' } });
  await page.goto('/#/settings/ai');
  const provider = page.getByRole('combobox', { name: /^Provider/ });
  const save = page.getByRole('button', { name: 'Save' }).first();
  await expect(provider).toHaveValue('openai');

  // Off, then on again: the provider it had, not the first in the list.
  await page.getByTestId('ai-enabled').uncheck();
  await expect(provider).toHaveCount(0);
  await expect(page.getByTestId('ai-unsaved')).toBeVisible();
  await page.getByTestId('ai-enabled').check();
  await expect(provider).toHaveValue('openai');
  await expect(page.getByTestId('ai-unsaved')).toHaveCount(0);

  // Addresses go unmasked only when the admin says the server is on their own network, never by its name (A3-SRV-20).
  const local = page.getByTestId('ai-local');
  await expect(local).not.toBeChecked();
  await local.check();
  await save.click();
  await expect.poll(async () => (await call<Ai & { openai: { local: boolean } }>('GET', '/api/settings/ai')).openai.local).toBe(true);
  await page.reload();
  await expect(local).toBeChecked();
  await local.uncheck();
  await save.click();
  await expect.poll(async () => (await call<Ai & { openai: { local: boolean } }>('GET', '/api/settings/ai')).openai.local).toBe(false);
  await expect(page.getByTestId('ai-unsaved')).toHaveCount(0);

  // Claude: the key goes to Burrow and never comes back; the field says it is stored.
  const secret = `sk-ant-e2e-${Math.random().toString(36).slice(2, 10)}`;
  await provider.selectOption('anthropic');
  await page.getByLabel('API key').fill(secret);
  await page.getByLabel('Model').fill('claude-e2e-model');
  await save.click();
  await expect(page.getByText('AI settings saved.').first()).toBeVisible();
  const stored = await call<Ai>('GET', '/api/settings/ai');
  expect(stored).toMatchObject({ provider: 'anthropic', anthropic: { model: 'claude-e2e-model', hasKey: true } });
  expect(JSON.stringify(stored)).not.toContain(secret);
  await expect(page.getByLabel('API key')).toHaveValue('');
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', 'stored - leave empty to keep');
  await expect(page.getByTestId('ai-unsaved')).toHaveCount(0);

  // Removed: only the key; a change typed meanwhile stays a change here, not saved by the way.
  await page.getByLabel('Model').fill('claude-other');
  await page.getByRole('button', { name: 'Remove stored key' }).click();
  await expect(page.getByRole('button', { name: 'Remove stored key' })).toHaveCount(0);
  expect(await call<Ai>('GET', '/api/settings/ai')).toMatchObject({ provider: 'anthropic', anthropic: { model: 'claude-e2e-model', hasKey: false } });
  await expect(page.getByLabel('Model')).toHaveValue('claude-other');
  await expect(page.getByTestId('ai-unsaved')).toBeVisible();

  // An OpenAI-compatible server's optional key: the same.
  await provider.selectOption('openai');
  await page.getByLabel('API key (optional)').fill('sk-e2e-openai');
  await save.click();
  await expect.poll(async () => (await call<Ai>('GET', '/api/settings/ai')).openai.hasKey).toBe(true);
  await page.getByRole('button', { name: 'Remove stored key' }).click();
  await expect.poll(async () => (await call<Ai>('GET', '/api/settings/ai')).openai.hasKey).toBe(false);

  // Its models, as the server lists them: a list to pick from (for the address just typed, not saved first, W-FUNC-07).
  await page.getByLabel('Server URL').fill(llm);
  await page.getByRole('button', { name: 'Load available models' }).click();
  await expect(page.getByRole('combobox', { name: 'Model' })).toContainText('fake-model');
  await page.getByRole('combobox', { name: 'Model' }).selectOption('fake-model');
  await save.click();
  await expect.poll(async () => (await call<Ai>('GET', '/api/settings/ai')).openai).toMatchObject({ url: llm, model: 'fake-model' });
  // Another provider chosen: its own field again, not the last one's list.
  await provider.selectOption('anthropic');
  await expect(page.getByLabel('Model')).toHaveJSProperty('tagName', 'INPUT');
  await provider.selectOption('openai');

  // A server that lists no models: said, and the model stays a field to type in.
  await page.route('**/api/settings/ai/models', (r) => r.fulfill({ json: [] }));
  await page.getByRole('button', { name: 'Load available models' }).click();
  await expect(page.getByText('The provider reports no models.')).toBeVisible();
  await expect(page.getByLabel('Model')).toHaveJSProperty('tagName', 'INPUT');
  await page.unroute('**/api/settings/ai/models');

  await call('PUT', '/api/settings/ai', input(before));
});

test("Settings -> AI: Gemini with its own key, its models listed to pick from, the key kept write-only; said what Google's free tier does with what is sent", async ({ page }) => {
  await signIn(page);
  const call = <T,>(method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return (r.status === 204 ? null : await r.json()) as unknown;
    }, [method, url, body] as const) as Promise<T>;
  type Ai = { provider: string; ollama: { url: string; model: string }; anthropic: { model: string }; openai: { url: string; model: string }; gemini: { model: string; hasKey: boolean }; timeoutMinutes: number; prices: { input: number | null; output: number | null; currency: string } };
  const before = await call<Ai>('GET', '/api/settings/ai');
  const llm = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
  const input = (a: Ai) => ({ provider: a.provider, ollama: a.ollama, anthropic: { model: a.anthropic.model }, openai: { url: a.openai.url, model: a.openai.model }, timeoutMinutes: a.timeoutMinutes, prices: a.prices });
  await call('PUT', '/api/settings/ai', { ...input(before), provider: 'openai', openai: { url: llm, model: 'fake-model' } });
  await page.goto('/#/settings/ai');
  const provider = page.getByRole('combobox', { name: /^Provider/ });
  const save = page.getByRole('button', { name: 'Save' }).first();
  await provider.selectOption('gemini');
  // External, as Claude: what goes there, and what Google's free tier may do with it.
  await expect(page.getByText(/^Requests go to an external service/)).toBeVisible();
  await expect(page.getByTestId('ai-gemini-free')).toContainText("On Gemini's free tier Google may use what is sent to improve its products");
  // No model yet: said, nothing saved.
  await save.click();
  await expect(page.getByText('Choose a model first: without one the AI answers nothing.').first()).toBeVisible();
  expect((await call<Ai>('GET', '/api/settings/ai')).provider).toBe('openai');

  // The models of the key just typed, not saved first (the server's side, against a stand-in for Google, in ai-providers.test.ts).
  const secret = `AIza-e2e-${Math.random().toString(36).slice(2, 10)}`;
  await page.getByTestId('ai-gemini-key').fill(secret);
  let asked: unknown = null;
  await page.route('**/api/settings/ai/models', (r) => {
    asked = r.request().postDataJSON();
    return r.fulfill({ json: ['gemini-e2e-flash', 'gemini-e2e-pro'] });
  });
  await page.getByRole('button', { name: 'Load available models' }).click();
  const model = page.getByTestId('ai-gemini-model');
  await expect(model).toHaveJSProperty('tagName', 'SELECT');
  await expect(model).toHaveValue('gemini-e2e-flash');
  expect(asked).toEqual({ provider: 'gemini', apiKey: secret });
  await page.unroute('**/api/settings/ai/models');
  await model.selectOption('gemini-e2e-pro');
  await lookAt(page, 'desktop-ai-gemini');
  await save.click();
  await expect(page.getByText('AI settings saved.').first()).toBeVisible();
  const stored = await call<Ai>('GET', '/api/settings/ai');
  expect(stored).toMatchObject({ provider: 'gemini', gemini: { model: 'gemini-e2e-pro', hasKey: true } });
  expect(JSON.stringify(stored)).not.toContain(secret);
  await expect(page.getByTestId('ai-gemini-key')).toHaveValue('');
  await expect(page.getByTestId('ai-gemini-key')).toHaveAttribute('placeholder', 'stored - leave empty to keep');
  await expect(page.getByTestId('ai-unsaved')).toHaveCount(0);

  // Removed: the key only, the model kept.
  await page.getByTestId('ai-gemini-remove-key').click();
  await expect(page.getByTestId('ai-gemini-remove-key')).toHaveCount(0);
  expect(await call<Ai>('GET', '/api/settings/ai')).toMatchObject({ provider: 'gemini', gemini: { model: 'gemini-e2e-pro', hasKey: false } });

  await call('PUT', '/api/settings/ai', { ...input(before), gemini: { model: before.gemini.model, apiKey: '' } });
});

test("Settings -> System: what was only in the .env file, set here; the .env's value said under each field, a value set applies at once, cleared the .env's again", async ({ page }) => {
  await signIn(page);
  const call = (method: string, url: string, body?: unknown) =>
    page.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, body: (r.status === 204 ? null : await r.json()) as { id?: string; error?: string; env?: Record<string, string | number>; saved?: Record<string, unknown> } };
    }, [method, url, body] as const);
  const env = (await call('GET', '/api/settings/system')).body.env!;
  await page.goto('/#/settings/system');
  const form = page.getByTestId('system');
  // What a value here does, not where they once were (report 4b06b3: "These were only in the .env file" read wrong).
  await expect(page.getByText('These were only in the .env file')).toHaveCount(0);
  await expect(page.getByText("A value here goes before the .env file's, at once.")).toBeVisible();
  // Each field empty, the .env's value under it.
  await expect(page.getByTestId('system-max-sessions')).toHaveValue('');
  await expect(form.locator('label', { has: page.getByTestId('system-max-sessions') })).toContainText(`Empty: ${env.terminalMaxSessions}, from the .env file`);
  // A pattern that is not one: said, nothing saved.
  await page.getByTestId('system-update-exclude').fill('^(');
  await page.getByTestId('system-save').click();
  await expect(page.getByTestId('toasts')).toContainText('regular expression');
  // The terminal limit at what is open now: the next session is refused, without a restart.
  const host = await hostId(page, 'test-sshd');
  const opened = (await call('POST', '/api/terminal/sessions', { hostId: host, tmux: 'never' })).body.id!;
  const open = ((await call('GET', '/api/terminal/sessions')).body as unknown as unknown[]).length;
  await page.getByTestId('system-max-sessions').fill(String(open));
  await page.getByTestId('system-idle-minutes').fill('120');
  await page.getByTestId('system-status-interval').fill('120');
  await page.getByTestId('system-update-exclude').fill('^registry\\.lan/');
  await page.getByTestId('system-registries').fill('registry.lan:5000=http://10.0.0.5:5000');
  await page.getByTestId('system-apps-domain').fill('home.example');
  await expect(page.getByTestId('system-unsaved')).toBeVisible();
  await page.getByTestId('system-save').click();
  await expect(page.getByTestId('toasts')).toContainText('System settings saved.');
  await expect(page.getByTestId('system-unsaved')).toHaveCount(0);
  expect((await call('POST', '/api/terminal/sessions', { hostId: host, tmux: 'never' })).body.error).toBe('too_many_sessions');
  // Kept: read again, the values are there.
  await page.reload();
  await expect(page.getByTestId('system-registries')).toHaveValue('registry.lan:5000=http://10.0.0.5:5000');
  await expect(page.getByTestId('system-update-exclude')).toHaveValue('^registry\\.lan/');
  await lookAt(page, 'desktop-settings-system');
  // Emptied: the .env's values again, a session opens.
  for (const id of ['system-max-sessions', 'system-idle-minutes', 'system-status-interval', 'system-update-exclude', 'system-registries', 'system-apps-domain']) await page.getByTestId(id).fill('');
  await page.getByTestId('system-save').click();
  await expect(page.getByTestId('toasts')).toContainText('System settings saved.');
  expect(Object.values((await call('GET', '/api/settings/system')).body.saved!).every((v) => v === null)).toBe(true);
  const again = (await call('POST', '/api/terminal/sessions', { hostId: host, tmux: 'never' })).body.id;
  expect(again).toBeTruthy();
  for (const id of [opened, again]) await call('DELETE', `/api/terminal/sessions/${id}`);
});

test('Settings on a wide screen: the parts in a column beside the open one, the first open when none is chosen (report 774696)', async ({ page }) => {
  // Reported (117b14): on a computer the pages used only a narrow column at the left.
  await signIn(page);
  await page.setViewportSize({ width: 1528, height: 794 });
  // Nothing chosen (report 774696): the first part open beside the list, not the list alone in the middle.
  await page.goto('/#/settings');
  const nav = page.getByTestId('settings-sections');
  await expect(nav).toBeVisible();
  await expect(page.locator('h2#appearance')).toBeVisible();
  expect((await page.locator('h2#appearance').boundingBox())!.x).toBeGreaterThan((await nav.boundingBox())!.x + (await nav.boundingBox())!.width);
  // The rows of the settings' own list: a name and what is in it, in a card (report ab8f2a).
  await expect(nav.locator('[aria-current=page] .title')).toHaveText('Appearance');
  await expect(nav.locator('[aria-current=page] .sub')).toHaveText('Language, light or dark, accent colour');
  expect(await nav.evaluate((n) => n.classList.contains('list'))).toBe(true);
  // No list of pages of their own below the parts any more: All hosts and the shortcuts are parts too (report 5c1209).
  await expect(page.getByTestId('settings-pages')).toHaveCount(0);
  await nav.getByTestId('settings-section').filter({ hasText: 'About Burrow' }).click();
  await expect(page).toHaveURL(/#\/settings\/about$/);
  await expect(nav.locator('[aria-current=page] .title')).toHaveText('About Burrow');
  await expect(page.getByTestId('about')).toBeVisible();
  // What this release brought, in a few sentences (report 4c30b4).
  await expect(page.getByRole('heading', { name: /^New in \d+\.\d+\.\d+$/ })).toBeVisible();
  await expect(page.getByTestId('about-new')).not.toBeEmpty();
  // Beside each other: the open part to the right of the column.
  const navBox = (await nav.boundingBox())!;
  const partBox = (await page.getByTestId('about').boundingBox())!;
  expect(partBox.x).toBeGreaterThan(navBox.x + navBox.width);
  await lookAt(page, 'wide-settings-nav');
  // A tablet upright too, beside the rail (decision 27).
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(nav).toBeVisible();
  await expect(page.locator('nav.bottomnav')).toHaveClass(/compact/);
  expect((await page.getByTestId('about').boundingBox())!.x).toBeGreaterThan((await nav.boundingBox())!.x + (await nav.boundingBox())!.width);
  // A phone: the column goes, the part keeps the page, and Back leads to the list.
  await page.setViewportSize({ width: 700, height: 794 });
  await expect(nav).toBeHidden();
  await page.getByTestId('settings-back').click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(nav).toBeVisible();
  await expect(page.locator('h2#about')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('Settings on a laptop: one scroll bar, the page; the list beside the part stays in view only when it fits (report 9abc2b)', async ({ page }) => {
  await signIn(page);
  // The reporter's window: an admin's list (thirteen parts) is taller than it.
  await page.setViewportSize({ width: 1528, height: 794 });
  await page.goto('/#/settings/ai');
  const side = page.getByTestId('settings-side');
  const nav = page.getByTestId('settings-sections');
  await expect(nav.locator('[aria-current=page] .title')).toHaveText('AI');
  const look = () => side.evaluate((el) => ({ own: el.scrollHeight - el.clientHeight, overflow: getComputedStyle(el).overflowY, position: getComputedStyle(el).position, height: el.getBoundingClientRect().height }));
  const tall = await look();
  // No scroll of its own (it was cut at the window's height and scrolled inside).
  expect(tall.own).toBeLessThanOrEqual(1);
  expect(tall.overflow).toBe('visible');
  expect(tall.height).toBeGreaterThan(794);
  expect(tall.position).toBe('static');
  // The page's scroll reaches its last part.
  const last = nav.getByTestId('settings-section').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(0);
  // A window it fits in: it stays in view while a long part scrolls.
  await page.setViewportSize({ width: 1528, height: 1600 });
  await expect.poll(async () => (await look()).position).toBe('sticky');
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('Hosts on a wide screen: the parts side by side start level, with room under the search (report dc0352)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  // A workspace of its own, so the Workspaces part is there whatever ran before.
  await page.evaluate(async (id) => {
    await fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: 'mkdir -p ~/hosts-wide' }) });
  }, sshd);
  const ws = (await page.evaluate(async (id) => (await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, root: '/home/tester/hosts-wide' }) })).json(), sshd)) as { id: number };
  await page.setViewportSize({ width: 1912, height: 914 });
  await page.goto('/#/hosts');
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  // Each column's first part, and the first words in it (a heading, a group's name): level across the columns.
  const tops = await page.evaluate(() => {
    const cols = document.querySelector<HTMLElement>('.page > .cols')!;
    const parts = [...cols.children].filter((c) => c.getBoundingClientRect().height > 0) as HTMLElement[];
    const byCol = new Map<number, HTMLElement>();
    for (const p of parts) {
      const x = Math.round(p.getBoundingClientRect().left);
      if (!byCol.has(x)) byCol.set(x, p);
    }
    const first = (p: HTMLElement) => p.querySelector<HTMLElement>('h2, .group-head, .list');
    return [...byCol.values()].map((p) => ({ part: p.getBoundingClientRect().top, words: first(p)!.getBoundingClientRect().top, kind: first(p)!.tagName }));
  });
  expect(tops.length, 'two columns on this screen').toBe(2);
  expect(Math.abs(tops[0]!.part - tops[1]!.part)).toBeLessThanOrEqual(1);
  // A heading or a group's head first in each: at the same height (the report: 19 px apart).
  expect(Math.abs(tops[0]!.words - tops[1]!.words), JSON.stringify(tops)).toBeLessThanOrEqual(2);
  // Not against the search: room above the first words of each column.
  const search = (await page.getByRole('searchbox').first().boundingBox())!;
  for (const t of tops) expect(t.words - (search.y + search.height)).toBeGreaterThanOrEqual(16);
  await lookAt(page, 'hosts-wide-parts');
  await page.evaluate(async (id) => void (await fetch(`/api/workspaces/${id}`, { method: 'DELETE' })), ws.id);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('a group of choices answers the arrow keys: the next one chosen, one Tab stop for the group (AUDIT2 UX-02)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/reports');
  const reports = page.getByTestId('made-reports');
  const analyses = page.getByTestId('made-analyses');
  await expect(reports).toHaveAttribute('aria-checked', 'true');
  await expect(analyses).toHaveAttribute('tabindex', '-1');
  await reports.focus();
  await page.keyboard.press('ArrowRight');
  await expect(analyses).toHaveAttribute('aria-checked', 'true');
  await expect(analyses).toBeFocused();
  await expect(reports).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Home');
  await expect(reports).toHaveAttribute('aria-checked', 'true');
});

test('the key vault, snippets and recordings are parts of Settings; their old addresses lead there; back keeps the list where it was (reports 8f4db3, e34ebd, 78bf46, a55e25)', async ({ page }) => {
  await signIn(page);
  // A phone: a part on a page of its own with the way back, as every other part.
  await page.setViewportSize({ width: 390, height: 640 });
  for (const [old, heading] of [['/#/keys', 'Key vault'], ['/#/snippets', 'Snippets'], ['/#/recordings', 'Recordings']] as const) {
    await page.goto(old);
    await expect(page).toHaveURL(new RegExp(`#/settings/${old.slice(3)}$`));
    await expect(page.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
    await expect(page.getByTestId('settings-back')).toBeVisible();
  }
  // Down the list, into a part, and back: where it was, not at its top.
  await page.goto('/#/settings');
  await expect(page.getByTestId('settings-section').first()).toBeVisible();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const y = await page.evaluate(() => scrollY);
  expect(y).toBeGreaterThan(200);
  // One in sight at the bottom: a click on one above it scrolls up to it first (gate 40: Recordings
  // out of sight once the list had System).
  await page.getByTestId('settings-section').filter({ hasText: 'About Burrow' }).click();
  await expect(page).toHaveURL(/#\/settings\/about$/);
  await page.getByTestId('settings-back').click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y - 10);
  // A computer, its list taller than the window: a part chosen low in it leaves the list where it is.
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto('/#/settings/appearance');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const about = page.getByTestId('settings-section').filter({ hasText: 'About Burrow' });
  await expect(about).toBeInViewport();
  await about.click();
  await expect(page).toHaveURL(/#\/settings\/about$/);
  await expect(about).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('Containers -> Reports: switching to the analyses and back moves nothing, its two halves alike, beside its heading', async ({ page }) => {
  // Reported: the view jumped at each switch, and its switch did not line up.
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/reports');
  const reports = page.getByTestId('made-reports');
  const analyses = page.getByTestId('made-analyses');
  await expect(reports).toHaveAttribute('aria-checked', 'true');
  const box = async () => [await reports.boundingBox(), await analyses.boundingBox()].map((b) => [Math.round(b!.x), Math.round(b!.width)]);
  const before = await box();
  expect(before[0]![1]).toBe(before[1]![1]);
  await analyses.click();
  await expect(analyses).toHaveAttribute('aria-checked', 'true');
  // Read beforehand: no "Loading..." between.
  await expect(page.getByText('Loading...')).toHaveCount(0);
  expect(await box()).toEqual(before);
  await reports.click();
  expect(await box()).toEqual(before);
  // On the line of its heading.
  const head = (await page.getByRole('heading', { name: 'Made', exact: true }).boundingBox())!;
  const sw = (await reports.boundingBox())!;
  expect(Math.abs(head.y + head.height / 2 - (sw.y + sw.height / 2))).toBeLessThan(8);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('About: an older version found is not offered as an update, and a result without a code says only its state (UIA-21)', async ({ page }) => {
  await signIn(page);
  const sshd = (await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id));
  await page.route('**/api/system/update', (r) =>
    r.fulfill({
      json: {
        target: { hostId: sshd, hostName: 'test-sshd', dir: '/opt/burrow', container: 'burrow', service: 'burrow' },
        running: '2.0.2',
        mode: 'git',
        available: '1.2.0',
        behind: 0,
        subject: null,
        last: { state: 'done', at: new Date(Date.now() - 86_400_000).toISOString(), message: 'Updated' },
        problem: null,
      },
    }),
  );
  await page.goto('/#/settings/about');
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-older')).toHaveText('1.2.0 is older than this version');
  await expect(page.getByTestId('update-start')).toHaveText('Install 1.2.0 (older)');
  await expect(page.getByTestId('update-start')).not.toHaveClass(/primary/);
  await expect(page.getByTestId('update-state')).not.toContainText('Updated');
});

test('the audit log in words: what happened, not "auth.login"; who and from where without a stray separator; a filter (UIA-07, UIB-11)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/settings/audit');
  const entries = page.getByTestId('audit-entry');
  await expect(entries.first()).toBeVisible();
  await expect(entries.filter({ hasText: 'Signed in' }).first()).toBeVisible();
  await expect(page.locator('.page')).not.toContainText('auth.login');
  await expect(page.locator('.page')).not.toContainText(/\| -? ?\|/);
  await page.getByTestId('audit-filter').fill('terminal opened');
  await expect(entries.first()).toContainText('Terminal opened');
  await expect(entries.filter({ hasNotText: 'Terminal opened' })).toHaveCount(0);
});
