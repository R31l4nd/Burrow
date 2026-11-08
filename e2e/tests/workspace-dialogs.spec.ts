import { expect, test } from './fixtures.js';
import { signIn } from './passkey.js';

// Dialogs that hold what was typed (A3-WEB-12), and the step-up dialog with
// no way to confirm (A3-WEB-23).

test('a command typed for several hosts: closing asks first; a text selection dragged onto the backdrop does not close (A3-WEB-12)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/snippets?run=1');
  await page.reload();
  const dialog = page.locator('dialog[data-tour=snippet-run]');
  const field = page.getByTestId('adhoc-command');
  await field.fill('uptime && df -h');
  // A selection that starts in the field and ends outside the dialog.
  const box = (await field.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('confirm-text')).toBeHidden();
  // Escape: asked first, and "no" keeps what was typed.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-text')).toContainText('not saved');
  await page.locator('dialog[data-tour=confirm]').getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue('uptime && df -h');
  // A tap on the backdrop itself asks too; yes closes.
  await page.mouse.click(5, 5);
  await expect(page.getByTestId('confirm-text')).toContainText('not saved');
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toBeHidden();
});

test('Escape pressed again and again on a dialog with changes: it asks each time, never closes by itself (audit 2026-11-05)', async ({ page }) => {
  // Chrome lets a page stop only one Escape in a row with nothing pressed in between; the next one
  // closed the form and what was typed in it.
  await signIn(page);
  await page.goto('/#/snippets?run=1');
  await page.reload();
  const dialog = page.locator('dialog[data-tour=snippet-run]');
  const field = page.getByTestId('adhoc-command');
  await field.click();
  await field.fill('uptime && free -m');
  // An odd number: each second Escape answers the question No, which keeps the form.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue('uptime && free -m');
  }
  await expect(page.getByTestId('confirm-text')).toContainText('not saved');
  // The question still answers: Close anyway closes it.
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toBeHidden();
});

test("the step-up dialog with no way to confirm on this device says where to get one, not only Cancel (A3-WEB-23)", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        const result = method === 'info' ? { version: '1.0.0', versionCode: 10000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false } : null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    (window as unknown as { BurrowAndroid: unknown }).BurrowAndroid = port;
  });
  // A passkey (not offered in the app), no authenticator, no single sign-on, the app not paired.
  await page.route('**/api/auth/state', async (r) => {
    const res = await r.fetch();
    const s = (await res.json()) as { user: Record<string, unknown> | null; deviceId?: unknown };
    if (s.user) Object.assign(s.user, { hasPasskey: true, hasTotp: false, hasSso: false });
    s.deviceId = null;
    await r.fulfill({ response: res, json: s });
  });
  await page.route('**/api/snippets/run', (r) => r.fulfill({ status: 403, json: { error: 'step_up_required' } }));
  await page.goto('/#/snippets?run=1');
  await page.reload();
  await page.getByTestId('adhoc-command').fill('uptime');
  await page.locator('dialog[data-tour=snippet-run] [data-testid=picklist]').getByRole('checkbox', { name: /test-sshd/ }).first().check();
  await page.locator('dialog[data-tour=snippet-run]').getByRole('button', { name: /^Run on/ }).click();
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp.getByTestId('stepup-none')).toContainText('pair it with Burrow');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test("the app's new direct-route key at its start: the step-up says why; an unchanged key asks nothing", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        const result = method === 'info' ? { version: '1.0.0', versionCode: 10000, deviceId: 4242, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false } : method === 'sshPublicKey' ? { publicKey: 'ecdsa-sha2-nistp256 AAAA' } : null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    (window as unknown as { BurrowAndroid: unknown }).BurrowAndroid = port;
  });
  await page.route('**/api/auth/state', async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...((await res.json()) as object), deviceId: 4242 } });
  });
  // The server has this key already: no question.
  let changed = false;
  await page.route('**/api/account/devices/current/ssh-key', (r) => (changed ? r.fulfill({ status: 403, json: { error: 'step_up_required' } }) : r.fulfill({ status: 204 })));
  await page.goto('/#/hosts');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hosts', level: 1 })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('dialog', { name: "Confirm it's you" })).toBeHidden();
  // A new key: the question, with why.
  changed = true;
  await page.reload();
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp.getByTestId('stepup-why')).toContainText('direct route is new');
  await stepUp.getByRole('button', { name: 'Cancel' }).click();
  await expect(stepUp).toBeHidden();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test("an update whose backup service did not come back is said in the app's words (backup_not_started)", async ({ page }) => {
  await signIn(page);
  const sshd = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.route('**/api/system/update', (r) =>
    r.fulfill({ json: { target: { hostId: sshd, hostName: 'test-sshd', dir: '/opt/burrow', container: 'burrow', service: 'burrow' }, running: '1.2.0', mode: 'git', available: '1.2.0', behind: 0, subject: null, last: { state: 'failed', code: 'backup_not_started', at: new Date().toISOString(), message: 'backup: not running' }, problem: null } }),
  );
  await page.goto('/#/settings/about');
  await page.reload();
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-state')).toContainText('the backup service did not come back after the update');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
