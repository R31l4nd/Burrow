import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { sayYes } from './confirm.js';
import { hostNamed, signIn } from './passkey.js';

const api = <T,>(page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;



// A problem report: armed in Settings, sent from the screen where it went
// wrong, with that screen captured and the context shown before sending.


/**
 * A point of the report's picture, as the picture itself has it (not what
 * the page did while taking it), beside the colour of `selector` on the
 * page: the bar or rail drawn there, or not (AUDIT2 TEST-22).
 */
async function pictureAt(page: Page, x: number, y: number, selector: string): Promise<{ got: number[]; want: number[] }> {
  return page.evaluate(
    async ([px, py, sel]) => {
      const img = document.querySelector<HTMLImageElement>('img[alt="The screen when you started the report"]')!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.min(c.width - 1, Math.floor(px * c.width)), Math.min(c.height - 1, Math.floor(py * c.height)), 1, 1).data;
      // The colour as the page has it, in whatever notation (oklch too), made rgb by painting it.
      const one = document.createElement('canvas').getContext('2d')!;
      one.fillStyle = getComputedStyle(document.querySelector(sel)!).backgroundColor;
      one.fillRect(0, 0, 1, 1);
      const want = [...one.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      return { got: [d[0]!, d[1]!, d[2]!], want };
    },
    [x, y, selector] as const,
  );
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 16);

test('report a problem from the screen where it happens', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/settings/report');
  await page.getByTestId('bug-arm').click();
  // Armed: the red button waits on every screen; off to the hosts.
  await page.goto('/#/hosts');
  // Taking the picture breaks none of the page's rules (W-FUNC-14: ten "base-uri" errors a report).
  const refused: string[] = [];
  page.on('console', (m) => m.type() === 'error' && /base-uri|Content Security Policy/i.test(m.text()) && refused.push(m.text()));
  await page.getByTestId('bug-button').click();
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(form).toBeVisible();
  expect(refused).toEqual([]);
  // The screen as it was, without the report's own button.
  const shot = form.getByRole('img', { name: 'The screen when you started the report' });
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
  // What goes along is there to read: the page, never a query.
  await form.getByText('Also sent: page, versions, device, recent errors').click();
  await expect(form.getByTestId('bug-context')).toContainText('"page": "/hosts"');
  await lookAt(page, 'desktop-bug-report');
  await form.getByTestId('bug-text').fill('The host list jumps when a host goes down.');
  await form.getByTestId('bug-send').click();
  await expect(page.getByText('Report saved. Thank you.')).toBeVisible();
  await expect(form).toBeHidden();
  // Sent: the button stays for the next report, until turned off.
  await expect(page.getByTestId('bug-button')).toBeVisible();

  // From a dialog: the page is behind it, so the dialog has its own button.
  await page.goto('/#/alerts');
  await page.getByTestId('new-rule').click();
  const rule = page.getByRole('dialog', { name: 'New rule' });
  await rule.getByTestId('dialog-bug-button').click();
  await expect(form).toBeVisible();
  await form.getByText('Also sent: page, versions, device, recent errors').click();
  await expect(form.getByTestId('bug-context')).toContainText('"dialog": "alert-rule"');
  await form.getByTestId('bug-text').fill('Host problems sit under Docker.');
  await form.getByTestId('bug-send').click();
  await expect(page.getByText('Report saved. Thank you.')).toBeVisible();
  await expect(rule.getByTestId('dialog-bug-button')).toBeVisible();
  await page.keyboard.press('Escape');

  // Kept on this device, a reload too; changed your mind: the x takes the button away, no form, and it stays away.
  await page.goto('/#/settings/report');
  await expect(page.getByTestId('bug-arm')).toHaveText('Stop reporting');
  await page.goto('/#/hosts');
  await page.reload();
  await expect(page.getByTestId('bug-button')).toBeVisible();
  await page.getByTestId('bug-disarm').click();
  await expect(page.getByTestId('bug-button')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByTestId('bug-button')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeHidden();
  // And from Settings too.
  await page.goto('/#/settings/about');
  // Which Burrow this is: the page and the server, the same version.
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  await expect(page.getByTestId('about')).toContainText(`Burrow ${version} | server ${version}`);
  // Not "the server runs X; this page is older" (its words, not "older" in what is new).
  await expect(page.getByTestId('about')).not.toContainText('this page is older');
  await page.goto('/#/settings/report');
  await page.getByTestId('bug-arm').click();
  await page.getByTestId('bug-arm').click();
  await expect(page.getByTestId('bug-button')).toHaveCount(0);
});

test('reports in a row on a computer: Ctrl+Enter sends, a picture pasted or dropped joins, the button and its keys said (user 2026-10-30)', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/settings/report');
  // The keys that report without the button, said where reporting is set up, and on the button.
  await expect(page.getByTestId('bug-key-hint')).toContainText('Ctrl+Shift+B reports the screen you are on');
  await page.getByTestId('bug-arm').click();
  await page.goto('/#/hosts');
  await expect(page.getByTestId('bug-button')).toHaveAttribute('title', 'Report a problem on this screen (Ctrl+Shift+B)');
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  const pictures = form.getByRole('img', { name: /^Picture \d$/ });
  // A 1x1 PNG, as a file in the page.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const withFile = (kind: 'paste' | 'drop') =>
    form.getByTestId('bug-text').evaluate((box, [k, b64]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], `${k}.png`, { type: 'image/png' }));
      box.dispatchEvent(k === 'paste' ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [kind, png] as const);
  for (const [i, text] of ['First of a row.', 'Second of a row.'].entries()) {
    await page.getByTestId('bug-button').click();
    await expect(form).toBeVisible();
    // A screenshot of your own pasted, another dropped: both join, text pasted stays text.
    await withFile('paste');
    await expect(pictures).toHaveCount(1);
    await withFile('drop');
    await expect(pictures).toHaveCount(2);
    await form.getByTestId('bug-text').fill(`${text} ${i}`);
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/bugreports') && r.method() === 'POST');
    await form.getByTestId('bug-text').press('Control+Enter');
    expect(((await sent).postDataJSON() as { attachments: string[] }).attachments).toHaveLength(2);
    await expect(form).toBeHidden();
    // The button still there for the next one.
    await expect(page.getByTestId('bug-button')).toBeVisible();
  }
  // Ctrl+Enter with nothing typed sends nothing.
  await page.getByTestId('bug-button').click();
  await form.getByTestId('bug-text').press('Control+Enter');
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('bug-button')).toBeVisible();
  await page.getByTestId('bug-disarm').click();
});

test('pictures added to a report: only pictures, 6 MB at most, three at most, one taken out again; sent with it', async ({ page }) => {
  await signIn(page);
  // A phone: its screenshot tall and narrow, beside square pictures (report 05a818).
  await page.setViewportSize({ width: 343, height: 711 });
  await page.goto('/#/settings/report');
  await page.getByTestId('bug-arm').click();
  await page.goto('/#/hosts');
  await page.getByTestId('bug-button').click();
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  const input = form.locator('input[type=file]');
  // A 1x1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const pic = (name: string) => ({ name, mimeType: 'image/png', buffer: png });
  await input.setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a picture') }]);
  await expect(page.getByText('Only PNG, JPEG or WebP pictures.')).toBeVisible();
  await input.setInputFiles([{ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(7 << 20) }]);
  await expect(page.getByText('huge.png is too large (6 MB at most).')).toBeVisible();
  await expect(form.getByRole('img', { name: /^Picture \d$/ })).toHaveCount(0);
  await input.setInputFiles([pic('a.png'), pic('b.png')]);
  await expect(form.getByRole('img', { name: /^Picture \d$/ })).toHaveCount(2);
  await form.getByRole('button', { name: 'Remove picture 1' }).click();
  await expect(form.getByRole('img', { name: /^Picture \d$/ })).toHaveCount(1);
  // The screen, the picture and Add a picture: one row of like tiles, one height on one line, the
  // screen as wide as the picture (report 05a818: a sliver of a phone's screen beside a square).
  const tiles = await Promise.all([form.getByTestId('bug-shot-zoom'), form.locator('.pic').first(), form.locator('label.add')].map(async (l) => (await l.boundingBox())!));
  for (const b of tiles) {
    expect(Math.abs(b.y - tiles[0]!.y)).toBeLessThan(2);
    expect(Math.abs(b.height - tiles[0]!.height)).toBeLessThan(2);
  }
  expect(Math.abs(tiles[0]!.width - tiles[1]!.width)).toBeLessThan(2);
  // Four more chosen: three in all, and no room for another.
  await input.setInputFiles([pic('c.png'), pic('d.png'), pic('e.png'), pic('f.png')]);
  await expect(form.getByRole('img', { name: /^Picture \d$/ })).toHaveCount(3);
  await expect(form.getByText('Add a picture')).toHaveCount(0);
  // Without the screenshot: only the three pictures go.
  await form.getByLabel('Send this screenshot along').uncheck();
  await expect(form.getByRole('img', { name: 'The screen when you started the report' })).toHaveCount(0);
  const text = `Three pictures ${Math.random().toString(36).slice(2, 8)}`;
  await form.getByTestId('bug-text').fill(text);
  await form.getByTestId('bug-send').click();
  await expect(page.getByText('Report saved. Thank you.')).toBeVisible();
  await page.goto('/#/settings/report');
  await expect(page.getByTestId('problem-row').filter({ hasText: text })).toContainText('3 pictures');
});

/** How many different colours a grid of points in `box` (fractions of the page) has in the report's picture. */
async function coloursIn(page: Page, box: { x: number; y: number; w: number; h: number }): Promise<number> {
  return page.evaluate(async (b) => {
    const img = document.querySelector<HTMLImageElement>('[data-testid=bug-shot]')!;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const seen = new Set<string>();
    for (let i = 1; i < 20; i++)
      for (let j = 1; j < 20; j++) {
        const d = g.getImageData(Math.floor((b.x + (b.w * i) / 20) * c.width), Math.floor((b.y + (b.h * j) / 20) * c.height), 1, 1).data;
        seen.add(`${d[0]},${d[1]},${d[2]}`);
      }
    return seen.size;
  }, box);
}

test("a report's picture covers what a file shows, unless the person ticks it (report 50a6f6: a whole .env readable)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "for i in $(seq 1 30); do echo \"API_KEY_$i='sk-not-a-real-key-$i-abcdefghijklmnopqrstuvwxyz'\"; done > ~/private.env" });
  await page.goto('/#/settings/report');
  if ((await page.getByTestId('bug-button').count()) === 0) await page.getByTestId('bug-arm').click();
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/home/tester/private.env')}`);
  await expect(page.locator('.cm-content')).toContainText('API_KEY_30');
  // Where the file's text is, as a part of the page.
  const box = await page.getByTestId('editor').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const b = document.body.getBoundingClientRect();
    // Below the words that say it was hidden (drawn near the top of the covered part).
    return { x: (r.left - b.left) / b.width, y: (r.top - b.top + 80) / b.height, w: r.width / b.width, h: Math.min(r.height - 80, 300) / b.height };
  });
  await page.getByTestId('bug-button').click();
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(form.getByTestId('bug-shot')).toBeVisible();
  // A small picture beside the others, larger on a tap and small again (report 04436d: shown whole it took the screen).
  const small = (await form.getByTestId('bug-shot').boundingBox())!.height;
  expect(small).toBeLessThanOrEqual(80);
  await form.getByTestId('bug-shot-zoom').click();
  await expect(form.getByTestId('bug-shot-zoom')).toHaveAttribute('aria-expanded', 'true');
  expect((await form.getByTestId('bug-shot').boundingBox())!.height).toBeGreaterThan(small * 2);
  await form.getByTestId('bug-shot-zoom').click();
  await expect(form.getByTestId('bug-shot-zoom')).toHaveAttribute('aria-expanded', 'false');
  // Covered: one colour where the keys were.
  await expect(form.getByTestId('bug-private')).not.toBeChecked();
  expect(await coloursIn(page, box)).toBeLessThanOrEqual(2);
  // Ticked: the screen as it was, the text in it.
  const covered = await form.getByTestId('bug-shot').getAttribute('src');
  await form.getByTestId('bug-private').check();
  await expect(form.getByTestId('bug-shot')).not.toHaveAttribute('src', covered!);
  expect(await coloursIn(page, box)).toBeGreaterThan(2);
  await lookAt(page, 'desktop-bug-report-private');
  // Its help says why the parts are covered.
  const help = form.locator('label.check:has([data-testid=bug-private]) + .helptip button');
  await help.click();
  await expect(form.getByRole('note')).toContainText('a file or a terminal can hold passwords and keys');
  await help.click();
  await expect(form.getByRole('note')).toHaveCount(0);
  // Not ticked again: what is sent is the covered picture.
  await form.getByTestId('bug-private').uncheck();
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/bugreports') && r.method() === 'POST');
  await form.getByTestId('bug-text').fill('The editor shows a key.');
  await form.getByTestId('bug-send').click();
  expect(((await sent).postDataJSON() as { screenshot: string }).screenshot).toBe(covered);
  await expect(page.getByText('Report saved. Thank you.')).toBeVisible();
});

test('on a long page the picture has the bottom bar at its bottom, not over the middle', async ({ page }) => {
  // Reported (050019): the phone's bottom nav halfway down a long Apps page.
  await page.setViewportSize({ width: 412, height: 600 });
  await signIn(page);
  await page.goto('/#/settings/report');
  if ((await page.getByTestId('bug-button').count()) === 0) await page.getByTestId('bug-arm').click();
  const app = (id: number) => ({ id, name: `App ${id}`, url: `https://${id}.example.lan`, group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null });
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: Array.from({ length: 30 }, (_, i) => app(9200 + i)) }) : r.fallback()));
  await page.goto('/#/apps');
  await expect(page.getByTestId('app-tile')).toHaveCount(30);
  // Where the bar is while the picture is taken, and after.
  await page.evaluate(() => {
    const w = window as unknown as { __nav: string[] };
    w.__nav = [];
    const nav = document.querySelector('.bottomnav')!;
    new MutationObserver(() => w.__nav.push(nav.getAttribute('style') ?? '')).observe(nav, { attributes: true, attributeFilter: ['style'] });
  });
  await page.getByTestId('bug-button').click();
  await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
  const nav = await page.evaluate(() => (window as unknown as { __nav: string[] }).__nav);
  expect(nav.some((s) => s.includes('position: absolute') && s.includes('bottom: 0'))).toBe(true);
  expect(nav.at(-1)).toBe('');
  // In the picture itself: the bar along its bottom edge.
  const bottom = await pictureAt(page, 0.01, 0.995, '.bottomnav');
  expect(near(bottom.got, bottom.want), JSON.stringify(bottom)).toBe(true);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.bottomnav')!).position)).toBe('fixed');
  await page.getByRole('dialog', { name: 'Report a problem' }).getByRole('button', { name: 'Cancel' }).click();
  await page.unroute('**/api/apps');
});

test('on a computer the rail at the left runs down the whole picture of a long page', async ({ page }) => {
  // Reported (117b14): in the picture the rail stopped halfway down.
  await page.setViewportSize({ width: 1280, height: 600 });
  await signIn(page);
  await page.goto('/#/settings/report');
  if ((await page.getByTestId('bug-button').count()) === 0) await page.getByTestId('bug-arm').click();
  const app = (id: number) => ({ id, name: `App ${id}`, url: `https://${id}.example.lan`, group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null });
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: Array.from({ length: 60 }, (_, i) => app(9400 + i)) }) : r.fallback()));
  await page.goto('/#/apps');
  await expect(page.getByTestId('app-tile')).toHaveCount(60);
  await page.evaluate(() => {
    const w = window as unknown as { __rail: string[] };
    w.__rail = [];
    const nav = document.querySelector('.bottomnav')!;
    new MutationObserver(() => w.__rail.push(nav.getAttribute('style') ?? '')).observe(nav, { attributes: true, attributeFilter: ['style'] });
  });
  await page.getByTestId('bug-button').click();
  await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
  const styles = await page.evaluate(() => (window as unknown as { __rail: string[] }).__rail);
  expect(styles.some((x) => x.includes('top: 0') && x.includes('bottom: 0'))).toBe(true);
  // In the picture itself: the rail at the top and at the very bottom.
  for (const y of [0.02, 0.98]) {
    const at = await pictureAt(page, 0.005, y, '.bottomnav');
    expect(near(at.got, at.want), `${y}: ${JSON.stringify(at)}`).toBe(true);
  }
  await page.getByRole('dialog', { name: 'Report a problem' }).getByRole('button', { name: 'Cancel' }).click();
  await page.unroute('**/api/apps');
});

test('a very long page: its picture drawn smaller, and the report taken', async ({ page }) => {
  // The picture of 900 tiles may take a minute: the test's own time covers that (AUDIT2 TEST-12).
  test.setTimeout(120_000);
  // Reported (8f41d4): from a host's long Docker page the report was refused
  // (400) three times; it went only without its picture.
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  await page.goto('/#/settings/report');
  if ((await page.getByTestId('bug-button').count()) === 0) await page.getByTestId('bug-arm').click();
  const app = (id: number) => ({ id, name: `App number ${id}`, url: `https://${id}.example.lan`, group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 1, certExpiresAt: null });
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: Array.from({ length: 900 }, (_, i) => app(9300 + i)) }) : r.fallback()));
  await page.goto('/#/apps');
  await expect(page.getByTestId('app-tile')).toHaveCount(900);
  expect(await page.evaluate(() => document.body.scrollHeight)).toBeGreaterThan(20_000);
  await page.getByTestId('bug-button').click();
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  const shot = form.getByRole('img', { name: 'The screen when you started the report' });
  await expect(shot).toBeVisible({ timeout: 60_000 });
  // Within what a canvas holds: no side over 16000 pixels.
  const size = await shot.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
  expect(Math.max(...size)).toBeLessThanOrEqual(16_000);
  expect(size[1]).toBeGreaterThan(5_000);
  await form.getByTestId('bug-text').fill('A very long page.');
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/bugreports') && r.request().method() === 'POST');
  await form.getByTestId('bug-send').click();
  expect((await sent).ok()).toBe(true);
  expect((await sent).request().postDataJSON().screenshot).toMatch(/^data:image\/(png|jpeg);base64,/);
  await expect(page.getByText('Report saved. Thank you.')).toBeVisible();
  await page.unroute('**/api/apps');
});

test('the picture shows what is ticked and typed', async ({ page }) => {
  // The picture is drawn from the page's markup; a ticked box lives only in
  // the element, and showed empty ("40 of 40 chosen" above empty boxes).
  await signIn(page);
  await page.goto('/#/settings/report');
  await page.getByTestId('bug-arm').click();
  await page.goto('/#/snippets?run=1');
  const box = page.getByRole('dialog').getByRole('checkbox').first();
  await box.check();
  const typed = page.getByTestId('adhoc-command');
  await typed.fill('uptime');
  // What the markup says while the picture is taken, and after.
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    const box = document.querySelector('dialog[open] input[type=checkbox]')!;
    new MutationObserver((ms) => ms.forEach((m) => w.__seen.push(`${m.attributeName}:${(m.target as Element).getAttribute(m.attributeName!)}`))).observe(box, { attributes: true, attributeFilter: ['checked'] });
  });
  await page.getByRole('dialog').getByTestId('dialog-bug-button').click();
  await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  // Written into the markup for the picture, taken out again after.
  expect(seen[0]).toBe('checked:');
  expect(seen.at(-1)).toBe('checked:null');
  expect(await box.isChecked()).toBe(true);
  await page.getByRole('dialog', { name: 'Report a problem' }).getByRole('button', { name: 'Cancel' }).click();
  // The run dialog holds what was typed, so leaving it asks first (A3-WEB-12).
  await page.goto('/#/settings/report');
  await expect(page.getByTestId('confirm-ok')).toHaveText('Leave without saving');
  await page.getByTestId('confirm-ok').click();

  // A chosen option too: a Dutch page showed "English" in its language box.
  await expect(page).toHaveURL(/#\/settings\/report/);
  if ((await page.getByTestId('bug-button').count()) === 0) await page.getByTestId('bug-arm').click();
  await page.goto('/#/settings/appearance');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('nl');
  await page.evaluate(() => {
    const w = window as unknown as { __opt: string[] };
    w.__opt = [];
    const nl = document.querySelector('option[value=nl]')!;
    new MutationObserver((ms) => ms.forEach((m) => w.__opt.push(`${(m.target as Element).getAttribute('selected')}`))).observe(nl, { attributes: true, attributeFilter: ['selected'] });
  });
  await page.getByTestId('bug-button').click();
  await expect(page.getByRole('dialog', { name: 'Probleem melden' })).toBeVisible();
  const opt = await page.evaluate(() => (window as unknown as { __opt: string[] }).__opt);
  expect(opt[0]).toBe('');
  expect(opt.at(-1)).toBe('null');
  await page.getByRole('dialog', { name: 'Probleem melden' }).getByRole('button', { name: 'Annuleren' }).click();
  await page.getByRole('combobox', { name: 'Taal' }).selectOption('en');
});

test('a picture of the screen that takes a while: said while it is made, kept out of the picture, gone when the form comes', async ({ page }) => {
  // On a phone's terminal page the picture took seconds, nothing on the screen meanwhile (gate 38).
  await signIn(page);
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true }).first()).toBeVisible();
  // The fonts the picture reads come slowly: the picture takes a while.
  await page.route('**/*.woff2', async (r) => (await new Promise((w) => setTimeout(w, 1500)), r.continue()));
  await page.keyboard.press('Control+Shift+B');
  const note = page.getByTestId('toasts').getByTestId('bug-capturing');
  await expect(note).toHaveText('Taking a picture of the screen for the report, a few seconds...');
  // Not in the picture: what the picture leaves out is marked so.
  await expect(note).toHaveAttribute('data-bug-ui');
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(note).toBeHidden();
  await expect(form.getByTestId('bug-shot')).toBeVisible();
  await page.unroute('**/*.woff2');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toBeHidden();
});

test('Ctrl+Shift+B on a terminal: the report at once, its input along, what was typed only when asked', async ({ page }) => {
  await signIn(page);
  const hosts = await page.evaluate(() => fetch('/api/hosts').then((r) => r.json() as Promise<{ id: number; name: string }[]>));
  const hostId = hosts.find((h) => h.name === 'test-sshd')!.id;
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.getByTestId('terminal').click();
  await page.keyboard.type('echo ab');
  // Not armed in Settings: the keys open the report straight away.
  await page.keyboard.press('Control+Shift+B');
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(form).toBeVisible();
  await expect(form.getByTestId('bug-typed')).not.toBeChecked();
  await form.getByTestId('bug-text').fill('Typed, then reported.');
  const without = page.waitForRequest((r) => r.url().endsWith('/api/bugreports') && r.method() === 'POST');
  await form.getByTestId('bug-send').click();
  const sent = (await without).postDataJSON() as { recording: { withText: boolean; entries: { e: string; text?: string; textLength?: number }[] } };
  expect(sent.recording.withText).toBe(false);
  expect(sent.recording.entries.some((x) => x.e === 'sent' && x.textLength === 1)).toBe(true);
  expect(JSON.stringify(sent.recording)).not.toContain('"text"');
  await expect(form).toBeHidden();
  // The shell did not get Ctrl+B (back a character in bash): "c" lands after "b".
  await page.getByTestId('terminal').click();
  await page.keyboard.type('c\n');
  await expect(page.locator('[data-testid=terminal] .xterm-rows > div', { hasText: /^abc[\s\u00a0]*$/ })).toHaveCount(1);

  // Ticked: what was typed goes along too.
  await page.keyboard.type('echo secret-ish');
  // Ticked, then the window closed by Escape: the next report starts unticked (AUDIT2 UI-23).
  await page.keyboard.press('Control+Shift+B');
  await expect(form).toBeVisible();
  await form.getByTestId('bug-typed').check();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await page.getByTestId('terminal').click();
  await page.keyboard.press('Control+Shift+B');
  await expect(form).toBeVisible();
  await expect(form.getByTestId('bug-typed')).not.toBeChecked();
  await form.getByTestId('bug-typed').check();
  await form.getByTestId('bug-text').fill('With the typing.');
  const withText = page.waitForRequest((r) => r.url().endsWith('/api/bugreports') && r.method() === 'POST');
  await form.getByTestId('bug-send').click();
  const sent2 = (await withText).postDataJSON() as { recording: { withText: boolean; entries: { e: string; text?: string }[] } };
  expect(sent2.recording.withText).toBe(true);
  expect(sent2.recording.entries.filter((x) => x.e === 'sent').map((x) => x.text).join('')).toContain('secret-ish');
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});

test('the admins read the reports in Burrow, download one, pass it on as a GitHub issue, delete it', async ({ page }) => {
  await signIn(page);
  const asked = await sayYes(page);
  // A report with a picture and a failed request, as sent from a phone.
  // A 1x1 PNG.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const sent = await api<{ id: string }>(page, 'POST', '/api/bugreports', {
    text: 'The stack page shows nothing\nafter an update.',
    screenshot: png,
    attachments: [],
    recording: null,
    context: {
      page: '/stacks/1/media',
      dialog: null,
      appVersion: '1.8.0',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) test',
      viewport: { width: 412, height: 915, dpr: 2.6 },
      terminal: null,
      locale: 'en',
      theme: 'light',
      android: true,
      androidApp: '1.8.0',
      online: true,
      errors: ['TypeError: info is null'],
      failedCalls: [{ method: 'GET', path: '/api/docker/1/stacks/media', status: 502, code: 'ssh_error', at: '2026-10-04T12:00:00Z' }],
    },
  });
  // Not left unread: the open ones counted on Settings and beside "Report a problem" (W-FUNC-11).
  const open = (await api<{ status: string }[]>(page, 'GET', '/api/bugreports')).filter((r) => r.status === 'open').length;
  await page.goto('/#/settings');
  await page.reload();
  await expect(page.getByTestId('reports-badge').first()).toHaveText(String(open));
  await expect(page.getByTestId('reports-open-count')).toHaveText(String(open));
  await page.goto('/#/settings/report');
  const row = page.getByTestId('problem-row').filter({ hasText: 'The stack page shows nothing' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('/stacks/1/media');
  await expect(row).toContainText('1 picture');
  await row.click();
  const dialog = page.getByRole('dialog', { name: 'Problem report' });
  await expect(dialog.getByTestId('problem-text')).toHaveText('The stack page shows nothing\nafter an update.');
  await expect(dialog).toContainText('GET /api/docker/1/stacks/media -> 502 ssh_error');
  // The picture itself, loaded.
  const pic = dialog.getByRole('img', { name: 'screenshot.png' });
  await expect.poll(() => pic.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // Small in the dialog; the whole picture in a tab of its own.
  const [picTab] = await Promise.all([page.context().waitForEvent('page'), dialog.getByTestId('problem-picture').click()]);
  await expect.poll(() => picTab.url()).toContain(`/api/bugreports/${sent.id}/pictures/screenshot.png`);
  await picTab.close();
  await lookAt(page, 'desktop-problem-report');
  // On a phone too (Dutch: the longest words).
  await page.setViewportSize({ width: 360, height: 780 });
  await lookAt(page, 'phone-problem-report');
  await page.setViewportSize({ width: 1280, height: 720 });
  // A build without a public repository (a fork with the placeholder) has no dead GitHub
  // link: the download instead, and said so (W-FUNC-15). The published build has the link.
  // As shared/src/bugreport.ts's projectPublished() tells it (the placeholder in parts, so no check finds it here).
  const published = !readFileSync(new URL('../../shared/src/bugreport.ts', import.meta.url), 'utf8').includes(['OWNER', 'burrow'].join('/'));
  if (!published) {
    await expect(dialog.getByTestId('problem-github')).toHaveCount(0);
    await expect(dialog.getByTestId('problem-private')).toContainText('no GitHub project to report to');
  } else {
  // The GitHub issue, filled in: the report's words and context, no picture.
  const href = (await dialog.getByTestId('problem-github').getAttribute('href'))!;
  const u = new URL(href);
  expect(u.pathname).toMatch(/\/burrow\/issues\/new$/i);
  expect(u.searchParams.get('title')).toBe('Problem: The stack page shows nothing');
  expect(u.searchParams.get('details')).toContain('/api/docker/1/stacks/media -> 502 ssh_error');
  expect(href).not.toContain('screenshot');
  expect(await dialog.getByTestId('problem-github').getAttribute('target')).toBe('_blank');
  // Opened in a new tab: GitHub itself is not reached from the test.
  await page.context().route('https://github.com/**', (r) => r.fulfill({ body: 'github stand-in' }));
  const [tab] = await Promise.all([page.context().waitForEvent('page'), dialog.getByTestId('problem-github').click()]);
  await expect.poll(() => tab.url()).toContain('/issues/new?template=bug_report.yml');
  await tab.close();
  }
  // The download: the folder as a .tar.gz.
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByTestId('problem-download').click()]);
  expect(download.suggestedFilename()).toBe(`burrow-problem-${sent.id}.tar.gz`);
  // Marked as solved: said so in it, and among the solved ones, not the open ones.
  await dialog.getByTestId('problem-close').click();
  await expect(page.getByText('Marked as solved.')).toBeVisible();
  await expect(dialog.getByTestId('problem-solved')).toContainText('Solved by admin');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('problems-open')).toHaveAttribute('aria-checked', 'true');
  await expect(row).toHaveCount(0);
  await page.getByTestId('problems-closed').click();
  await expect(row).toBeVisible();
  await expect(row).toContainText('| solved ');
  await lookAt(page, 'desktop-problems-solved');
  // Open | Solved split in the middle, at a phone's width, a foldable's and a computer's (reports 86756d, 4d0518:
  // each its words plus a share of the rest, "Open (2)" narrower than "Solved (195)").
  const was = page.viewportSize()!;
  const apart = async () => {
    const [a, b] = await Promise.all(['problems-open', 'problems-closed'].map((id) => page.getByTestId(id).evaluate((e) => e.getBoundingClientRect().width)));
    return Math.abs(a! - b!);
  };
  for (const width of [343, 698, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(apart, { message: `at ${width}` }).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize(was);
  // Open again: back among the open ones.
  await row.click();
  await dialog.getByTestId('problem-reopen').click();
  await expect(page.getByText('Open again.')).toBeVisible();
  await expect(dialog.getByTestId('problem-close')).toBeVisible();
  expect((await api<{ id: string; status: string }[]>(page, 'GET', '/api/bugreports')).find((r) => r.id === sent.id)?.status).toBe('open');
  // Deleted after a yes: gone from the list.
  await dialog.getByTestId('problem-delete').click();
  await expect(page.getByText('Problem report deleted.')).toBeVisible();
  expect((await asked()).join('\n')).toContain('Delete this problem report?');
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  expect((await api<{ id: string }[]>(page, 'GET', '/api/bugreports')).map((r) => r.id)).not.toContain(sent.id);
});

test('a folder of thousands of files on a phone: the picture is the part around the screen, the rows far off left out while it is taken (report 8344c1)', async ({ page }) => {
  // Reported (8344c1): reporting from a folder of 4000+ files crashed the app: the whole list, every
  // row with its styles, was copied into one picture of the page's full height.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/many && mkdir -p ~/many && cd ~/many && seq 1 4200 | xargs sh -c \'for i; do : > "file-$i.txt"; done\' sh' });
  await page.goto('/#/settings/report');
  if ((await page.getByTestId('bug-button').count()) === 0) await page.getByTestId('bug-arm').click();
  await page.goto(`/#/files/${sshd}?p=${encodeURIComponent('/home/tester/many')}`);
  await expect.poll(() => page.getByTestId('file-row').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4200);
  const all = await page.getByTestId('file-row').count();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(100_000);
  // Somewhere in the middle, as when looking for one file.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  // How many rows were left in while the picture was taken.
  await page.evaluate(() => {
    const w = window as unknown as { __rows: number };
    w.__rows = Infinity;
    new MutationObserver(() => (w.__rows = Math.min(w.__rows, [...document.querySelectorAll('[data-testid=file-row]')].filter((r) => (r as HTMLElement).style.display !== 'none').length))).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style'] });
  });
  await page.getByTestId('bug-button').click();
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  const shot = form.getByRole('img', { name: 'The screen when you started the report' });
  await expect(shot).toBeVisible({ timeout: 60_000 });
  const rows = await page.evaluate(() => (window as unknown as { __rows: number }).__rows);
  expect(rows).toBeGreaterThan(5);
  expect(rows).toBeLessThan(400);
  // A picture of the part around the screen, not of 4200 rows.
  const size = await shot.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
  expect(size[1]).toBeGreaterThanOrEqual(711);
  expect(size[1]).toBeLessThanOrEqual(8000 * 2);
  expect(size[1]! / size[0]!).toBeLessThan(30);
  // The bottom bar along the bottom of the part drawn, the file list above it (not the page's empty start).
  const bottom = await pictureAt(page, 0.01, 0.995, '.bottomnav');
  expect(near(bottom.got, bottom.want), JSON.stringify(bottom)).toBe(true);
  // Kept for a look: the part around the screen, the bars at its edges.
  const pic = await shot.evaluate((i: HTMLImageElement) => i.src);
  writeFileSync(test.info().outputPath('picture.png'), Buffer.from(pic.split(',')[1]!, 'base64'));
  // Every row back as it was.
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid=file-row]')].filter((r) => r.style.display === 'none').length)).toBe(0);
  await expect(page.getByTestId('file-row')).toHaveCount(all);
  await form.getByTestId('bug-text').fill('A folder of thousands of files.');
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/bugreports') && r.request().method() === 'POST');
  await form.getByTestId('bug-send').click();
  expect((await sent).ok()).toBe(true);
  await expect(page.getByText('Report saved. Thank you.')).toBeVisible();
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/many' });
});
