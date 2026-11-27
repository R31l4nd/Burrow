import { expect, test, type Page } from './fixtures.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { hostNamed, signIn } from './passkey.js';

// Report 9d710d: two tabs both "docker-compose.yml" (which folder?), no way
// to compare two files of a workspace, and two GET .../text -> 403 in the
// report while a root-owned file was open through sudo.

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

test('files of the same name say their folder; one compared with another open one or any of the workspace; a root-only one said, not a failure (report 9d710d)', async ({ page }) => {
  test.setTimeout(120_000);
  await sayYes(page);
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const run = async (command: string) => {
    const [r] = await api<{ exitCode: number; stderr: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command });
    expect(r!.exitCode, r!.stderr).toBe(0);
  };
  await run(
    [
      'rm -rf ~/cmp-data ~/cmp-hdd',
      'mkdir -p ~/cmp-data ~/cmp-hdd/AppData',
      "printf 'services:\\n  web:\\n    image: nginx:1\\n' > ~/cmp-data/docker-compose.yml",
      "printf 'services:\\n  web:\\n    image: nginx:2\\n' > ~/cmp-hdd/AppData/docker-compose.yml",
      // Only root may read it, as the report's file.
      "printf '%s\\n' burrow-test-password | sudo -S -p '' sh -c \"printf 'secret: 1\\n' > /home/tester/cmp-hdd/root.yml && chown root:root /home/tester/cmp-hdd/root.yml && chmod 600 /home/tester/cmp-hdd/root.yml\"",
    ].join(' && '),
  );
  const ws = await api<{ id: number; name: string }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/cmp-data' });
  await api(page, 'PUT', `/api/workspaces/${ws.id}`, { folders: ['/home/tester/cmp-hdd'] });
  await page.evaluate((id) => localStorage.removeItem(`burrow.ws.${id}`), ws.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/ws/${ws.id}`);
  const node = (path: string) => page.locator(`[data-testid="tree-node"][data-path="${path}"]`);
  // A double click keeps each open; one click would show the second in the first one's place (report 96a655).
  await node('docker-compose.yml').dblclick();
  await node('AppData').click();
  await node('AppData/docker-compose.yml').dblclick();

  // Each tab: the name, and the part of its folder that tells it apart; the full path on hover.
  const tabs = page.getByTestId('ws-tab');
  await expect(tabs).toHaveCount(2);
  await expect(page.getByTestId('ws-tab-dir')).toHaveText(['cmp-data', 'cmp-hdd/AppData']);
  await expect(tabs.nth(1)).toHaveAttribute('title', 'test-sshd:/home/tester/cmp-hdd/AppData/docker-compose.yml');
  await expect(page).toHaveTitle(`docker-compose.yml (cmp-hdd/AppData) - ${ws.name} - Burrow`);
  await expect(page.getByRole('button', { name: 'Close docker-compose.yml (cmp-data)' })).toBeVisible();

  // Typed and not saved: compared as it is in the tab. The tab's own menu (a right click) has Compare with...
  await expect(page.locator('.cm-content').nth(1)).toContainText('nginx:2');
  await page.locator('.cm-content').nth(1).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('# typed\n');
  await tabs.nth(1).click({ button: 'right' });
  // Each tab has its tools; the open one's.
  await page.getByRole('dialog', { name: 'docker-compose.yml' }).getByTestId('ws-compare-open').click();
  const dialog = page.getByRole('dialog', { name: 'Compare docker-compose.yml (cmp-hdd/AppData) with...' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('compare-tab')).toHaveCount(1);
  await expect(dialog.getByTestId('compare-tab')).toContainText('cmp-data');
  await dialog.getByTestId('compare-tab').click();
  // In a tab of its own (report a43cd5), named by both and their folders.
  await expect(dialog).toBeHidden();
  await expect(tabs.nth(2)).toHaveText('docker-compose.yml (cmp-data) <-> docker-compose.yml (cmp-hdd/AppData)');
  await expect(tabs.nth(2)).toHaveAttribute('title', 'test-sshd:/home/tester/cmp-data/docker-compose.yml\ntest-sshd:/home/tester/cmp-hdd/AppData/docker-compose.yml');
  const diff = page.getByTestId('diff');
  await expect(diff).toContainText('# typed');
  // Side by side on this screen: the other file at the left, this one at the right.
  await expect(diff.locator('.cm-editor')).toHaveCount(2);
  await expect(diff.locator('.cm-editor').first()).toContainText('nginx:1');
  await lookAt(page, 'ws-compare');

  // Any file of the workspace's folders, found by name; one only root may read says so, with the way to open it.
  await tabs.nth(1).click({ button: 'right' });
  await page.getByRole('dialog', { name: 'docker-compose.yml' }).getByTestId('ws-compare-open').click();
  await dialog.getByTestId('compare-find').fill('root.yml');
  // Found by a few letters of its name, best first.
  await expect(dialog.getByTestId('compare-file').first()).toContainText('/home/tester/cmp-hdd/root.yml');
  await dialog.getByTestId('compare-file').first().click();
  await expect(dialog.getByTestId('compare-error')).toContainText('/home/tester/cmp-hdd/root.yml');
  await lookAt(page, 'ws-compare-root-only');
  await expect(dialog.getByTestId('compare-pair')).toContainText('/home/tester/cmp-hdd/AppData/docker-compose.yml');
  await expect(dialog.getByTestId('compare-pair')).toContainText('/home/tester/cmp-hdd/root.yml');
  // Back to the choice, and the same file again.
  await dialog.getByTestId('compare-back').click();
  await expect(dialog.getByTestId('compare-error')).toHaveCount(0);
  await dialog.getByTestId('compare-find').fill('root.yml');
  await dialog.getByTestId('compare-file').first().click();
  await dialog.getByTestId('compare-open-tab').click();
  await expect(dialog).toBeHidden();
  await expect(tabs).toHaveCount(4);
  await expect(page.getByTestId('open-sudo')).toBeVisible();

  // From the tree's menu too: the same dialog, this time for a file not open.
  await tabs.nth(1).click();
  await page.getByTestId('save').click();
  await expect(page.getByTestId('dirty')).toHaveCount(0);
  await node('docker-compose.yml').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'docker-compose.yml' }).getByTestId('compare-open').click();
  await expect(page.getByRole('dialog', { name: 'Compare docker-compose.yml (cmp-data) with...' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The editor's first read of the root-only file was answered on the page (Open with sudo): a
  // problem report says it was handled, not that something broke.
  await page.goto('/#/settings/report');
  await page.getByTestId('bug-arm').click();
  await page.getByTestId('bug-button').click();
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  await form.getByText('Also sent: page, versions, device, recent errors').click();
  await expect(form.getByTestId('bug-context')).toContainText(new RegExp(`"path": "/api/files/${sshd}/text",\\s*"status": 403,\\s*"code": "permission_denied",\\s*"at": "[^"]+",\\s*"handled": true`));
  await page.keyboard.press('Escape');
  await page.getByTestId('bug-disarm').click();
  await expect(page.getByTestId('bug-button')).toHaveCount(0);
  await run("rm -rf ~/cmp-data ~/cmp-hdd/AppData; printf '%s\\n' burrow-test-password | sudo -S -p '' rm -rf /home/tester/cmp-hdd");
});

test('a comparison shows where and how much differs at once: side by side, the first difference in view, F7 to the next, marks along the edge, the same parts folded (user 2026-10-23)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  // A hundred lines, two changes far apart: one near the top, one near the end.
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: "rm -rf ~/cmp-long && mkdir -p ~/cmp-long && seq 1 100 | sed 's/^/line /' > ~/cmp-long/a.txt && seq 1 100 | sed 's/^/line /; s/^line 5$/line five/; s/^line 90$/line ninety/' > ~/cmp-long/b.txt",
  });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/cmp-long' });
  await page.evaluate((id) => localStorage.removeItem(`burrow.ws.${id}`), ws.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/ws/${ws.id}`);
  const node = (path: string) => page.locator(`[data-testid="tree-node"][data-path="${path}"]`);
  await node('b.txt').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'b.txt' }).getByTestId('compare-open').click();
  const dialog = page.getByRole('dialog', { name: /^Compare b\.txt/ });
  await dialog.getByTestId('compare-find').fill('a.txt');
  await dialog.getByTestId('compare-file').first().click();
  // How much and where, before any scrolling.
  await expect(page.getByTestId('diff-summary')).toContainText('+2 -2 in 2 places');
  await expect(page.getByTestId('diff-mark')).toHaveCount(2);
  const diff = page.getByTestId('diff');
  await expect(diff.locator('.cm-editor')).toHaveCount(2);
  // The same stretches folded, the first difference marked as the one in view.
  await expect(diff.locator('.cm-collapsedLines').first()).toBeVisible();
  await expect(page.getByTestId('diff-summary')).toContainText('1 of 2');
  await lookAt(page, 'compare-long');
  // The next one: by its button, by F7, and by its mark.
  await page.getByTestId('diff-next').click();
  await expect(page.getByTestId('diff-summary')).toContainText('2 of 2');
  await expect(diff).toContainText('line ninety');
  await diff.locator('.cm-editor').nth(1).locator('.cm-content').click();
  await page.keyboard.press('Shift+F7');
  await expect(page.getByTestId('diff-summary')).toContainText('1 of 2');
  await page.getByTestId('diff-mark').nth(1).click();
  await expect(page.getByTestId('diff-summary')).toContainText('2 of 2');
  await page.getByTestId('diff-prev').click();
  await expect(page.getByTestId('diff-summary')).toContainText('1 of 2');
  // Every line when asked.
  await page.getByTestId('diff-all').check();
  await expect(diff.locator('.cm-collapsedLines')).toHaveCount(0);
  // A phone: one column, the older lines above the newer.
  await page.setViewportSize({ width: 412, height: 839 });
  await expect(diff.locator('.cm-editor')).toHaveCount(1);
  await expect(diff.locator('.cm-deletedChunk').first()).toContainText('line 5');
  await lookAt(page, 'compare-long-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press('Escape');
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('a comparison opens in a tab of its own, the two files side by side scrolling together, a phone held sideways too (report a43cd5)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: "rm -rf ~/cmp-tab && mkdir -p ~/cmp-tab && seq 1 100 | sed 's/^/line /' > ~/cmp-tab/a.txt && seq 1 100 | sed 's/^/line /; s/^line 5$/line five/; /^line 40$/d; s/^line 90$/line ninety/' > ~/cmp-tab/b.txt",
  });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/cmp-tab' });
  await page.evaluate((id) => localStorage.removeItem(`burrow.ws.${id}`), ws.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/ws/${ws.id}`);
  const node = (path: string) => page.locator(`[data-testid="tree-node"][data-path="${path}"]`);
  await node('b.txt').dblclick();
  const tabs = page.getByTestId('ws-tab');
  await expect(tabs).toHaveCount(1);
  await tabs.first().click({ button: 'right' });
  await page.getByRole('dialog', { name: 'b.txt' }).getByTestId('ws-compare-open').click();
  const dialog = page.getByRole('dialog', { name: /^Compare b\.txt/ });
  await dialog.getByTestId('compare-find').fill('a.txt');
  await dialog.getByTestId('compare-file').first().click();

  // Chosen: the dialog gone, the comparison a tab beside the file, named by both, the whole editor's room.
  await expect(dialog).toBeHidden();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText('a.txt <-> b.txt');
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(tabs.nth(1)).toHaveAttribute('title', 'test-sshd:/home/tester/cmp-tab/a.txt\ntest-sshd:/home/tester/cmp-tab/b.txt');
  const diff = page.getByTestId('diff');
  await expect(page.getByTestId('diff-summary')).toContainText('+2 -3 in 3 places');

  // A phone held sideways (the report's 698 x 394): still side by side, most of the height the two files'.
  await page.setViewportSize({ width: 698, height: 394 });
  await expect(diff.locator('.cm-editor')).toHaveCount(2);
  const box = (await diff.boundingBox())!;
  expect(box.height, 'the comparison has most of the screen').toBeGreaterThan(394 * 0.45);
  await lookAt(page, 'compare-tab-phone');
  // Scrolled together, the lines lined up: the last difference shows both its sides at once, and the line
  // gone at the left has an empty place at the right.
  await page.getByTestId('diff-all').check();
  await page.getByTestId('diff-next').click();
  await page.getByTestId('diff-next').click();
  await expect(page.getByTestId('diff-summary')).toContainText('3 of 3');
  await expect(diff.locator('.cm-editor').first().locator('.cm-line', { hasText: /^line 90$/ })).toBeInViewport();
  await expect(diff.locator('.cm-editor').nth(1).locator('.cm-line', { hasText: /^line ninety$/ })).toBeInViewport();
  const top = async (n: number, text: RegExp) => (await diff.locator('.cm-editor').nth(n).locator('.cm-line', { hasText: text }).boundingBox())!.y;
  expect(Math.abs((await top(0, /^line 90$/)) - (await top(1, /^line ninety$/))), 'both sides of a difference on one height').toBeLessThan(2);
  expect(Math.abs((await top(0, /^line 91$/)) - (await top(1, /^line 91$/))), 'the lines after a line gone (40 at the left) still level').toBeLessThan(2);
  // One column when asked, and back.
  await page.getByTestId('diff-layout').click();
  await expect(diff.locator('.cm-editor')).toHaveCount(1);
  await page.getByTestId('diff-layout').click();
  await expect(diff.locator('.cm-editor')).toHaveCount(2);

  // A phone upright: one column, the older lines above the newer.
  await page.setViewportSize({ width: 412, height: 839 });
  await expect(diff.locator('.cm-editor')).toHaveCount(1);
  await expect(diff.locator('.cm-deletedChunk').first()).toContainText('line 5');
  // The lines gone numbered as in the older file, each beside its line (asked 2026-11-17).
  const gone = diff.locator('.cm-deletedNumbers').first();
  await expect(gone).toHaveText('5');
  const [num, old] = [(await gone.boundingBox())!, (await diff.locator('.cm-deletedLine').first().boundingBox())!];
  expect(Math.abs(num.y - old.y), 'the number on the line it numbers').toBeLessThan(2);
  await lookAt(page, 'compare-tab-upright');

  // Closed as any tab: the file's tab stays, and a comparison is not opened again with the page.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Close a.txt <-> b.txt' }).click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText('b.txt');
  await page.reload();
  await expect(tabs).toHaveCount(1);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/cmp-tab' });
});

test('two large files compared: first said that they are being compared and how many lines, then each changed line on its own, not the whole file as one change (report 2de305)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: "rm -rf ~/cmp-big && mkdir -p ~/cmp-big && seq 1 30000 | sed 's/^/line /' > ~/cmp-big/a.txt && seq 1 30000 | sed 's/^/line /; s/^line \\(.*7\\)$/line \\1 changed/' > ~/cmp-big/b.txt",
  });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/cmp-big' });
  await page.evaluate((id) => localStorage.removeItem(`burrow.ws.${id}`), ws.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/ws/${ws.id}`);
  await page.locator('[data-testid="tree-node"][data-path="b.txt"]').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'b.txt' }).getByTestId('compare-open').click();
  const dialog = page.getByRole('dialog', { name: /^Compare b\.txt/ });
  await dialog.getByTestId('compare-find').fill('a.txt');
  // What showed while it worked: watched from before the choice.
  await page.evaluate(() => {
    const w = window as unknown as { busySaid: string };
    w.busySaid = '';
    new MutationObserver(() => {
      const b = document.querySelector('[data-testid=diff-busy]');
      if (b && !w.busySaid) w.busySaid = b.textContent ?? '';
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await dialog.getByTestId('compare-file').first().click();
  await expect(page.getByTestId('diff-summary')).toContainText('+3000 -3000', { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { busySaid: string }).busySaid)).toBe("Comparing 60002 lines...");
  await expect(page.getByTestId('diff-busy')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('what differs stands out as in VS Code: a changed word coloured behind it, not a thin line under it; changed lines tinted; a line only on one side faces a hatched gap (report b11968)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: "rm -rf ~/cmp-look2 && mkdir -p ~/cmp-look2 && printf 'PUID=1000\\nPORT=587\\nUSER=demo\\n' > ~/cmp-look2/old.env && printf 'PUID=1000\\nPORT=465\\nUSER=demo\\nNEW=1\\n' > ~/cmp-look2/new.env",
  });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/cmp-look2' });
  await page.evaluate((id) => localStorage.removeItem(`burrow.ws.${id}`), ws.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The alpha of a computed colour: rgb(), rgba(), or color(srgb r g b / a) as color-mix gives it.
  const alpha = (c: string) => {
    const m = /\/\s*([\d.]+)\s*\)$/.exec(c) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(c);
    if (m) return Number(m[1]);
    return /^(rgb|color)\(/.test(c) ? 1 : 0;
  };
  const style = (sel: string) =>
    page.locator(sel).first().evaluate((e) => {
      const s = getComputedStyle(e);
      return { image: s.backgroundImage, color: s.backgroundColor };
    });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/#/ws/${ws.id}`);
    await page.locator('[data-testid="tree-node"][data-path="new.env"]').click({ button: 'right' });
    await page.getByRole('dialog', { name: 'new.env' }).getByTestId('compare-open').click();
    const dialog = page.getByRole('dialog', { name: /^Compare new\.env/ });
    await dialog.getByTestId('compare-find').fill('old.env');
    await dialog.getByTestId('compare-file').first().click();
    await expect(page.getByTestId('diff-summary')).toContainText('+2 -1');
    const diff = page.getByTestId('diff');
    // The changed number, on each side: a colour behind it, no line under it.
    for (const side of ['a', 'b']) {
      const word = await style(`[data-testid=diff] .cm-merge-${side} .cm-changedText`);
      expect(word.image, `${scheme} ${side}`).toBe('none');
      expect(alpha(word.color), `${scheme} ${side} ${word.color}`).toBeGreaterThanOrEqual(0.2);
      const line = await style(`[data-testid=diff] .cm-merge-${side} .cm-changedLine`);
      expect(alpha(line.color), `${scheme} ${side} ${line.color}`).toBeGreaterThanOrEqual(0.08);
    }
    // NEW=1 only in the newer: the older faces it with a hatched gap.
    await expect(diff.locator('.cm-merge-a .cm-mergeSpacer').first()).toBeVisible();
    expect((await style('[data-testid=diff] .cm-merge-a .cm-mergeSpacer')).image).toContain('repeating-linear-gradient');
    await page.keyboard.press('Escape');
  }
  await page.emulateMedia({ colorScheme: null });
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});
