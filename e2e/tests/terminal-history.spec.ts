import { expect, test, type Page } from './fixtures.js';
import { sayYes } from './confirm.js';
import { signIn } from './passkey.js';

// Remembered commands: one forgotten from its suggestion (held down) and
// one from the host's list. And a person's own tmux with "mouse on" and
// extended keys (as on the author's host): the text box sends and runs,
// and a finger scrolls tmux's history.

const screen = (page: Page) => page.locator('[data-testid=terminal] .xterm-rows');

async function run(page: Page, command: string) {
  await page.getByTestId('terminal').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** The session this page shows, closed (the next test must not find it open). */
async function closeSession(page: Page) {
  const id = /#\/term\/([\w-]+)/.exec(page.url())?.[1];
  if (id) await page.evaluate(async (sid) => void (await fetch(`/api/terminal/sessions/${sid}`, { method: 'DELETE' })), id);
}

const history = (page: Page, hostId: number) =>
  page.evaluate(async (id) => ((await (await fetch(`/api/hosts/${id}/history?limit=5000`)).json()) as { command: string }[]).map((h) => h.command), hostId);

test('a remembered command is forgotten from its suggestion and from the list', async ({ page }) => {
  await sayYes(page);
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByTestId('new-session').click();
  await expect(screen(page)).toContainText('$');
  await run(page, 'echo typo-one');
  await run(page, 'echo keep-two');
  await expect.poll(() => history(page, hostId)).toEqual(expect.arrayContaining(['echo typo-one', 'echo keep-two']));

  // Learnt: after "echo typo-one" came "echo keep-two". Run it again: with
  // nothing typed yet, that is what the prompt offers next.
  await run(page, 'echo typo-one');
  await expect(page.getByTestId('suggestions')).toContainText('echo keep-two', { timeout: 10_000 });
  await page.keyboard.press('Control+U');

  // Held down on the suggestion: asked, then gone, here and on the server.
  await page.getByTestId('terminal').click();
  await page.keyboard.type('echo typ');
  const chip = page.getByTestId('history-chip').filter({ hasText: 'echo typo-one' });
  await expect(chip).toBeVisible();
  await chip.hover();
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(chip).toHaveCount(0);
  await expect.poll(() => history(page, hostId)).not.toContain('echo typo-one');
  await page.keyboard.press('Control+U');
  await closeSession(page);

  // From the host's list: searched, forgotten.
  await page.goto('/#/hosts');
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByText('Completion and history').click();
  await page.getByTestId('history-manage').click();
  await page.getByTestId('history-search').fill('keep-two');
  await expect(page.getByTestId('history-list').locator('.list-item')).toHaveCount(1);
  await page.getByTestId('history-forget').click();
  await expect(page.getByTestId('history-list').locator('.list-item')).toHaveCount(0);
  expect(await history(page, hostId)).not.toContain('echo keep-two');
});

test("the host's ~/.bash_history read in from the host's menu: said how many, and offered after", async ({ page }) => {
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.evaluate(
    async (id) => void (await fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: 'echo "echo from-bash-history-burrow" >> ~/.bash_history' }) })),
    hostId,
  );
  await page.goto('/#/hosts');
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByText('Completion and history').click();
  await page.getByRole('button', { name: 'Import ~/.bash_history' }).click();
  await expect(page.getByText(/^Imported \d+ commands? \(\d+ skipped\)\.$/)).toBeVisible();
  await expect.poll(() => history(page, hostId)).toContain('echo from-bash-history-burrow');
});

test('in a tmux of your own with mouse on: the text box runs, a finger scrolls', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Menu for test-sshd' }).first().click();
  await page.getByTestId('session-options').click();
  // Without Burrow's tmux: the person starts their own, as on their host.
  await page.getByTestId('session-memory').click();
  await expect(screen(page)).toContainText('$');
  // A line, then enough below it to push it off the screen.
  await run(page, 'echo before-$((40+2))-own-tmux; seq 1 60');
  await expect(screen(page)).toContainText('5960');
  await run(page, "printf 'set -g extended-keys on\\nset -g extended-keys-format csi-u\\nset -g mouse on\\n' > /tmp/own.conf && tmux -L own kill-server 2>/dev/null; tmux -L own -f /tmp/own.conf new -s own");
  await expect(screen(page)).not.toContainText('own.conf', { timeout: 10_000 });
  // What came before the tmux is still there: Shift + the wheel scrolls
  // Burrow's own history (the wheel alone goes to tmux, with mouse on).
  await expect(screen(page)).not.toContainText('before-42-own-tmux');
  const box = (await page.getByTestId('terminal').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Shift');
  await expect(screen(page)).toContainText('before-42-own-tmux');

  // Typed straight into the terminal, in tmux: suggestions from the history
  // too (a prompt inside another program's screen).
  await page.getByTestId('terminal').click();
  await page.keyboard.type('echo ', { delay: 30 });
  await expect(page.getByTestId('suggestions')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Control+U');

  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByTestId('compose-toggle').check();
  await page.getByTestId('compose').fill('echo res-$((6*7))');
  await page.getByTestId('compose-send').click();
  await expect(screen(page)).toContainText('res-42');
  // Send held puts the text on the line without running it. Several lines
  // would each run in a shell that does not take marked pastes (AUDIT2
  // TERM-02; inside this tmux the terminal still marks them): they stay in
  // the box, said so, and nothing runs.
  await page.getByTestId('compose').fill("bind 'set enable-bracketed-paste off'");
  await page.getByTestId('compose-send').click();
  await page.waitForTimeout(500);
  await page.getByTestId('compose').fill('echo held-$((1+1))\necho held-$((2+2))');
  await page.getByTestId('compose-send').dispatchEvent('pointerdown', { pointerType: 'mouse', isPrimary: true });
  await page.waitForTimeout(800);
  await page.getByTestId('compose-send').dispatchEvent('pointerup', { pointerType: 'mouse', isPrimary: true });
  await expect(page.getByText('Several lines cannot go onto the line without running')).toBeVisible();
  await expect(page.getByTestId('compose')).toHaveValue('echo held-$((1+1))\necho held-$((2+2))');
  await page.waitForTimeout(500);
  await expect(screen(page)).not.toContainText('held-2');
  await page.getByTestId('compose').fill("bind 'set enable-bracketed-paste on'");
  await page.getByTestId('compose-send').click();
  await expect(screen(page)).toContainText("bind 'set enable-bracketed-paste on'");
  await page.waitForTimeout(500);
  // A program that looks for pastes (an assistant) reads its input raw: the
  // text and its Enter must come in separate reads, or it takes the Enter
  // for part of a paste and does not run the line.
  await page.getByTestId('compose').fill("stty raw -echo; r=$(dd bs=256 count=1 2>/dev/null | od -An -c | tr -d ' \\n'); stty sane; echo \"first-read:$r:\"");
  await page.getByTestId('compose-send').click();
  await page.waitForTimeout(500);
  await page.getByTestId('compose').fill('abc');
  await page.getByTestId('compose-send').click();
  await expect(screen(page)).toContainText('first-read:abc:');
  // Enough to scroll back through: the drag and the flick together stay short
  // of its top (a notch per line the finger moves since 2.20.1, a third of
  // that before), or the flick has nowhere left to go.
  await page.getByTestId('compose').fill('seq 1 1000');
  await page.getByTestId('compose-send').click();
  // Its output, not the command line (Enter follows the text a moment later).
  await expect(screen(page)).toContainText('998');

  // A finger drags down over the terminal: tmux scrolls back (its copy mode
  // shows where: "[12/300]").
  await page.getByTestId('terminal').evaluate((el) => {
    const wrap = el.parentElement!;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    wrap.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(r.top + 20)], changedTouches: [touch(r.top + 20)], bubbles: true, cancelable: true }));
    for (let y = r.top + 20; y < r.bottom - 20; y += 10) wrap.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
    wrap.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(r.bottom - 20)], bubbles: true, cancelable: true }));
  });
  await expect(screen(page)).toContainText(/\[\d+\/\d+\]/);
  // A flick, as on a phone: after the finger lets go, tmux scrolls on for a
  // moment (it stopped dead at the finger before).
  const where = async () => Number(/\[(\d+)\/\d+\]/.exec(await screen(page).innerText())?.[1] ?? -1);
  const before = await where();
  await page.getByTestId('terminal').evaluate(async (el) => {
    const wrap = el.parentElement!;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const touch = (y: number) => new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
    const at = r.top + 40;
    wrap.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(at)], changedTouches: [touch(at)], bubbles: true, cancelable: true }));
    for (let i = 1; i <= 6; i++) {
      await new Promise((w) => setTimeout(w, 16));
      wrap.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(at + i * 30)], changedTouches: [touch(at + i * 30)], bubbles: true, cancelable: true }));
    }
    wrap.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(at + 180)], bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  const atRelease = await where();
  await expect.poll(where, { timeout: 5000 }).toBeGreaterThan(atRelease);
  expect(atRelease).toBeGreaterThan(before);

  // Out of copy mode and tmux, and the session closed.
  await page.keyboard.press('q');
  await page.getByTestId('compose').fill('tmux -L own kill-server');
  await page.getByTestId('compose-send').click();
  await closeSession(page);
});
