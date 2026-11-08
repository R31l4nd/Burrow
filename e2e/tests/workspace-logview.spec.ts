import { expect, test } from './fixtures.js';
import { lookAt } from './checks.js';
import { signIn } from './passkey.js';

// What a log line shows, with lines from a stand-in socket.

const LONG = 'homeassistant-zigbee2mqtt-bridge-with-a-very-long-name';

test('merged logs on a phone: a long source name is cut with ..., the level and a JSON line\'s {...} stay whole (A3-WEB-10)', async ({ page }) => {
  await signIn(page);
  const sshd = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.routeWebSocket(/\/api\/docker\/logs\/ws/, (ws) => {
    const at = (k: number) => new Date(Date.now() - (20 - k) * 1000).toISOString();
    const lines = Array.from({ length: 12 }, (_, k) => ({ i: k % 2, ts: at(k), s: k % 3 ? 'o' : 'e', text: k % 4 === 0 ? JSON.stringify({ level: 'warn', msg: 'failed to inspect container, falling back to list entry', id: k }) : `ERROR connection lost to the coordinator after ${k} tries` }));
    ws.send(JSON.stringify({ t: 'lines', lines }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/logs?t=${sshd}:burrowtest-db,${sshd}:${LONG}`);
  await page.reload();
  await expect(page.getByTestId('log-line').first()).toBeVisible();
  await lookAt(page, 'phone-logs-long-source');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
