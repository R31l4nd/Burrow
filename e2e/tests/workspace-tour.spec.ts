import { generateKeyPairSync } from 'node:crypto';
import { expect, request, test, type Page } from './fixtures.js';
import { en, type MessageKey } from '../../web/src/lib/i18n/en.js';
import { nl } from '../../web/src/lib/i18n/nl.js';
import { lookAt, mainRoomy } from './checks.js';
import { SETTINGS_PARTS } from './pages.js';
import { signIn, stepUpAgain } from './passkey.js';
import { diskScreens, unrouteDisk } from './diskio-tour.js';

// A walk through every page and dialog, on a phone, a laptop, a tablet, in Dutch and
// dark, the way a person would look at it: a screenshot of each for review
// (test-results/tour/) and the checks of checks.ts on each.

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8190';
// Only these screens (a regex on "<size>-<screen>", e.g. "phone-nl-host"):
// for a quick look while changing one. The gate runs the whole tour.
const ONLY = process.env.TOUR_ONLY ? new RegExp(process.env.TOUR_ONLY) : null;

/** A phone, paired and with its direct-route key, as the Android app would do it. */
async function pairPhone(page: Page) {
  const { code } = await page.evaluate(async () => (await fetch('/api/account/devices/pair-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json());
  const phone = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const dk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  expect((await phone.post('/api/auth/pair', { data: { code, name: 'Test phone', publicKey: dk } })).ok()).toBe(true);
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const blob = Buffer.concat([str(Buffer.from('ecdsa-sha2-nistp256')), str(Buffer.from('nistp256')), str(point)]);
  expect((await phone.put('/api/account/devices/current/ssh-key', { data: { publicKey: `ecdsa-sha2-nistp256 ${blob.toString('base64')}` } })).ok()).toBe(true);
  await phone.dispose();
}

// Looks, it does not count code: see `cover` in fixtures.ts.
test.use({ cover: false });

/** The direct route, set up from Settings as an admin would. */
async function directRoute(page: Page) {
  // A retry of the pass pairs again: the phone of the try before goes first, so there is one of this name.
  await page.evaluate(async () => {
    for (const d of (await (await fetch('/api/account/devices')).json()) as { id: number; name: string }[]) if (d.name === 'Test phone') await fetch(`/api/account/devices/${d.id}`, { method: 'DELETE' });
  });
  await pairPhone(page);
  await page.goto('/#/settings/android');
  const direct = page.getByTestId('direct-route');
  await expect(direct).toContainText('Test phone');
  // This phone's row, by its name (other specs' phones may be listed).
  await direct.locator('.list-item', { hasText: 'Test phone' }).getByRole('button', { name: 'Choose hosts' }).click();
  const dialog = page.getByRole('dialog', { name: 'Direct route: Test phone' });
  await dialog.getByText('test-sshd', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(direct).toContainText('1 host without Burrow');
  // One place for the direct route: not also on the phone's row.
  await expect(page.locator('.list-item', { hasText: 'Test phone' }).getByRole('button', { name: 'Direct route' })).toHaveCount(0);
}

// Six passes over every screen, one test each so they run side by side
// (playwright.config.ts, project "look"). Long: it is the one place that
// looks at all of them, so a slip anywhere shows up here. What is made once
// (the paired phone, the sign-in and invite pages) is made by the phone pass.
const VARIANTS = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 800 }],
  // Dutch on a small phone too: longer words wrap where English does not.
  // As narrow as the outer screen of a OnePlus Open.
  ['phone-nl', { width: 343, height: 711 }],
  ['phone-dark', { width: 390, height: 844 }],
  // A tablet upright (an iPad, a large foldable open), in Dutch: its own
  // middle layout, and the longer words (A3-WEB-15).
  ['tablet-nl', { width: 820, height: 1180 }],
  // Dark on a computer, where the rail is (its "Your hosts" failed contrast
  // and no pass saw it, A3-WEB-04), in Dutch: the longer words beside it.
  ['desktop-dark-nl', { width: 1440, height: 900 }],
] as const;
/** The pass's language and theme, from its name. */
const langOf = (vp: string): 'en' | 'nl' => (vp.endsWith('-nl') ? 'nl' : 'en');
const darkOf = (vp: string) => vp.includes('-dark');
/** Wide enough for the rail and the computer's layout (app.css: 900 px). */
const wideOf = (size: { width: number }) => size.width >= 900;
/** How many rows the fields and buttons in a box take: their middles more than a few pixels apart (a 36 px field beside 44 px buttons is one row). */
const rowsOf = (p: Page, sel: string) =>
  p.locator(sel).evaluate((el) => {
    const ys = [...el.querySelectorAll('input, button')].filter((c) => (c as HTMLElement).checkVisibility()).map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; }).sort((a, b) => a - b);
    return ys.filter((y, i) => i === 0 || y - ys[i - 1]! > 12).length;
  });
for (const [vp, size] of VARIANTS) {
  test.describe(() => {
    // The Dutch passes in a Dutch browser: its own time pickers showed "08:00 AM" beside Burrow's 24 hours (UIA-22, UIB-18).
    if (langOf(vp) === 'nl') test.use({ locale: 'nl-NL', timezoneId: 'Europe/Amsterdam' });
    test(`every page and dialog, looked at: ${vp}`, async ({ page }) => tour(page, vp, size));
  });
}

async function tour(page: Page, vp: (typeof VARIANTS)[number][0], size: { width: number; height: number }) {
  const first = vp === 'phone';
  // Over 120 screens a pass: up to 8 minutes on a quiet machine, 13 on a busy one (passes ran out at 10 in a gate).
  test.setTimeout(1_200_000);
  // "Leave this page?" (something pressed left unsaved work) is answered yes: dismissed, a reload waited for ever (15 minutes in a gate).
  page.on('dialog', (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()));
  // Signed out: the sign-in page, and an invite link (made below).
  const outside = async (url: string, name: string, ready: (p: Page) => Promise<void>) => {
    const out = await page.context().browser()!.newContext({ baseURL: BASE });
    const p = await out.newPage();
    for (const [vp, size] of [
      ['phone', { width: 360, height: 780 }],
      ['desktop', { width: 1280, height: 800 }],
    ] as const) {
      await p.setViewportSize(size);
      await p.goto(url);
      await ready(p);
      await lookAt(p, `${vp}-${name}`, vp === 'phone' ? { passes: [] } : {});
    }
    await out.close();
  };
  if (first) await outside('/', 'login', (p) => expect(p.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible());
  // Signed in in English whatever the browser's language (a Dutch pass runs in a Dutch browser); the pass's own language after.
  await page.addInitScript(() => {
    if (!localStorage.getItem('burrow.locale')) localStorage.setItem('burrow.locale', 'en');
  });
  const key = await signIn(page);

  // The direct route, set up from Settings as an admin would (once).
  if (first) await directRoute(page);

  // What the screens need: a host's history, a compose file, a terminal,
  // an invite, and the ids of what the other tests made.
  await page.route('**/api/hosts/*/stats/history*', (route) =>
    route.fulfill({ json: Array.from({ length: 12 }, (_, i) => ({ at: new Date(Date.now() - (12 - i) * 300_000).toISOString(), cpu: 10 + i, memPercent: 40, load1: 0.5, diskPercent: 47, maxCelsius: 50 })) }),
  );
  // Backups that ran yesterday, for Settings -> Backups, the newest to download (report cb6da8: its button beside Back up now).
  await page.route('**/api/backup/status', (route) =>
    route.fulfill({ json: { status: { ok: true, at: new Date(Date.now() - 86_400_000).toISOString(), file: 'burrow-20260927-0300.tar.gz.enc', bytes: 48_213_004, count: 14, remote: true, error: null }, staleAfterMs: 172_800_000, download: { file: 'burrow-20260927-0300.tar.gz.enc', bytes: 48_213_004 } } }),
  );
  // Inspect asks to confirm it is you: shown by answering "step up first".
  await page.route('**/api/docker/*/containers/*/inspect', (route) => route.fulfill({ status: 403, json: { error: 'step_up_required' } }));
  const api = <T,>(method: string, url: string, body?: unknown) =>
    page.evaluate(
      async ([m, u, b]) => {
        const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
        if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
        return r.status === 204 ? null : r.json();
      },
      [method, url, body] as const,
    ) as Promise<T>;
  const hosts = await api<{ id: number; name: string }[]>('GET', '/api/hosts');
  const real = hosts.find((h) => h.name === 'docker-real');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!;
  // The workspace-editor test's ~/proj (other tests add workspaces of their own).
  const wss = (await api<{ id: number; root: string }[]>('GET', '/api/workspaces')).filter((w) => w.root.endsWith('/proj'));
  const groups = await api<{ id: number }[]>('GET', '/api/groups');
  const reports = await api<{ id: number }[]>('GET', '/api/reports');
  // A report with a fix to carry out (the reports test made one).
  let fixable: number | null = null;
  for (const r of reports) {
    const full = await api<{ containers: { fixes: (string | { command: string | null })[] }[] }>('GET', `/api/reports/${r.id}`);
    if (full.containers.some((c) => c.fixes.some((f) => typeof f !== 'string' && f.command))) {
      fixable = r.id;
      break;
    }
  }
  const apps = await api<{ id: number; name: string }[]>('GET', '/api/apps');
  const framed = apps.find((a) => a.name === 'Framed app');
  const ownTab = apps.find((a) => a.name === 'Own tab app');
  const term = await api<{ id: string }>('POST', '/api/terminal/sessions', { hostId: sshd.id, cols: 80, rows: 24 });
  // The AI dialog as a conversation (report 411dbe): two turns, when a model is set up (terminal-complete.spec's stand-in).
  for (const prompt of ['grootste mappen in /data', 'make it recursive']) await api('POST', '/api/ai/command', { hostId: sshd.id, prompt, sessionId: term.id }).catch(() => null);
  const invite = await api<{ url: string }>('POST', '/api/invites', { role: 'operator' });
  if (first) await outside(invite.url.slice(invite.url.indexOf('/#/')), 'invite', (p) => expect(p.locator('h1').first()).toBeVisible());
  // A compose file to open in the editor, as from a stack's page (with its
  // Deploy button): long enough lines to wrap on a phone.
  const COMPOSE = '/home/tester/tour/compose.yaml';
  const NGINX = '/home/tester/tour/nginx.conf';
  if (real) {
    const yaml = [
      'networks:',
      '  default:',
      '    ipam:',
      '      config:',
      '        - subnet: 172.30.0.0/16',
      'x-defaults: &defaults',
      '  stop_grace_period: 60s',
      '  logging:',
      '    driver: json-file',
      '    options:',
      '      max-size: 10m',
      '  dns:',
      '    - ${SERVER_IP:?SERVER_IP is not set}',
      'services:',
      '  web:',
      '    <<: *defaults',
      '    image: nginx:1.27 # the front door',
      '',
    ].join('\n');
    await api('POST', `/api/files/${real.id}/create`, { path: '/home/tester/tour', kind: 'dir' }).catch(() => {});
    // The passes run side by side: written by the first to get there, the same for all.
    await api('PUT', `/api/files/${real.id}/text`, { path: COMPOSE, content: yaml, baseHash: null }).catch(() => {});
    await api('PUT', `/api/files/${real.id}/text`, { path: NGINX, content: 'events {}\nhttp {\n  server { listen 80; }\n}\n', baseHash: null }).catch(() => {});
  }

  // Every screen: a page, or a dialog opened on one. `open` gets the
  // current language's words (T) to find its buttons by.
  type Screen = { name: string; url: string; noDialog?: boolean; ready?: (p: Page) => Promise<unknown>; open?: (p: Page, T: Tr) => Promise<unknown>; extra?: (p: Page, vp: string, size: { width: number; height: number }) => Promise<void> };
  const dlg = (p: Page) => expect(p.locator('dialog[open]').last()).toBeVisible();
  // A button that is not there fails in seconds, not at the tour's time limit.
  const click = (p: Page, name: string) => p.getByRole('button', { name, exact: true }).first().click({ timeout: 15_000 });
  const fromTopOrMenu = async (p: Page, T: Tr, name: string) => {
    if ((p.viewportSize()?.width ?? 1280) < 600) {
      await click(p, T('term.menu'));
      await p.locator('dialog[open]').getByRole('button', { name, exact: true }).click();
    } else await click(p, name);
  };
  const screens: Screen[] = [
    { name: 'hosts', url: '/#/hosts', extra: fabChecks },
    { name: 'host-sheet', url: '/#/hosts', open: (p, T) => click(p, T('hosts.menu', { name: 'test-sshd' })) },
    // The app's own "are you sure?" (over the host's menu; never answered here).
    {
      name: 'confirm',
      url: '/#/hosts',
      open: async (p, T) => (await click(p, T('hosts.menu', { name: 'test-sshd' })), await p.locator('dialog[open]').getByRole('button', { name: T('common.delete'), exact: true }).click(), expect(p.getByTestId('confirm-ok')).toBeVisible()),
    },
    // What the keys do: "?" anywhere, except while typing (then it is a "?").
    {
      name: 'shortcuts',
      url: '/#/hosts',
      open: async (p) => {
        await p.getByRole('searchbox').first().press('?');
        await expect(p.getByRole('searchbox').first()).toHaveValue('?');
        await expect(p.getByTestId('shortcuts')).toBeHidden();
        await p.getByRole('searchbox').first().fill('');
        await p.locator('h1').first().click();
        await p.keyboard.press('?');
        await expect(p.getByTestId('shortcuts')).toBeVisible();
      },
    },
    { name: 'session-options', url: '/#/hosts', open: async (p, T) => (await click(p, T('hosts.menu', { name: 'test-sshd' })), p.getByTestId('session-options').click()) },
    {
      name: 'history-manage',
      url: '/#/hosts',
      open: async (p, T) => {
        await click(p, T('hosts.menu', { name: 'test-sshd' }));
        await p.getByText(T('hosts.completion')).click();
        await p.getByTestId('history-manage').click();
        await expect(p.getByTestId('history-search')).toBeVisible();
      },
    },
    { name: 'host-new', url: '/#/hosts/new' },
    { name: 'host-edit', url: `/#/hosts/${sshd.id}/edit` },
    ...(groups[0] ? [{ name: 'group-edit', url: `/#/groups/${groups[0].id}/edit` }] : []),
    { name: 'group-new', url: '/#/groups/new' },
    { name: 'import', url: '/#/import' },
    { name: 'host-stats', url: `/#/hosts/${sshd.id}/stats`, ready: (p) => expect(p.getByTestId('stats-now')).toBeVisible({ timeout: 20_000 }) },
    { name: 'host-docker', url: `/#/hosts/${sshd.id}/docker`, ready: (p) => expect(p.getByTestId('res-list')).toBeVisible({ timeout: 20_000 }) },
    // Disks judged: one good, one to watch, one failing (growing since the oldest check kept).
    {
      name: 'host-stats-smart-judged',
      url: `/#/hosts/${sshd.id}/stats`,
      noDialog: true,
      ready: async (p: Page) => {
        const at = new Date().toISOString();
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const base = { model: 'WDC WD40EFRX', passed: true, celsius: 36, powerOnHours: 31000, reallocated: 0, pending: 0, percentUsed: null, mediaErrors: null, uncorrectable: 0, timeouts: 0, offlineUncorrectable: 0 };
        const disks = [
          { ...base, device: '/dev/sda', serial: 'A1', verdict: 'good', reasons: [] },
          { ...base, device: '/dev/sdb', serial: 'B1', reallocated: 8, verdict: 'watch', reasons: [{ code: 'attr', attr: 'reallocated', value: 8 }] },
          { ...base, device: '/dev/sdc', serial: 'C1', pending: 24, verdict: 'failing', reasons: [{ code: 'attr', attr: 'pending', value: 24, was: 2, since }] },
          // Behind a USB bridge smartctl does not know: why it is unknown, no "0 C" (seen on the live Burrow).
          { ...base, device: '/dev/sdd', serial: null, model: null, passed: null, celsius: null, powerOnHours: null, reallocated: null, pending: null, uncorrectable: null, timeouts: null, offlineUncorrectable: null, verdict: 'unknown', reasons: [], note: 'Unknown USB bridge [0x152d:0x0578 (0x214)]. Please specify device type with the -d option.' },
          // Read, but no health status and no word why (the live Burrow's /dev/sda): said so, not a bare UNKNOWN.
          { ...base, device: '/dev/sde', serial: null, model: null, passed: null, celsius: null, powerOnHours: null, reallocated: null, pending: null, uncorrectable: null, timeouts: null, offlineUncorrectable: null, verdict: 'unknown', reasons: [] },
        ];
        await p.route(/\/api\/hosts\/\d+\/smart$/, (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { hostId: sshd.id, checkedAt: at, state: 'ok', message: null, disks } }) : r.fallback()));
        await p.route(/\/api\/hosts\/\d+\/smart\/history$/, (r) => r.fulfill({ json: [{ hostId: sshd.id, checkedAt: since, state: 'ok', message: null, disks }, { hostId: sshd.id, checkedAt: at, state: 'ok', message: null, disks }] }));
        await p.reload();
        await expect(p.getByTestId('smart-verdict')).toHaveCount(5, { timeout: 20_000 });
      },
      open: async (p: Page, T: Tr) => {
        await expect(p.getByTestId('smart-verdict')).toHaveText([T('stats.verdict.good'), T('stats.verdict.watch'), T('stats.verdict.failing'), T('stats.verdict.unknown'), T('stats.verdict.unknown')]);
        await expect(p.getByTestId('smart-note')).toHaveText([T('stats.smartNote', { note: 'Unknown USB bridge [0x152d:0x0578 (0x214)]. Please specify device type with the -d option.' }), T('stats.smartNoStatus')]);
        await expect(p.getByTestId('smart-reasons').first()).toHaveText(T('stats.attr.reallocated', { n: 8 }));
        await expect(p.getByTestId('smart-reasons').last()).toContainText(T('stats.attr.pending', { n: 24 }));
        await expect(p.getByTestId('smart-trend')).toContainText('2');
      },
    },
    // Each disk's activity, and who reads and writes (report d4a9c0).
    ...diskScreens(sshd.id),
    { name: 'host-journal', url: `/#/hosts/${sshd.id}/journal`, ready: (p) => expect(p.getByTestId('journal-unit').first()).toBeVisible({ timeout: 20_000 }) },
    // A host without systemd: said so, plainly, with a way to its log files; not an empty list.
    {
      name: 'host-journal-no-systemd',
      url: `/#/hosts/${sshd.id}/journal`,
      noDialog: true,
      ready: async (p: Page) => {
        await p.route(/\/api\/hosts\/\d+\/journal\/units$/, (r) => r.fulfill({ status: 422, json: { error: 'no_systemd', message: 'This host has no systemd, so no journal to read.' } }));
        await p.reload();
        await expect(p.getByTestId('no-systemd')).toBeVisible({ timeout: 20_000 });
      },
      // How the host is, not a failure: no red, no Try again; its log files a tap away (UIA-14).
      open: async (p: Page, T: Tr) => {
        await expect(p.getByTestId('no-systemd')).toContainText(T('journal.noSystemd'));
        await expect(p.getByTestId('load-failed')).toHaveCount(0);
      },
      extra: async (p: Page) => {
        await p.getByTestId('no-systemd-logs').click();
        await expect(p).toHaveURL(/#\/files\/\d+\?p=(%2F|\/)var(%2F|\/)log/);
      },
    },
    // A host without smartctl: said once, with the line that installs it.
    {
      name: 'host-stats-no-smart',
      url: `/#/hosts/${sshd.id}/stats`,
      noDialog: true,
      ready: async (p: Page) => {
        await p.route(/\/api\/hosts\/\d+\/smart$/, (r) =>
          r.request().method() === 'GET' ? r.fulfill({ json: { hostId: sshd.id, checkedAt: new Date().toISOString(), state: 'none', message: 'smartctl is not installed (smartmontools).', disks: [] } }) : r.fallback(),
        );
        await p.reload();
        await expect(p.getByTestId('smart-state')).toBeVisible({ timeout: 20_000 });
      },
      open: async (p: Page) => {
        // Said once: not the host's own words again beside the app's.
        await expect(p.getByTestId('smart')).not.toContainText('smartctl is not installed (smartmontools)');
        await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await p.getByTestId('smart-copy').click();
        await expect.poll(() => p.evaluate(() => navigator.clipboard.readText())).toBe('sudo apt install smartmontools');
      },
    },
    { name: 'files-hosts', url: '/#/files' },
    { name: 'files', url: `/#/files/${sshd.id}?p=~` },
    { name: 'file-sheet', url: `/#/files/${sshd.id}?p=~`, open: (p, T) => click(p, T('files.menuFor', { name: 'proj' })) },
    { name: 'folder-sheet', url: `/#/files/${sshd.id}?p=~`, open: (p, T) => click(p, T('files.more')) },
    { name: 'files-search', url: `/#/files/${sshd.id}?p=~`, open: (p, T) => click(p, T('files.search')) },
    { name: 'files-new', url: `/#/files/${sshd.id}?p=~`, open: async (p, T) => (await click(p, T('files.more')), click(p, T('files.newFolder'))) },
    // A folder only root may read (report 4d30e6): refused with Open with sudo, sudo asking its password, then shown as root.
    { name: 'files-denied', url: `/#/files/${sshd.id}?p=%2Fsrv%2Fburrowtest-root`, ready: (p) => expect(p.getByTestId('files-open-as-root')).toBeVisible() },
    { name: 'files-sudo-ask', url: `/#/files/${sshd.id}?p=%2Fsrv%2Fburrowtest-root&sudo=1`, ready: (p) => expect(p.getByTestId('files-sudo-password')).toBeVisible() },
    {
      name: 'files-as-root',
      url: `/#/files/${sshd.id}?p=%2Fsrv%2Fburrowtest-root&sudo=1`,
      noDialog: true,
      ready: (p) => expect(p.getByTestId('files-sudo-password')).toBeVisible(),
      open: async (p) => {
        const form = p.getByTestId('files-sudo-password');
        await form.locator('input[type=password]').fill('burrow-test-password');
        await form.locator('button[type=submit]').click();
        await expect(p.getByTestId('files-as-root')).toBeVisible();
        await expect(p.getByTestId('file-row')).toHaveCount(3);
      },
    },
    { name: 'sessions', url: '/#/term' },
    { name: 'terminal', url: `/#/term/${term.id}`, ready: (p) => expect(p.locator('.xterm').first()).toBeVisible() },
    // On a phone the top bar keeps only the tabs and the menu: these two are in the menu there.
    { name: 'terminal-ai', url: `/#/term/${term.id}`, ready: (p) => expect(p.locator('.xterm').first()).toBeVisible(), open: (p, T) => fromTopOrMenu(p, T, T('ai.title')) },
    { name: 'terminal-snippets', url: `/#/term/${term.id}`, ready: (p) => expect(p.locator('.xterm').first()).toBeVisible(), open: (p, T) => fromTopOrMenu(p, T, T('term.snippets')) },
    { name: 'terminal-sessions', url: `/#/term/${term.id}`, ready: (p) => expect(p.locator('.xterm').first()).toBeVisible(), open: (p, T) => click(p, T('term.menu')) },
    { name: 'apps', url: '/#/apps' },
    { name: 'apps-manage', url: '/#/apps', noDialog: true, open: async (p, T) => (await click(p, T('apps.manage')), expect(p.getByTestId('apps-manage')).toBeVisible()) },
    { name: 'apps-add', url: '/#/apps', open: async (p, T) => (await click(p, T('apps.manage')), click(p, T('apps.add'))) },
    { name: 'apps-discover', url: '/#/apps', open: async (p, T) => (await click(p, T('apps.manage')), click(p, T('apps.discover'))) },
    ...(framed ? [{ name: 'app-frame', url: `/#/apps/${framed.id}`, ready: (p: Page) => expect(p.locator('iframe').first()).toBeVisible() }] : []),
    ...(ownTab ? [{ name: 'app-not-framed', url: `/#/apps/${ownTab.id}`, ready: (p: Page) => expect(p.getByTestId('app-not-framed')).toBeVisible() }] : []),
    // Every host read before it is looked at (a host still being read pushes the list down for a moment, UIB-04).
    { name: 'containers', url: '/#/containers', ready: async (p: Page) => (await expect(p.locator('h1').first()).toBeVisible(), await expect(p.getByTestId('host-pending')).toHaveCount(0, { timeout: 30_000 })) },
    { name: 'containers-select', url: '/#/containers', noDialog: true, open: (p, T) => click(p, T('containers.select')) },
    { name: 'updates-menu', url: '/#/containers', open: (p) => p.getByTestId('updates-menu').click() },
    { name: 'alerts', url: '/#/alerts' },
    { name: 'alert-rule', url: '/#/alerts', open: (p, T) => click(p, T('alerts.newRule')) },
    // An alert's menu: analyse, mute, delete (a stand-in alert: the alerts test cleared its own).
    {
      name: 'alert-menu',
      url: '/#/alerts',
      open: async (p: Page) => {
        await p.route(/\/api\/alerts$/, (r) =>
          r.request().method() !== 'GET'
            ? r.fallback()
            : r.fulfill({ json: [{ id: 9301, ruleId: null, ruleName: 'Crash watch', hostId: sshd.id, hostName: 'test-sshd', container: 'burrowtest-menu', title: 'Exited with code 1', detail: 'Error: listen EADDRINUSE :::8080', at: new Date().toISOString(), count: 1, read: true, pushed: 'yes' }] }),
        );
        await p.reload();
        await p.getByTestId('alert-menu').click();
      },
    },
    // A long container name, not read yet (as on a real host): the name is
    // cut short, its host and "New" pills stay whole.
    {
      name: 'alerts-long',
      url: '/#/alerts',
      ready: async (p: Page) => {
        await p.route(/\/api\/alerts$/, (r) =>
          r.request().method() !== 'GET'
            ? r.fallback()
            : r.fulfill({
                json: [
                  { id: 9001, ruleId: null, ruleName: 'Crashes and failures', hostId: sshd.id, hostName: 'Debian', container: 'homeassistant-zigbee2mqtt-bridge', title: 'exited with code 1', detail: 'ERROR lost connection to the coordinator', at: new Date().toISOString(), count: 3, read: false, pushed: 'yes' },
                ],
              }),
        );
        await p.reload();
        await expect(p.getByTestId('alert-new')).toBeVisible();
      },
    },
    // A log rule on a host with more containers than are followed: said on the rule (OPS-W-09). A stand-in.
    {
      name: 'alerts-partial',
      url: '/#/alerts',
      ready: async (p: Page) => {
        await p.route(/\/api\/alerts\/rules$/, (r) =>
          r.request().method() !== 'GET'
            ? r.fallback()
            : r.fulfill({ json: [{ id: 9201, name: 'Errors in the logs', kind: 'pattern', hostId: null, container: null, project: null, events: [], pattern: 'ERROR', threshold: null, windowMinutes: null, enabled: true, builtin: false, partial: [{ hostId: sshd.id, hostName: 'docker-host-in-the-garage', following: 60, total: 112 }] }] }),
        );
        await p.reload();
        await expect(p.getByTestId('rule').filter({ hasText: '60' })).toBeVisible();
      },
    },
    { name: 'reports', url: '/#/reports' },
    { name: 'report-schedule', url: '/#/reports', open: (p) => p.getByTestId('new-schedule').click() },
    { name: 'schedule-menu', url: '/#/reports', open: (p: Page) => p.getByTestId('schedule-menu').first().click() },
    // The AI's analyses beside the reports, and one of them read (the alerts test made some).
    { name: 'analyses', url: '/#/reports?view=analyses', noDialog: true, open: (p) => expect(p.getByTestId('analysis-row').first()).toBeVisible({ timeout: 10_000 }) },
    {
      name: 'analysis-view',
      url: '/#/reports?view=analyses',
      open: async (p) => {
        await p.getByTestId('analysis-row').first().click();
        await expect(p.getByTestId('analysis-text')).toBeVisible();
      },
    },
    ...(reports[0] ? [{ name: 'report', url: `/#/reports/${reports[0].id}` }] : []),
    // A report's fix, before it runs.
    ...(fixable ? [{ name: 'fix-run', url: `/#/reports/${fixable}`, open: (p: Page) => p.getByTestId('fix-open').first().click() }] : []),
    ...(wss[0]
      ? [
          { name: 'workspace', url: `/#/ws/${wss[0].id}`, ready: (p: Page) => expect(p.getByTestId('ws-tab-files')).toBeAttached() },
          { name: 'workspace-quick-open', url: `/#/ws/${wss[0].id}`, ready: (p: Page) => expect(p.getByTestId('ws-quick')).toBeVisible(), open: (p: Page) => p.getByTestId('ws-quick').click() },
          // A huge folder: the files found before the host's time ran out, said to be not all (live log 2026-10-19).
          {
            name: 'workspace-quick-open-partial',
            url: `/#/ws/${wss[0].id}`,
            ready: async (p: Page) => {
              await p.route('**/api/workspace/*/files?*', (r) => r.fulfill({ json: { files: ['media/films/a-very-long-film-title-of-the-collection (2019)/movie.mkv', 'media/series/show/season 1/episode 1.mkv', 'docker-compose.yml'], truncated: true, slow: true } }));
              await expect(p.getByTestId('ws-quick')).toBeVisible();
            },
            open: async (p: Page) => (await p.getByTestId('ws-quick').click(), await expect(p.getByTestId('quick-open-partial')).toBeVisible()),
          },
          {
            // Compare a file with another of the workspace (report 9d710d), from the tree's menu.
            name: 'workspace-compare',
            url: `/#/ws/${wss[0].id}`,
            ready: (p: Page) => expect(p.getByTestId('ws-quick')).toBeVisible(),
            open: async (p: Page) => {
              if (await p.getByTestId('ws-drawer').isVisible()) await p.getByTestId('ws-drawer').click();
              await p.getByTestId('tree-node').filter({ hasText: 'compose.yaml' }).click({ button: 'right' });
              await p.getByTestId('compare-open').click();
              await expect(p.getByTestId('compare-file').first()).toBeVisible();
            },
          },
        ]
      : []),
    ...(real
      ? [
          { name: 'container', url: `/#/containers/${real.id}/burrowtest-web`, ready: logLines, extra: containerChecks },
          { name: 'container-menu', url: `/#/containers/${real.id}/burrowtest-web`, ready: logLines, open: (p: Page) => p.getByTestId('log-options').click() },
          // Its details open: they scroll in their own part, the log keeps the rest (report 5d0b33).
          { name: 'container-info', url: `/#/containers/${real.id}/burrowtest-web`, ready: logLines, noDialog: true, open: async (p: Page) => (await p.getByTestId('container-info').click(), await expect(p.getByTestId('container-history')).toBeVisible()) },
          {
            // What Docker says about the container, once the person confirmed it is them.
            name: 'container-inspect',
            url: `/#/containers/${real.id}/burrowtest-web`,
            ready: logLines,
            open: async (p: Page, T: Tr) => {
              await p.route('**/api/docker/*/containers/*/inspect', (r) => r.fulfill({ json: { json: JSON.stringify([{ Id: 'abc123', Name: '/burrowtest-web', Config: { Image: 'alpine:3.22', Env: ['TZ=Europe/Amsterdam'] }, State: { Status: 'running' } }]) } }));
              await p.getByTestId('log-options').click();
              await click(p, T('containers.inspect'));
            },
          },
          {
            name: 'nginx-test',
            url: `/#/edit/${real.id}?p=${encodeURIComponent(NGINX)}`,
            ready: (p: Page) => expect(p.locator('.cm-line').first()).toBeVisible(),
            open: async (p: Page) => (await p.getByTestId('editor-menu').click(), p.getByTestId('nginx-test').click()),
          },
          {
            name: 'step-up',
            url: `/#/containers/${real.id}/burrowtest-web`,
            ready: logLines,
            open: async (p: Page, T: Tr) => (await p.getByTestId('log-options').click(), click(p, T('containers.inspect'))),
          },
          { name: 'stack', url: `/#/stacks/${real.id}/burrowtest`, ready: (p: Page) => expect(p.getByTestId('stack-service').first()).toBeVisible({ timeout: 20_000 }) },
          // An operation on the stack running, its output open (report 1d821b: the output's toggle
          // wrapped beside its chevron). A stand-in: the tour only looks, nothing runs on the host.
          {
            name: 'stack-op',
            url: `/#/stacks/${real.id}/burrowtest`,
            ready: async (p: Page) => {
              await p.route('**/api/docker/*/stacks/*/ops', (r) =>
                r.request().method() !== 'POST' ? r.fallback() : r.fulfill({ json: { id: 'tour-op', hostId: real.id, project: 'burrowtest', op: 'pull', startedAt: new Date().toISOString(), exitCode: null } }),
              );
              // Routed before the page loads: Playwright routes only the sockets of pages loaded after.
              await p.routeWebSocket(/\/api\/docker\/ops\/tour-op\/ws/, (ws) => ws.send(JSON.stringify({ t: 'output', d: TOUR_OP_OUTPUT })));
              await p.reload();
              await expect(p.getByTestId('stack-service').first()).toBeVisible({ timeout: 20_000 });
            },
            noDialog: true,
            open: async (p: Page, T: Tr) => {
              await click(p, T('stack.op.pull'));
              await expect(p.getByTestId('op-images')).toBeVisible();
              await p.getByTestId('op-log-toggle').click();
              await expect(p.getByTestId('op-output').locator('pre')).toContainText('Pulling fs layer');
            },
          },
          // The review when what runs differs from the files (W-FUNC-04). A stand-in for the check.
          {
            name: 'stack-review-drift',
            url: `/#/stacks/${real.id}/burrowtest`,
            ready: async (p: Page) => {
              await p.route('**/api/docker/*/stacks/*/check', (r) => r.fulfill({ json: { ok: true, output: '', digest: 'a'.repeat(64), recreate: [{ service: 'web', why: 'differs' }, { service: 'worker-with-a-long-service-name', why: 'missing' }] } }));
              // The stack's file as the review reads it: the docker host's real stack has its file on the machine, not on the test host.
              const yaml = 'services:\n  web:\n    image: alpine:3.22\n  worker-with-a-long-service-name:\n    image: alpine:3.22\n';
              await p.route('**/api/files/*/text?*compose.yaml*', (r) => r.fulfill({ json: { path: '/srv/burrowtest/compose.yaml', content: yaml, hash: 'b'.repeat(64), size: yaml.length, mtime: new Date().toISOString(), mode: 0o644, writable: true } }));
              await p.reload();
              await expect(p.getByTestId('stack-service').first()).toBeVisible({ timeout: 20_000 });
            },
            open: (p: Page) => p.getByTestId('review-deploy').click(),
          },
          // An update put back: how it ended (W-FUNC-10), and the version marked as rolled back (W-FUNC-03). Stand-ins.
          {
            name: 'stack-rolled-back',
            url: `/#/stacks/${real.id}/burrowtest`,
            ready: async (p: Page) => {
              await p.route('**/api/docker/updates', async (r) => {
                if (r.request().method() !== 'GET') return r.fallback();
                const o = (await (await r.fetch()).json()) as { checks: { hostId: number; status: string; remoteDigest: string | null; rolledBackAt?: string | null }[] };
                for (const c of o.checks) if (c.hostId === real.id) Object.assign(c, { status: 'update', remoteDigest: c.remoteDigest ?? `sha256:${'b'.repeat(64)}`, rolledBackAt: new Date(Date.now() - 3_600_000).toISOString() });
                return r.fulfill({ json: o });
              });
              await p.route('**/api/docker/*/stacks/*/ops', (r) =>
                r.request().method() !== 'POST' ? r.fallback() : r.fulfill({ json: { id: 'tour-back', hostId: real.id, project: 'burrowtest', op: 'update', startedAt: new Date().toISOString(), exitCode: null } }),
              );
              await p.routeWebSocket(/\/api\/docker\/ops\/tour-back\/ws/, (ws) => {
                ws.send(JSON.stringify({ t: 'output', d: 'Not well: web: exited (exit code 1). Putting the previous images back.\nThe previous images run again, and run well.\n' }));
                ws.send(JSON.stringify({ t: 'exit', code: 1, outcome: { kind: 'rolled_back', why: 'web: exited (exit code 1)' } }));
              });
              await p.reload();
              await expect(p.getByTestId('stack-service').first()).toBeVisible({ timeout: 20_000 });
            },
            noDialog: true,
            open: async (p: Page, T: Tr) => {
              await click(p, T('stack.op.restart'));
              await expect(p.getByTestId('op-status')).toContainText(T('ops.rolledBackOp', { op: T('ops.op.update'), why: 'web: exited (exit code 1)' }));
            },
          },
          { name: 'editor', url: `/#/edit/${real.id}?p=${encodeURIComponent(COMPOSE)}&stack=tour`, ready: (p: Page) => expect(p.locator('.cm-line').first()).toBeVisible(), extra: editorChecks },
          {
            name: 'editor-tools',
            url: `/#/edit/${real.id}?p=${encodeURIComponent(COMPOSE)}&stack=tour`,
            ready: (p: Page) => expect(p.locator('.cm-line').first()).toBeVisible(),
            open: (p: Page) => p.getByTestId('editor-menu').click(),
          },
          // Find (Ctrl+F): the app's own panel, at most two rows; CodeMirror's took half a phone's screen (report dccaf7).
          {
            name: 'editor-find',
            url: `/#/edit/${real.id}?p=${encodeURIComponent(COMPOSE)}&stack=tour`,
            ready: (p: Page) => expect(p.locator('.cm-line').first()).toBeVisible(),
            noDialog: true,
            open: async (p: Page) => {
              await p.locator('.cm-content').click();
              await p.keyboard.press('Control+f');
              await expect(p.locator('.cm-search')).toBeVisible();
              await expect(p.locator('.cm-search input[name=search]')).toBeFocused();
              // With a match chosen, its count as wide as it gets ("1 van 20"): with that the close button
              // fell to a row of its own on a 343 px phone, three rows under the keyboard (report 696298).
              await p.locator('.cm-search input[name=search]').pressSequentially('e');
              await p.locator('.cm-search input[name=search]').press('Enter');
              await expect(p.getByTestId('editor-find-count')).toHaveText(/^\d+ (of|van) \d\d+$/);
              // One row on a computer (report a4f865: CodeMirror's panel broke over two there too), two on a phone.
              const rows = wideOf(p.viewportSize()!) ? 1 : 2;
              expect(await rowsOf(p, '.cm-search'), `the find panel: ${rows} row(s) at most`).toBeLessThanOrEqual(rows);
            },
          },
          // With Replace asked for: one row more.
          {
            name: 'editor-find-replace',
            url: `/#/edit/${real.id}?p=${encodeURIComponent(COMPOSE)}&stack=tour`,
            ready: (p: Page) => expect(p.locator('.cm-line').first()).toBeVisible(),
            noDialog: true,
            open: async (p: Page) => {
              await p.locator('.cm-content').click();
              await p.keyboard.press('Control+f');
              await p.getByTestId('editor-find-replace').click();
              await expect(p.locator('.cm-search input[name=replace]')).toBeVisible();
              expect(await rowsOf(p, '.cm-search'), 'find and replace: one row more').toBeLessThanOrEqual(wideOf(p.viewportSize()!) ? 2 : 3);
            },
          },
          {
            name: 'editor-problems',
            url: `/#/edit/${real.id}?p=${encodeURIComponent(COMPOSE)}&stack=tour`,
            ready: (p: Page) => expect(p.locator('.cm-line').first()).toBeVisible(),
            open: async (p: Page) => (await p.getByTestId('editor-menu').click(), p.getByTestId('problems').click()),
          },
          {
            // Ask AI about the file (report 76bcda): with a model set up, the lines chosen and the question.
            name: 'file-ask',
            url: `/#/edit/${real.id}?p=${encodeURIComponent(COMPOSE)}&stack=tour`,
            ready: async (p: Page) => {
              await p.route('**/api/ai/analyze/options', (r) => r.fulfill({ json: { available: true, deep: true, prices: { input: null, output: null, currency: 'USD' }, model: 'ollama:gemma4:e2b' } }));
              await expect(p.locator('.cm-line').first()).toBeVisible();
            },
            open: async (p: Page, T: Tr) => {
              await p.locator('.cm-line').nth(1).click();
              await p.keyboard.press('Shift+ArrowDown');
              await p.getByTestId('editor-menu').click();
              await p.getByTestId('editor-ask-ai').click();
              await expect(p.getByTestId('file-ask-sends')).toContainText('ollama:gemma4:e2b');
              await p.getByTestId('file-ask-question').fill(T('fileAsk.placeholder'));
            },
          },
          { name: 'logs', url: `/#/logs?t=${real.id}:burrowtest-web,${real.id}:burrowtest-worker`, ready: logLines },
          {
            // On a phone the filters fold behind a button; on a laptop they are always there.
            name: 'logs-filters',
            url: `/#/logs?t=${real.id}:burrowtest-web,${real.id}:burrowtest-worker`,
            ready: logLines,
            noDialog: true,
            open: async (p: Page) => {
              const b = p.getByTestId('log-filters');
              if (await b.isVisible()) await b.click();
              await expect(p.locator('.filters .chip').first()).toBeVisible();
            },
          },
          {
            name: 'analyse',
            url: `/#/logs?t=${real.id}:burrowtest-web,${real.id}:burrowtest-worker`,
            ready: logLines,
            // Also the question for Claude or ChatGPT, masked, in a link.
            open: async (p: Page) => {
              await p.getByTestId('analyze-open').click();
              await expect(p.getByRole('link', { name: 'Claude' })).toHaveAttribute('href', /^https:\/\/claude\.ai\/new\?q=.+/, { timeout: 15_000 });
              await expect(p.getByRole('link', { name: 'ChatGPT' })).toHaveAttribute('href', /^https:\/\/chatgpt\.com\/\?q=.+/);
            },
          },
        ]
      : []),
    // Settings: an overview, and each part on a page of its own.
    { name: 'settings', url: '/#/settings', extra: sectionChecks },
    ...partsAt(size).map((id) => ({ name: `settings-${id}`, url: `/#/settings/${id}`, extra: async (p: Page, vp: string) => (await saveChecks(p, vp), id === 'terminal' ? await accentChecks(p, vp) : undefined) })),
    { name: 'channel-kind', url: '/#/settings/channels', open: (p: Page) => p.getByTestId('add-channel').click() },
    ...(['ntfy', 'email', 'discord', 'webhook'] as const).map((k) => ({ name: `channel-${k}`, url: '/#/settings/channels', open: async (p: Page) => (await p.getByTestId('add-channel').click(), p.getByTestId(`add-${k}`).click()) })),
    { name: 'password', url: '/#/settings/security', open: (p, T) => click(p, T('settings.setPassword')) },
    { name: 'totp', url: '/#/settings/security', open: (p, T) => click(p, T('settings.totpSetup')) },
    { name: 'direct-hosts', url: '/#/settings/android', open: (p, T) => click(p, T('android.chooseHosts')) },
    // A person's menu: their role, folders, single sign-on and remove (report e6fc13), for a stand-in signed in through a provider.
    {
      name: 'user-menu',
      url: '/#/settings/users',
      open: async (p: Page) => {
        const people = await api<{ id: number; username: string; role: string; sso: boolean }[]>('GET', '/api/users');
        await p.route('**/api/users', (r) => r.fulfill({ json: [...people.filter((u) => u.role === 'admin'), { ...people[0]!, id: 999998, username: 'oscar-on-tour', role: 'operator', sso: true }] }));
        await p.reload();
        await p.getByTestId('user').filter({ hasText: 'oscar-on-tour' }).getByTestId('user-menu').click();
      },
    },
    { name: 'channel-menu', url: '/#/settings/channels', open: (p: Page) => p.getByTestId('channel-menu').first().click() },
    { name: 'device-menu', url: '/#/settings/android', open: (p: Page) => p.getByTestId('device-menu').first().click() },
    // The folders an operator may open (A3-SRV-01): an operator of its own on the list (a stand-in), with folders on the test host.
    {
      name: 'file-access',
      url: '/#/settings/users',
      open: async (p: Page) => {
        const people = await api<{ id: number; username: string; role: string; sso: boolean }[]>('GET', '/api/users');
        await p.route('**/api/users', (r) => r.fulfill({ json: [...people.filter((u) => u.role === 'admin'), { ...people[0]!, id: 999999, username: 'olivia-on-tour-with-a-long-name', role: 'operator', sso: false }] }));
        await p.route('**/api/users/999999/file-access', (r) => r.fulfill({ json: [{ hostId: sshd.id, allow: ['/home/tester/tour', '/srv/media/a-folder-with-a-long-name-to-wrap'], deny: ['/srv/media/a-folder-with-a-long-name-to-wrap/private'] }] }));
        await p.reload();
        await p.getByTestId('user').filter({ hasText: 'olivia-on-tour' }).getByTestId('user-menu').click();
        await p.locator('dialog[open]').getByTestId('user-files').click();
        // The dialog opens on the first host by name, which other specs' hosts come before.
        await p.getByTestId('file-access-host').selectOption(String(sshd.id));
        await expect(p.getByTestId('file-access-allow')).toHaveValue(/home\/tester\/tour/);
      },
    },
    { name: 'pair-code', url: '/#/settings/android', noDialog: true, open: async (p, T) => (await click(p, T('android.makeCode')), expect(p.getByText(/[A-Z0-9]{4}-[A-Z0-9]{4}/).first()).toBeVisible()) },
    { name: 'audit', url: '/#/settings/audit' },
    // Burrow updating itself: what a check finds (the host side stood in for).
    {
      name: 'about-update',
      url: '/#/settings/about',
      noDialog: true,
      open: async (p: Page) => {
        await p.route('**/api/system/update', (r) =>
          r.fulfill({
            json: {
              target: { hostId: sshd.id, hostName: 'test-sshd', dir: '/opt/burrow', container: 'burrow', service: 'burrow' },
              running: '1.1.0',
              mode: 'git',
              available: '1.2.0',
              behind: 3,
              subject: 'feat: 1.2.0 - uptime, port forwarding, self-update',
              last: { state: 'done', at: new Date(Date.now() - 86_400_000).toISOString(), message: 'Updated' },
              problem: null,
            },
          }),
        );
        await p.getByTestId('update-check').click();
        await expect(p.getByTestId('update-state')).toBeVisible();
        await p.getByTestId('about').scrollIntoViewIfNeeded();
      },
    },
    // What admins are told about how Burrow runs (decision 12, OPS-W-02, W-FUNC-11), and what it does by itself (OPS-W-14). Stand-ins.
    {
      name: 'settings-hints',
      url: '/#/settings',
      noDialog: true,
      ready: async (p: Page) => {
        await p.route('**/api/system/hints', (r) => r.fulfill({ json: { trustProxy: { proxies: ['172.18.0.4'], current: '172.18.0.9', suggest: '172.18.0.0/16' }, diskFull: true, openReports: 3 } }));
        await p.reload();
        await expect(p.getByTestId('hint-trust-proxy')).toBeVisible();
      },
      open: (p: Page) => expect(p.getByTestId('reports-open-count')).toHaveText('3'),
    },
    {
      name: 'about-jobs',
      url: '/#/settings/about',
      noDialog: true,
      ready: async (p: Page) => {
        const at = new Date(Date.now() - 120_000).toISOString();
        await p.route('**/api/system/jobs', (r) =>
          r.fulfill({
            json: [
              { name: 'container-history', lastRunAt: at, ms: 2140, runs: 12, ok: false, lastError: 'nas-in-the-cupboard-with-a-long-name: ssh: connect ETIMEDOUT 192.168.1.40:22', lastErrorAt: at },
              { name: 'host-stats', lastRunAt: at, ms: 3390, runs: 12, ok: true, lastError: null, lastErrorAt: null },
              { name: 'housekeeping', lastRunAt: at, ms: 18, runs: 1, ok: true, lastError: null, lastErrorAt: null },
            ],
          }),
        );
        // Burrow's own warnings, kept across deploys (OPS-W-13): a long one, and an error.
        await p.route('**/api/system/log-events', (r) =>
          r.fulfill({
            json: [
              { kind: 'host-stats: nas-in-the-cupboard-with-a-long-name: ssh: connect ETIMEDOUT #.#.#.#:#', level: 'warn', count: 288, firstAt: new Date(Date.now() - 86_400_000).toISOString(), lastAt: at, example: 'host-stats: nas-in-the-cupboard-with-a-long-name: ssh: connect ETIMEDOUT 192.168.1.40:22' },
              { kind: 'unhandled error: SQLITE_FULL', level: 'error', count: 1, firstAt: at, lastAt: at, example: 'unhandled error: SQLITE_FULL: database or disk is full' },
              // More than fit: the newest five, the rest on a tap (report 5d1b13).
              ...[1, 2, 3, 4, 5, 6].map((n) => ({ kind: `alert: app-${n} exited with code 1`, level: 'warn', count: n, firstAt: at, lastAt: at, example: `alert: app-${n} exited with code 1` })),
            ],
          }),
        );
        await p.reload();
      },
      open: async (p: Page) => {
        await expect(p.getByTestId('about-jobs').locator('li')).toHaveCount(3);
        await expect(p.getByTestId('about-log-events').locator('li')).toHaveCount(5);
        await p.getByTestId('log-events-all').click();
        await expect(p.getByTestId('about-log-events').locator('li')).toHaveCount(8);
        await expect(p.getByTestId('log-events-all')).toHaveCount(0);
        await expect(p.getByTestId('about-log-events')).toContainText(/288 (times|keer)/);
      },
    },
    {
      name: 'bug-report',
      url: '/#/settings/report',
      open: async (p: Page) => (await p.getByTestId('bug-arm').click(), p.getByTestId('bug-button').click()),
      // The red button stays on until turned off: off again, out of the screens after this one.
      extra: async (p: Page) => (await p.getByRole('dialog', { name: /Report a problem|Probleem melden/ }).getByRole('button', { name: /^(Cancel|Annuleren)$/ }).click(), p.getByTestId('bug-disarm').click()),
    },
    { name: 'snippets', url: '/#/snippets' },
    // A long name: cut with "...", its scope pill whole beside it (A3-WEB-09).
    {
      name: 'snippets-long',
      url: '/#/snippets',
      noDialog: true,
      ready: async (p: Page) => {
        await p.route(/\/api\/snippets$/, (r) =>
          r.request().method() !== 'GET'
            ? r.fallback()
            : r.fulfill({ json: [{ id: 9101, name: 'Restart the whole media stack and clear the transcoding cache first', command: 'docker compose -f /opt/media/compose.yaml restart && rm -rf /opt/media/cache/transcodes/*', description: null, hostId: null, groupId: null, createdAt: new Date().toISOString() }] }),
        );
        await p.reload();
        await expect(p.getByTestId('snippet-row')).toHaveCount(1);
      },
      open: (p: Page) => expect(p.getByTestId('snippet-row').locator('.chip')).toBeVisible(),
    },
    { name: 'snippet-new', url: '/#/snippets', open: (p, T) => click(p, T('snippets.new')) },
    { name: 'snippet-menu', url: '/#/snippets', open: (p: Page) => p.getByTestId('snippet-menu').first().click() },
    { name: 'snippet-run', url: '/#/snippets', open: async (p: Page) => (await p.getByTestId('snippet-menu').first().click(), p.locator('dialog[open]').getByTestId('snippet-run').click()) },
    { name: 'snippet-adhoc', url: '/#/snippets?run=1', open: (p) => expect(p.getByTestId('adhoc-command')).toBeVisible() },
    { name: 'keys', url: '/#/keys' },
    { name: 'key-menu', url: '/#/keys', open: (p: Page) => p.getByTestId('key-menu').first().click() },
    { name: 'key-generate', url: '/#/keys', open: (p, T) => click(p, T('keys.generate')) },
    { name: 'key-import', url: '/#/keys', open: (p, T) => click(p, T('keys.importShort')) },
    { name: 'share', url: '/#/share' },
    // The busy pill on a page with tabs: clear of the title bar and the tabs.
    {
      name: 'busy-pill',
      url: '/#/alerts',
      noDialog: true,
      open: async (p: Page) => {
        await p.route('**/api/docker/activity', (r) => r.fulfill({ json: { ops: [], check: { done: 3, total: 12 } } }));
        await expect(p.getByTestId('transfers-pill')).toBeVisible({ timeout: 10_000 });
      },
    },
    // The busy pill and its list: a deploy and an update check going on.
    {
      name: 'busy',
      url: '/#/hosts',
      noDialog: true,
      open: async (p: Page) => {
        await p.route('**/api/docker/activity', (r) =>
          r.fulfill({ json: { ops: [{ id: 'x1', hostId: sshd.id, project: 'burrowtest', op: 'update', startedAt: new Date().toISOString(), exitCode: null }], check: { done: 3, total: 12 } } }),
        );
        await p.getByTestId('transfers-pill').click({ timeout: 10_000 });
        await expect(p.getByTestId('activity-op')).toBeVisible();
        await expect(p.getByTestId('check-progress')).toBeVisible();
      },
      // The running operation's line opens its stack.
      extra: async (p: Page) => {
        await p.getByTestId('activity-op').getByRole('button').first().click();
        await expect(p).toHaveURL(/#\/stacks\/\d+\/burrowtest/);
      },
    },
  ];

  await page.setViewportSize(size);
  // A confirmation lasts fifteen minutes; a pass can take longer on a busy machine (17 minutes in
  // the 2.24.0 gate: making a pairing code asked again): confirmed again after ten.
  await stepUpAgain(page, key);
  let steppedUp = Date.now();
  const lang = langOf(vp);
  await page.evaluate((l) => localStorage.setItem('burrow.locale', l), lang);
  await page.evaluate((dark) => localStorage.setItem('burrow.appearance', JSON.stringify({ mode: dark ? 'dark' : 'light', accent: 'green' })), darkOf(vp));
  const T = translate(lang);
  for (const s of screens) {
    const where = `${vp}-${s.name}`;
    if (ONLY && !ONLY.test(where)) continue;
    await test.step(where, async () => {
      const setUp = async () => {
        if (Date.now() - steppedUp > 10 * 60_000) {
          await stepUpAgain(page, key);
          steppedUp = Date.now();
        }
        await page.goto(s.url);
        await page.reload();
        await (s.ready ? s.ready(page) : expect(page.locator('h1').first()).toBeVisible());
        if (s.open) {
          await s.open(page, T);
          if (!s.noDialog) await dlg(page);
        }
      };
      await setUp();
      // Help tips: opened and closed once per screen, on the phone.
      // Every help tip opened on a phone and on a computer (where the rail is, report 6779f4).
      // axe in every pass but the small Dutch phone's (the other passes' screens, its words longer only).
      await lookAt(page, where, { tips: vp === 'phone' || vp === 'desktop', axe: vp !== 'phone-nl', passes: [] });
      await s.extra?.(page, vp, size);
      await page.unroute('**/api/docker/activity');
      await page.unroute('**/api/ai/analyze/options');
      await page.unroute('**/api/docker/*/stacks/*/ops');
      await page.unroute('**/api/system/update');
      await page.unroute('**/api/users');
      await page.unroute('**/api/users/999999/file-access');
      await page.unroute(/\/api\/alerts$/);
      await page.unroute(/\/api\/snippets$/);
      await page.unroute('**/api/workspace/*/files?*');
      await page.unroute('**/api/system/log-events');
      await page.unroute(/\/api\/hosts\/\d+\/smart$/);
      await unrouteDisk(page);
      await page.unroute('**/api/docker/*/containers/*/inspect');
      await page.route('**/api/docker/*/containers/*/inspect', (route) => route.fulfill({ status: 403, json: { error: 'step_up_required' } }));
    });
  }
  // The workspace on a phone: the tree in its drawer, then a file.
  if (vp === 'phone' && wss[0] && !ONLY) {
    await page.goto(`/#/ws/${wss[0].id}`);
    await page.reload();
    await page.getByTestId('ws-drawer').click();
    await lookAt(page, 'phone-workspace-drawer');
    await page.getByTestId('tree-node').filter({ hasText: 'compose.yaml' }).click();
    await expect(page.getByTestId('ws-tabbar-item').first()).toBeVisible();
    await lookAt(page, 'phone-workspace-file');
  }
  await api('DELETE', `/api/terminal/sessions/${term.id}`);
}

type Tr = (key: MessageKey, params?: Record<string, string | number>) => string;
/** The app's own words, so a test finds the same button in either language. */
function translate(lang: 'en' | 'nl'): Tr {
  const cat = lang === 'nl' ? nl : en;
  return (key, params = {}) =>
    cat[key]
      .replace(/\{(\w+):((?:[^|{}]|\{\w+\})*)\|((?:[^{}]|\{\w+\})*)\}/g, (_, k: string, one: string, other: string) => (Number(params[k]) === 1 ? one : other))
      .replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** A pull as compose prints it, part way: two images, their layers, a container (the stack-op screen). */
const TOUR_OP_OUTPUT = [
  '$ pull burrowtest',
  ' Image amir20/dozzle:latest Pulling',
  ' Image docker.io/technitium/dns-server:latest Pulling',
  ' d5aec63251bb Already exists 0B',
  ' 403304faf2f5 Pulling fs layer 0B',
  ' 268b3295b871 Downloading [=====>     ]  12.4MB/27.0MB',
  ' Image amir20/dozzle:latest Pulled',
  ' Container burrowtest-web-1 Recreate',
  '',
].join('\n');

const logLines = (p: Page) => expect(p.getByTestId('log-line').first()).toBeVisible({ timeout: 20_000 });

/** The add button sits in the title bar at every width: no round one floating over the list's row menus (UIA-06, decision 25). */
async function fabChecks(page: Page, vp: string) {
  await expect(page.locator('.fab'), `no floating add button (${vp})`).toHaveCount(0);
  await expect(page.locator('.topbar').getByTestId('hosts-add-top'), `the add button in the title bar (${vp})`).toBeVisible();
}

const SETTINGS = SETTINGS_PARTS;
/** The parts listed at this size: the keyboard shortcuts only where the app counts as a computer (no touch, 900 px up). */
const partsAt = (size: { width: number }) => SETTINGS.filter((id) => id !== 'shortcuts' || wideOf(size));

/**
 * The overview of Settings: every part listed, each opening its own page; on a phone that page has
 * Back to the list, from a tablet up the list stays beside it with the open part marked (report 774696).
 */
async function sectionChecks(page: Page, vp: string) {
  const rows = page.getByTestId('settings-section');
  const parts = partsAt(page.viewportSize()!);
  await expect(rows).toHaveCount(parts.length);
  const beside = (page.viewportSize()?.width ?? 0) >= 720;
  // Nothing chosen yet: on a wide screen the first part is open beside the list, not the list alone.
  if (beside) await expect(page.locator(`h2#${parts[0]}`), `the first part open (${vp})`).toBeVisible();
  for (let i = 0; i < parts.length; i++) {
    await rows.nth(i).click();
    await expect(page, `a part's own page (${vp})`).toHaveURL(new RegExp(`#/settings/${parts[i]}$`));
    await expect(page.locator(`h2#${parts[i]}`)).toBeVisible();
    if (beside) {
      await expect(rows.nth(i), `the open part marked (${vp})`).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('settings-back')).toHaveCount(0);
    } else {
      await page.getByTestId('settings-back').click();
      await expect(page).toHaveURL(/#\/settings$/);
    }
  }
}

/**
 * Settings saves a single choice at once. A Save button is only for fields
 * that belong together, and such a form tells when it holds changes and
 * asks before they are lost (data-unsaved: warnUnsaved in the page).
 */
async function saveChecks(page: Page, vp: string) {
  const save = langOf(vp) === 'nl' ? nl['common.save'] : en['common.save'];
  const bare = await page.evaluate(
    (word) =>
      [...document.querySelectorAll('form')]
        .filter((f) => !f.closest('dialog') && !f.hasAttribute('data-unsaved'))
        .filter((f) => [...f.querySelectorAll('button')].some((b) => b.textContent?.trim() === word))
        .map((f) => f.getAttribute('data-testid') ?? f.closest('.card, section')?.previousElementSibling?.textContent?.trim() ?? f.outerHTML.slice(0, 80)),
    save,
  );
  expect(bare, `forms in Settings with a Save button but no warning for unsaved changes (${vp})`).toEqual([]);
}

/**
 * The editor: one save button; foldable lines marked in a narrow gutter; and
 * with the phone's keyboard open (a shorter screen), the key bar there and
 * still half the screen for the text.
 */
async function editorChecks(page: Page, vp: string, size: { width: number; height: number }) {
  const saves = await page.locator('button:visible').evaluateAll((els) => els.filter((b) => /^(Save|Opslaan)$/.test(b.getAttribute('aria-label') ?? b.textContent!.trim())).length);
  expect(saves, `save buttons in the editor (${vp})`).toBe(1);
  const gutter = (await page.locator('.cm-gutters').boundingBox())!;
  expect(gutter.width / size.width, `gutter width share (${vp})`).toBeLessThan(wideOf(size) ? 0.06 : 0.14);
  await expect(page.locator('.cm-fold-chevron:visible').first(), `foldable lines marked (${vp})`).toBeVisible();
  if (wideOf(size)) return;
  await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) });
  await page.locator('.cm-content').click();
  await expect(page.getByTestId('editor-keys')).toBeVisible();
  await mainRoomy(page, `${vp}-editor-keyboard`, 0.5);
  // The keyboard closed (the back gesture leaves the focus): the bar goes too.
  await page.setViewportSize(size);
  await expect(page.getByTestId('editor-keys'), `key bar gone with the keyboard (${vp})`).toHaveCount(0);
}

/**
 * A field in use shows the chosen accent (not the browser's blue): its
 * border is the accent colour, for each accent.
 */
async function accentChecks(page: Page, vp: string) {
  if (vp !== 'desktop') return;
  const tints: string[] = [];
  for (const accent of ['green', 'blue', 'pink']) {
    await page.evaluate((a) => document.documentElement.setAttribute('data-accent', a), accent);
    const field = page.locator('.page input:not([type=checkbox]):not([type=radio]):visible').first();
    await field.focus();
    const [border, want] = await field.evaluate((e) => [getComputedStyle(e).borderTopColor, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()]);
    const rgb = await page.evaluate((c) => {
      const d = document.createElement('div');
      d.style.color = c;
      document.body.append(d);
      const out = getComputedStyle(d).color;
      d.remove();
      return out;
    }, want);
    expect(border, `focused field border in accent ${accent} (${vp})`).toBe(rgb);
    await field.blur();
    // Sliders, ticks and progress bars too (the text-size slider was the browser's blue).
    const off = await page.locator('input[type=range]:visible, input[type=checkbox]:visible, input[type=radio]:visible, progress:visible').evaluateAll(
      (els, want) => els.filter((e) => getComputedStyle(e).accentColor !== want).map((e) => e.outerHTML.slice(0, 60)),
      rgb,
    );
    expect(off, `controls not in accent ${accent} (${vp})`).toEqual([]);
    // The page's own colours lean to the accent too: ground, rail and borders (report 5d820e: they stayed green).
    tints.push(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('nav.bottomnav')!).backgroundColor, getComputedStyle(document.querySelector('.card, .list')!).borderTopColor].join(' ')));
  }
  expect(new Set(tints).size, `ground, rail and borders follow the accent (${vp}): ${tints.join(' / ')}`).toBe(3);
  await page.evaluate(() => document.documentElement.setAttribute('data-accent', 'green'));
}

/** A container's page is mostly its logs: its actions take no room of their own. */
async function containerChecks(page: Page, vp: string, size: { height: number }) {
  const top = (await page.getByTestId('log').first().boundingBox())!.y;
  expect(top, `logs start high on the container page (${vp})`).toBeLessThan(size.height * 0.3);
}
