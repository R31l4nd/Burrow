import { chromium, type Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './passkey.js';

// The same app in Firefox and WebKit (Safari), on a computer and as a phone:
// the rest of the tests run in Chromium only. Reported from Firefox on a
// phone: a finger's scroll in `tmux attach` pulled the page to reload.
//
// Passkeys in these tests come from Chromium's virtual authenticator, which
// the others do not have: a Chromium page signs in and hands its session
// cookie over.

test.describe.configure({ mode: 'serial' });

async function signInHere(page: Page): Promise<void> {
  const browser = await chromium.launch();
  try {
    const other = await browser.newPage({ baseURL: test.info().project.use.baseURL });
    await signIn(other);
    // By URL, not domain: WebKit leaves a cookie for the bare "localhost" domain out.
    const base = test.info().project.use.baseURL ?? 'http://localhost:8190';
    await page.context().addCookies((await other.context().cookies()).map(({ name, value, httpOnly, secure, sameSite, expires }) => ({ name, value, httpOnly, secure, sameSite, expires, url: base })));
  } finally {
    await browser.close();
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
}

const errors = (page: Page) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  return list;
};

test('the main pages show without errors', async ({ page }) => {
  const seen = errors(page);
  await signInHere(page);
  await expect(page.getByTestId('host-row').filter({ hasText: 'test-sshd' }).first()).toBeVisible();
  for (const [hash, heading] of [
    ['#/term', 'Sessions'],
    ['#/files', 'Files'],
    ['#/containers', 'Containers'],
    ['#/settings', 'Settings'],
    ['#/alerts', 'Alerts'],
  ] as const) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }
  expect(seen).toEqual([]);
});

test('Ctrl+Shift+B reports the screen from any page in this browser too (Firefox keeps the key for its bookmarks bar unless the page takes it)', async ({ page }) => {
  await signInHere(page);
  await page.goto('/#/alerts');
  await expect(page.getByRole('heading', { name: 'Alerts' }).first()).toBeVisible();
  await page.keyboard.press('Control+Shift+B');
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  // The screenshot is taken first: over 5 s in Firefox on a busy machine (the 2.24.0 gate).
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toBeHidden();
});

test('a terminal: typed into, its answer, a finger scroll that stays in it', async ({ page, browserName }) => {
  const seen = errors(page);
  await signInHere(page);
  // A session of its own (a host opens the one used last there).
  const s = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[];
    const r = await fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: hosts.find((h) => h.name === 'test-sshd')!.id, tmux: 'never' }) });
    return (await r.json()) as { id: string };
  });
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.getByTestId('terminal').click();
  await page.keyboard.type(`echo ${browserName}-$((6*7))\n`);
  await expect(rows).toContainText(`${browserName}-42`);
  // A program with the mouse on (as tmux attach): the finger's moves are the
  // terminal's, never the page's (where a browser pulls to reload).
  if (test.info().project.use.hasTouch) {
    await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'; sleep 30\n");
    await page.waitForTimeout(500);
    const prevented = await page.evaluate(async () => {
      const term = document.querySelector<HTMLElement>('[data-testid=terminal]')!;
      const box = term.getBoundingClientRect();
      const x = box.left + box.width / 2;
      // WebKit has no Touch constructor: an event with the same fields does
      // (a passive listener cannot stop it either way).
      const make = (type: string, y: number): Event => {
        const t = { identifier: 9, target: term, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
        const touches = type === 'touchend' ? [] : [t];
        if (typeof Touch === 'function' && typeof TouchEvent === 'function') {
          try {
            const real = (y2: number) => new Touch({ ...t, clientY: y2 });
            return new TouchEvent(type, { touches: touches.map(() => real(y)), changedTouches: [real(y)], bubbles: true, cancelable: true });
          } catch {
            // Fall through to the plain event.
          }
        }
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(e, { touches: { value: touches }, changedTouches: { value: [t] }, targetTouches: { value: touches } });
        return e;
      };
      const send = (type: string, y: number) => {
        const e = make(type, y);
        term.dispatchEvent(e);
        return e.defaultPrevented;
      };
      send('touchstart', box.top + 40);
      const moves: boolean[] = [];
      for (let y = box.top + 60; y <= box.top + 200; y += 20) {
        moves.push(send('touchmove', y));
        await new Promise((w) => setTimeout(w, 16));
      }
      send('touchend', box.top + 200);
      return moves;
    });
    expect(prevented.every(Boolean), JSON.stringify(prevented)).toBe(true);
    // The glide after the flick ends, then the program and its mouse mode.
    await page.waitForTimeout(1500);
    await page.keyboard.press('Control+C');
    await page.keyboard.type("printf '\\033[?1000l\\033[?1006l'\n");
  }
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
  expect(seen).toEqual([]);
});

test('a file: listed, opened in the editor, saved', async ({ page }) => {
  const seen = errors(page);
  await signInHere(page);
  const hosts = await page.evaluate(async () => (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]);
  const sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  const path = `/home/tester/${test.info().project.name}.txt`;
  await page.evaluate(
    async ([id, p]) => {
      const r = await fetch(`/api/files/${id}/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p, content: 'first\n', baseHash: null }) });
      if (!r.ok) throw new Error(await r.text());
    },
    [sshd, path] as const,
  );
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester`);
  await expect(page.getByTestId('file-row').filter({ hasText: `${test.info().project.name}.txt` })).toBeVisible();
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent(path)}`);
  await expect(page.locator('.cm-content')).toContainText('first');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('second');
  // The save button, as on a phone (an iPhone's Ctrl+S is Cmd+S there).
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => page.evaluate(async ([id, p]) => ((await (await fetch(`/api/files/${id}/text?path=${encodeURIComponent(p)}`)).json()) as { content: string }).content, [sshd, path] as const))
    .toContain('second');
  expect(seen).toEqual([]);
});

test('open files reordered by a drag in this browser too (review 2026-10-24: Firefox starts no drag without data)', async ({ page }) => {
  test.skip(!!test.info().project.use.hasTouch, 'a drag of tabs is a computer\'s');
  await signInHere(page);
  const hosts = await page.evaluate(async () => (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]);
  const sshd = hosts.find((h) => h.name === 'test-sshd')!.id;
  const dir = `/home/tester/drag-${test.info().project.name}`;
  const ws = await page.evaluate(
    async ([id, d]) => {
      await fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: `rm -rf ${d} && mkdir -p ${d} && for f in one two three; do echo $f > ${d}/$f.txt; done` }) });
      const r = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, root: d }) });
      return ((await r.json()) as { id: number }).id;
    },
    [sshd, dir] as const,
  );
  await page.evaluate((id) => localStorage.setItem(`burrow.ws.${id}`, JSON.stringify({ tabs: ['one.txt', 'two.txt', 'three.txt'], current: 'one.txt' })), ws);
  await page.goto(`/#/ws/${ws}`);
  const tabs = page.getByTestId('ws-tab');
  await expect(tabs).toHaveText(['one.txt', 'two.txt', 'three.txt']);
  await page.getByTestId('ws-tabbar-item').nth(2).dragTo(page.getByTestId('ws-tabbar-item').nth(0));
  await expect(tabs).toHaveText(['three.txt', 'one.txt', 'two.txt']);
  await page.evaluate((id) => fetch(`/api/workspaces/${id}`, { method: 'DELETE' }), ws);
});
