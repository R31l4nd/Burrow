import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { hostNamed, signIn } from './passkey.js';

// Report 780048: a file's properties at a glance on hover in the workspace's
// tree, and the file list, two editors side by side and a file beside its
// Markdown preview each resizable by dragging the edge between them, as VS Code.

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

/** The edge dragged by dx pixels with the mouse. */
async function drag(page: Page, testid: string, dx: number) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(b.height / 2, 200);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 3 });
  await page.mouse.move(x + dx, y, { steps: 3 });
  await page.mouse.up();
}

const width = async (page: Page, testid: string) => Math.round((await page.getByTestId(testid).boundingBox())!.width);

test("a file's properties on hover; the file list, two editors and a file beside its preview resized by their edge, kept (report 780048)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: "rm -rf ~/ws-sash && mkdir -p ~/ws-sash/sub && printf 'hello there\\n' > ~/ws-sash/a.txt && chmod 640 ~/ws-sash/a.txt && printf '# Notes\\n\\nSome text.\\n' > ~/ws-sash/README.md && ln -s a.txt ~/ws-sash/link.txt",
  });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/ws-sash' });
  await page.evaluate((id) => (localStorage.removeItem(`burrow.ws.${id}`), localStorage.removeItem('burrow.wsLayout'), localStorage.setItem('burrow.markdownSide', '1')), ws.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/ws/${ws.id}`);
  const node = (path: string) => page.locator(`[data-testid="tree-node"][data-path="${path}"]`);

  // Hovered a moment: what the file is, without a click.
  const tip = page.getByTestId('file-tip');
  await node('a.txt').hover();
  await expect(tip).toBeVisible();
  await expect(node('a.txt')).toHaveAttribute('aria-describedby', 'file-tip');
  for (const s of ['a.txt', 'Size', '12 B', 'Changed', 'Owner', 'tester:tester', 'Rights', 'rw-r----- (0640)', 'Path', '/home/tester/ws-sash/a.txt']) await expect(tip).toContainText(s);
  await lookAt(page, 'ws-file-tip');
  // Beside the list, not over it; gone when the mouse leaves.
  const [row, box] = [(await node('a.txt').boundingBox())!, (await tip.boundingBox())!];
  expect(box.x).toBeGreaterThanOrEqual(row.x + row.width - 1);
  await page.mouse.move(900, 600);
  await expect(tip).toBeHidden();
  await expect(node('a.txt')).not.toHaveAttribute('aria-describedby');
  // A folder says so, without a size; a link where it points.
  await node('sub').hover();
  await expect(tip).toContainText('Folder');
  await expect(tip).not.toContainText('Size');
  await node('link.txt').hover();
  await expect(tip).toContainText('-> a.txt');
  // Pressed, it is gone (the click opens the file).
  await node('link.txt').click();
  await expect(tip).toBeHidden();

  // A file beside its preview: the edge between them dragged, double-clicked back to half.
  await node('README.md').dblclick();
  await expect(page.getByTestId('markdown-side')).toBeVisible();
  const half = await width(page, 'markdown-side');
  await drag(page, 'md-sash', 200);
  expect(Math.abs((await width(page, 'markdown-side')) - (half - 200))).toBeLessThan(12);
  await page.getByTestId('md-sash').dblclick();
  expect(Math.abs((await width(page, 'markdown-side')) - half)).toBeLessThan(6);
  await drag(page, 'md-sash', -150);
  const wider = await width(page, 'markdown-side');
  expect(wider).toBeGreaterThan(half + 130);

  // Two editors side by side: their edge too.
  await node('a.txt').dblclick();
  await page.getByTestId('ws-tab').filter({ hasText: 'a.txt' }).click({ button: 'right' });
  await page.locator('dialog[open]').getByTestId('ws-other-side').click();
  const slots = page.getByTestId('ws-slot');
  await expect(page.getByTestId('ws-split-sash')).toBeVisible();
  const left = Math.round((await slots.first().boundingBox())!.width);
  await drag(page, 'ws-split-sash', -200);
  expect(Math.abs(Math.round((await slots.first().boundingBox())!.width) - (left - 200))).toBeLessThan(12);
  // With the keyboard: an arrow moves it a step.
  await page.getByTestId('ws-split-sash').focus();
  const before = Math.round((await slots.first().boundingBox())!.width);
  await page.keyboard.press('ArrowRight');
  expect(Math.round((await slots.first().boundingBox())!.width)).toBeGreaterThan(before + 20);

  // The file list: wider by its edge, never so wide the editor has no room.
  expect(await width(page, 'ws-side')).toBe(290);
  await drag(page, 'ws-side-sash', 150);
  expect(Math.abs((await width(page, 'ws-side')) - 440)).toBeLessThan(6);
  await drag(page, 'ws-side-sash', 2000);
  expect(await width(page, 'ws-side')).toBeLessThanOrEqual(1440 - 480);
  await drag(page, 'ws-side-sash', -2000);
  expect(await width(page, 'ws-side')).toBe(180);
  await drag(page, 'ws-side-sash', 170);
  const side = await width(page, 'ws-side');
  await lookAt(page, 'ws-sashes');

  // Kept on this device: the same after a reload.
  const split = Math.round((await slots.first().boundingBox())!.width);
  await page.reload();
  await expect(page.getByTestId('ws-side-sash')).toBeVisible();
  expect(await width(page, 'ws-side')).toBe(side);
  await expect.poll(async () => Math.round((await slots.first().boundingBox())!.width)).toBe(split);
  // Double-clicked: back as it was at first.
  await page.getByTestId('ws-side-sash').dblclick();
  expect(await width(page, 'ws-side')).toBe(290);

  // A phone: the list is a drawer, no edges to drag.
  await page.setViewportSize({ width: 412, height: 839 });
  await expect(page.getByTestId('ws-side-sash')).toHaveCount(0);
  await expect(page.getByTestId('ws-split-sash')).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/ws-sash' });
});
