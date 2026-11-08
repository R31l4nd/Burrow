import { expect, test, type Page } from './fixtures.js';
import { en, type MessageKey } from '../../web/src/lib/i18n/en.js';
import { diskScreens, unrouteDisk } from './diskio-tour.js';
import { hostNamed, signIn } from './passkey.js';

/** The app's English words, filled in as the app fills them. */
const T = (key: MessageKey, params: Record<string, string | number> = {}) =>
  en[key]
    .replace(/\{(\w+):((?:[^|{}]|\{\w+\})*)\|((?:[^{}]|\{\w+\})*)\}/g, (_, k: string, one: string, other: string) => (Number(params[k]) === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));

// Report d4a9c0: "I would like more statistics per HDD/SSD, for example
// which processes are writing right now: my hard disk keeps spinning." Each
// whole disk's reads, writes and busy time on the statistics page; opened,
// which processes read and write, measured on the host only while it is open.

const ACTIVITY = /\/api\/hosts\/\d+\/disks\/activity$/;

test("a disk's activity: its numbers, and who reads and writes, measured only while it is open (report d4a9c0)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  let asked = 0;
  page.on('request', (r) => void (ACTIVITY.test(r.url()) && asked++));
  await page.goto(`/#/hosts/${sshd}/stats`);
  // The test host's disks are this machine's (a container sees the kernel's /proc/diskstats and /sys/block).
  const disks = page.getByTestId('io-disk');
  await expect(disks.first()).toBeVisible({ timeout: 20_000 });
  await expect(disks.first()).toContainText(/write \d.* \| read \d.* \| busy [\d.]+%/);
  expect(asked).toBe(0);

  await disks.first().click();
  const dialog = page.locator('dialog[open][data-tour=disk-activity]');
  await expect(dialog.getByTestId('disk-now')).toBeVisible();
  await expect(dialog.getByTestId('disk-sampled')).toContainText(/Measured over [\d.]+ s/, { timeout: 20_000 });
  // The e2e host logs in with a key, no password stored, and its user needs one for sudo:
  // its own processes only, said with sudo's own words - not a list that looks complete.
  await expect(dialog.getByTestId('disk-as-user')).toContainText(/Only the SSH user's own processes: \d+ of \d+ could be read/);
  await expect(dialog.getByTestId('disk-as-user')).toContainText('sudo said: ');
  // Measured again while open.
  await expect.poll(() => asked, { timeout: 20_000 }).toBeGreaterThan(1);

  // Closed: nothing measured any more.
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  const closedAt = asked;
  await page.waitForTimeout(6000);
  expect(asked).toBe(closedAt);
});

test('a measurement that failed is said, with Try again; never an empty list as "nobody writes" (report d4a9c0)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.route(ACTIVITY, (r) => r.fulfill({ status: 502, json: { error: 'activity_unreadable', message: 'The host answered without the whole sample.' } }));
  await page.goto(`/#/hosts/${sshd}/stats`);
  await page.getByTestId('io-disk').first().click({ timeout: 20_000 });
  const dialog = page.locator('dialog[open][data-tour=disk-activity]');
  await expect(dialog.getByTestId('load-failed')).toContainText('Could not measure: The host answered without the whole sample.');
  await expect(dialog.getByTestId('disk-proc')).toHaveCount(0);
  await expect(dialog.getByTestId('disk-nobody')).toHaveCount(0);
  await page.unroute(ACTIVITY);
  await dialog.getByTestId('load-retry').click();
  await expect(dialog.getByTestId('disk-sampled')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId('load-failed')).toHaveCount(0);
});

test('who reads and writes, as root and as the SSH user only: each process with its container and files, the charts of the disk (report d4a9c0)', async ({ page }) => {
  // The tour's stand-ins for the host's answers (a busy hard disk, one asleep, an NVMe SSD; numbers that stay put), here with the code counted.
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  for (const screen of diskScreens(sshd).filter((x) => x.name !== 'host-stats-disks')) {
    await page.goto(screen.url);
    await screen.ready(page);
    await screen.open(page, T);
    await page.keyboard.press('Escape');
    await unrouteDisk(page);
  }
  // The root view in detail: a process with its container, its files on this disk and on others, and the ones not told.
  const d = page.locator('dialog[open][data-tour=disk-activity]');
  await page.goto(`/#/hosts/${sshd}/stats`);
  await diskScreens(sshd).find((x) => x.name === 'disk-activity')!.ready(page);
  await page.getByTestId('io-disk').filter({ hasText: 'sdb' }).click();
  const qb = d.getByTestId('disk-here').getByTestId('disk-proc').filter({ hasText: 'qbittorrent-nox' });
  await expect(qb).toContainText('qbittorrent');
  await expect(qb).toContainText('/downloads/incomplete/');
  await expect(qb).toContainText(T('disk.proc.more', { n: 3 }));
  // The containers' own bytes on this disk, from their cgroups (decision 6): qbittorrent's 7.9 MB/s, not the other's on nvme0n1.
  await expect(d.getByTestId('disk-containers')).toContainText('qbittorrent');
  await expect(d.getByTestId('disk-containers')).not.toContainText('immich');
  const ended = d.getByTestId('disk-elsewhere').getByTestId('disk-proc').filter({ hasText: T('disk.ended') });
  await expect(ended).toContainText(T('disk.proc.unread'));
  await expect(d.getByTestId('disk-elsewhere').getByTestId('disk-proc').filter({ hasText: 'jbd2' })).toContainText(T('disk.proc.noFiles'));
  await page.keyboard.press('Escape');
  await unrouteDisk(page);
});

/** SMART as the host might report it: every kind of reason, one disk getting worse since the oldest check kept. */
async function judged(p: Page, hostId: number, keptFails: boolean) {
  const at = new Date().toISOString();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const base = { model: 'WDC WD40EFRX', serial: 'S', passed: true, celsius: 36, powerOnHours: 31000, reallocated: 0, pending: 0, percentUsed: null, mediaErrors: null, uncorrectable: 0, timeouts: 0, offlineUncorrectable: 0 };
  const disks = [
    { ...base, device: '/dev/sda', passed: false, verdict: 'failing', reasons: [{ code: 'smart_failed' }] },
    { ...base, device: '/dev/nvme0', percentUsed: 104, mediaErrors: 2, verdict: 'failing', reasons: [{ code: 'critical_warning', value: 4 }, { code: 'worn_out', value: 104 }] },
    { ...base, device: '/dev/nvme1', percentUsed: 91, mediaErrors: 0, verdict: 'watch', reasons: [{ code: 'worn', value: 91 }] },
    { ...base, device: '/dev/sdb', timeouts: 3, verdict: 'watch', reasons: [{ code: 'attr', attr: 'timeouts', value: 3, was: 1, since }] },
    // An older report: no verdict of its own, SMART's word stands.
    { ...base, device: '/dev/sdc' },
  ];
  await p.route(/\/api\/hosts\/\d+\/smart$/, (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { hostId, checkedAt: at, state: 'ok', message: 'One disk could not be read: /dev/sdz', disks } }) : r.fallback()));
  await p.route(/\/api\/hosts\/\d+\/smart\/history$/, (r) => (keptFails ? r.fulfill({ status: 500, json: { error: 'internal', message: 'Disk full.' } }) : r.fulfill({ json: [{ hostId, checkedAt: since, state: 'ok', message: null, disks }] })));
}

test('SMART judged: each reason in words, a disk getting worse since the oldest check, earlier checks not read said; Check now asks the host itself', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.goto(`/#/hosts/${sshd}/stats`);
  await judged(page, sshd, true);
  await page.reload();
  const smart = page.getByTestId('smart');
  await expect(page.getByTestId('smart-verdict')).toHaveText([T('stats.verdict.failing'), T('stats.verdict.failing'), T('stats.verdict.watch'), T('stats.verdict.watch'), T('stats.verdict.good')], { timeout: 20_000 });
  const reasons = page.getByTestId('smart-reasons');
  await expect(reasons.nth(0)).toHaveText(T('stats.reason.smartFailed'));
  await expect(reasons.nth(1)).toHaveText(`${T('stats.reason.critical', { n: 4 })}${T('stats.reason.wornOut', { n: 104 })}`);
  await expect(reasons.nth(2)).toHaveText(T('stats.reason.worn', { n: 91 }));
  await expect(reasons.nth(3)).toContainText(`${T('stats.attr.timeouts', { n: 3 })}, more than the 1 on `);
  await expect(smart).toContainText('One disk could not be read: /dev/sdz');
  await expect(smart).toContainText(T('stats.keptFailed', { error: 'Disk full.' }));
  await expect(smart).toContainText(T('stats.worn', { n: 104 }));

  // Check now: the host's own answer replaces what was shown, and the kept checks are read again.
  await page.unroute(/\/api\/hosts\/\d+\/smart\/history$/);
  await page.route(/\/api\/hosts\/\d+\/smart\/history$/, (r) => r.fulfill({ json: [] }));
  const asked = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/hosts\/\d+\/smart$/.test(r.url()));
  await page.getByTestId('smart-check').click();
  await asked;
  await expect(page.getByTestId('smart-check')).toHaveText(T('stats.checkNow'), { timeout: 60_000 });
  // The test host has no disks of its own to read: said in the app's words, not the verdicts shown before.
  await expect(page.getByTestId('smart-verdict')).toHaveCount(0);
  await expect(page.getByTestId('smart-state')).toBeVisible();
  await expect(smart).not.toContainText(T('stats.keptFailed', { error: 'Disk full.' }));
  await page.unroute(/\/api\/hosts\/\d+\/smart$/);
  await page.unroute(/\/api\/hosts\/\d+\/smart\/history$/);
});

test("a host's charts: the value and time of the moment under the pointer, beside it, by time across a gap (report af0eec)", async ({ page }) => {
  await signIn(page);
  const host = await hostNamed(page, 'test-sshd');
  // Ten samples five minutes apart, then two hours without (the host was off), then one more.
  const start = Date.parse('2026-10-21T08:00:00Z');
  const at = [...Array.from({ length: 10 }, (_, i) => start + i * 300_000), start + 9 * 300_000 + 7_200_000];
  await page.route('**/api/hosts/*/stats/history*', (r) => r.fulfill({ json: at.map((t, i) => ({ at: new Date(t).toISOString(), cpu: i * 10, memPercent: 40 + i, load1: i / 10, diskPercent: 50, maxCelsius: null })) }));
  await page.setViewportSize({ width: 1912, height: 914 });
  await page.goto(`/#/hosts/${host}/stats`);
  const cpu = page.getByTestId('stats-chart').first();
  const svg = (await cpu.locator('svg').boundingBox())!;
  // A quarter in: by time that is among the first ten (the last is far right), not the third of eleven.
  const span = at[10]! - at[0]!;
  const x = svg.x + svg.width * 0.25;
  await page.mouse.move(x, svg.y + svg.height / 2);
  const tip = cpu.getByTestId('chart-tip');
  await expect(tip).toBeVisible();
  const nearest = at.reduce((b, t, i) => (Math.abs(t - (at[0]! + 0.25 * span)) < Math.abs(at[b]! - (at[0]! + 0.25 * span)) ? i : b), 0);
  await expect(tip).toContainText(`${(nearest * 10).toFixed(1)}`);
  // Next to the pointer, not at the far left of the chart.
  const box = (await tip.boundingBox())!;
  expect(Math.min(Math.abs(box.x - x), Math.abs(box.x + box.width - x))).toBeLessThan(40);
  // Every chart shows that moment; the pointer gone, so is the value.
  await expect(page.getByTestId('stats-chart').nth(1).getByTestId('chart-tip')).toContainText(`${40 + nearest}.0`);
  await page.mouse.move(svg.x + svg.width / 2, svg.y - 120);
  await expect(tip).toHaveCount(0);
  await page.unroute('**/api/hosts/*/stats/history*');
  await page.setViewportSize({ width: 1280, height: 720 });
});
