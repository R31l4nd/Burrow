import { expect, test, type Page } from './fixtures.js';
import { signIn } from './passkey.js';

// Every way of typing into the terminal on a phone, in every kind of
// session, with the same checks each time: what was typed arrives once, a
// backspace takes one character, suggestions come, and the gestures do what
// they say. Problems reported so far each lived in one corner of this
// square (a keyboard's correction in a plain shell, the text box open while
// typing in the terminal, a tmux of your own); here every corner is tried.

type Kind = 'tmux' | 'plain' | 'own tmux';
// The last: the text box open, but typed straight into the terminal.
type Way = 'keys' | 'keyboard app' | 'text box' | 'keyboard app, text box open';
const KINDS: Kind[] = ['tmux', 'plain', 'own tmux'];
const WAYS: Way[] = ['keys', 'keyboard app', 'text box', 'keyboard app, text box open'];

const rows = (page: Page) => page.locator('[data-testid=terminal] .xterm-rows');
const lines = async (page: Page) => (await rows(page).innerText()).split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim());

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

/** The text box on or off for the next page (the terminal's saved preference). */
async function textBox(page: Page, on: boolean) {
  await page.evaluate((c) => {
    const p = JSON.parse(localStorage.getItem('burrow.terminal') || '{}');
    localStorage.setItem('burrow.terminal', JSON.stringify({ ...p, compose: c }));
  }, on);
}

/** Types `text` the given way (without Enter). */
async function type(page: Page, way: Way, text: string) {
  if (way === 'text box') return page.getByTestId('compose').fill(text);
  if (way === 'keys') {
    await page.getByTestId('terminal').click();
    return page.keyboard.type(text, { delay: 10 });
  }
  // As a phone's keyboard app does it: keyCode 229, then the field changes.
  await page.evaluate(async (t) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    ta.focus();
    let v = ta.value;
    for (const ch of t) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Unidentified', bubbles: true } as KeyboardEventInit));
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true }));
      ta.value = v += ch;
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
      await new Promise((w) => setTimeout(w, 15));
    }
  }, text);
}

async function backspace(page: Page, way: Way) {
  if (way === 'text box') {
    const box = page.getByTestId('compose');
    return box.fill((await box.inputValue()).slice(0, -1));
  }
  if (way === 'keys') return page.keyboard.press('Backspace');
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
  });
}

async function enter(page: Page, way: Way) {
  if (way === 'text box') return page.getByTestId('compose-send').tap();
  if (way === 'keys') return page.keyboard.press('Enter');
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true }));
  });
}

/**
 * A tmux server of this test's own: one socket name shared by the tests met a
 * server the test before had not finished ending, and its client printed
 * "server exited unexpectedly" (the gate's flaky own-tmux test, found in the 2026-10-16 review).
 */
const ownSocket = () => `mx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new session of the given kind on test-sshd, open on its page; `made` hears its id at once, so a failure here still closes it. */
async function open(page: Page, kind: Kind, sock: string, made: (id: string) => void): Promise<string> {
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const hostId = hosts.find((h) => h.name === 'test-sshd')!.id;
  const s = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId, tmux: kind === 'tmux' ? 'always' : 'never' });
  made(s.id);
  await page.goto(`/#/term/${s.id}`);
  // The text box setting is read when the app starts.
  await page.reload();
  await expect(rows(page)).toContainText('$', { timeout: 20_000 });
  if (kind === 'own tmux') {
    await page.getByTestId('terminal').click();
    await page.keyboard.type(`printf 'set -g mouse on\\n' > /tmp/${sock}.conf && tmux -L ${sock} -f /tmp/${sock}.conf new -s mx\n`);
    await expect.poll(async () => (await lines(page)).some((l) => l.startsWith('[mx]')), { timeout: 15_000 }).toBe(true);
  }
  return s.id;
}

async function close(page: Page, id: string | undefined, kind: Kind, sock: string) {
  // Ended through the API, which waits, and gone before this returns: typed into the terminal, the
  // keys raced the session's end and the server outlived the test.
  if (kind === 'own tmux') {
    const hostId = (await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts')).find((h) => h.name === 'test-sshd')!.id;
    await api(page, 'POST', '/api/snippets/run', { hostIds: [hostId], command: `tmux -L ${sock} kill-server 2>/dev/null; for i in $(seq 50); do tmux -L ${sock} has-session 2>/dev/null || break; sleep 0.1; done; rm -f /tmp/${sock}.conf` });
  }
  if (id) await api(page, 'DELETE', `/api/terminal/sessions/${id}`);
}

for (const kind of KINDS) {
  test.describe(`a ${kind} session`, () => {
    for (const way of WAYS) {
      test(`typed with ${way}: once, a backspace, suggestions`, async ({ page }, info) => {
        test.setTimeout(90_000);
        await signIn(page);
        await textBox(page, way.includes('text box'));
        const sock = ownSocket();
        let id: string | undefined;
        // Closed however the test ends, its opening too: a session left open counts against the limit for the next.
        try {
          await open(page, kind, sock, (x) => (id = x));
          // Its own per try: a retry found the first try's commands in the history already.
          const tag = `${kind}-${way}${info.retry ? `r${info.retry}` : ''}`.replace(/\W+/g, '');
          // Once, and Enter runs it.
          await type(page, way, `echo mx-${tag}`);
          await enter(page, way);
          await expect.poll(async () => (await lines(page)).filter((l) => l === `mx-${tag}`).length, { timeout: 10_000 }).toBe(1);
          // A backspace takes one character.
          await type(page, way, `echo bs-${tag}X`);
          await backspace(page, way);
          await enter(page, way);
          await expect.poll(async () => (await lines(page)).filter((l) => l === `bs-${tag}`).length, { timeout: 10_000 }).toBe(1);
          // Kept in the host's history (not in a tmux of your own: that shell is not Burrow's).
          if (kind !== 'own tmux') {
            const hostId = (await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts')).find((h) => h.name === 'test-sshd')!.id;
            const kept = () => api<{ command: string }[]>(page, 'GET', `/api/hosts/${hostId}/history`).then((l) => l.map((h) => h.command));
            await expect.poll(kept, { timeout: 10_000 }).toContain(`echo mx-${tag}`);
            // The history arrives after the typing: the suggestions come again
            // with it (they stayed without the new command until the next key).
            let letGo = () => {};
            const held = new Promise<void>((r) => (letGo = r));
            await page.route('**/api/hosts/*/history?*', async (r) => (await held, r.continue()));
            await type(page, way, `echo late-${tag}`);
            await enter(page, way);
            await expect.poll(kept, { timeout: 10_000 }).toContain(`echo late-${tag}`);
            await type(page, way, 'echo lat');
            // The typing is in (its echo too) and worked out without the new
            // command; only then the history comes.
            if (way === 'text box') await expect(page.getByTestId('compose')).toHaveValue('echo lat');
            else await expect.poll(async () => (await lines(page)).some((l) => l.endsWith('$ echo lat')), { timeout: 10_000 }).toBe(true);
            await page.waitForTimeout(500);
            await expect(page.getByTestId('suggestions').filter({ hasText: `echo late-${tag}` })).toHaveCount(0);
            letGo();
            await expect(page.getByTestId('suggestions')).toContainText(`echo late-${tag}`, { timeout: 10_000 });
            await page.unroute('**/api/hosts/*/history?*');
            if (way === 'text box') await page.getByTestId('compose').fill('');
            else await page.keyboard.press('Control+U');
          }
          // Suggestions from what ran before, whichever way it is typed.
          // (In a tmux of your own: the start of a command, which the host's commands complete.)
          // The start of this way's own command: the others' ran twice (a chip
          // picked runs it again), so a start they share shows them first.
          await type(page, way, kind === 'own tmux' ? 'ech' : `echo mx-${tag.slice(0, -2)}`);
          // Inside a tmux of your own the shell there is not the one Burrow
          // records, so any suggestion counts; elsewhere the command just run.
          if (kind === 'own tmux') await expect(page.getByTestId('suggestions')).toBeVisible({ timeout: 10_000 });
          else await expect(page.getByTestId('suggestions')).toContainText(`echo mx-${tag}`, { timeout: 10_000 });
          // Picked, it goes where it was typed: the terminal, or the text box
          // when typed there (reported: typed in the terminal, it went to the box).
          const chips = page.getByTestId('suggestions').getByRole('option');
          await (kind === 'own tmux' ? chips.first() : chips.filter({ hasText: `echo mx-${tag}` }).first()).tap();
          if (way === 'keyboard app, text box open') await expect(page.getByTestId('compose')).toHaveValue('');
          if (kind !== 'own tmux') {
            await enter(page, way);
            // Its output, on a line of its own or (a command exactly as wide as the
            // screen) after the wrapped last letter: not the command line itself.
            // (20 s: beside the other browsers of a whole run the second one could take over 10.)
            await expect.poll(async () => (await lines(page)).filter((l) => l.endsWith(`mx-${tag}`) && !l.includes('$ echo')).length, { timeout: 20_000 }).toBe(2);
          }
        } finally {
          await close(page, id, kind, sock).catch(() => {});
        }
      });
    }

    test('one finger scrolls back, a held word is copied', async ({ page, context }) => {
      test.setTimeout(90_000);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await signIn(page);
      await textBox(page, false);
      const sock = ownSocket();
      let id: string | undefined;
      // Closed however the test ends, its opening too: a session left open counts against the limit for the next.
      try {
        await open(page, kind, sock, (x) => (id = x));
        await page.getByTestId('terminal').click();
        await page.keyboard.type('seq 1 200; echo pick-$((6*7))\n');
        await expect.poll(async () => (await lines(page)).includes('pick-42'), { timeout: 10_000 }).toBe(true);
        // A held word: the one under the finger, copied.
        await page.getByTestId('terminal').evaluate(async (el) => {
          const line = [...el.querySelectorAll('.xterm-rows > div')].find((d) => /^pick-42/.test(d.textContent ?? ''))!;
          const r = line.getBoundingClientRect();
          const t = new Touch({ identifier: 8, target: el, clientX: r.left + 20, clientY: r.top + r.height / 2 });
          el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
          await new Promise((w) => setTimeout(w, 700));
          el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
        });
        await page.getByTestId('term-copy').tap();
        expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe('pick-42');
        // One finger down the screen: back in history (in a tmux of your own,
        // its copy mode shows where: "[n/m]"; elsewhere the lines go back).
        const numbers = async () => (await lines(page)).filter((l) => /^\d+$/.test(l)).map(Number);
        const lowest = async () => Math.min(...(await numbers()), 9999);
        const before = await lowest();
        await page.getByTestId('terminal').evaluate(async (el) => {
          const r = el.getBoundingClientRect();
          const touch = (y: number) => new Touch({ identifier: 9, target: el, clientX: r.left + r.width / 2, clientY: y });
          el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(r.top + 40)], changedTouches: [touch(r.top + 40)], bubbles: true, cancelable: true }));
          for (let y = r.top + 40; y < r.bottom - 40; y += 12) {
            el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
            await new Promise((w) => setTimeout(w, 16));
          }
          el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(r.bottom - 40)], bubbles: true, cancelable: true }));
        });
        // In a tmux of your own (the mouse on) its copy mode shows where: "[n/m]". Else the session's
        // history layer, scrolled by the phone itself (2.19.0): the first lines are in it, and the
        // screen behind it stayed where it was.
        if (kind === 'own tmux') await expect.poll(async () => (await rows(page).innerText()).match(/\[\d+\/\d+\]/) !== null).toBe(true);
        else {
          await expect(page.getByTestId('term-history')).toBeVisible();
          expect(await page.getByTestId('term-history').locator('.line').allTextContents()).toContain('1');
          expect(await lowest()).toBe(before);
          await page.getByTestId('term-history-live').tap();
          await expect(page.getByTestId('term-history')).toHaveCount(0);
        }
        if (kind === 'own tmux') await page.keyboard.press('q');
      } finally {
        await close(page, id, kind, sock).catch(() => {});
      }
    });
  });
}
