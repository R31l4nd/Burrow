import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { fillSettled, hostNamed, signIn } from './passkey.js';

// Phase 3: a compose error and a ShellCheck warning show inline; a folder is
// copied from host A to host B. Plus hadolint, uploads and a save conflict.

const SSHD2_HOST = process.env.SSHD2_HOST ?? 'burrow-e2e-sshd2';

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, {
        method: m as string,
        ...(b === undefined ? (m === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }) : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }),
      });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

async function newFileInEditor(page: Page, name: string, content: string) {
  await page.getByRole('button', { name: 'Folder menu' }).click();
  await page.getByRole('button', { name: 'New file' }).click();
  const dialog = page.getByRole('dialog', { name: 'New file' });
  await fillSettled(dialog.getByLabel('Name'), name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.locator('.cm-content').click();
  // insertText: no key events, so no auto-indent reshaping the YAML.
  await page.keyboard.insertText(content);
}

// Problems: a badge in the top bar when there are errors or warnings; the
// whole list (notes too) from the menu (three dots).
const badge = (page: Page) => page.getByTestId('problems-badge');
async function openProblems(page: Page, count: RegExp) {
  await page.getByTestId('editor-menu').click();
  await expect(page.getByTestId('problems')).toContainText(count, { timeout: 20_000 });
  await page.getByTestId('problems').click();
}

test('editor diagnostics, uploads, a save conflict and a copy between hosts', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');

  // Host B through the API (the UI for adding hosts is tested elsewhere).
  const b = await api<{ id: number }>(page, 'POST', '/api/hosts', { name: 'test-sshd2', address: SSHD2_HOST, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const probe = await api<{ status: string; fingerprint?: string }>(page, 'POST', `/api/hosts/${b.id}/test`);
  if (probe.status === 'unknown_host_key') await api(page, 'POST', `/api/hosts/${b.id}/trust`, { fingerprint: probe.fingerprint });
  // Its row's connect on the host list: a terminal on it (pressed only now and then by press-all before, so the
  // gate's control list went stale one run and was right the next).
  await page.goto('/#/hosts');
  await page.getByRole('button', { name: 'test-sshd2 - connect' }).first().click();
  await expect(page).toHaveURL(/#\/term\/[\w-]+$/);
  for (const s of await api<{ id: string; hostId: number }[]>(page, 'GET', '/api/terminal/sessions')) if (s.hostId === b.id) await api(page, 'DELETE', `/api/terminal/sessions/${s.id}`);

  // Host A: a new folder.
  await page.getByRole('link', { name: 'Files' }).click();
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
  await page.goto(`/#/files/${sshd}?p=~`);
  await expect(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'tester', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Folder menu' }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  const folderDialog = page.getByRole('dialog', { name: 'New folder' });
  await fillSettled(folderDialog.getByLabel('Name'), 'project');
  await folderDialog.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('file-row').filter({ hasText: 'project' }).getByRole('button').first().click();
  await expect(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'project', exact: true })).toHaveAttribute('aria-current', 'page');

  // A compose error, inline, from the YAML language server with the compose schema.
  await newFileInEditor(page, 'compose.yaml', 'services:\n  web:\n    image: nginx\n    portz:\n      - "80:80"\n');
  await expect(badge(page)).toHaveAttribute('aria-label', /[1-9]\d* errors?\b/, { timeout: 20_000 });
  await expect(badge(page)).toHaveClass(/bad/);
  await expect(page.locator('.cm-problem-error').first()).toBeVisible();
  await badge(page).click();
  await expect(page.getByTestId('problem').first()).toContainText('portz');
  await page.getByRole('button', { name: 'Close' }).click();
  // docker compose's own check, from the menu (three dots): it finds the error too.
  await page.getByTestId('editor-menu').click();
  await page.getByTestId('compose-check').click();
  // Its answer comes as a message: here the host's own words (this host may
  // have no compose at all), never silence.
  await expect(page.getByTestId('toasts').locator('.toast').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('save').click();
  // Saved when the unsaved-changes dot is gone (the button is also disabled while saving).
  await expect(page.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);

  // A ShellCheck warning, inline.
  await page.getByRole('button', { name: 'Back' }).click();
  await newFileInEditor(page, 'run.sh', '#!/bin/bash\nname=$1\necho $name\n');
  // SC2086 is a ShellCheck "info" finding: shown as a note.
  // Only a note: no badge taking room, the list in the menu.
  await openProblems(page, /[1-9]\d* notes?\b/);
  await expect(badge(page)).toHaveCount(0);
  await expect(page.getByTestId('problem').filter({ hasText: 'SC2086' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('save').click();
  // Saved when the unsaved-changes dot is gone (the button is also disabled while saving).
  await expect(page.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);

  // Changed since the save: marked beside the line, and compared in full.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('echo done\n');
  await expect(page.locator('.cm-change-add').first()).toBeVisible();
  await page.getByTestId('editor-menu').click();
  await page.getByTestId('compare-saved').click();
  await expect(page.getByRole('dialog').getByTestId('diff')).toContainText('echo done');
  await lookAt(page, 'compare-saved');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('save').click();
  await expect(page.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);
  await expect(page.locator('.cm-change-add')).toHaveCount(0);

  // Two files compared, from the file's menu (another host would do too).
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Menu for run.sh' }).click();
  await page.getByTestId('compare-open').click();
  await expect(page.getByTestId('compare-host')).toHaveValue(/\d+/);
  await page.getByTestId('compare-host').selectOption({ label: 'test-sshd' });
  await page.getByTestId('compare-path').fill(`${await page.getByTestId('compare-path').inputValue()}compose.yaml`);
  await page.getByTestId('compare-go').click();
  await expect(page.getByRole('dialog').getByTestId('diff')).toContainText('services:');
  await lookAt(page, 'file-compare');
  await page.keyboard.press('Escape');
  await page.getByTestId('file-row').filter({ hasText: 'run.sh' }).first().click();

  // hadolint on a Dockerfile.
  await page.getByRole('button', { name: 'Back' }).click();
  await newFileInEditor(page, 'Dockerfile', 'FROM debian:12\nRUN apt-get update && apt-get install -y curl\n');
  await expect(badge(page)).toBeVisible({ timeout: 20_000 });
  await badge(page).click();
  await expect(page.getByTestId('problem').filter({ hasText: 'DL3008' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('save').click();
  // Saved when the unsaved-changes dot is gone (the button is also disabled while saving).
  await expect(page.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);

  // A conflict: the file changes on the host while it is open here.
  const path = '/home/tester/project/run.sh';
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('file-row').filter({ hasText: 'run.sh' }).getByRole('button').first().click();
  await expect(page.locator('.cm-content')).toContainText('echo $name');
  const current = await api<{ hash: string }>(page, 'GET', `/api/files/${sshd}/text?path=${encodeURIComponent(path)}`);
  await api(page, 'PUT', `/api/files/${sshd}/text`, { path, content: '#!/bin/bash\necho "changed elsewhere"\n', baseHash: current.hash });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('# mine\n');
  await page.getByTestId('save').click();
  await expect(page.getByRole('dialog', { name: 'Changed on the host' })).toBeVisible();
  await lookAt(page, 'desktop-editor-conflict');
  await page.getByRole('button', { name: 'Overwrite with mine' }).click();
  // Saved when the unsaved-changes dot is gone (the button is also disabled while saving).
  await expect(page.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);
  expect((await api<{ content: string }>(page, 'GET', `/api/files/${sshd}/text?path=${encodeURIComponent(path)}`)).content).toContain('# mine');

  // Upload a file into the folder.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'run.sh' })).toBeVisible();
  await page.getByTestId('upload-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded from the browser\n') });
  await expect(page.getByTestId('transfer-status').last()).toHaveText('done', { timeout: 20_000 });
  await expect(page.getByTestId('file-row').filter({ hasText: 'notes.txt' })).toBeVisible();
  // Done without errors: the list goes away by itself, pill included.
  await expect(page.getByTestId('transfers')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('transfers-pill')).toBeHidden();

  // The same name again: asked, Replace or Keep both, not refused (decision 8).
  await page.getByTestId('upload-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('the second\n') });
  await expect(page.getByTestId('confirm-text')).toContainText('notes (1).txt');
  await page.getByTestId('confirm-other').click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'notes (1).txt' })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('upload-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('replaced\n') });
  await page.getByTestId('confirm-ok').click();
  await expect.poll(async () => (await api<{ content: string }>(page, 'GET', `/api/files/${sshd}/text?path=${encodeURIComponent(path.replace(/[^/]+$/, 'notes.txt'))}`)).content).toBe('replaced\n');
  expect((await api<{ content: string }>(page, 'GET', `/api/files/${sshd}/text?path=${encodeURIComponent(path.replace(/[^/]+$/, 'notes (1).txt'))}`)).content).toBe('the second\n');
  await expect(page.getByTestId('transfers')).toBeHidden({ timeout: 10_000 });

  // An upload stopped halfway leaves nothing on the host: the first chunk is
  // held back until Stop is pressed.
  let letGo = () => {};
  const held = new Promise<void>((r) => (letGo = r));
  await page.route('**/api/files/uploads/*?offset=*', async (r) => (await held, r.continue()));
  await page.getByTestId('upload-input').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(6 << 20, 1) });
  await page.getByTestId('transfer-stop').click();
  letGo();
  await expect(page.getByTestId('transfer-stop')).toHaveCount(0);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await expect
    .poll(async () => (await api<{ entries: { name: string }[] }>(page, 'GET', `/api/files/${sshd}/list?path=${encodeURIComponent(dir)}`)).entries.map((e) => e.name).filter((n) => n.includes('big.bin')))
    .toEqual([]);
  await page.unroute('**/api/files/uploads/*?offset=*');

  // The criterion: copy the folder from host A to host B.
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester`);
  await page.getByRole('button', { name: 'Menu for project' }).click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.goto(`/#/files/${b.id}?p=%2Fhome%2Ftester`);
  await expect(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'tester', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('paste').click();
  await expect(page.getByTestId('transfer-status').last()).toHaveText('done', { timeout: 30_000 });
  // Checked afterwards: each file's sha256 the same on both hosts.
  // As many checked as the folder holds on host A (AUDIT2 TEST-18: zero passed before).
  const [counted] = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'find /home/tester/project -type f | wc -l' });
  await expect(page.getByTestId('transfer-verified').last()).toHaveText(`${Number(counted!.stdout.trim())} files checked: the same on both hosts (sha256)`);
  await expect(page.getByTestId('file-row').filter({ hasText: 'project' })).toBeVisible();
  await page.goto(`/#/files/${b.id}?p=%2Fhome%2Ftester%2Fproject`);
  for (const n of ['compose.yaml', 'run.sh', 'Dockerfile', 'notes.txt']) {
    await expect(page.getByTestId('file-row').filter({ hasText: n })).toBeVisible();
  }
  // Their content too, every one of them, not only their names (AUDIT2 TEST-18).
  for (const n of ['compose.yaml', 'run.sh', 'Dockerfile', 'notes.txt']) {
    const [onA, onB] = await Promise.all([sshd, b.id].map((h) => api<{ content: string }>(page, 'GET', `/api/files/${h}/text?path=${encodeURIComponent(`/home/tester/project/${n}`)}`)));
    expect(onB!.content, n).toBe(onA!.content);
  }

  // Delete it again on host B (step-up is fresh after sign-in).
  await page.goto(`/#/files/${b.id}?p=%2Fhome%2Ftester`);
  await page.getByRole('button', { name: 'Menu for project' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'project' })).toHaveCount(0);

  // The conflict's other way out: theirs kept, mine dropped.
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent(path)}`);
  await expect(page.locator('.cm-content')).toContainText('echo');
  // The copy's list may still be open over the editor's buttons: closed, as a person would.
  if (await page.getByTestId('transfers').isVisible()) await page.getByTestId('transfers').getByRole('button', { name: 'Close' }).click();
  const now = await api<{ hash: string }>(page, 'GET', `/api/files/${sshd}/text?path=${encodeURIComponent(path)}`);
  await api(page, 'PUT', `/api/files/${sshd}/text`, { path, content: '#!/bin/bash\necho "theirs"\n', baseHash: now.hash });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('# dropped\n');
  await page.getByTestId('save').click();
  await page.getByRole('button', { name: 'Discard mine, load theirs' }).click();
  await expect(page.locator('.cm-content')).toContainText('echo "theirs"');
  await expect(page.locator('.cm-content')).not.toContainText('# dropped');
});

test('a Markdown file: coloured in the editor, read beside it on a wide screen (live, with its pictures), in a dialog on a phone', async ({ page }) => {
  // Reported (8fa899): no Markdown support.
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const md = '# Plan\\n\\nSome **bold** text and <script>window.__md=1</script>.\\n\\n| Point | State |\\n|---|---|\\n| BE-24 | done |\\n\\n- one\\n- two\\n\\n![the menu](img/menu.png)\\n';
  // A picture beside the file, shown from the host (not its path as text).
  const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAAE0lEQVR4nGPQzfInCTGMaqCFBgABsHMBBNt++QAAAABJRU5ErkJggg==';
  await page.evaluate(([id, text, pic]) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: `printf '${text}' > /tmp/notes.md && mkdir -p /tmp/img && echo ${pic} | base64 -d > /tmp/img/menu.png` }) }), [hostId, md, png] as const);
  await page.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/tmp/notes.md')}`);
  await expect(page.locator('.cm-content')).toContainText('BE-24');
  // Coloured: the heading is marked as one.
  await expect(page.locator('.cm-content .cm-line').first().locator('span').first()).toBeVisible();
  await page.getByTestId('editor-menu').click();
  await page.getByTestId('markdown-preview').click();
  // On a wide screen beside the text, not in a small dialog (report ac7481), and following what is typed.
  const shown = page.getByTestId('markdown-side').getByTestId('markdown-rendered');
  await expect(shown.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(shown.getByRole('table')).toContainText('BE-24');
  await expect(shown.locator('strong')).toHaveText('bold');
  await expect(shown).toContainText('<script>');
  expect(await page.evaluate(() => (window as unknown as { __md?: number }).__md)).toBeUndefined();
  const pic = shown.getByRole('img', { name: 'the menu' });
  await expect(pic).toBeVisible();
  await expect.poll(() => pic.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(16);
  const [text, side] = await Promise.all([page.getByTestId('editor').boundingBox(), page.getByTestId('markdown-side').boundingBox()]);
  expect(side!.x).toBeGreaterThan(text!.x + text!.width - 2);
  expect(side!.width).toBeGreaterThan(400);
  // The picture is the same element after the text is rendered again (audit 2026-11-05: made anew at
  // each pause in typing, fetched again and blinking): marked in the page, still marked after.
  await pic.evaluate((i) => ((i as HTMLImageElement & { seen?: boolean }).seen = true));
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n## Typed now\n');
  await expect(shown.getByRole('heading', { name: 'Typed now' })).toBeVisible();
  expect(await pic.evaluate((i) => (i as HTMLImageElement & { seen?: boolean }).seen)).toBe(true);
  // A picture that is not there: its words and that it could not be loaded, not a tiny broken mark (UIB-12).
  await page.keyboard.insertText('\n![the map](img/map.png)\n');
  await expect(shown.getByTestId('picture-missing')).toHaveText('Picture: the map (could not be loaded)');
  await lookAt(page, 'desktop-markdown-preview');
  // A reading dialog uses the room a wide screen has: the text against the saved file.
  await page.getByTestId('editor-menu').click();
  await page.getByTestId('compare-saved').click();
  const compare = page.locator('dialog[data-tour="compare-saved"]');
  await expect(compare).toBeVisible();
  expect((await compare.boundingBox())!.width).toBeGreaterThan(1000);
  await compare.getByRole('button', { name: 'Close' }).click();
  // The same Preview button hides it again; on a phone it is a dialog, as wide as the screen.
  await page.getByTestId('editor-menu').click();
  await page.getByTestId('markdown-preview').click();
  await expect(page.getByTestId('markdown-side')).toHaveCount(0);
  await page.setViewportSize({ width: 412, height: 800 });
  await page.getByTestId('editor-menu').click();
  await page.getByTestId('markdown-preview').click();
  await expect(page.getByRole('dialog', { name: 'notes.md' }).getByRole('heading', { name: 'Typed now' })).toBeVisible();
  await lookAt(page, 'phone-markdown-preview');
});

test('a fold arrow sits on the first row of a line that wraps', async ({ page }) => {
  // Reported (19c129): on a long line that wrapped, the arrow sat between its two rows.
  await signIn(page);
  await page.setViewportSize({ width: 360, height: 700 });
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const yaml = 'x-defaults_nodns_and_a_name_long_enough_to_wrap: &defaults_nodns_and_a_name_long_enough\\n  restart: unless-stopped\\n  stop_grace_period: 60s\\n';
  await page.evaluate(([id, text]) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: `printf '${text}' > /tmp/fold.yml` }) }), [hostId, yaml] as const);
  await page.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/tmp/fold.yml')}`);
  await expect(page.locator('.cm-content')).toContainText('unless-stopped');
  const first = page.locator('.cm-line').first();
  const lineBox = (await first.boundingBox())!;
  const rowHeight = await first.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  // The line wraps: more than one row high.
  expect(lineBox.height).toBeGreaterThan(rowHeight * 1.5);
  const arrow = (await page.locator('.cm-fold-chevron').first().boundingBox())!;
  // Its middle on the first row, as the line's number is.
  expect(arrow.y + arrow.height / 2).toBeGreaterThan(lineBox.y);
  expect(arrow.y + arrow.height / 2).toBeLessThan(lineBox.y + rowHeight);
});

test('held down on a phone, a file is chosen, not its menu too: as Android sends it, the hold and then its context menu (report fa1a85)', async ({ page }) => {
  // Reported: held, then Select in the menu chose nothing. The hold chose it and Android's context
  // menu opened the menu as well; Select there took it out again.
  await signIn(page);
  await page.setViewportSize({ width: 343, height: 711 });
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.goto(`/#/files/${hostId}?p=%2Fetc`);
  const row = page.getByTestId('file-open').first();
  await expect(row).toBeVisible();
  const hold = async () => {
    await row.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
    await page.waitForTimeout(600);
    await row.dispatchEvent('contextmenu');
    await row.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  };
  await hold();
  const bar = page.getByTestId('file-selection');
  await expect(bar.getByTestId('file-selected')).toHaveText('1 selected');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  // A right click with a mouse: the menu, nothing chosen by it.
  await bar.getByTestId('select-none').click();
  await row.dispatchEvent('pointerdown', { pointerType: 'mouse', isPrimary: true });
  await row.dispatchEvent('contextmenu');
  await row.dispatchEvent('pointerup', { pointerType: 'mouse', isPrimary: true });
  const sheet = page.locator('dialog[open]');
  await expect(sheet.getByRole('button', { name: 'Select', exact: true })).toBeVisible();
  await expect(bar).toHaveCount(0);
  // Select in the menu of a file chosen already: it stays chosen.
  await sheet.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(bar.getByTestId('file-selected')).toHaveText('1 selected');
  await page.getByTestId('file-menu').first().click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Select', exact: true }).click();
  await expect(bar.getByTestId('file-selected')).toHaveText('1 selected');
  // Tiles: the hold chooses there too, so each has its own three dots for the menu.
  await bar.getByTestId('select-none').click();
  await page.evaluate(() => localStorage.setItem('burrow.files', JSON.stringify({ grid: true })));
  await page.reload();
  const tile = page.getByTestId('file-row').first();
  await expect(tile.getByTestId('file-menu')).toBeVisible();
  await tile.getByTestId('file-menu').click();
  await expect(page.locator('dialog[open]').getByRole('button', { name: 'Select', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await lookAt(page, 'phone-files-grid');
  await page.evaluate(() => localStorage.removeItem('burrow.files'));
});

test('files chosen: the title bar says how many and what to do, all or none at a press, whole on a narrow phone (reports fc208f, 1d6881)', async ({ page }) => {
  // Reported (fc208f): no way to choose all or none, and the bar's X hung
  // over its edge (its count squeezed away) on a 343 px phone. Then (1d6881,
  // 7ff350, b06954): a bar of two rows over the list at the bottom, large and
  // ugly; now the title bar turns into it, as Files (Android) and Gmail do.
  await signIn(page);
  await page.setViewportSize({ width: 343, height: 711 });
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.goto(`/#/files/${hostId}?p=%2Fetc`);
  const rows = page.getByTestId('file-row');
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  await page.getByRole('button', { name: /^Menu for / }).first().click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const bar = page.getByTestId('file-selection');
  await expect(bar.getByTestId('file-selected')).toHaveText('1 selected');
  // The title bar itself, one row at the top: nothing over the list at the bottom.
  await expect(page.locator('.topbar')).toHaveCount(1);
  await expect(bar).toHaveClass(/topbar/);
  const top = (await bar.boundingBox())!;
  expect(top.y).toBeLessThan(2);
  expect(top.height).toBeLessThanOrEqual(64);
  await expect(page.locator('.actionbar')).toHaveCount(0);
  await bar.getByTestId('select-all').click();
  await expect(bar.getByTestId('file-selected')).toHaveText(`${n} selected`);
  // All chosen: the same place chooses none (report d6a5e3: the button went, nothing in its place).
  await expect(bar.getByTestId('select-all')).toHaveCount(0);
  await expect(bar.getByTestId('select-all-none')).toHaveAccessibleName('Choose none');
  // Everything in it inside the bar.
  const box = (await bar.boundingBox())!;
  for (const b of await bar.getByRole('button').all()) {
    const r = (await b.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(box.x);
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
  await lookAt(page, 'phone-files-selection');
  await bar.getByTestId('select-all-none').click();
  await expect(bar).toHaveCount(0);
  await page.getByRole('button', { name: /^Menu for / }).first().click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await bar.getByTestId('select-none').click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'test-sshd' })).toBeVisible();
  // What the bar does with one file: copied or cut (to paste elsewhere), or deleted after a yes.
  const one = async () => {
    await page.getByRole('button', { name: /^Menu for / }).first().click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(bar.getByTestId('file-selected')).toHaveText('1 selected');
  };
  const clip = page.getByRole('toolbar', { name: 'Clipboard' });
  await one();
  await bar.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(clip).toContainText('1 to copy from test-sshd');
  await clip.getByRole('button', { name: 'Cancel' }).click();
  await one();
  await bar.getByRole('button', { name: 'Cut', exact: true }).click();
  await expect(clip).toContainText('1 to move from test-sshd');
  await clip.getByRole('button', { name: 'Cancel' }).click();
  await expect(clip).toHaveCount(0);
  await one();
  await bar.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('confirm-text')).toContainText('Delete 1');
  await page.getByTestId('confirm-cancel').click();
  await expect(rows).toHaveCount(n);
});

test('the line numbers take no more room than they need while there are no problems', async ({ page }) => {
  // Reported (f15675): the side with the line numbers was far too wide on a computer.
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: 'seq 1 1500 > /tmp/long.txt' }) }), hostId);
  await page.goto(`/#/edit/${hostId}?p=${encodeURIComponent('/tmp/long.txt')}`);
  await expect(page.locator('.cm-content')).toContainText('1');
  // No column for problems there are none of (they are marked on the line numbers).
  await expect(page.locator('.cm-gutter-lint:visible')).toHaveCount(0);
  const gutters = (await page.locator('.cm-gutters').boundingBox())!;
  const digit = await page.locator('.cm-lineNumbers .cm-gutterElement').nth(1).evaluate((e) => {
    const r = document.createRange();
    r.selectNodeContents(e);
    return r.getBoundingClientRect().width / (e.textContent ?? '1').length;
  });
  // Four digits, the fold arrows, the change marks and a little room: not much more.
  expect(gutters.width).toBeLessThan(digit * 4 + 40);
});

test('on a phone the line numbers of a long file take a narrow side, each on its line (report 202777)', async ({ page }) => {
  // Reported: a log of four-digit lines opened on a 343 px phone gave the
  // numbers, fold arrows and change marks a fifth of the width.
  await signIn(page);
  await page.setViewportSize({ width: 343, height: 711 });
  const sshd = await hostNamed(page, 'test-sshd');
  await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: 'seq 1 1500 > /tmp/long-phone.txt' }) }), sshd);
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/tmp/long-phone.txt')}`);
  await expect(page.locator('.cm-content')).toContainText('12');
  const gutters = (await page.locator('.cm-gutters').boundingBox())!;
  expect(gutters.width).toBeLessThanOrEqual(42);
  // Still readable, and each number beside its own line.
  const number = page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^12$/ });
  const line = page.locator('.cm-line').filter({ hasText: /^12$/ });
  // The middle of its text, not of its box.
  const middle = (l: typeof line) =>
    l.evaluate((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      const x = r.getBoundingClientRect();
      return x.y + x.height / 2;
    });
  expect(Math.abs((await middle(number)) - (await middle(line)))).toBeLessThanOrEqual(2);
  expect(await number.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(11);
  await lookAt(page, 'phone-editor-long-file');
});

test('a problem is marked on its line number, clear to see; no column of its own, the text does not move; on a computer and on a wide and a narrow phone (reports 279f73, 413d6f)', async ({ page }) => {
  // Reported (279f73): the problem's dot in a column of its own was very small; before that the
  // column moved the text as it came and went (413d6f) and was too wide when empty (f15675).
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: "printf 'name: web\\nport: 80\\n' > ~/problem-dot.yml" }) }), sshd);
  for (const [width, height] of [[1440, 900], [698, 394], [343, 711]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/home/tester/problem-dot.yml')}`);
    await expect(page.locator('.cm-content')).toContainText('port: 80');
    const left = async () => (await page.locator('.cm-content').boundingBox())!.x;
    await expect(page.locator('.cm-gutter-lint:visible')).toHaveCount(0);
    await expect(page.locator('.cm-problem')).toHaveCount(0);
    const before = await left();
    // A key twice: the language server marks it.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('port: 81');
    const marked = page.locator('.cm-lineNumbers .cm-gutterElement.cm-problem').first();
    await expect(marked).toBeVisible({ timeout: 20_000 });
    await expect(marked).toHaveText('3');
    // Clear: the whole number's place in the problem's colour, a band as tall as its line.
    const box = (await marked.boundingBox())!;
    expect(box.width, `${width}px`).toBeGreaterThanOrEqual(14);
    expect(box.height, `${width}px`).toBeGreaterThanOrEqual(16);
    expect(await marked.evaluate((e) => getComputedStyle(e).backgroundColor), `${width}px`).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(await left(), `${width}px`).toBe(before);
    await lookAt(page, `editor-problem-${width}`);
    // And gone again: still in place.
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-problem')).toHaveCount(0, { timeout: 20_000 });
    expect(await left(), `${width}px`).toBe(before);
  }
});

test('a section keeps its place: a folder, a look at the terminal, and Files opens that folder again (report d6ea6c)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester`);
  await expect(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'tester', exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Terminal' }).click();
  await expect(page).toHaveURL(/#\/term/);
  // Back in Files: the same host and folder.
  await nav.getByRole('link', { name: 'Files' }).click();
  await expect(page).toHaveURL(new RegExp(`#/files/${sshd}\\?p=%2Fhome%2Ftester$`));
  // Pressed again while there: Files' start.
  await nav.getByRole('link', { name: 'Files' }).click();
  await expect(page).toHaveURL(/#\/files$/);
});

test('the picture viewer is a real window: the focus in it, the page behind out of reach, Escape back where it was (AUDIT2 UI-26)', async ({ page }) => {
  await signIn(page);
  const hostId = await page.evaluate(async () => ((await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]).find((h) => h.name === 'test-sshd')!.id);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAAE0lEQVR4nGPQzfInCTGMaqCFBgABsHMBBNt++QAAAABJRU5ErkJggg==';
  await page.evaluate(([id, pic]) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: `rm -rf /tmp/gallery && mkdir -p /tmp/gallery && echo ${pic} | base64 -d > /tmp/gallery/a.png && cp /tmp/gallery/a.png /tmp/gallery/b.png` }) }), [hostId, png] as const);
  await page.goto(`/#/files/${hostId}?p=${encodeURIComponent('/tmp/gallery')}`);
  await page.getByTestId('file-row').filter({ hasText: 'a.png' }).getByTestId('file-open').click();
  const viewer = page.locator('dialog.viewer[open]');
  await expect(viewer).toContainText('a.png | 1/2');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog.viewer'))).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(viewer).toContainText('b.png | 2/2');
  // Tab stays inside it.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog.viewer'))).toBe(true);
  // The folder read again by itself meanwhile (every ten seconds) with a picture before it: still
  // b.png, at its new place, not the one now where it was (audit 2026-11-05).
  await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: 'cp /tmp/gallery/a.png /tmp/gallery/0.png' }) }), hostId);
  await expect(viewer).toContainText('b.png | 3/3', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test("Files' Compare with...: a file only root may read is said, and read through sudo there (as a workspace's compare)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "mkdir -p ~/cmp-root && printf 'listen 81;\\n' > ~/cmp-root/mine.conf" });
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester%2Fcmp-root`);
  await page.getByRole('button', { name: 'Menu for mine.conf' }).click();
  await page.getByTestId('compare-open').click();
  await page.getByTestId('compare-host').selectOption({ label: 'test-sshd' });
  await page.getByTestId('compare-path').fill('/etc/burrowtest.conf');
  await page.getByTestId('compare-go').click();
  // Not a bare "no permission" toast: which file, and the way to read it.
  await expect(page.getByTestId('compare-root-only')).toContainText('/etc/burrowtest.conf');
  await page.getByTestId('compare-sudo').click();
  // This host has no stored password: sudo asks for one, here.
  await page.getByTestId('compare-sudo-pw').fill('burrow-test-password');
  await page.getByTestId('compare-go').click();
  const diff = page.getByRole('dialog').getByTestId('diff');
  await expect(diff).toContainText('listen 81');
  await expect(diff.locator('.cm-deletedChunk')).toContainText('listen 80');
  await expect(page.getByTestId('compare-root-only')).toHaveCount(0);
});

test('Files: files dropped from the computer go up to the folder shown, or the folder row they land on; the list follows by itself (reports 6d86aa, 905455)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/drop-here && mkdir -p ~/drop-here/inner && echo a > ~/drop-here/a.txt' });
  await page.goto(`/#/files/${sshd}?p=${encodeURIComponent('/home/tester/drop-here')}`);
  const list = page.getByTestId('file-list');
  await expect(list).toContainText('a.txt');
  const drop = async (target: import('@playwright/test').Locator, name: string) => {
    const dt = await page.evaluateHandle((n) => {
      const d = new DataTransfer();
      d.items.add(new File(['x'], n, { type: 'text/plain' }));
      return d;
    }, name);
    await target.dispatchEvent('dragover', { dataTransfer: dt });
    await target.dispatchEvent('drop', { dataTransfer: dt });
  };
  await drop(list.getByTestId('file-row').filter({ hasText: 'a.txt' }), 'here.txt');
  await expect(list.getByTestId('file-row').filter({ hasText: 'here.txt' })).toBeVisible({ timeout: 15_000 });
  await drop(list.getByTestId('file-row').filter({ hasText: 'inner' }), 'deeper.txt');
  await expect.poll(async () => (await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'ls ~/drop-here/inner' }))[0]!.stdout.trim(), { timeout: 15_000 }).toBe('deeper.txt');
  // Made elsewhere: shown within the list's own round, no reload.
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'echo b > ~/drop-here/made-elsewhere.txt' });
  await expect(list.getByTestId('file-row').filter({ hasText: 'made-elsewhere.txt' })).toBeVisible({ timeout: 15_000 });
});

test('a folder measured says how many files and folders are below it, and that it is busy meanwhile (report 1b1aa2)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "rm -rf ~/sized && mkdir -p ~/sized/sub && printf 'x%.0s' $(seq 1 3000) > ~/sized/a.txt && : > ~/sized/b.txt && : > ~/sized/sub/c.txt" });
  await page.goto(`/#/files/${sshd}?p=${encodeURIComponent('/home/tester/sized')}`);
  await expect(page.getByTestId('file-row')).toHaveCount(3);
  // Held a moment: "busy" is said while it counts.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/files/*/du?*', async (r) => (await held, r.fallback()));
  await page.getByRole('button', { name: 'Folder menu' }).click();
  await page.getByTestId('folder-size').click();
  await expect(page.getByTestId('folder-size')).toHaveText('Calculating... (a big folder can take a minute)');
  release();
  // Three files, one of them in the one folder below.
  await expect(page.getByTestId('folder-size')).toHaveText(/^Size: [\d.]+ (KB|kB|B) \| 3 files in 1 folder$/);
  await page.unroute('**/api/files/*/du?*');
  await page.keyboard.press('Escape');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/sized' });
});

test('a long path on a narrow phone: the star beside it stays in sight, the path scrolls on its own (report b7caab)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const deep = '/home/tester/proj-deep/a-rather-long-folder-name/another-long-folder-name/the-folder-shown';
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: `rm -rf ~/proj-deep && mkdir -p ${deep} && : > ${deep}/notes.txt` });
  await page.setViewportSize({ width: 343, height: 436 });
  await page.goto(`/#/files/${sshd}?p=${encodeURIComponent(deep)}`);
  await expect(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'the-folder-shown' })).toHaveAttribute('aria-current', 'page');
  // The path is wider than the screen; the star is not part of what scrolls.
  expect(await page.getByRole('navigation', { name: 'Path' }).evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
  const star = page.getByRole('button', { name: 'Bookmark this folder' });
  await expect(star).toBeInViewport({ ratio: 1 });
  await lookAt(page, 'phone-small-files-long-path');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(star).toBeInViewport({ ratio: 1 });
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  // Each folder of the path goes there; the one shown reads it again.
  const crumb = (name: string) => page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name, exact: true });
  await crumb('the-folder-shown').click();
  await expect(page.getByText('notes.txt')).toBeVisible();
  for (const name of ['another-long-folder-name', 'a-rather-long-folder-name', 'proj-deep']) {
    await crumb(name).click();
    await expect(crumb(name)).toHaveAttribute('aria-current', 'page');
  }
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/proj-deep' });
});

test('a paste where the name is taken asks: both kept with a number, skipped, or replaced; into its own folder only beside it (report dfda31)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const sh = (command: string) => api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command });
  const cat = async (f: string) => (await api<{ content: string }>(page, 'GET', `/api/files/${sshd}/text?path=${encodeURIComponent(f)}`)).content;
  await sh('rm -rf /tmp/e2e-clash && mkdir -p /tmp/e2e-clash/src && echo old > /tmp/e2e-clash/a.txt && echo new > /tmp/e2e-clash/src/a.txt');
  const rows = page.getByTestId('file-row');
  const status = page.getByTestId('transfer-status');
  await page.goto(`/#/files/${sshd}?p=${encodeURIComponent('/tmp/e2e-clash/src')}`);
  await page.getByRole('button', { name: 'Menu for a.txt' }).click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Already there' });

  // Into its own folder: beside it, with a number, or not at all.
  await page.getByTestId('paste').click();
  await expect(ask).toContainText('Pasted into its own folder');
  await expect(ask.getByTestId('clash-names')).toHaveText('a.txt');
  await expect(ask.getByTestId('clash-replace')).toHaveCount(0);
  await lookAt(page, 'files-paste-clash-same');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(status).toHaveCount(0);
  await page.getByTestId('paste').click();
  await ask.getByTestId('clash-rename').click();
  await expect(status.last()).toHaveText('done', { timeout: 30_000 });
  await expect(rows.filter({ hasText: 'a (1).txt' })).toBeVisible();
  expect(await cat('/tmp/e2e-clash/src/a (1).txt')).toBe('new\n');

  // Into another folder where the name is taken: skipped (said so), replaced, or both kept.
  await page.goto(`/#/files/${sshd}?p=${encodeURIComponent('/tmp/e2e-clash')}`);
  await page.getByTestId('paste').click();
  await expect(ask).toContainText('This name is taken where you paste');
  await lookAt(page, 'files-paste-clash');
  await ask.getByTestId('clash-skip').click();
  await expect(page.getByTestId('transfer-skipped').last()).toHaveText('Skipped, already there: 1', { timeout: 30_000 });
  expect(await cat('/tmp/e2e-clash/a.txt')).toBe('old\n');
  // The busy list with a finished copy: its head's button clear of the line under it (on a phone it touched).
  await lookAt(page, 'files-busy-finished');
  await page.getByTestId('paste').click();
  await ask.getByTestId('clash-rename').click();
  await expect(rows.filter({ hasText: 'a (1).txt' })).toBeVisible({ timeout: 30_000 });
  expect([await cat('/tmp/e2e-clash/a.txt'), await cat('/tmp/e2e-clash/a (1).txt')]).toEqual(['old\n', 'new\n']);
  await page.getByTestId('paste').click();
  await ask.getByTestId('clash-replace').click();
  // Its own line in the list (the fourth), done.
  await expect(status).toHaveCount(4);
  await expect(status.last()).toHaveText('done', { timeout: 30_000 });
  expect(await cat('/tmp/e2e-clash/a.txt')).toBe('new\n');
  // The busy list closed and opened again from its pill, then cleared.
  const drawer = page.getByTestId('transfers');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
  await page.getByTestId('transfers-pill').click();
  await drawer.getByRole('button', { name: 'Clear finished' }).click();
  await expect(status).toHaveCount(0);
  // The path's controls on these screens: the folder's own crumb lists it anew, the recent
  // folder and a crumb higher up go there.
  const crumbs = page.getByRole('navigation', { name: 'Path' });
  const listed = page.waitForResponse((r) => r.url().includes(`/list?path=${encodeURIComponent('/tmp/e2e-clash')}`) && r.ok());
  await crumbs.getByRole('button', { name: 'e2e-clash' }).click();
  await listed;
  await page.getByRole('button', { name: '/tmp/e2e-clash/src', exact: true }).click();
  await expect(page).toHaveURL(/p=%2Ftmp%2Fe2e-clash%2Fsrc$/);
  await expect(rows.filter({ hasText: 'a (1).txt' })).toBeVisible();
  await crumbs.getByRole('button', { name: 'tmp', exact: true }).click();
  await expect(page).toHaveURL(/p=%2Ftmp$/);
  await sh('rm -rf /tmp/e2e-clash');
});
