import { expect, test } from './fixtures.js';
import { signIn } from './passkey.js';
import type { WebSocketRoute } from '@playwright/test';

// A container's log on a phone, following: long lines wrap to several rows there, and each new one
// is first counted at a placeholder's height (the lines are drawn only when in view). Scrolled to
// that bottom, the line was then drawn rows higher: the view stood above the real end and stopped
// following, the person scrolling along by hand at every new line (report 27519a).
test('a phone follows a log of long lines: each new one in view at the bottom, no scrolling along by hand (report 27519a)', async ({ page }) => {
  // The log's socket is this test's: the lines it sends, when it sends them. Before the page loads
  // (the route goes in with a new document; the container page is opened by its hash in this one).
  const socket = new Promise<WebSocketRoute>((resolve) => void page.routeWebSocket(/\/api\/docker\/logs\/ws/, (ws) => resolve(ws)));
  await signIn(page);
  const sshd = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.goto(`/#/containers/${sshd}/burrowtest-db`);
  const ws = await socket;
  let n = 0;
  const send = (count: number) => {
    const lines = Array.from({ length: count }, () => {
      n++;
      const ts = new Date(Date.UTC(2026, 10, 11, 17, 0, n)).toISOString().replace('Z', '000000Z');
      return { i: 0, s: 'o' as const, ts, text: `[Warn] IndexerParser: Failed to expand directory ${n} for share:@@music\\Techno\\202508\\Some_Artist-Long_Release_Name_(Official_Anthem_2025)-SINGLE-16BIT-WEB-FLAC-2025-GROUP` };
    });
    ws.send(JSON.stringify({ t: 'lines', lines }));
  };
  send(40);
  const log = page.getByTestId('log');
  await expect(log.locator('.line').last()).toContainText(`directory ${n} `);
  const fromBottom = () => log.evaluate((b) => b.scrollHeight - b.clientHeight - b.scrollTop);
  // The lines wrap here: the test is about lines rows high.
  expect(await log.locator('.line').last().evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThan(50);
  await expect.poll(fromBottom).toBeLessThanOrEqual(1);
  for (let k = 0; k < 6; k++) {
    send(1);
    await expect(log.locator('.line').last()).toContainText(`directory ${n} `);
    await page.waitForTimeout(300);
    expect(await fromBottom(), `line ${n}: the view at the end`).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('log-resume'), `line ${n}: still following`).toBeHidden();
  }
});
