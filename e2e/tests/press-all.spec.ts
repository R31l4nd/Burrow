import { expect, test, type Page } from './fixtures.js';
import { fromRowMenu } from './menu.js';
import { sayYes } from './confirm.js';
import { concretePages, pageOf } from './pages.js';
import { SELECTOR, SKIP } from './press.js';
import { signIn } from './passkey.js';

// Every control the tests did not press yet, pressed once: page by page, in
// an open dialog first, each followed by a look for errors in the page and
// failed answers from the server, then back to where it was. Runs after all
// the other tests (its own project), so what it changes touches none of
// them. What removes, ends or deploys something is left out here: those
// have tests of their own, or a reason in e2e/controls-allow.json
// (scripts/controls-check.mjs holds the two lists together).

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status}`);
      return r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

test('signed out: the other ways to sign in', async ({ browser }) => {
  const out = await browser.newContext();
  const p = await out.newPage();
  await p.goto('/');
  for (const name of ['Use password instead', 'Password + authenticator app', 'Use a recovery code']) {
    const b = p.getByRole('button', { name });
    if (await b.count()) await b.first().click();
  }
  await expect(p.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await out.close();
});

test('signed out: the password step expired before the code: back to the password, said why (AUDIT2 PAGE-15)', async ({ browser }) => {
  const out = await browser.newContext();
  const p = await out.newPage();
  // Stand-ins: a password that is right, and a code entered after the step expired.
  await p.route('**/api/auth/password', (r) => r.fulfill({ json: { ticket: 'stand-in' } }));
  await p.route('**/api/auth/totp', (r) => r.fulfill({ status: 401, json: { error: 'ticket_expired' } }));
  await p.goto('/');
  await p.getByRole('button', { name: 'Use password instead' }).click();
  await p.getByLabel('Username').fill('someone');
  await p.getByLabel('Password').fill('a password');
  await p.getByRole('button', { name: 'Next' }).click();
  await p.getByLabel('Authenticator code').fill('123456');
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(p.getByText('That took too long: enter your password again, then a new code.')).toBeVisible();
  await expect(p.getByLabel('Password')).toHaveValue('');
  await expect(p.getByLabel('Authenticator code')).toHaveCount(0);
  // And back by hand from the code step.
  await p.getByLabel('Username').fill('someone');
  await p.getByLabel('Password').fill('a password');
  await p.getByRole('button', { name: 'Next' }).click();
  await p.getByTestId('totp-back').click();
  await expect(p.getByLabel('Password')).toBeVisible();
  await out.close();
});

// What removes or ends something: pressed for real, each on something made
// for it here (after all the other tests, so nothing they need goes).
test('what removes or ends something: each pressed on a thing made for it', async ({ page }) => {
  test.skip(test.info().project.name !== 'press', 'once is enough');
  test.setTimeout(180_000);
  await sayYes(page);
  await signIn(page);
  const call = <T,>(method: string, url: string, body?: unknown) =>
    page.evaluate(
      async ([m, u, b]) => {
        const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
        if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
        return r.status === 204 ? null : r.json();
      },
      [method, url, body] as const,
    ) as Promise<T>;
  const hosts = await call<{ id: number; name: string }[]>('GET', '/api/hosts');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  const row = (text: string) => page.locator('.list-item', { hasText: text });

  await test.step('a key', async () => {
    await call('POST', '/api/keys/generate', { name: 'press-key' });
    await page.goto('/#/keys');
    await fromRowMenu(row('press-key'), 'key-menu', 'key-remove');
    await expect(row('press-key')).toHaveCount(0);
  });
  await test.step('an app', async () => {
    await call('POST', '/api/apps', { name: 'Press app', url: 'http://press.invalid/', monitor: false });
    await page.goto('/#/apps');
    await page.getByRole('button', { name: 'Manage' }).click();
    await row('Press app').getByRole('button', { name: 'Delete' }).click();
    await expect(row('Press app')).toHaveCount(0);
  });
  await test.step('an invite', async () => {
    await call('POST', '/api/invites', { role: 'operator' });
    await page.goto('/#/settings/users');
    // The list first (Settings loads on its own since 2.3.0): counted at once, it was none.
    await expect(page.getByRole('button', { name: 'Withdraw this invite' }).first()).toBeVisible();
    const before = await page.getByRole('button', { name: 'Withdraw this invite' }).count();
    await page.getByRole('button', { name: 'Withdraw this invite' }).first().click();
    await expect(page.getByRole('button', { name: 'Withdraw this invite' })).toHaveCount(before - 1);
  });
  await test.step('a workspace, from the hosts page and from files', async () => {
    for (const where of ['/#/hosts', '/#/files']) {
      await call('POST', '/api/workspaces', { hostId: sshd, root: '/home/tester' });
      await page.goto(where);
      await page.getByRole('button', { name: 'Remove tester' }).first().click();
      await expect(page.getByRole('button', { name: 'Remove tester' })).toHaveCount(0);
    }
  });
  await test.step('a session, from its tab and from the list', async () => {
    const a = await call<{ id: string }>('POST', '/api/terminal/sessions', { hostId: sshd, tmux: 'never' });
    await page.goto(`/#/term/${a.id}`);
    await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Sessions' }).click();
    // This one's row (marked so), not another test's session.
    await page.getByRole('dialog').getByTestId('session-row').filter({ has: page.locator('.badge') }).getByTestId('session-close').click();
    await expect.poll(async () => (await call<{ id: string }[]>('GET', '/api/terminal/sessions')).some((x) => x.id === a.id)).toBe(false);
    const b = await call<{ id: string }>('POST', '/api/terminal/sessions', { hostId: sshd, tmux: 'never' });
    await page.goto('/#/term');
    // The newest: the list is in the order they were opened.
    await page.getByTestId('session-row').last().getByTestId('session-close').click();
    await expect.poll(async () => (await call<{ id: string }[]>('GET', '/api/terminal/sessions')).some((x) => x.id === b.id)).toBe(false);
  });
  await test.step('the alerts, a paired phone, the notification topics', async () => {
    await page.goto('/#/alerts');
    if (await page.getByTestId('alerts-clear').count()) await page.getByTestId('alerts-clear').click();
    // A phone the Android spec paired: asked, not guessed from a page still loading.
    const devices = await call<{ id: number }[]>('GET', '/api/account/devices');
    await page.goto('/#/settings/android');
    if (devices.length) {
      await fromRowMenu(page.locator('.list-item').filter({ has: page.getByTestId('device-menu') }).first(), 'device-menu', 'device-unpair');
      await expect.poll(async () => (await call<{ id: number }[]>('GET', '/api/account/devices')).length).toBe(devices.length - 1);
    }
    await page.goto('/#/settings/terminal');
    await expect(page.locator('h2#terminal')).toBeVisible();
    if (await page.getByRole('button', { name: 'Reset to default' }).count()) await page.getByRole('button', { name: 'Reset to default' }).first().click();
  });
  await test.step("a host's history and its shell integration", async () => {
    await page.goto('/#/hosts');
    await page.getByRole('button', { name: /^Menu for test-sshd/ }).first().click();
    const sheet = page.locator('dialog[data-tour=host-sheet]');
    // Under "Completion and history", folded away.
    await sheet.getByText('Completion and history').click();
    await sheet.getByRole('button', { name: 'Clear history' }).click();
    await expect.poll(async () => (await call<unknown[]>('GET', `/api/hosts/${sshd}/history`)).length).toBe(0);
    if (!(await sheet.isVisible())) {
      await page.getByRole('button', { name: /^Menu for test-sshd/ }).first().click();
      await sheet.getByText('Completion and history').click();
    }
    if (await sheet.getByRole('button', { name: 'Remove shell integration' }).count()) await sheet.getByRole('button', { name: 'Remove shell integration' }).click();
  });
});

test('every control not pressed yet: pressed once, nothing breaks', async ({ page, context }) => {
  // Every page once, settings parts and host pages each their own (AUDIT2 TEST-01): about a quarter more than before.
  test.setTimeout(900_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500 && r.status() !== 502 && r.status() !== 503 && r.url().includes('/api/')) errors.push(`${r.request().method()} ${r.url()}: ${r.status()}`);
  });
  // A link that opens another tab: closed again.
  context.on('page', (p) => void p.close().catch(() => {}));
  page.on('filechooser', () => {});
  // "Leave this page?" (something pressed left unsaved work) is answered yes: dismissed, a reload waited for ever (15 minutes in a gate).
  page.on('dialog', (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()));

  // Every page of the app (pages.ts) with real ids filled in; the signed-out ones apart.
  const first = async (url: string) => (await api<{ id: number | string }[]>(page, 'GET', url))[0]?.id;
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  const real = hosts.find((h) => h.name === 'docker-real')?.id ?? sshd;
  const pages = concretePages({
    sshd,
    docker: real,
    group: await first('/api/groups'),
    // A plain shell of its own: the first in the list is another spec's, in whatever state it left it (its key bar's keys then did nothing seen).
    session: (await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId: sshd, tmux: 'never' })).id,
    workspace: await first('/api/workspaces'),
    report: await first('/api/reports'),
    recording: await first('/api/recordings'),
    // One shown in a frame: another opens in a tab of its own and goes back to the list.
    app: (await api<{ id: number; embeddable: string }[]>(page, 'GET', '/api/apps')).find((a) => a.embeddable === 'yes')?.id,
    container: 'burrowtest-web',
    stack: 'burrowtest',
    // One every host has, whatever the specs before it removed (the tour's compose file is gone by now).
    file: '/home/tester/.profile',
    logs: `${real}:burrowtest-web,${real}:burrowtest-worker`,
  }).filter((p) => !p.missing);
  const urls = pages.map((p) => p.url);
  const pageOfUrl = new Map(pages.map((p) => [p.url, p.page]));
  // Opened by a key, not a button: the editor's find, the terminal's search.
  const keys: Record<string, string> = { edit: 'Control+f', term: 'Control+Shift+F' };

  const done = new Set<string>();
  for (const url of urls) {
    await test.step(url, async () => {
      const open = async () => {
        await page.goto(url);
        // A page may load itself anew on the way (an app frame after the apps changed: the new CSP),
        // which ends this reload early: the load that page started is waited for instead.
        await page.reload().catch(async (err: unknown) => {
          if (!/ERR_ABORTED|frame was detached/.test(String(err))) throw err;
          await page.waitForLoadState('load');
        });
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
        // The page asked for, not another one it fell back to (AUDIT2 TEST-01).
        expect(pageOf(new URL(page.url()).hash, true), url).toBe(pageOfUrl.get(url));
        // "#/edit/3?p=..." -> "edit": splitting the whole URL on "/" gave "#" (AUDIT2 TEST-07).
        const parts = url.replace(/^\/#\//, '').split('?')[0]!.split('/');
        const key = keys[parts[0]!];
        if (key && parts.length > 1) {
          await page.locator('.cm-content, [data-testid=terminal]').first().click({ timeout: 10_000 });
          await page.keyboard.press(key);
          await expect(page.locator(parts[0] === 'edit' ? '.cm-search' : '[data-testid=term-search]'), `${url}: ${key} opened its search`).toBeVisible();
        }
      };
      await open();
      // Which control opened each dialog: a dialog that closes after one of
      // its buttons (a file's sheet, a menu) is opened again for the next.
      const openers = new Map<string, string>();
      const reopened = new Map<string, number>();
      const dialogNow = () => page.evaluate(() => document.querySelector<HTMLElement>('dialog[open]')?.dataset.tour ?? null);
      for (let i = 0; i < 300; i++) {
        const target = await page.evaluate(
          ({ selector, skip, done }) => {
            const id = (window as unknown as { __controlId: (el: Element) => string | null }).__controlId;
            const pick = (root: ParentNode) =>
              [...root.querySelectorAll(selector)].find((el) => {
                if ((el as HTMLElement).offsetParent === null || (el as HTMLButtonElement).disabled || el.closest('.danger, [data-bug-ui]') || el.classList.contains('danger')) return false;
                const name = id(el);
                return !!name && !done.includes(name) && !skip.some((s) => new RegExp(s, 'i').test(name));
              });
            const dialog = document.querySelector('dialog[open]');
            const el = (dialog && pick(dialog)) ?? (dialog ? null : pick(document));
            document.querySelectorAll('[data-press]').forEach((x) => x.removeAttribute('data-press'));
            if (!el) return dialog ? 'close-dialog' : null;
            el.setAttribute('data-press', '');
            return id(el);
          },
          { selector: SELECTOR, skip: SKIP.map((r) => r.source), done: [...done] },
        );
        if (!target) break;
        // A dialog whose controls are all pressed: closed, on to the page behind.
        if (target === 'close-dialog') {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          if (await page.locator('dialog[open]').count()) await open();
          continue;
        }
        done.add(target);
        const before = await dialogNow();
        await page
          .locator('[data-press]')
          .click({ timeout: 3000 })
          .catch(() => {});
        await page.waitForTimeout(200);
        const after = await dialogNow();
        if (!before && after) openers.set(after, target);
        // Gone elsewhere (a row opened its page): back.
        if (!page.url().includes(url.split('?')[0]!)) await open();
        // The dialog went with that press: open it again (a few times at most) for its other buttons.
        if (before && !(await dialogNow()) && openers.has(before) && (reopened.get(before) ?? 0) < 15) {
          reopened.set(before, (reopened.get(before) ?? 0) + 1);
          const opener = openers.get(before)!;
          await page.evaluate((want) => {
            const id = (window as unknown as { __controlId: (el: Element) => string | null }).__controlId;
            const el = [...document.querySelectorAll<HTMLElement>('button, [role=button], a[href], summary')].find((x) => x.offsetParent !== null && id(x) === want);
            el?.click();
          }, opener);
          await page.waitForTimeout(400);
        }
      }
    });
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
