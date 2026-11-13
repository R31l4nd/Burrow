import { expect, test } from './fixtures.js';
import { signIn } from './passkey.js';
import { lookAt } from './checks.js';
import type { Page } from '@playwright/test';

/**
 * A host of this spec's own, the test sshd under another name: a tap or
 * Enter on a host goes back to its last session, and on test-sshd that was
 * one the tour or the sizes (beside this spec) keep open: typed into and
 * resized by both (AUDIT2 TEST-02).
 */
async function ownHost(page: Page): Promise<void> {
  const made = await page.evaluate(async () => {
    const hosts = (await (await fetch('/api/hosts')).json()) as { name: string; address: string; port: number | null }[];
    if (hosts.some((h) => h.name === 'mobile-sshd')) return false;
    const s = hosts.find((h) => h.name === 'test-sshd')!;
    const r = await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'mobile-sshd', address: s.address, port: s.port, username: 'tester', authMethod: 'password', password: 'burrow-test-password' }) });
    if (!r.ok) throw new Error(`mobile-sshd: ${r.status}`);
    return true;
  });
  // The page read its hosts before: again, with the new one.
  if (made) {
    await page.reload();
    await expect(page.getByPlaceholder('Search name, address or tag')).toBeVisible();
  }
}

test('works on a phone: sign in, search, open a host', async ({ page }) => {
  // Many pages in one go (every Settings page's buttons among them): 27-29 s of the default 30, 35 s on a busy gate.
  test.setTimeout(90_000);
  await signIn(page);
  // No horizontal scrolling at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Search, Enter: straight into the terminal of that host.
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Extra keys' })).toBeVisible();

  // A connection error opens the host menu (a modal dialog); its message
  // must show above that dialog, not behind it.
  await page.evaluate(async () => {
    await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'no-key', address: '127.0.0.1', username: 'x', authMethod: 'key' }) });
  });
  await page.goto('/#/hosts');
  await page.getByRole('button', { name: /^no-key/ }).first().tap();
  await expect(page.getByRole('dialog', { name: 'no-key' })).toBeVisible();
  const alert = page.getByTestId('toasts').getByRole('alert');
  await expect(alert).toContainText('Choose a key');
  // It is in the top layer, shown after the dialog (so drawn above it).
  // Hit-testing cannot show that: outside a modal dialog the page is inert.
  expect(await alert.evaluate((el) => el.closest('[popover]')!.matches(':popover-open'))).toBe(true);
  await page.getByRole('button', { name: 'Close' }).tap();
  await page.goto('/#/hosts');
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal')).toBeVisible();
  // A session of its own: the host's last one may be on another test's
  // screen at the same time, and then that screen sets its size.
  const reused = page.url();
  await page.getByTestId('term-new').tap();
  await expect(page).not.toHaveURL(reused);
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });

  // Compose mode: type in a text box, send the whole line at once.
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').check();
  // One line: the box is as tall as the send button next to it, also with a
  // placeholder too long for the width (as in Dutch on a narrow phone).
  await page.getByTestId('compose').evaluate((el) => {
    (el as HTMLTextAreaElement).placeholder = 'Een heel lange voorbeeldtekst die op een smal scherm zeker over meerdere regels zou lopen';
    el.dispatchEvent(new Event('input'));
  });
  const box = (await page.getByTestId('compose').boundingBox())!;
  const send = (await page.getByTestId('compose-send').boundingBox())!;
  expect(Math.abs(box.height - send.height)).toBeLessThanOrEqual(1);
  // And one line of the terminal's font high, not more (report 03f3f5: a
  // small font in a box that looked empty).
  const font = await page.getByTestId('compose').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(box.height, `one line of ${font}px`).toBeLessThanOrEqual(Math.max(28, Math.round(font * 1.4) + 10) + 1);
  // Several lines: the box grows, and the send button with it (it stayed one
  // line high at the bottom, reported more than once).
  await page.getByTestId('compose').fill('een\ntwee\ndrie\nvier');
  await expect.poll(async () => (await page.getByTestId('compose').boundingBox())!.height).toBeGreaterThan(box.height + 40);
  const tall = (await page.getByTestId('compose').boundingBox())!;
  const tallSend = (await page.getByTestId('compose-send').boundingBox())!;
  expect(Math.abs(tall.height - tallSend.height), 'send button as tall as the grown box').toBeLessThanOrEqual(1);
  expect(Math.abs(tall.y - tallSend.y), 'send button level with the grown box').toBeLessThanOrEqual(1);
  // The terminal gave up the room: as many rows as the session runs at, and
  // nothing to scroll into below them (empty rows under a tmux, reported).
  const sessionId = page.url().split('/term/')[1]!.split('?')[0];
  await expect
    .poll(async () => {
      const shown = await page.locator('[data-testid=terminal] .xterm-rows > div').count();
      const s = await page.evaluate(async (id) => (await (await fetch(`/api/terminal/sessions/${id}`)).json()) as { rows: number }, sessionId);
      return shown - s.rows;
    })
    .toBe(0);
  // Fitted once the box has settled (TermView's SETTLE_MS on a touch screen, report b00aad).
  await expect.poll(() => page.locator('.term-wrap').evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1);
  await page.getByTestId('compose').fill('echo composed-$((20+22))');
  await page.getByTestId('compose-send').tap();
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('composed-42');
  await expect(page.getByTestId('compose')).toHaveValue('');
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').uncheck();
  await expect(page.getByTestId('compose')).toHaveCount(0);

  // Starting a swipe on a key to scroll the bar does not press it: the
  // browser cancels the pointer when it starts scrolling, and no click follows.
  const ctrlKey = page.getByRole('toolbar', { name: 'Extra keys' }).getByRole('button', { name: 'Ctrl' });
  await ctrlKey.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await ctrlKey.dispatchEvent('pointercancel', { pointerType: 'touch', isPrimary: true });
  await expect(ctrlKey).not.toHaveClass(/\bon\b/);
  await ctrlKey.tap();
  await expect(ctrlKey).toHaveClass(/\bon\b/);
  await ctrlKey.tap();

  // Backspace from an Android soft keyboard arrives as a beforeinput event,
  // not a key press. Simulate one on an empty input line.
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await page.getByTestId('terminal').click();
  await page.keyboard.type('echo keep-this-X');
  const softBackspace = () =>
    page.locator('.xterm-helper-textarea').evaluate((ta) => {
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    });
  await softBackspace();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await rows.innerText()).split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim()))
    .toContain('keep-this-');
  await page.getByRole('button', { name: 'Hosts' }).tap();

  // The host menu is a sheet; no Esc key on a phone: the close button and
  // the backdrop close it.
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().tap();
  await expect(page.getByRole('dialog', { name: 'test-sshd' })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).tap();
  await expect(page.getByTestId('test-ok')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).tap();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().tap();
  await expect(page.getByRole('dialog', { name: 'test-sshd' })).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(page.getByRole('dialog')).toBeHidden();

  // Bottom navigation is reachable; the key vault sits under Settings.
  await page.getByRole('link', { name: 'Files' }).tap();
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).tap();
  await page.getByRole('button', { name: /^Key vault/ }).tap();
  await expect(page.getByRole('heading', { name: 'Key vault' })).toBeVisible();

  // Help tips stay on screen, also the ones at the right edge of a field.
  await page.getByRole('link', { name: 'Settings' }).tap();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // The five tabs are equally wide and centred, also with the longer Dutch
  // labels ("Instellingen" once pushed the row to the right).
  await page.getByTestId('settings-section').filter({ hasText: 'Appearance' }).tap();
  for (const lang of ['nl', 'en']) {
    await page.getByRole('combobox', { name: lang === 'nl' ? 'Language' : 'Taal', exact: true }).selectOption(lang);
    const boxes = await page.locator('nav.bottomnav a').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, w: r.width })));
    const vw = page.viewportSize()!.width;
    expect(boxes).toHaveLength(5);
    for (const b of boxes) expect(Math.abs(b.w - vw / 5), `tab width (${lang})`).toBeLessThan(1);
    expect(Math.abs(boxes[0]!.x), `row start (${lang})`).toBeLessThan(1);
  }

  // On every part of Settings that has them.
  let seenTips = 0;
  for (const part of ['appearance', 'terminal', 'notify', 'ai', 'channels', 'updates', 'users', 'sso', 'android', 'security', 'backups', 'about']) {
    await page.goto(`/#/settings/${part}`);
    await expect(page.locator(`h2#${part}`)).toBeVisible();
    const tips = page.getByRole('button', { name: 'Help' });
    for (let i = 0; i < (await tips.count()); i++) {
      await tips.nth(i).scrollIntoViewIfNeeded();
      await tips.nth(i).tap();
      const box = await page.getByRole('note').boundingBox();
      const vw = page.viewportSize()!.width;
      expect(box, `help tip ${part} ${i}`).not.toBeNull();
      expect(box!.x, `help tip ${part} ${i} left edge`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `help tip ${part} ${i} right edge`).toBeLessThanOrEqual(vw);
      await tips.nth(i).tap();
      seenTips++;
    }
  }
  expect(seenTips, 'help tips looked at in Settings').toBeGreaterThan(8);

  // Consistent buttons: every content button fills its column (page or card).
  for (const section of ['keys', 'settings', 'settings/terminal', 'settings/channels', 'settings/android', 'settings/security', 'settings/about', 'files/1']) {
    await page.goto(`/#/${section}`);
    await page.waitForTimeout(300);
    const misfits = await page.locator('.page .btn').evaluateAll((els) =>
      els
        // Rows of small buttons (the section jumps) are meant to sit side by side.
        .filter((e) => !e.closest('.topbar, .list-item, .toolbar, dialog, .jump'))
        .filter((e) => {
          const parent = e.parentElement!;
          const cs = getComputedStyle(parent);
          const inner = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          // Buttons in a row share it: the row's last one ends at its edge.
          if (parent.classList.contains('row')) {
            const r = e.getBoundingClientRect();
            const edge = parent.getBoundingClientRect().right - parseFloat(cs.paddingRight);
            const lastOnLine = ![...parent.children].some((o) => { const b = o.getBoundingClientRect(); return o !== e && b.top < r.bottom && b.bottom > r.top && b.left > r.left; });
            return lastOnLine && Math.abs(r.right - edge) > 1;
          }
          return Math.abs(e.getBoundingClientRect().width - inner) > 1;
        })
        .map((e) => e.textContent?.trim()),
    );
    expect(misfits, `buttons not spanning their column on ${section}`).toEqual([]);
  }
});

test('pulled down at the top, a list reads again', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/containers');
  await expect(page.getByTestId('container-row').first()).toBeVisible({ timeout: 30_000 });
  const asked: string[] = [];
  page.on('request', (r) => r.url().includes('/containers') && r.url().includes('/api/docker/') && asked.push(r.url()));
  // A finger from near the top, down 250 px, let go.
  await page.evaluate(async () => {
    const touch = (y: number) => new Touch({ identifier: 7, target: document.body, clientX: 180, clientY: y });
    const send = (type: string, y: number) =>
      document.body.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
    send('touchstart', 120);
    for (let y = 140; y <= 370; y += 30) {
      send('touchmove', y);
      await new Promise((w) => setTimeout(w, 16));
    }
  });
  await expect(page.getByTestId('pull')).toContainText('Let go to refresh');
  await page.evaluate(() => {
    const t = new Touch({ identifier: 7, target: document.body, clientX: 180, clientY: 370 });
    document.body.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
  });
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  await expect(page.getByTestId('pull')).toHaveCount(0, { timeout: 10_000 });
});

test("a finger's scroll in Burrow's tmux: the whole history at once in a layer the phone scrolls itself, back to live at its bottom or by the button (2.19.0)", async ({ page }) => {
  // Each step of a finger was a tmux command over SSH and a redraw back: a few frames a second,
  // "as if the screen had a low refresh rate" (report 2026-11-05).
  const sent: string[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/api/terminal/sessions/')) return;
    ws.on('framesent', (f) => {
      try {
        sent.push((JSON.parse(String(f.payload)) as { t: string }).t);
      } catch {
        // not ours
      }
    });
  });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'always' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.getByTestId('terminal').click();
  // Output still to come while the history is open.
  await page.keyboard.type('seq 1 300; (sleep 3; echo late-$((6*7))) &\n');
  await expect(rows).toContainText('299');
  const layer = page.getByTestId('term-history');
  // A slow swipe down (back): the history comes once, and opens where the finger got to.
  const swipe = (dy: number) =>
    page.getByTestId('terminal').evaluate(async (el, d) => {
      const r = el.getBoundingClientRect();
      const touch = (y: number) => new Touch({ identifier: 5, target: el, clientX: r.left + r.width / 2, clientY: y });
      const top = r.top + 30;
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(top)], changedTouches: [touch(top)], bubbles: true, cancelable: true }));
      for (let y = top; y <= top + d; y += 4) {
        el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
        await new Promise((w) => setTimeout(w, 30));
      }
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(top + d)], bubbles: true, cancelable: true }));
    }, dy);
  await swipe(120);
  await expect(layer).toBeVisible();
  expect(sent.filter((t) => t === 'history')).toHaveLength(1);
  expect(sent).not.toContain('scroll');
  expect([...(await layer.locator('.line').allTextContents())]).toContain('1');
  // Above its bottom by about what the finger moved, to the pixel (not a line at a time).
  const fromBottom = () => layer.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(fromBottom).toBeGreaterThan(60);
  // The phone's own scrolling from here: the layer's, not the terminal's.
  await layer.evaluate((el) => el.scrollBy(0, -200));
  await expect.poll(fromBottom).toBeGreaterThan(200);
  // Output that came meanwhile: the button says so.
  await expect(page.getByTestId('term-history-live')).toHaveClass(/newer/, { timeout: 10_000 });
  await lookAt(page, 'phone-terminal-history');
  // Scrolled back to its bottom: live again, the late line there.
  await layer.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(layer).toHaveCount(0);
  await expect(rows).toContainText('late-42');
  // Again, and "Back to live".
  await swipe(80);
  await expect(layer).toBeVisible();
  await page.getByTestId('term-history-live').tap();
  await expect(layer).toHaveCount(0);
  // Nothing of it went to tmux: no pane in its copy mode.
  const modes = await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: "tmux -L burrow list-panes -a -F '#{pane_in_mode}'" }) }).then((r) => r.json() as Promise<{ stdout: string }[]>), hostId);
  expect(modes[0]!.stdout.split('\n').filter(Boolean)).not.toContain('1');
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});

test("typing right after a flick in a tmux session: the glide stops, no scroll goes after the first key", async ({ page }) => {
  // Audit BR-01: the glide went on scrolling tmux after typing began, and the
  // typed text ended in tmux's copy mode, not at the prompt.
  const sent: { t: string; at: number }[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/api/terminal/sessions/')) return;
    ws.on('framesent', (f) => {
      try {
        sent.push({ t: (JSON.parse(String(f.payload)) as { t: string }).t, at: Date.now() });
      } catch {
        // not ours
      }
    });
  });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'always' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.getByTestId('terminal').click();
  await page.keyboard.type('seq 1 300\n');
  await expect(rows).toContainText('299');
  // A quick flick down (back in history), let go while moving: it glides on.
  // The first key comes straight after.
  const from = sent.length;
  await page.getByTestId('terminal').evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const touch = (y: number) => new Touch({ identifier: 6, target: el, clientX: r.left + r.width / 2, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(r.top + 40)], changedTouches: [touch(r.top + 40)], bubbles: true, cancelable: true }));
    let y = r.top + 40;
    for (; y < r.top + 240; y += 40) {
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
      await new Promise((w) => setTimeout(w, 16));
    }
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
    await new Promise((w) => setTimeout(w, 60));
  });
  await page.keyboard.type('echo after-$((5*5))');
  await page.waitForTimeout(1500);
  const firstInput = sent.findIndex((m, i) => i >= from && m.t === 'input');
  expect(firstInput).toBeGreaterThan(-1);
  // The flick asked for the history once (its layer, 2.19.0), and nothing went to tmux after the first key.
  expect(sent.slice(from, firstInput).filter((m) => m.t === 'history')).toHaveLength(1);
  expect(sent.slice(firstInput).filter((m) => m.t === 'scroll' || m.t === 'history')).toHaveLength(0);
  await expect(page.getByTestId('term-history')).toHaveCount(0);
  // And the typed line is at the prompt: Enter runs it.
  await page.keyboard.press('Enter');
  await expect(rows).toContainText('after-25');
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});

test("a phone keyboard's corrections reach the shell once", async ({ page }) => {
  await signIn(page);
  // A plain shell of its own: the host's tmux setting and sessions other
  // specs left open (a finger's scroll is tmux's copy mode there) play no part.
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$');
  // As Gboard types: a keydown with keyCode 229 ("composing"), then the
  // textarea changes and an input event says how. Then a correction that
  // rewrites the word ("wrld" -> "world"): xterm.js sent the line again for it.
  await page.evaluate(async () => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    ta.focus();
    const edit = async (value: string, inputType: string, data: string | null) => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Unidentified', bubbles: true } as KeyboardEventInit));
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }));
      ta.value = value;
      ta.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true }));
      await new Promise((w) => setTimeout(w, 30));
    };
    let v = '';
    for (const ch of 'echo gboard-wrld') await edit((v += ch), 'insertText', ch);
    await edit('echo gboard-world', 'insertReplacementText', 'gboard-world');
    await edit('echo gboard-world ', 'insertText', ' ');
    // Enter as Gboard sends it: a line break, no key.
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true }));
  });
  // The line typed once (its echo on the next line), nothing sent twice.
  const lines = async () => (await rows.innerText()).split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim());
  await expect.poll(lines).toContain('gboard-world');
  expect((await rows.innerText()).match(/gboard-w/g)).toHaveLength(2);
  // One finger scrolls back through a plain shell's history (it did not).
  await page.keyboard.type('seq 1 300\n');
  await expect(rows).toContainText('299');
  const firstNumber = () => rows.evaluate((r) => Math.min(...[...r.children].map((d) => (/^\d+$/.test(d.textContent!.trim()) ? Number(d.textContent) : 9999))));
  const before = await firstNumber();
  await page.getByTestId('terminal').evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const touch = (y: number) => new Touch({ identifier: 5, target: el, clientX: r.left + r.width / 2, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(r.top + 40)], changedTouches: [touch(r.top + 40)], bubbles: true, cancelable: true }));
    for (let y = r.top + 40; y < r.bottom - 40; y += 12) {
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
      await new Promise((w) => setTimeout(w, 16));
    }
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(r.bottom - 40)], bubbles: true, cancelable: true }));
  });
  // A plain shell's history comes in the layer too (2.19.0), its earlier lines there.
  const layer = page.getByTestId('term-history');
  await expect(layer).toBeVisible();
  const shown = () => layer.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const seen = [...el.querySelectorAll<HTMLElement>('.line')].filter((l) => { const r = l.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
    return Math.min(...seen.map((l) => (/^\d+$/.test(l.textContent!.trim()) ? Number(l.textContent) : 9999)));
  });
  await expect.poll(shown).toBeLessThan(before - 3);
  // Back to live for what follows.
  await layer.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(layer).toHaveCount(0);

  // Typed straight into the terminal on a phone: the suggestions come
  // (they did not since the keyboard's typing is read here, 1.5.1).
  await page.evaluate(async () => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    let v = ta.value;
    for (const ch of 'echo gbo') {
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Unidentified', bubbles: true } as KeyboardEventInit));
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true }));
      ta.value = v += ch;
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
      await new Promise((w) => setTimeout(w, 30));
    }
  });
  await expect(page.getByTestId('suggestions')).toContainText('echo gboard-world');
  // The same with the text box open but typed straight into the terminal
  // (reported: the suggestions looked only at the empty box).
  await page.keyboard.press('Control+U');
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').check();
  await expect(page.getByTestId('compose')).toBeVisible();
  await page.evaluate(async () => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    ta.focus();
    let v = ta.value;
    for (const ch of 'echo gbo') {
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true }));
      ta.value = v += ch;
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
      await new Promise((w) => setTimeout(w, 30));
    }
  });
  await expect(page.getByTestId('suggestions')).toContainText('echo gboard-world');
  // The suggestions in the terminal's own font size and as tall as the text box beside the
  // keys, not larger and brighter than the terminal (report c02b7a).
  const sizes = await page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('[data-testid=suggestions] [role=option]')!;
    const box = document.querySelector<HTMLElement>('textarea[data-testid=compose]')!;
    return { chip: getComputedStyle(chip).fontSize, chipHeight: Math.round(chip.getBoundingClientRect().height), box: getComputedStyle(box).fontSize, boxHeight: Math.round(box.getBoundingClientRect().height) };
  });
  expect({ font: sizes.chip, height: sizes.chipHeight }).toEqual({ font: sizes.box, height: sizes.boxHeight });
  await page.keyboard.press('Control+U');
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').uncheck();
});

test("typed as Android's keyboard types: exactly that reaches the shell, and a report's recording holds the keyboard's own events", async ({ page }) => {
  // Report 117251: "0/logout" on Claude Code's input line after typing "0",
  // "0", two backspaces and "/logout". What Burrow sent was right; Claude
  // Code drew the first key one column left (anthropics/claude-code #78737).
  // But the report's recording held only the real keys: the keyboard's own
  // events (229, input, composition) were stopped before the recorder saw
  // them, so its replay typed "00" and two backspaces, nothing more.
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.locator('[data-testid=terminal] textarea').focus();
  // The shell shows every byte that reaches it, as is.
  await page.keyboard.type('stty raw -echo; head -c 13 | od -An -c; stty sane; echo od-done\n');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    const pause = () => new Promise((w) => setTimeout(w, 30));
    // A digit as Gboard sends it in a password-like field: a real key.
    const key = async (keyCode: number, key: string) => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode, key, bubbles: true, cancelable: true } as KeyboardEventInit));
      ta.dispatchEvent(new KeyboardEvent('keyup', { keyCode, key, bubbles: true, cancelable: true } as KeyboardEventInit));
      await pause();
    };
    // Text committed by the keyboard: 229, then the field changes.
    const edit = async (value: string, inputType: string, data: string | null, isComposing = false) => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Unidentified', isComposing, bubbles: true } as KeyboardEventInit));
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType, data, isComposing, bubbles: true, cancelable: true }));
      ta.value = value;
      ta.dispatchEvent(new InputEvent('input', { inputType, data, isComposing, bubbles: true }));
      await pause();
    };
    await key(48, '0');
    await key(48, '0');
    await key(8, 'Backspace');
    await key(8, 'Backspace');
    await edit('/', 'insertText', '/');
    // A word composed (underlined while typed), a typo taken back inside it.
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const w of ['l', 'lo', 'log', 'logo', 'logoi', 'logo', 'logou', 'logout']) {
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: w, bubbles: true }));
      await edit(`/${w}`, 'insertCompositionText', w, true);
    }
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'logout', bubbles: true }));
    await pause();
  });
  // Byte for byte: the two zeros, two backspaces, the slash, the word with its typo taken back once.
  const flat = async () => (await rows.innerText()).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  await expect.poll(flat).toContain('0 0 177 177 / l o g o i 177 u t');
  await expect(rows).toContainText('od-done');
  // A report from here: its recording has what the keyboard did, not only the real keys.
  await page.route('**/api/bugreports', (r) => (r.request().method() === 'POST' ? r.fulfill({ json: { id: 'not-kept' } }) : r.fallback()));
  await page.keyboard.press('Control+Shift+B');
  // The keys taken: the page is being drawn for the report's picture, or the
  // form is up already. The form comes once the picture is drawn: a phone's
  // terminal page: no form within 5 s beside the tour (gate 38), 11 s on a CPU 8x slower.
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('capturing') || !!document.querySelector('dialog[open]')), { timeout: 5_000 }).toBe(true);
  const form = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByTestId('bug-typed').check();
  await form.getByTestId('bug-text').fill('Typed as a keyboard app does.');
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/bugreports') && r.method() === 'POST');
  await form.getByTestId('bug-send').click();
  const rec = ((await posted).postDataJSON() as { recording: { entries: { e: string; inputType?: string; text?: string; keyCode?: number }[] } }).recording;
  await page.unroute('**/api/bugreports');
  const kinds = rec.entries.map((x) => (x.inputType ? `${x.e} ${x.inputType}` : x.e));
  for (const k of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput insertText', 'input insertText', 'input insertCompositionText']) expect(kinds, k).toContain(k);
  expect(rec.entries.some((x) => x.e === 'keydown' && x.keyCode === 229)).toBe(true);
  expect(rec.entries.filter((x) => x.e === 'sent').map((x) => x.text).join('')).toContain('00\x7f\x7f/logoi\x7fut');
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});

test('held on the text: a word selected, copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  // The reporting phone's width.
  await page.setViewportSize({ width: 343, height: 711 });
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$');
  await page.getByTestId('terminal').tap();
  await page.keyboard.type('clear; echo pickme-$((40+2)) and-more\n');
  await expect(rows).toContainText('pickme-42');
  await page.getByTestId('terminal').evaluate(async (el) => {
    // Hold a finger on the word, as a person would.
    const line = [...el.querySelectorAll('.xterm-rows > div')].find((d) => /^pickme-42/.test(d.textContent ?? ''))!;
    const r = line.getBoundingClientRect();
    const t = new Touch({ identifier: 3, target: el, clientX: r.left + 20, clientY: r.top + r.height / 2 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
    await new Promise((w) => setTimeout(w, 700));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('term-pickbar')).toBeVisible();
  // Whole on the screen (four buttons in a row ran off a 343 px phone).
  const bar = (await page.getByTestId('term-pickbar').boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // A grip under each end; the end's grip dragged to the right takes the
  // rest of the line (reported: the selection could not be made bigger).
  await expect(page.getByTestId('term-grip')).toHaveCount(2);
  await page.getByTestId('terminal').evaluate(async (el) => {
    const grip = document.querySelector<HTMLElement>('[data-testid=term-grip].to')!;
    const g = grip.getBoundingClientRect();
    const line = [...el.querySelectorAll('.xterm-rows > div')].find((d) => /^pickme-42/.test(d.textContent ?? ''))!.getBoundingClientRect();
    const touch = (x: number) => new Touch({ identifier: 4, target: grip, clientX: x, clientY: g.top + g.height / 2 });
    grip.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(g.left + g.width / 2)], changedTouches: [touch(g.left + g.width / 2)], bubbles: true, cancelable: true }));
    for (let x = g.left + g.width / 2; x < line.right - 4; x += 20) {
      grip.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(x)], changedTouches: [touch(x)], bubbles: true, cancelable: true }));
      await new Promise((w) => setTimeout(w, 16));
    }
    grip.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(line.right - 4)], bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('term-pickbar')).toBeVisible();
  await page.getByTestId('term-copy').tap();
  await expect(page.getByText('Copied')).toBeVisible();
  await expect(page.getByTestId('term-pickbar')).toHaveCount(0);
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe('pickme-42 and-more');
});

test("in the app: Android's own menu over the selection, its picks done by the page", async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Signed in as in a browser first (the app's own sign-in is its own test).
  await signIn(page);
  // A stand-in for the app's bridge: it says it has the menu, keeps what the
  // page asks of it, and can send a pick back as the app would.
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __menu: unknown[]; __pick: (a: string) => void };
    w.__menu = [];
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        let result: unknown = null;
        if (method === 'info') result = { version: '1.8.0', versionCode: 10800, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: true, selectionMenu: true };
        else if (method === 'selectionMenu') w.__menu.push(params);
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.__pick = (a) => port.onmessage?.({ data: JSON.stringify({ event: 'selectionAction', data: a }) });
    w.BurrowAndroid = port;
  });
  // A new page load, so the stand-in is there from the start.
  await page.reload();
  await page.setViewportSize({ width: 343, height: 711 });
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$');
  await page.getByTestId('terminal').tap();
  await page.keyboard.type('clear; echo native-$((40+2)) menu\n');
  await expect(rows).toContainText('native-42');
  const hold = () =>
    page.getByTestId('terminal').evaluate(async (el) => {
      const line = [...el.querySelectorAll('.xterm-rows > div')].find((d) => /^native-42/.test(d.textContent ?? ''))!;
      const r = line.getBoundingClientRect();
      const t = new Touch({ identifier: 5, target: el, clientX: r.left + 20, clientY: r.top + r.height / 2 });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
      await new Promise((w) => setTimeout(w, 700));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
      return { top: r.top, bottom: r.bottom };
    });
  const menu = () => page.evaluate(() => (window as unknown as { __menu: { x?: number; y?: number; w?: number; h?: number }[] }).__menu);
  const line = await hold();
  // Android's menu over the word's row, not the page's own bar.
  await expect.poll(async () => (await menu()).at(-1)?.w ?? 0).toBeGreaterThan(0);
  const box = (await menu()).at(-1)!;
  expect(box.y!).toBeGreaterThanOrEqual(line.top - 2);
  expect(box.y! + box.h!).toBeLessThanOrEqual(line.bottom + 2);
  await expect(page.getByTestId('term-pickbar')).toHaveCount(0);
  await expect(page.getByTestId('term-grip')).toHaveCount(2);
  // "Copy" picked in Android's menu: the word on the clipboard, the selection and the menu gone.
  await page.evaluate(() => (window as unknown as { __pick: (a: string) => void }).__pick('copy'));
  await expect(page.getByText('Copied')).toBeVisible();
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe('native-42');
  await expect(page.getByTestId('term-grip')).toHaveCount(0);
  await expect.poll(async () => (await menu()).at(-1)).toEqual({});
  // "Select all": the whole of it selected, the menu over the terminal's box.
  await hold();
  await expect.poll(async () => (await menu()).at(-1)?.w ?? 0).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { __pick: (a: string) => void }).__pick('all'));
  await expect.poll(async () => (await menu()).at(-1)?.h ?? 0).toBeGreaterThan(line.bottom - line.top + 4);
  // Dismissed by Android itself (a tap outside): the selection goes too.
  await page.evaluate(() => (window as unknown as { __pick: (a: string) => void }).__pick('close'));
  await expect(page.getByTestId('term-grip')).toHaveCount(0);
  // "Paste": what is on the clipboard goes to the shell.
  await page.evaluate(() => navigator.clipboard.writeText('echo pasted-$((6*7))'));
  await hold();
  await expect.poll(async () => (await menu()).at(-1)?.w ?? 0).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { __pick: (a: string) => void }).__pick('paste'));
  await page.keyboard.press('Enter');
  await expect(rows).toContainText('pasted-42');
});

test('away from a terminal with the keyboard up: no error on the way out', async ({ page }) => {
  await signIn(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  // The terminal has the keyboard (its field the focus), then another page.
  await page.getByTestId('terminal').tap();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // Leaving took the field away while it had the focus: its blur changed state mid-teardown.
  expect(errors).toEqual([]);
});

test('what is typed in the text box stays there while another tab is in front (report e55d04)', async ({ page }) => {
  // Reported: typed in the text box, to another tab and back, and it was gone.
  // Two shells opened, each up to 20 s on a busy machine: more than the default 30 s in all (a gate's NOTE).
  test.setTimeout(60_000);
  await signIn(page);
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  const first = new URL(page.url()).hash;
  await page.getByTestId('term-new').tap();
  await expect.poll(() => new URL(page.url()).hash).not.toBe(first);
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  const second = new URL(page.url()).hash;
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').check();
  await page.getByTestId('compose').fill('echo half-typed');
  // The other tab: its own box, empty.
  await page.evaluate((to) => (location.hash = to), first);
  await expect(page).toHaveURL(new RegExp(`${first}$`));
  await expect(page.getByTestId('compose')).toHaveValue('');
  await page.getByTestId('compose').fill('echo other');
  // Back: each box as it was left, nothing sent.
  await page.evaluate((to) => (location.hash = to), second);
  await expect(page.getByTestId('compose')).toHaveValue('echo half-typed');
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).not.toContainText('half-typed');
  await page.evaluate((to) => (location.hash = to), first);
  await expect(page.getByTestId('compose')).toHaveValue('echo other');
  // Sent, it is gone for good.
  await page.getByTestId('compose-send').tap();
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('other');
  await page.evaluate((to) => (location.hash = to), second);
  await page.evaluate((to) => (location.hash = to), first);
  await expect(page.getByTestId('compose')).toHaveValue('');
  // As it was: the second tab closed (its draft with it), the box off.
  await page.evaluate((to) => (location.hash = to), second);
  await page.getByTestId('term-tab-close').tap();
  await page.getByTestId('confirm-ok').tap();
  await expect(page).not.toHaveURL(new RegExp(`${second}$`));
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').uncheck();
  await expect(page.getByTestId('compose')).toHaveCount(0);
});

test("a finger's scroll in a terminal under a tmux of its own stays in the terminal", async ({ page }) => {
  // Reported: in the browser, scrolling in `tmux attach` also pulled the page
  // down for the browser's reload (the terminal's touch handlers were
  // passive, so stopping the page did nothing). The app has no such pull.
  await signIn(page);
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$');
  // A program that takes the mouse, as tmux with mouse on does.
  await page.getByTestId('terminal').click();
  await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'; sleep 30\n");
  await page.waitForTimeout(500);
  const prevented = await page.evaluate(async () => {
    const term = document.querySelector<HTMLElement>('[data-testid=terminal]')!;
    const box = term.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const touch = (y: number) => new Touch({ identifier: 9, target: term, clientX: x, clientY: y });
    const send = (type: string, y: number) => {
      const e = new TouchEvent(type, { touches: type === 'touchend' ? [] : [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true });
      term.dispatchEvent(e);
      return e.defaultPrevented;
    };
    send('touchstart', box.top + 40);
    const moves: boolean[] = [];
    for (let y = box.top + 60; y <= box.top + 260; y += 20) {
      moves.push(send('touchmove', y));
      await new Promise((w) => setTimeout(w, 16));
    }
    send('touchend', box.top + 260);
    return moves;
  });
  // Every move kept from the page (the browser neither scrolls nor pulls to reload).
  expect(prevented.every(Boolean), JSON.stringify(prevented)).toBe(true);
  // Left as found for the next test: the glide over, the program ended, the
  // mouse off again (it stays on after a program that does not turn it off,
  // as in any terminal) and the line empty.
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+U');
  await page.keyboard.type("printf '\\033[?1000l\\033[?1006l'; clear\n");
});

test("a foldable with the keyboard up, typing straight into the terminal: the text box folds away and the rows are the terminal's", async ({ page }) => {
  // Reported (e03c6e, also be21c2): on the inner screen with the keyboard up
  // (698 x 355) the text box left 18 rows, and an assistant's input line in a
  // tmux attach was not drawn: what was typed could not be seen.
  await page.setViewportSize({ width: 698, height: 698 });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toBeVisible();
  // The keyboard up for the text box: it stays, and the rows that leaves.
  await page.getByTestId('compose').focus();
  await page.setViewportSize({ width: 698, height: 355 });
  await expect(page.getByTestId('compose')).toBeVisible();
  const room = async () => (await page.locator('.term-wrap').boundingBox())?.height ?? 0;
  await page.waitForTimeout(300);
  const withBox = await room();
  // A tap on the terminal: the box folds to a key, its room the terminal's.
  await page.locator('[data-testid=terminal] textarea').focus();
  await expect(page.getByTestId('compose')).toBeHidden();
  await expect(page.getByTestId('compose-unfold')).toBeVisible();
  await expect.poll(room, { message: 'room for the terminal' }).toBeGreaterThan(withBox + 30);
  await page.keyboard.type('echo straight-$((40+2))\n');
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('straight-42');
  // The key brings the box back, with the focus in it.
  await page.getByTestId('compose-unfold').tap();
  await expect(page.getByTestId('compose')).toBeFocused();
  // Back in the terminal it folds again; the keyboard down, it is there again.
  await page.locator('[data-testid=terminal] textarea').focus();
  await expect(page.getByTestId('compose')).toBeHidden();
  await page.setViewportSize({ width: 698, height: 698 });
  await expect(page.getByTestId('compose')).toBeVisible();
  await expect(page.getByTestId('compose-unfold')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').uncheck();
});

test('the keyboard up, typing straight into the terminal: a row of suggestions that comes does not cover the line typed on (report c2f122)', async ({ page }) => {
  // With the keyboard up the terminal keeps its rows, scrolled to its cursor. The suggestions'
  // row came under it while typing, the box smaller, and nothing scrolled: the row lay over the
  // line typed on (a foldable's inner screen, 698 x 355).
  await page.setViewportSize({ width: 698, height: 698 });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  const ta = page.locator('[data-testid=terminal] textarea');
  await ta.focus();
  await page.setViewportSize({ width: 698, height: 355 });
  await page.waitForTimeout(400);
  // The screen full, the prompt on the last row.
  await page.keyboard.type('seq 1 80; echo filled-up\n');
  await expect(rows).toContainText('filled-up');
  await page.keyboard.type('se');
  const row = page.getByTestId('suggestions');
  await expect(row.getByRole('option').first()).toBeVisible();
  await page.waitForTimeout(400);
  const [line, under] = [await rows.locator(':scope > div').filter({ hasText: /\$ se\s*$/ }).last().boundingBox(), await row.boundingBox()];
  expect(line && under && line.y + line.height <= under.y + 1, `the line typed on (${line?.y}+${line?.height}) above the row (${under?.y})`).toBe(true);
  await page.keyboard.press('Control+c');
  await page.setViewportSize({ width: 698, height: 698 });
});

test("the keyboard up over an assistant: its input line and the three lines under it stay in sight", async ({ page }) => {
  // Reported (c7f699): Claude Code in a tmux attach shows its input line with
  // the box's edge and two status lines under it; with the keyboard up the
  // view followed the cursor and those three lines fell off the bottom.
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  const api = (path: string, body: unknown) => page.evaluate(([p, b]) => fetch(p as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json()), [path, body] as const);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await api('/api/snippets/run', { hostIds: [hostId], command: "tmux -L asst kill-server 2>/dev/null; printf '%s\\n' 'draw() { clear; printf \"top\\n\"; l=$(tput lines); tput cup $((l - 3)) 0; printf \"BOX-EDGE\"; tput cup $((l - 2)) 0; printf \"STATUS-ONE\"; tput cup $((l - 1)) 0; printf \"STATUS-TWO\"; tput cup $((l - 4)) 0; printf \"> ASK-HERE\"; }' 'trap draw WINCH' 'draw' 'while :; do sleep 1; done' > /tmp/asst.sh" });
  const s = (await api('/api/terminal/sessions', { hostId, tmux: 'never' })) as { id: string };
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.locator('[data-testid=terminal] textarea').focus();
  await page.keyboard.type('tmux -L asst -f /dev/null set -g status off \\; new -s asst "sh /tmp/asst.sh"\n');
  await expect(rows).toContainText('STATUS-TWO');
  await page.setViewportSize({ width: 343, height: 356 });
  const wrap = page.locator('.term-wrap');
  const inSight = async (text: string) => {
    const [line, box] = [await rows.locator(':scope > div').filter({ hasText: text }).boundingBox(), await wrap.boundingBox()];
    return !!line && !!box && line.y >= box.y - 1 && line.y + line.height <= box.y + box.height + 1;
  };
  for (const text of ['ASK-HERE', 'BOX-EDGE', 'STATUS-ONE', 'STATUS-TWO']) await expect.poll(() => inSight(text), { message: `${text} in sight` }).toBe(true);
  await lookAt(page, 'phone-terminal-keyboard-assistant');
  await page.setViewportSize({ width: 343, height: 711 });
  await page.keyboard.press('Control+b');
  await page.keyboard.type('d');
  await api('/api/snippets/run', { hostIds: [hostId], command: 'tmux -L asst kill-server 2>/dev/null; true' });
});

test("the keyboard up over a tmux attach: the terminal keeps its rows, nothing is redrawn, the input line stays in sight", async ({ page }) => {
  // Reported (f18108): an assistant in the user's own tmux, the keyboard up
  // on a phone: redrawn for fewer rows, its input line fell together with the
  // line at the bottom (anthropics/claude-code #52660). Now nothing changes size.
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  const api = (path: string, body: unknown) => page.evaluate(([p, b]) => fetch(p as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json()), [path, body] as const);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  // A program that draws its input line on the bottom row, again on every resize.
  await api('/api/snippets/run', { hostIds: [hostId], command: "tmux -L tui kill-server 2>/dev/null; printf '%s\\n' 'draw() { clear; printf \"top\\n\"; tput cup $(($(tput lines) - 1)) 0; printf \"INPUT-LINE %s\" \"$(tput lines)\"; }' 'trap draw WINCH' 'draw' 'while :; do sleep 1; done' > /tmp/tui.sh" });
  const s = (await api('/api/terminal/sessions', { hostId, tmux: 'never' })) as { id: string };
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.locator('[data-testid=terminal] textarea').focus();
  await page.keyboard.type('tmux -L tui -f /dev/null new -s tui "sh /tmp/tui.sh"\n');
  await expect(rows).toContainText('INPUT-LINE');
  const inputLine = rows.locator(':scope > div').filter({ hasText: 'INPUT-LINE' });
  const before = (await inputLine.innerText()).trim();
  const ptyRows = async () => ((await api('/api/snippets/run', { hostIds: [hostId], command: "tmux -L tui list-clients -F '#{client_height}'" })) as { stdout: string }[])[0]!.stdout.trim();
  const heightBefore = await ptyRows();
  // The keyboard comes up: the terminal keeps its rows (the program draws
  // nothing again), and the box shows the part with the cursor.
  await page.setViewportSize({ width: 343, height: 356 });
  await page.waitForTimeout(600);
  expect(await ptyRows(), 'the size on the host').toBe(heightBefore);
  expect((await inputLine.innerText()).trim()).toBe(before);
  const wrap = page.locator('.term-wrap');
  await expect.poll(async () => {
    const [line, box] = [await inputLine.boundingBox(), await wrap.boundingBox()];
    return !!line && !!box && line.y >= box.y && line.y + line.height <= box.y + box.height;
  }, { message: 'the input line in sight' }).toBe(true);
  await lookAt(page, 'phone-terminal-keyboard-kept');
  // Typed now: it shows (the line under the cursor stays in sight).
  await page.keyboard.type('x');
  // The keyboard down: the whole terminal again.
  await page.setViewportSize({ width: 343, height: 711 });
  await expect.poll(async () => page.evaluate(() => document.querySelector('.term-wrap')!.scrollTop)).toBe(0);
  await page.keyboard.press('Control+b');
  await page.keyboard.type('d');
  await api('/api/snippets/run', { hostIds: [hostId], command: 'tmux -L tui kill-server 2>/dev/null; true' });
});

test('the keyboard coming up and going down in steps, as Android animates it: no other size sent on the way (report b00aad)', async ({ page }) => {
  // Reported (b00aad): the picture jumped each time the keyboard opened or
  // closed. The page shrinks in steps while the keyboard slides in; the steps
  // before it counted as a keyboard (120 px) went out as fewer rows, and the
  // program in the terminal redrew for each, then again for the rows kept.
  await page.setViewportSize({ width: 343, height: 711 });
  const sizes: string[] = [];
  page.on('websocket', (ws) => {
    if (/\/sessions\/[^/]+\/ws/.test(ws.url())) ws.on('framesent', (f) => {
      const m = typeof f.payload === 'string' ? /"t":"resize","cols":(\d+),"rows":(\d+)/.exec(f.payload) : null;
      if (m) sizes.push(`${m[1]}x${m[2]}`);
    });
  });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  await page.locator('[data-testid=terminal] textarea').focus();
  await expect.poll(() => sizes.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const size = sizes.at(-1)!;
  sizes.length = 0;
  // The page's clock in the test's hands: the steps 30 ms apart on it, however long a resize takes on a
  // busy machine (in the gate one took over the 200 ms the terminal waits, and its size went out).
  await page.clock.install();
  // Up in steps of 40 px, a frame or two apart, then down again the same way.
  for (let h = 676; h >= 356; h -= 40) {
    await page.setViewportSize({ width: 343, height: h });
    await page.clock.runFor(30);
  }
  await page.setViewportSize({ width: 343, height: 356 });
  await page.clock.runFor(800);
  await page.waitForTimeout(300);
  expect(sizes.filter((x) => x !== size), 'sizes sent while the keyboard came up').toEqual([]);
  for (let h = 396; h <= 711; h += 40) {
    await page.setViewportSize({ width: 343, height: h });
    await page.clock.runFor(30);
  }
  await page.setViewportSize({ width: 343, height: 711 });
  await page.clock.runFor(800);
  await page.waitForTimeout(300);
  expect(sizes.filter((x) => x !== size), 'sizes sent while it went down').toEqual([]);
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});

test("the key bar and the text box are compact, the text box in the terminal's font size", async ({ page }) => {
  // Reported (efc5af): both took too much room; the box's text was bigger than the terminal's.
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').check();
  await page.keyboard.press('Escape');
  const height = async (sel: string) => (await page.locator(sel).boundingBox())?.height ?? 0;
  expect(await height('.keybar'), 'the key bar').toBeLessThanOrEqual(38);
  expect(await height('form.compose'), 'the text box row').toBeLessThanOrEqual(46);
  // Every key 28 px high, as the text box (docs/UI.md), and only as wide as
  // its label: they no longer stretch over the row (asked 2026-10-07).
  for (const k of await page.locator('.keybar .key').all()) {
    const b = (await k.boundingBox())!;
    expect(Math.round(b.height)).toBe(28);
    expect(b.width, await k.innerText()).toBeLessThanOrEqual(64);
  }
  const sizes = await page.evaluate(() => [getComputedStyle(document.querySelector('[data-testid=compose]')!).fontSize, getComputedStyle(document.querySelector('.xterm-rows')!).fontSize]);
  expect(sizes[0]).toBe(sizes[1]);
  await lookAt(page, 'phone-terminal-compact-bars');
  // A key of the bar while typing in the text box: the key goes to the shell, the box keeps
  // the focus and its keyboard (review 2026-10-24: the focus jumped to the terminal).
  await page.getByTestId('compose').tap();
  await page.getByRole('toolbar', { name: 'Extra keys' }).getByRole('button', { name: 'Tab', exact: true }).tap();
  await expect(page.getByTestId('compose')).toBeFocused();
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').uncheck();
});

test("a cursor key of the key bar held down goes again and again; a tap is one step", async ({ page }) => {
  // Reported (0bc1fe): holding an arrow moved one letter; a whole line took a tap per letter.
  await page.setViewportSize({ width: 343, height: 711 });
  const lefts: number[] = [];
  page.on('websocket', (ws) => ws.url().includes('/api/terminal/') && ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('"d":"\\u001b[D"') && lefts.push(Date.now())));
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  const left = page.getByRole('toolbar', { name: 'Extra keys' }).getByRole('button', { name: 'Left', exact: true });
  // A tap: one step.
  await left.tap();
  await expect.poll(() => lefts.length).toBe(1);
  await page.keyboard.type('$((40+2))');
  await expect(rows).toContainText('$((40+2))');
  // Held: again and again until let go, back over the whole line; letting go sends no more.
  await left.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true });
  await expect.poll(() => lefts.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1 + 12);
  await left.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true });
  await left.dispatchEvent('click');
  const sent = lefts.length;
  await page.waitForTimeout(400);
  expect(lefts.length, 'nothing more after letting go').toBe(sent);
  await page.keyboard.type('echo burrow-\n');
  await expect(rows).toContainText('burrow-42');
});

test('app names on the tiles keep their words whole on a phone', async ({ page }) => {
  // Reported (050019) on a foldable's inner screen (six to a row): "Audiobookshel / f", "Homeassistan / t".
  await page.setViewportSize({ width: 698, height: 698 });
  await signIn(page);
  const app = (id: number, name: string) => ({ id, name, url: `https://${id}.example.lan`, group: null, pinned: true, embeddable: 'no', hasIcon: false, hostId: null, container: null, monitor: true, up: true, checkedAt: null, latencyMs: 10, downSince: null, uptime: 0.96, certExpiresAt: null });
  const list = [app(9101, 'Audiobookshelf'), app(9102, 'Homeassistant'), app(9103, 'Sparkyfitness Frontend'), app(9104, 'Immich Server'), app(9105, 'Social To Mealie'), app(9106, 'Uptime Kuma')];
  await page.route('**/api/apps', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: list }) : r.fallback()));
  await page.goto('/#/apps');
  await expect(page.getByTestId('app-tile')).toHaveCount(6);
  await lookAt(page, 'phone-apps-long-names');
  await page.unroute('**/api/apps');
});

test("the keyboard up, scrolled back: the history layer covers the part of the terminal in sight, its Back to live button there too (Android test 2.19.0)", async ({ page }) => {
  // Seen on the emulator: with the keyboard up the terminal keeps its rows in
  // a box scrolled to the cursor, and the layer lay at the box's top, the
  // live terminal under it in sight (its numbers again, its cursor).
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  await page.locator('[data-testid=terminal] textarea').focus();
  await page.keyboard.type('seq 1 300\n');
  await expect(rows).toContainText('299');
  // The keyboard up: the rows kept, the box scrolled down to the cursor.
  await page.setViewportSize({ width: 343, height: 356 });
  const wrap = page.locator('.term-wrap');
  await expect(wrap).toHaveClass(/kept/);
  await expect.poll(() => wrap.evaluate((w) => w.scrollTop)).toBeGreaterThan(0);
  // A finger down over the part in sight: back in the history.
  await wrap.evaluate(async (w) => {
    const r = w.getBoundingClientRect();
    const el = w.querySelector<HTMLElement>('[data-testid=terminal]')!;
    const touch = (y: number) => new Touch({ identifier: 7, target: el, clientX: r.left + r.width / 2, clientY: y });
    const top = r.top + 20;
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(top)], changedTouches: [touch(top)], bubbles: true, cancelable: true }));
    for (let y = top; y <= top + 100; y += 4) {
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
      await new Promise((d) => setTimeout(d, 30));
    }
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(top + 100)], bubbles: true, cancelable: true }));
  });
  const layer = page.getByTestId('term-history');
  await expect(layer).toBeVisible();
  // The layer over exactly the part in sight; the button inside it.
  const inSight = async () => {
    const [box, l, b] = [await wrap.boundingBox(), await layer.boundingBox(), await page.getByTestId('term-history-live').boundingBox()];
    if (!box || !l || !b) return 'missing';
    const out: string[] = [];
    if (Math.abs(l.y - box.y) > 1 || Math.abs(l.y + l.height - (box.y + box.height)) > 1) out.push(`layer ${Math.round(l.y)}..${Math.round(l.y + l.height)} for ${Math.round(box.y)}..${Math.round(box.y + box.height)}`);
    if (b.y < box.y || b.y + b.height > box.y + box.height) out.push(`button at ${Math.round(b.y)}`);
    return out.join('; ') || 'ok';
  };
  await expect.poll(inSight).toBe('ok');
  // Scrolled in the layer: it stays over the part in sight.
  await layer.evaluate((el) => el.scrollBy(0, -200));
  await expect.poll(inSight).toBe('ok');
  // Last: the look takes its passes (the button's own press is the other test's).
  await lookAt(page, 'phone-terminal-history-keyboard');
});

test("a finger in a tmux of the person's own (Claude Code in it, the mouse on): its history in the layer; a program with the mouse in Burrow's pane keeps its wheel", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'always' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  const typeLine = async (line: string) => {
    await page.locator('[data-testid=terminal] textarea').focus();
    await page.keyboard.type(`${line}\n`);
  };
  const swipe = () =>
    page.locator('.term-wrap').evaluate(async (w) => {
      const r = w.getBoundingClientRect();
      const el = w.querySelector<HTMLElement>('[data-testid=terminal]')!;
      const touch = (y: number) => new Touch({ identifier: 9, target: el, clientX: r.left + r.width / 2, clientY: y });
      const top = r.top + 40;
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(top)], changedTouches: [touch(top)], bubbles: true, cancelable: true }));
      for (let y = top; y <= top + 160; y += 4) {
        el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
        await new Promise((d) => setTimeout(d, 30));
      }
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(top + 160)], bubbles: true, cancelable: true }));
    });
  const layer = page.getByTestId('term-history');
  // A program in Burrow's own pane that took the mouse: the finger turns its wheel (cat -v shows the codes).
  await typeLine("printf '\\033[?1000h'; cat -v");
  await page.waitForTimeout(500);
  await swipe();
  await expect(rows).toContainText('^[[M');
  await expect(layer).toHaveCount(0);
  await page.keyboard.press('Control+C');
  // A notch of its wheel for every two lines the finger moved (a slow finger), each one sent: xterm
  // took the small pixel steps for a trackpad's and sent one in three, Claude Code's own scroll slow
  // and jerky (2026-11-06); a notch a line was too fast there (2026-11-07).
  await typeLine("clear; printf '\\033[?1006h'; cat -v");
  await page.waitForTimeout(500);
  await swipe();
  const cell = await rows.locator('> div').first().evaluate((d) => d.getBoundingClientRect().height);
  const notches = async () => ((await rows.textContent()) ?? '').split('^[[<64;').length - 1;
  await expect.poll(notches, { message: 'a notch for every two lines the finger moved' }).toBeGreaterThanOrEqual(Math.floor(160 / cell / 2) - 1);
  await page.waitForTimeout(500);
  expect(await notches(), 'no more than a notch for every two lines').toBeLessThanOrEqual(Math.ceil(160 / cell / 2) + 1);
  await page.keyboard.press('Control+C');
  await typeLine("printf '\\033[?1006l\\033[?1000l'; clear");
  // The person's own tmux, mouse on, with output only it keeps.
  await typeLine("tmux -f /dev/null new-session -s mine-e2e \\; set -g mouse on");
  await expect(rows).not.toContainText('^[[M');
  await page.waitForTimeout(1000);
  await typeLine('seq 1 300; echo own-$((40+2))');
  await expect(rows).toContainText('own-42');
  await swipe();
  await expect(layer).toBeVisible();
  await expect(layer.locator('.line').filter({ hasText: /^1$/ })).toHaveCount(1, { timeout: 10_000 });
  await page.getByTestId('term-history-live').click();
  await expect(layer).toHaveCount(0);
  await typeLine('tmux kill-session -t mine-e2e');
  await expect(rows).not.toContainText('own-42');
});

test("a finger in a tmux of the person's own attached in a session without Burrow's tmux, its mouse off or on: its history in the layer (2026-11-07)", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const s = await page.evaluate((id) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: 'never' }) }).then((r) => r.json() as Promise<{ id: string }>), hostId);
  await page.goto(`/#/term/${s.id}`);
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 20_000 });
  const typeLine = async (line: string) => {
    await page.locator('[data-testid=terminal] textarea').focus();
    await page.keyboard.type(`${line}\n`);
  };
  const swipe = () =>
    page.locator('.term-wrap').evaluate(async (w) => {
      const r = w.getBoundingClientRect();
      const el = w.querySelector<HTMLElement>('[data-testid=terminal]')!;
      const touch = (y: number) => new Touch({ identifier: 9, target: el, clientX: r.left + r.width / 2, clientY: y });
      const top = r.top + 40;
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(top)], changedTouches: [touch(top)], bubbles: true, cancelable: true }));
      for (let y = top; y <= top + 160; y += 4) {
        el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
        await new Promise((d) => setTimeout(d, 30));
      }
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(top + 160)], bubbles: true, cancelable: true }));
    });
  const layer = page.getByTestId('term-history');
  // A pager on its alternate screen, no tmux: still arrow keys for it (review 2026-10-24), once the session said so.
  await typeLine(`printf '\\033[?1049h'; read -rsn3 k; printf '\\033[?1049l'; printf 'got:%q\\n' "$k"`);
  await page.waitForTimeout(500);
  await swipe();
  await expect(rows).toContainText("got:$'\\E[A'");
  await expect(layer).toHaveCount(0);
  for (const mouse of ['off', 'on']) {
    await typeLine(`tmux -f /dev/null new-session -s mem-${mouse}-e2e \\; set -g mouse ${mouse}`);
    await page.waitForTimeout(1000);
    await typeLine(`seq 1 300; echo mem-${mouse}-$((40+2))`);
    await expect(rows).toContainText(`mem-${mouse}-42`);
    await swipe();
    await expect(layer, `mouse ${mouse}`).toBeVisible();
    await expect(layer.locator('.line').filter({ hasText: /^1$/ }), `mouse ${mouse}`).toHaveCount(1, { timeout: 10_000 });
    await page.getByTestId('term-history-live').click();
    await expect(layer).toHaveCount(0);
    await typeLine(`tmux kill-session -t mem-${mouse}-e2e`);
    await typeLine(`echo back-${mouse}-$((40+2))`);
    await expect(rows).toContainText(`back-${mouse}-42`);
  }
  await page.evaluate((id) => fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), s.id);
});

for (const tmux of ['never', 'always'] as const) {
  test(`the terminal's last row and column whole in sight, also after the keyboard went down, tmux ${tmux} (report de3278)`, async ({ page }) => {
    // A foldable's inner screen: the bottom row (the prompt) was half under
    // the text box. The fit took the terminal's box with its padding for the
    // room, a row too many at some heights (this one with the keyboard down).
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 698, height: 698 });
    await signIn(page);
    const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
    const s = await page.evaluate(([id, mode]) => fetch('/api/terminal/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostId: id, tmux: mode }) }).then((r) => r.json() as Promise<{ id: string }>), [hostId, tmux] as const);
    await page.goto(`/#/term/${s.id}`);
    const rows = page.locator('[data-testid=terminal] .xterm-rows');
    await expect(rows).toContainText('$', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Sessions' }).tap();
    await page.getByTestId('compose-toggle').check();
    const compose = page.getByTestId('compose');
    const send = async (line: string) => {
      await compose.fill(line);
      await page.getByTestId('compose-send').tap();
      await expect(compose).toHaveValue('');
    };
    await send('seq 1 300');
    await expect(rows).toContainText('299');
    const wrap = page.locator('.term-wrap');
    // The terminal's bottom and right edges and its last row against the box's: none of it past the box's edges.
    const cut = () =>
      wrap.evaluate((w) => {
        const box = w.getBoundingClientRect();
        const screen = w.querySelector('.xterm-screen')!.getBoundingClientRect();
        const last = [...w.querySelectorAll('.xterm-rows > div')].at(-1)!.getBoundingClientRect();
        return Math.round(Math.max(screen.bottom - box.bottom, last.bottom - box.bottom, screen.right - box.right));
      });
    await expect.poll(cut).toBeLessThanOrEqual(0);
    // The keyboard up, a line typed in the box, the keyboard down again.
    await compose.focus();
    await page.setViewportSize({ width: 698, height: 394 });
    await expect(wrap).toHaveClass(/kept/);
    await send('echo up-$((1+1))');
    await expect(rows).toContainText('up-2');
    await page.setViewportSize({ width: 698, height: 698 });
    await expect(wrap).not.toHaveClass(/kept/);
    await expect.poll(cut).toBeLessThanOrEqual(0);
    await expect.poll(() => wrap.evaluate((w) => w.scrollTop)).toBe(0);
  });
}

test('a phone turned on its side with its keyboard up: the terminal keeps the room', async ({ page }) => {
  // Found by the Android test turned: the tabs, the labels, the key bar and
  // the text box took all the height, and nothing of the terminal showed.
  await signIn(page);
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  await page.setViewportSize({ width: 820, height: 260 });
  await expect(page.locator('.term-top')).toBeHidden();
  const box = await page.getByTestId('terminal').boundingBox();
  expect(box?.height ?? 0, 'the terminal has room for a few lines').toBeGreaterThan(80);
  // Room again (the keyboard gone): the tabs are back.
  await page.setViewportSize({ width: 820, height: 412 });
  await expect(page.locator('.term-top')).toBeVisible();
  // Reported: a foldable's inner screen with the keyboard up (698 x 355)
  // left 15 rows, and an assistant's input line in a tmux attach fell off
  // the top: what was typed could not be seen. Now the labels make way and
  // the bar is compact. It stays (report ce0acd: with the bar gone there was
  // no way back nor to another session while the keyboard was up).
  await page.setViewportSize({ width: 698, height: 355 });
  await expect(page.locator('.status-row')).toBeHidden();
  await expect(page.locator('.term-top')).toBeVisible();
  await expect(page.locator('.term-top').getByRole('button', { name: 'Hosts' })).toBeVisible();
  await expect(page.locator('.term-top').getByRole('tab').first()).toBeVisible();
  expect((await page.locator('.term-top').boundingBox())!.height, 'the compact bar').toBeLessThanOrEqual(40);
  // Most of the height is the terminal's (with the bars it had some 60%).
  await expect.poll(async () => (await page.getByTestId('terminal').boundingBox())?.height ?? 0, { message: 'the terminal height' }).toBeGreaterThan(355 * 0.75);
  await lookAt(page, 'phone-terminal-foldable-keyboard');
  // As reported: in Dutch, dark.
  await page.evaluate(() => (localStorage.setItem('burrow.locale', 'nl'), localStorage.setItem('burrow.appearance', JSON.stringify({ mode: 'dark', accent: 'green' }))));
  await page.reload();
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  await expect(page.locator('.term-top').getByRole('button', { name: 'Hosts' })).toBeVisible();
  await lookAt(page, 'phone-terminal-foldable-keyboard-nl-dark');
  await page.evaluate(() => (localStorage.setItem('burrow.locale', 'en'), localStorage.removeItem('burrow.appearance')));
  await page.reload();
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$', { timeout: 20_000 });
  // Upright: the bar the same with the keyboard up or down, and no row of
  // labels coming and going with it (report aa109d: the picture changed
  // scale each time; the compact one, as with the keyboard up, was liked).
  await page.setViewportSize({ width: 412, height: 450 });
  await expect(page.locator('.term-top')).toBeVisible();
  await expect(page.locator('.status-row')).toBeHidden();
  const up = (await page.locator('.term-top').boundingBox())!.height;
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.locator('.term-top').getByRole('tab').first()).toBeVisible();
  expect((await page.locator('.term-top').boundingBox())!.height, 'the bar with the keyboard down').toBe(up);
  await expect(page.locator('.status-row')).toBeHidden();
});

test('several lines pasted reach a program as one paste, from the keyboard and the text box', async ({ page }) => {
  // Reported: a log pasted into a tmux attach arrived in pieces, each line
  // its own send (an assistant in that tmux took every line as a message).
  // A program that asks for pastes to be marked (bracketed paste, as tmux
  // and assistants do) gets one, marked: cat -v shows the marks.
  await signIn(page);
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$');
  await page.locator('[data-testid=terminal] textarea').focus();
  // An empty line and no mouse mode, whatever the session went through before.
  // A moment after Ctrl+C: the shell drops what is typed right on its heels
  // (as in any terminal; checked: the page sends every key).
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+U');
  await page.keyboard.type("printf '\\033[?1000l\\033[?1006l\\033[?2004h'; cat -v\n");
  await page.waitForTimeout(500);
  const text = async () => (await rows.innerText()).replace(/\u00a0/g, ' ');
  // The keyboard's clipboard: the text arrives in the field at once.
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    ta.focus();
    const data = 'kb-one\nkb-two\n';
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data, bubbles: true, cancelable: true }));
    ta.value += data;
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data, bubbles: true }));
  });
  // Both lines inside one paste's marks (the line's echo, then cat's copy).
  await expect.poll(text).toMatch(/\^\[\[200~kb-one\s*kb-two\s*\^\[\[201~/);
  // The text box: several lines, sent with the button.
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').check();
  await page.getByTestId('compose').fill('box-one\nbox-two');
  await page.getByTestId('compose-send').tap();
  await expect.poll(text).toMatch(/\^\[\[200~box-one\s*box-two\^\[\[201~/);
  await page.getByRole('button', { name: 'Sessions' }).tap();
  await page.getByTestId('compose-toggle').uncheck();
  await page.getByTestId('terminal').click();
  await page.keyboard.press('Control+C');
  await page.keyboard.type("printf '\\033[?2004l'\n");
});

test("a phone's title bar is dark like the rail; the browser's and the app's bar above it follow, light again on a wide screen and on a phone held sideways, in the title bar's colour (report dfc5b0)", async ({ page }) => {
  await signIn(page);
  // A stand-in for the app's bridge, keeping what the page tells it.
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __chrome: string[] };
    w.__chrome = [];
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: { top?: string } };
        if (method === 'chrome') w.__chrome.push(params.top ?? '');
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result: method === 'info' ? { version: '1.10.0', versionCode: 11000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: true } : null }) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  await page.reload();
  // Colours as hex: theme-color and the app take nothing else (a token mixed
  // with the accent read as "color-mix(...)", and the app's status bar stayed).
  const hexOf = (sel: string) =>
    page.locator(sel).first().evaluate((e) => {
      const c = getComputedStyle(e).backgroundColor;
      const n = (c.match(/[\d.]+/g) ?? []).map(Number);
      const v = c.startsWith('color(') ? n.slice(0, 3).map((x) => x * 255) : n.slice(0, 3);
      return `#${v.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
    });
  const bar = page.locator('.topbar').first();
  await expect(bar).toBeVisible();
  const side = await hexOf('.topbar');
  const dark = parseInt(side.slice(1, 3), 16) < 60;
  expect(dark, `the title bar is dark: ${side}`).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content'))).toBe(side);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __chrome: string[] }).__chrome.at(-1))).toBe(side);
  await lookAt(page, 'phone-dark-topbar');
  // Wide, and a phone held sideways (the report's 750 x 342): the title bar light, the bar above it
  // in the title bar's colour; it was the page's background, a grey strip over the white bar (report dfc5b0).
  const near = (a: string, b: string) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 3);
  for (const size of [{ width: 750, height: 342 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size);
    const top = await hexOf('.topbar');
    const bg = await hexOf('html');
    expect(top, `the title bar light at ${size.width} px`).not.toBe(side);
    expect(near(top, bg), `title bar ${top} and page ${bg} apart at ${size.width} px`).toBe(false);
    await expect.poll(() => page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '').then((c) => near(c, top)), { message: `theme-color as the title bar ${top} at ${size.width} px` }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __chrome: string[] }).__chrome.at(-1) ?? '').then((c) => near(c, top)), { message: `the app's bar as the title bar ${top} at ${size.width} px` }).toBe(true);
  }
  await lookAt(page, 'phone-sideways-topbar');
});

test('Settings -> Appearance in Dutch on a narrow phone: the language it is in, and the themes fit', async ({ page }) => {
  // Reported from a 343 px wide phone: "English" in the language box of a
  // Dutch page, and "Zwart (OLED)" over two lines past the edge.
  await page.setViewportSize({ width: 343, height: 711 });
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('burrow.locale', 'nl'));
  await page.goto('/#/settings/appearance');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Weergave' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Taal' })).toHaveValue('nl');
  // The theme a dropdown too: four choices side by side broke over three
  // rows, the last under the colours (report 36aa3d).
  const theme = page.getByRole('combobox', { name: 'Thema' });
  await theme.selectOption({ label: 'Zwart (OLED)' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  const themeBox = (await theme.boundingBox())!;
  const colours = (await page.getByRole('radiogroup', { name: 'Accentkleur' }).boundingBox())!;
  expect(colours.y).toBeGreaterThanOrEqual(themeBox.y + themeBox.height);
  await lookAt(page, 'phone-343-nl-appearance');
  await theme.selectOption({ label: 'Automatisch' });
  await page.evaluate(() => localStorage.setItem('burrow.locale', 'en'));
});

test('a long press on the tab in front renames it on a phone', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /^test-sshd/ }).first().click();
  await expect(page).toHaveURL(/#\/term\//);
  const front = page.getByRole('tab', { selected: true });
  // A finger held on the tab (touch pointer events, not a mouse).
  await front.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(800);
  await front.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  await page.getByTestId('confirm-input').fill('held-name');
  await page.getByTestId('confirm-ok').click();
  await expect(front).toHaveText('held-name');
  // Kept by the server: still so after a reload, and in the session list.
  await page.reload();
  await expect(page.getByRole('tab', { selected: true })).toHaveText('held-name');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByTestId('session-row').filter({ hasText: 'held-name' })).toHaveCount(1);
  // The host's name again for the tests after this one.
  await page.getByTestId('term-rename').click();
  await page.getByTestId('confirm-input').fill('');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByRole('tab', { selected: true })).not.toHaveText('held-name');
});

test('the charts of a host: a finger on one shows that moment in all of them', async ({ page }) => {
  // Reported (4af4ec): no values to see in the charts on a phone.
  await signIn(page);
  const hosts = (await page.evaluate(async () => (await fetch('/api/hosts')).json())) as { id: number; name: string }[];
  const host = hosts.find((h) => h.name === 'test-sshd')!;
  const start = Date.parse('2026-10-07T08:00:00Z');
  await page.route('**/api/hosts/*/stats/history*', (r) =>
    r.fulfill({ json: Array.from({ length: 11 }, (_, i) => ({ at: new Date(start + i * 600_000).toISOString(), cpu: i * 10, memPercent: 40 + i, load1: i / 10, diskPercent: 50, maxCelsius: null })) }),
  );
  await page.goto(`/#/hosts/${host.id}/stats`);
  // How long the host has been up, as large as the other tiles' values, since when under it (report 9cc851: smaller than the rest).
  const tiles = page.getByTestId('stats-now').locator('.tile');
  await expect(tiles).toHaveCount(4);
  const size = (i: number) => tiles.nth(i).locator('b').evaluate((e) => getComputedStyle(e).fontSize);
  expect(await size(3)).toBe(await size(0));
  await expect(tiles.nth(3).locator('.dim').last()).toContainText(/^since /);
  const charts = page.getByTestId('stats-chart');
  await expect(charts).toHaveCount(4);
  await expect(charts.first().getByTestId('chart-value')).toContainText('max 100.0');
  // A tap in the middle of the CPU chart: the sixth sample, in every chart.
  const svg = (await charts.first().locator('svg').boundingBox())!;
  await page.touchscreen.tap(svg.x + svg.width / 2, svg.y + svg.height / 2);
  await expect(charts.nth(0).getByTestId('chart-tip')).toContainText('50.0');
  await expect(charts.nth(1).getByTestId('chart-tip')).toContainText('45.0');
  await expect(charts.nth(0).locator('circle')).toHaveCount(1);
  await expect(charts.nth(3).locator('circle')).toHaveCount(1);
  await lookAt(page, 'phone-host-stats-picked');
  // The charts' height: on a phone as it was (a tenth of their width), on any computer screen at
  // most 60 px, not growing with the width (report dfc610: hundreds of pixels each on a wide one).
  const heights = () => charts.locator('svg').evaluateAll((all) => all.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
  for (const c of await heights()) expect(Math.abs(c.h - Math.round(c.w / 10))).toBeLessThanOrEqual(1);
  const phone = page.viewportSize()!;
  for (const width of [1280, 1920, 3432]) {
    await page.setViewportSize({ width, height: 1000 });
    // The chart is drawn again once its new width is measured, a frame or more after the resize.
    await expect.poll(async () => Math.max(...(await heights()).map((c) => c.h)), { message: `at ${width}` }).toBeLessThanOrEqual(60.5);
  }
  await page.setViewportSize(phone);
  await page.unroute('**/api/hosts/*/stats/history*');
});

test('volume up in the app: a line says what the next key does, gone after a tap on Vol+', async ({ page }) => {
  // Asked: the key bar said only "Vol+".
  await signIn(page);
  // A stand-in for the app's bridge, which sends the volume keys as events.
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __volume: (k: string) => void };
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        const result = method === 'info' ? { version: '1.17.0', versionCode: 11700, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: true, selectionMenu: true } : null;
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.__volume = (k) => port.onmessage?.({ data: JSON.stringify({ event: 'volumeKey', data: k }) });
    w.BurrowAndroid = port;
  });
  await page.reload();
  await page.setViewportSize({ width: 343, height: 711 });
  await ownHost(page);
  await page.getByPlaceholder('Search name, address or tag').fill('mobile-sshd');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toContainText('$');
  await page.evaluate(() => (window as unknown as { __volume: (k: string) => void }).__volume('up'));
  const hint = page.getByTestId('volume-up-hint');
  await expect(hint.locator('span')).toHaveText(['Vol+', 'W A S D: arrows', 'E: Esc', 'T: Tab', '1-9: F1-F9', 'P/N: page']);
  await expect(page.getByTestId('volume-up-key')).toBeVisible();
  await lookAt(page, 'phone-volume-up-hint');
  // Every part on the screen, wrapped onto a second line where it does not fit (UIA-12); lookAt's textOnScreen checks the same everywhere.
  const right = await hint.locator('span').evaluateAll((s) => Math.max(...s.map((x) => x.getBoundingClientRect().right)));
  expect(right).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await page.getByTestId('volume-up-key').click();
  await expect(hint).toHaveCount(0);
});

test('find in a file on a 343 px phone with the keyboard up: field, count and its buttons on one row, all as high as the field (reports 696298, 703c76)', async ({ page }) => {
  // Reported: with a match chosen ("1 van 20") the close button fell to a row of its own, and
  // Replace stretched over the options' row: three rows, half the screen left over the keyboard.
  await page.setViewportSize({ width: 343, height: 396 });
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('burrow.locale', 'nl'));
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: 'for i in $(seq 1 25); do echo "image: web-$i"; done > ~/find-phone.yml' }) }).then((r) => r.json()), hostId);
  await page.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/home/tester/find-phone.yml')}`);
  // Dutch, as reported: the locale is read as the app starts.
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('web-25');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+f');
  const panel = page.locator('.cm-search');
  const field = panel.locator('input[name=search]');
  await field.pressSequentially('image');
  await field.press('Enter');
  await expect(page.getByTestId('editor-find-count')).toHaveText(/^\d+ van 25$/);
  const middle = (l: import('@playwright/test').Locator) => l.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
  const row = await middle(field);
  for (const name of ['Vorige', 'Volgende', 'Sluiten']) expect(Math.abs((await middle(panel.getByRole('button', { name, exact: true }))) - row), `${name} beside the field`).toBeLessThan(12);
  // Replace as wide as its word at the end of the options' row, not the row's rest.
  const replace = await panel.getByTestId('editor-find-replace').boundingBox();
  expect(replace!.width).toBeLessThan(140);
  // And as high as the field and the options beside it (report 703c76: lower than both).
  const fieldHigh = (await field.boundingBox())!.height;
  const aa = (await panel.getByRole('button', { name: 'Hoofdletters gelijk' }).boundingBox())!.height;
  expect(Math.abs(replace!.height - fieldHigh), 'Replace as high as the field').toBeLessThanOrEqual(1);
  expect(Math.abs(replace!.height - aa), 'Replace as high as Aa').toBeLessThanOrEqual(1);
  await lookAt(page, 'mobile-editor-find-nl');
});

// Reported: Claude Code in a session in tmux, its spinner and prompt twice and letters of two frames
// through each other after a switch of tabs. A tab come back replays what was kept into a new terminal,
// which a busy phone fits to its size after the screen was drawn again: xterm moves its lines, and the
// program in tmux draws only what changed since, over what differed. A program as such an assistant
// draws: three lines at the bottom drawn again in place, a line of output now and then. In Burrow's tmux,
// and in a tmux of the person's own attached in a session without it (the reporter's way).
for (const [how, tmuxMode] of [["Burrow's tmux", 'always'], ['a tmux of your own (a session without Burrow\'s)', 'never']] as const) {
  test(`a tab back in ${how} with a program drawing in it, on a busy phone: the screen as tmux has it, no two frames through each other (reports d1113b, 92eaa5)`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 698, height: 750 });
    await signIn(page);
    const api = (path: string, body: unknown) => page.evaluate(([p, b]) => fetch(p as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json()), [path, body] as const);
    const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
    const script = [
      "i=0; while [ $i -lt 60 ]; do i=$((i+1)); printf 'history line %s %s\\n' $i \"$(printf '%0120d' $i)\"; done",
      "blk() { printf '\\r\\033[KSpin %s\\n\\r\\033[K> prompt\\n\\r\\033[KTip %s' \"$1\" \"$1\"; }",
      'blk 0',
      'i=0',
      "while :; do i=$((i+1)); printf '\\r\\033[2A'; if [ $((i%5)) = 0 ]; then printf '\\r\\033[Kout %s %s\\n' $i \"$(printf '%090d' $i)\"; fi; blk $i; sleep 0.2; done",
    ];
    const ink = `/tmp/ink-${tmuxMode}.sh`;
    await api('/api/snippets/run', { hostIds: [hostId], command: `printf '%s\\n' ${script.map((l) => `'${l.replace(/'/g, `'\\''`)}'`).join(' ')} > ${ink}` });
    const s = (await api('/api/terminal/sessions', { hostId, tmux: tmuxMode })) as { id: string };
    const other = (await api('/api/terminal/sessions', { hostId, tmux: tmuxMode })) as { id: string };
    const ours = 'tmux -L burrow -f /dev/null';
    const own = 'tmux -L own-e2e -f /dev/null';
    const tmux = tmuxMode === 'always' ? ours : own;
    const target = tmuxMode === 'always' ? `burrow-${s.id.replace(/[^A-Za-z0-9]/g, 'x')}` : 'own';
    const run = async (command: string) => ((await api('/api/snippets/run', { hostIds: [hostId], command })) as { stdout: string }[])[0]!.stdout;
    await page.goto(`/#/term/${s.id}`);
    const rows = page.locator('[data-testid=terminal] .xterm-rows');
    await expect(rows).toContainText('$', { timeout: 20_000 });
    await page.locator('[data-testid=terminal] textarea').focus();
    if (tmuxMode === 'never') {
      await page.keyboard.type(`${own} new -s own \\; set status off\n`);
      await expect.poll(() => run(`${own} has -t own && echo yes`)).toContain('yes');
    }
    await page.keyboard.type(`sh ${ink}\n`);
    await expect(rows).toContainText('Spin');
    // Each row on the phone as in tmux's own picture of the screen, the program stopped meanwhile (and
    // going on after: the shell's lines of that come before the tab is left, as in the report's session).
    const same = async (what: string) => {
      await page.waitForTimeout(1500);
      await run(`${tmux} send-keys -t ${target} C-z`);
      await page.waitForTimeout(800);
      const height = Number((await run(`${tmux} display-message -p -t ${target} '#{pane_height}'`)).trim());
      const tm = (await run(`${tmux} capture-pane -p -t ${target}`)).split('\n').slice(0, height).map((l) => l.trimEnd());
      const xt = (await rows.locator(':scope > div').allInnerTexts()).slice(0, height).map((l) => l.replace(/\u00a0/g, ' ').trimEnd());
      expect(tm.some((l) => l.startsWith('Spin')), `the program on the screen ${what}`).toBe(true);
      expect(xt, `the phone as tmux has it ${what}`).toEqual(tm);
      await page.keyboard.type('fg\n');
      await page.waitForTimeout(500);
    };
    await same('before');
    // To the other tab a moment, the program drawing on meanwhile, and back on a phone six times slower
    // (as in the 2.24.0 gate: fitted only after the screen came), twice.
    const cdp = await page.context().newCDPSession(page);
    for (const n of [1, 2]) {
      await page.evaluate((i) => (location.hash = `#/term/${i}`), other.id);
      await page.waitForTimeout(2000);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      await page.evaluate((i) => (location.hash = `#/term/${i}`), s.id);
      await expect(rows).toContainText('Spin');
      await page.waitForTimeout(1500);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await page.locator('[data-testid=terminal] textarea').focus();
      await same(`after tab ${n}`);
    }
    // A foldable folded and opened again while the program draws, on the busy phone: the terminal of
    // other columns drawn again at its new size, not at the one before it (report 723e9d: the letters
    // of the inner screen's frames through those of the outer one).
    for (const [what, size] of [['folded', { width: 343, height: 711 }], ['opened', { width: 698, height: 750 }]] as const) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      await page.setViewportSize(size);
      await page.waitForTimeout(1500);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await same(what);
    }
    await run(`${ours} kill-session -t burrow-${s.id.replace(/[^A-Za-z0-9]/g, 'x')}; ${ours} kill-session -t burrow-${other.id.replace(/[^A-Za-z0-9]/g, 'x')}; ${own} kill-server; rm -f ${ink}`);
  });
}
