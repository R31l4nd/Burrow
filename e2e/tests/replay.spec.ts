import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { signIn } from './passkey.js';

// make replay ID=...: a problem report's input recording (recording.json,
// the last 30 seconds on a terminal) played again on a fresh session of the
// test setup, at the speed it was typed, as the keyboard and the fingers
// sent it. What was typed is there only when the person allowed it; else as
// many x's. At the end: what the terminal shows, the suggestions, a picture
// beside the report (replay.png). Without one (the gate), a recording kept
// here is played, so the replay itself stays working.

/** What recording.json holds (shared/src/bugreport.ts, inputRecording). */
interface InputRecording {
  withText: boolean;
  viewport: { width: number; height: number };
  terminal: { compose: boolean; mode: string | null } | null;
  entries: { t: number; e: string; keyCode?: number; key?: string; inputType?: string; composing?: boolean; text?: string; len?: number; value?: string; textLength?: number; points?: [number, number][]; n?: number }[];
}

const FIXTURE = 'e2e/fixtures/recording.json';
const FILE = process.env.REPLAY || FIXTURE;
const SSHD_HOST = process.env.SSHD_HOST ?? 'burrow-e2e-sshd';

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

/** A host to replay on: the test sshd, added and trusted when not there yet. */
async function replayHost(page: Page): Promise<number> {
  const hosts = await api<{ id: number; name: string }[]>(page, 'GET', '/api/hosts');
  const there = hosts.find((h) => h.name === 'replay');
  if (there) return there.id;
  const h = await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'replay', address: SSHD_HOST, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await api<{ status: string; fingerprint?: string }>(page, 'POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await api(page, 'POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  return h.id;
}

// What the replay made, removed however it ends: the other tests' lists of
// hosts and sessions stay as they expect (one worker: nothing runs beside it).
const made: { hostId: number | null; sessionId: string | null } = { hostId: null, sessionId: null };
test.afterEach(async ({ page }) => {
  if (made.sessionId) await api(page, 'DELETE', `/api/terminal/sessions/${made.sessionId}`).catch(() => {});
  if (made.hostId) await api(page, 'DELETE', `/api/hosts/${made.hostId}`).catch(() => {});
});

test('a problem report\'s input, played again', async ({ page }) => {
  test.setTimeout(180_000);
  const rec = JSON.parse(readFileSync(join('/app', FILE), 'utf8')) as InputRecording;
  await signIn(page);
  if (rec.viewport.width && rec.viewport.height) await page.setViewportSize(rec.viewport);
  // The text box as it was set, then a session of the same kind.
  await page.evaluate((c) => {
    const p = JSON.parse(localStorage.getItem('burrow.terminal') || '{}');
    localStorage.setItem('burrow.terminal', JSON.stringify({ ...p, compose: c }));
  }, rec.terminal?.compose ?? false);
  const hostId = (made.hostId = await replayHost(page));
  const s = await api<{ id: string }>(page, 'POST', '/api/terminal/sessions', { hostId, tmux: rec.terminal?.mode === 'tmux' ? 'always' : 'never' });
  made.sessionId = s.id;
  await page.goto(`/#/term/${s.id}`);
  await page.reload();
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('$', { timeout: 30_000 });
  await page.getByTestId('terminal').click();

  // Event by event, a moment apart as they were (a long pause cut to a second).
  let last = rec.entries[0]?.t ?? 0;
  for (const x of rec.entries) {
    await page.waitForTimeout(Math.min(1000, Math.max(0, x.t - last)));
    last = x.t;
    await page.evaluate((x) => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-testid=terminal] textarea')!;
      const area = document.querySelector<HTMLElement>('[data-testid=terminal]')!;
      const text = x.text ?? 'x'.repeat(x.textLength ?? 0);
      if (x.e === 'keydown' || x.e === 'keyup' || x.e === 'keypress') {
        ta.dispatchEvent(new KeyboardEvent(x.e, { keyCode: x.keyCode, key: x.key ?? (text || 'Unidentified'), isComposing: x.composing, bubbles: true, cancelable: true } as KeyboardEventInit));
      } else if (x.e === 'beforeinput') {
        ta.dispatchEvent(new InputEvent('beforeinput', { inputType: x.inputType, data: text || null, isComposing: x.composing, bubbles: true, cancelable: true }));
      } else if (x.e === 'input') {
        // The keyboard's field after it: as it was, or as long as it was.
        ta.value = x.value ?? (x.len !== undefined ? ta.value.slice(0, x.len).padEnd(x.len, 'x') : ta.value + text);
        ta.dispatchEvent(new InputEvent('input', { inputType: x.inputType, data: text || null, isComposing: x.composing, bubbles: true }));
      } else if (x.e.startsWith('composition')) {
        ta.dispatchEvent(new CompositionEvent(x.e, { data: text, bubbles: true }));
      } else if (x.e.startsWith('touch') && x.points) {
        const r = area.getBoundingClientRect();
        const touches = x.points.map(([px, py], i) => new Touch({ identifier: i + 1, target: area, clientX: r.left + px * r.width, clientY: r.top + py * r.height }));
        area.dispatchEvent(new TouchEvent(x.e, { touches: x.e === 'touchend' ? [] : touches, changedTouches: touches, bubbles: true, cancelable: true }));
      }
    }, x);
  }
  await page.waitForTimeout(1500);

  // What it came to: the terminal's last lines, the suggestions, what was sent then.
  const lines = (await rows.innerText()).split('\n').map((l) => l.replace(/\u00a0/g, ' ').trimEnd()).filter(Boolean);
  const chips = await page.getByTestId('suggestions').getByRole('option').allTextContents().catch(() => []);
  const sentThen = rec.entries.filter((x) => x.e === 'sent').map((x) => x.text ?? `<${x.textLength ?? 0}>`).join('');
  const suggestedThen = rec.entries.filter((x) => x.e === 'suggestions').pop()?.n ?? 0;
  console.log(['', `replayed ${rec.entries.length} events (${rec.withText ? 'with' : 'without'} the text)`, `sent then: ${JSON.stringify(sentThen)}`, `suggestions then: ${suggestedThen}, now: ${chips.length} ${JSON.stringify(chips)}`, 'the terminal now ends with:', ...lines.slice(-6).map((l) => `  ${l}`)].join('\n'));
  await page.screenshot({ path: FILE === FIXTURE ? test.info().outputPath('replay.png') : join('/app', dirname(FILE), 'replay.png') });
  // The kept recording types a command the keyboard-app way and runs it.
  if (FILE === FIXTURE) expect(lines).toContain('replayed-42');
});
