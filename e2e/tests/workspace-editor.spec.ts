import { expect, test, type Page } from './fixtures.js';
import { sayYes } from './confirm.js';
import { lookAt } from './checks.js';
import { hostNamed, saveCredential, signIn } from './passkey.js';

// Phase 7: a folder as a workspace, search across all its files, a commit.
// Plus quick open, replace, the diff, a root file through sudo and
// favourite folders. The test sshd has git, ripgrep and sudo.


/** Two frames after the page had its answer: whatever it was going to change, it has (AUDIT2 TEST-10). */
async function settled(page: Page, answer: Promise<unknown>): Promise<void> {
  await answer;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b === undefined ? (m === 'GET' ? undefined : '{}') : JSON.stringify(b) });
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

/** A screenshot for review, with every check of checks.ts on what is shown. */
async function shoot(page: Page, name: string) {
  await lookAt(page, name);
}

test('a folder as workspace: tree, tabs, quick open, search and replace, git commit', async ({ page }) => {
  test.setTimeout(120_000);
  await sayYes(page);
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: [
      'chmod -R u+rwx ~/proj 2>/dev/null; rm -rf ~/proj ~/proj-notes && mkdir -p ~/proj/app ~/proj/node_modules/x ~/proj/locked ~/proj-notes && chmod 000 ~/proj/locked',
      "printf 'needle in the notes\\n' > ~/proj-notes/todo.md",
      'cd ~/proj',
      "printf 'services:\\n  web:\\n    image: nginx\\n' > compose.yaml",
      "printf 'print(\"needle\")\\n' > app/main.py",
      "printf 'needle in a dependency\\n' > node_modules/x/n.txt",
      "printf 'node_modules/\\n' > .gitignore",
      'git init -q -b main',
    ].join(' && '),
  });

  // From Files: the folder's menu, "Open as workspace".
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester`);
  await page.getByRole('button', { name: 'Menu for proj', exact: true }).click();
  await page.getByTestId('open-workspace').click();
  await expect(page.getByText('test-sshd:/home/tester/proj')).toBeVisible();

  // The tree; a file in a tab.
  await page.getByTestId('tree-node').filter({ hasText: 'compose.yaml' }).click();
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'compose.yaml' })).toBeVisible();
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('  cache:\n    image: redis\n');
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'compose.yaml' }).getByTestId('dirty')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: /^compose\.yaml/ })).toBeVisible();
  // Typed while a save is on its way: still unsaved after it comes back (it
  // showed saved, and closing the tab lost the text without asking).
  const dirtyMark = page.getByTestId('ws-tabbar-item').filter({ hasText: 'compose.yaml' }).getByTestId('dirty');
  await expect(dirtyMark).toHaveCount(0);
  const slow = async (r: import('@playwright/test').Route) => {
    if (r.request().method() === 'PUT') await new Promise((w) => setTimeout(w, 1000));
    await r.continue();
  };
  await page.route('**/api/files/*/text', slow);
  await page.keyboard.insertText('# one\n');
  const saved = page.waitForResponse((r) => r.url().includes('/text') && r.request().method() === 'PUT');
  const putSent = page.waitForRequest((r) => r.url().includes('/text') && r.method() === 'PUT');
  await page.keyboard.press('Control+s');
  await putSent;
  await page.keyboard.insertText('# typed during the save\n');
  await settled(page, saved);
  await expect(dirtyMark).toBeVisible();
  await page.unroute('**/api/files/*/text', slow);
  await page.keyboard.press('Control+s');
  await expect(dirtyMark).toHaveCount(0);

  // A folder that cannot be read says so (it looked empty).
  await page.getByTestId('tree-node').filter({ hasText: 'locked' }).click();
  await expect(page.getByTestId('tree-error')).toContainText(/denied|permission/i);

  // Quick open.
  await page.keyboard.press('Control+p');
  await page.getByTestId('quick-open').fill('mainpy');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'main.py' })).toBeVisible();
  await shoot(page, 'desktop-workspace');

  // A second folder beside the first: its own tree, and search in it.
  await page.getByTestId('ws-add-folder').click();
  await page.getByTestId('confirm-input').fill('/home/tester/proj-notes');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('ws-root')).toHaveCount(2);
  await page.getByTestId('tree-node').filter({ hasText: 'todo.md' }).click();
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'todo.md' })).toBeVisible();
  await lookAt(page, 'workspace-two-folders');
  await page.getByTestId('ws-tab-search').click();
  await page.getByTestId('ws-folder').selectOption('/home/tester/proj-notes');
  await page.getByTestId('ws-search').fill('needle');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('ws-results')).toContainText('todo.md');
  // Aa, .* and Replace as high as the search beside them (report eb4f8a: lower, in the middle of its height).
  const field = (await page.getByTestId('ws-search').boundingBox())!;
  for (const name of ['Match case', 'Regular expression', 'Replace']) {
    const b = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(b.height, name).toBeCloseTo(field.height, 0);
  }
  await lookAt(page, 'workspace-search');
  // Aa and .* each turn on and off again; a hit opens its file and keeps it (the tree's click was a preview).
  for (const name of ['Match case', 'Regular expression']) {
    const b = page.getByRole('button', { name, exact: true });
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'false');
  }
  const todo = page.getByTestId('ws-tabbar-item').filter({ hasText: 'todo.md' });
  await expect(todo).toHaveClass(/preview/);
  await page.getByTestId('ws-results').getByRole('button', { name: /needle in the notes/ }).click();
  await expect(todo).not.toHaveClass(/preview/);
  await page.getByTestId('ws-tab-search').click();
  await page.getByTestId('ws-folder').selectOption('');
  await page.getByTestId('ws-tab-files').click();
  // Taken out again: the folder stays on the host, the workspace is one folder.
  await page.getByTestId('ws-remove-folder').click();
  await expect(page.getByTestId('ws-root')).toHaveCount(0);
  // Two added while the first is still being saved: both stay (AUDIT2 PAGE-29).
  let release!: () => void;
  let sending!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent = new Promise<void>((r) => (sending = r));
  let puts = 0;
  await page.route(/\/api\/workspaces\/\d+$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    if ((puts += 1) === 1) {
      sending();
      await held;
    }
    await route.continue();
  });
  await page.getByTestId('ws-add-folder').click();
  await page.getByTestId('confirm-input').fill('/home/tester/proj-notes');
  await page.getByTestId('confirm-ok').click();
  await sent;
  await page.getByTestId('ws-add-folder').click();
  await page.getByTestId('confirm-input').fill('/tmp');
  await page.getByTestId('confirm-ok').click();
  release();
  await expect(page.getByTestId('ws-root')).toHaveCount(3);
  await page.unroute(/\/api\/workspaces\/\d+$/);
  // One after the other: clicked before the first is gone, the second press hit the same folder.
  await page.getByTestId('ws-remove-folder').first().click();
  await expect(page.getByTestId('ws-root')).toHaveCount(2);
  await page.getByTestId('ws-remove-folder').first().click();
  await expect(page.getByTestId('ws-root')).toHaveCount(0);

  // Search all files (not node_modules), then replace.
  await page.getByTestId('ws-tab-search').click();
  await page.getByTestId('ws-search').fill('needle');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const results = page.getByTestId('ws-results');
  await expect(results).toContainText('app/main.py');
  await expect(results).not.toContainText('node_modules');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await page.getByTestId('ws-replace').fill('pin');
  await page.getByTestId('ws-replace-all').click();
  // The question says what happens: every match in the whole file, not only the lines shown (AUDIT2 UI-15).
  await expect.poll(() => page.evaluate(() => ((window as unknown as { __asked?: string[] }).__asked ?? []).join('\n'))).toContain('a line can hold more than one');
  // The open main.py follows (the notes' todo.md, from the folder taken out, is in front).
  await page.getByTestId('ws-tabbar-item').filter({ hasText: 'main.py' }).getByRole('button').first().click();
  await expect(page.locator('.cm-content').filter({ hasText: 'print("pin")' })).toBeVisible();

  // Git: changes, a diff, stage, commit (asks who commits once).
  await page.getByTestId('ws-tab-git').click();
  await expect(page.getByTestId('git-branch')).toContainText('main');
  await expect(page.getByTestId('git-file')).toHaveCount(3);
  await page.getByTestId('git-file').filter({ hasText: 'compose.yaml' }).locator('.gname').click();
  await expect(page.getByTestId('git-diff')).toContainText('redis');
  await shoot(page, 'desktop-git-diff');
  // Closed, opened again, and from the diff to the file itself.
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByTestId('git-diff')).toBeHidden();
  await page.getByTestId('git-file').filter({ hasText: 'compose.yaml' }).locator('.gname').click();
  await expect(page.getByTestId('git-diff')).toContainText('redis');
  // Its file on disk not readable: said, not a diff of the whole file deleted (AUDIT2 UI-12).
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.route('**/api/files/*/text?*compose.yaml*', (r) => r.fulfill({ status: 500, json: { error: 'internal', message: 'File not read.' } }));
  await page.getByTestId('git-file').filter({ hasText: 'compose.yaml' }).locator('.gname').click();
  await expect(page.getByTestId('git-diff-error')).toHaveText('File not read.');
  await expect(page.getByTestId('git-diff')).not.toContainText('services');
  await page.unroute('**/api/files/*/text?*compose.yaml*');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByTestId('git-file').filter({ hasText: 'compose.yaml' }).locator('.gname').click();
  await expect(page.getByTestId('git-diff')).toContainText('redis');
  await page.getByRole('dialog').getByRole('button', { name: 'Open file' }).click();
  await expect(page.getByTestId('ws-tab').filter({ hasText: 'compose.yaml' })).toBeVisible();
  await page.getByRole('button', { name: 'Stage all' }).click();
  await expect(page.getByText('Staged (3)')).toBeVisible();
  // One back, all back, then one and all staged again.
  await page.getByRole('button', { name: 'Unstage', exact: true }).first().click();
  await expect(page.getByText('Staged (2)')).toBeVisible();
  await page.getByRole('button', { name: 'Unstage all', exact: true }).click();
  await expect(page.getByText('Staged (')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stage', exact: true }).first().click();
  await expect(page.getByText('Staged (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Stage all', exact: true }).click();
  await expect(page.getByText('Staged (3)')).toBeVisible();
  await page.getByTestId('commit-message').fill('First commit from Burrow');
  await page.getByTestId('commit').click();
  const who = page.getByRole('dialog', { name: 'Who commits?' });
  await expect(who).toBeVisible();
  await shoot(page, 'desktop-git-identity');
  // Not now: nothing committed; asked again at the next commit.
  await who.getByRole('button', { name: 'Cancel' }).click();
  await expect(who).toBeHidden();
  await page.getByTestId('commit').click();
  await expect(who).toBeVisible();
  await who.getByLabel('Name').fill('Burrow E2E');
  await who.getByLabel('E-mail').fill('e2e@example.com');
  await who.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('No changes.')).toBeVisible({ timeout: 15_000 });
  const log = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'cd ~/proj && git log --format="%an %s"' });
  expect(log[0]!.stdout.trim()).toBe('Burrow E2E First commit from Burrow');

  // Workspaces are listed with the hosts.
  await page.goto('/#/hosts');
  await expect(page.getByTestId('workspaces')).toContainText('proj');
});

test('Replace All replaces what was searched; an open file read again keeps what is typed meanwhile', async ({ page }) => {
  await sayYes(page);
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "rm -rf ~/proj-rep && mkdir -p ~/proj-rep && cd ~/proj-rep && printf 'alpha one\\n' > a.txt && printf 'beta two\\n' > b.txt" });
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester`);
  await page.getByRole('button', { name: 'Menu for proj-rep', exact: true }).click();
  await page.getByTestId('open-workspace').click();
  await page.getByTestId('tree-node').filter({ hasText: 'a.txt' }).click();
  await expect(page.locator('.cm-content')).toContainText('alpha one');

  // Searched for alpha, then the words changed: no results, nothing to replace.
  await page.getByTestId('ws-tab-search').click();
  await page.getByTestId('ws-search').fill('alpha');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('ws-results')).toContainText('a.txt');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await page.getByTestId('ws-replace').fill('gamma');
  await page.getByTestId('ws-search').fill('o');
  await expect(page.getByTestId('ws-results')).toBeHidden();
  await expect(page.getByTestId('ws-replace-all')).toBeDisabled();
  await page.getByTestId('ws-search').fill('alpha');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('ws-results')).toContainText('a.txt');

  // The open a.txt is read again after the replace; typed in while that read is on its way: kept.
  let release!: () => void;
  let reading!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const asked = new Promise<void>((r) => (reading = r));
  await page.route(`**/api/files/${sshd}/text?*`, async (route) => {
    reading();
    await held;
    await route.continue();
  });
  await page.getByTestId('ws-replace-all').click();
  await asked;
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('typed meanwhile');
  const reread = page.waitForResponse((r) => r.url().includes(`/api/files/${sshd}/text?`) && r.request().method() === 'GET');
  release();
  await settled(page, reread);
  await expect(page.locator('.cm-content')).toContainText('typed meanwhile');
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'a.txt' }).getByTestId('dirty')).toBeVisible();
  await page.unroute(`**/api/files/${sshd}/text?*`);
  const files = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'cat ~/proj-rep/a.txt ~/proj-rep/b.txt' });
  expect(files[0]!.stdout).toBe('gamma one\nbeta two\n');
});

test('find in a file says how often the text is there and which one is chosen (report dc29b4)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "printf 'port: 80\\nport: 443\\nname: web\\nport: 8080\\n' > ~/find-count.yml" });
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/home/tester/find-count.yml')}`);
  await expect(page.locator('.cm-content')).toContainText('port: 8080');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+f');
  const field = page.locator('.cm-search input[name=search]');
  const count = page.getByTestId('editor-find-count');
  // In place as the panel opens, before a key: coming with the first query, it moved the rows under a tap.
  await expect(count).toBeAttached();
  // Typed, as a person does: the panel takes its query on each key (keyup), not on fill.
  await field.pressSequentially('port');
  await expect(count).toHaveText('3 matches');
  await field.press('Enter');
  await expect(count).toHaveText(/^[123] of 3$/);
  const first = await count.textContent();
  await field.press('Enter');
  await expect(count).not.toHaveText(first!);
  await field.fill('');
  await field.pressSequentially('nothing here');
  await expect(count).toHaveText('No results');
  await field.fill('');
  await field.pressSequentially('name');
  await expect(count).toHaveText('1 match');
  await lookAt(page, 'editor-find-count');
});

/** Files dropped on an element as from the computer's file manager (a DataTransfer made in the page). */
async function dropFiles(page: Page, target: import('@playwright/test').Locator, files: { name: string; text: string }[]) {
  const dt = await page.evaluateHandle((fs) => {
    const d = new DataTransfer();
    for (const f of fs) d.items.add(new File([f.text], f.name, { type: 'text/plain' }));
    return d;
  }, files);
  await target.dispatchEvent('dragenter', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
}

test('files dropped from the computer on a folder of the tree go up there; a name there already is asked (report 6d86aa)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/proj-drop && mkdir -p ~/proj-drop/sub && echo a > ~/proj-drop/a.txt' });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-drop' });
  await page.goto(`/#/ws/${ws.id}`);
  const sub = page.getByTestId('tree-node').filter({ hasText: 'sub' });
  await expect(sub).toBeVisible();
  await dropFiles(page, sub, [{ name: 'dropped.txt', text: 'hello' }]);
  // Up into sub, and shown there (sub opened).
  await expect(page.locator('[data-testid=tree-node][data-path="sub/dropped.txt"]')).toBeVisible({ timeout: 15_000 });
  const got = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'cat ~/proj-drop/sub/dropped.txt' });
  expect(got[0]!.stdout).toBe('hello');
  // The same name again, on a file of that folder (its folder takes it): Replace or Keep both, as in Files.
  await dropFiles(page, page.locator('[data-testid=tree-node][data-path="sub/dropped.txt"]'), [{ name: 'dropped.txt', text: 'again' }]);
  await expect(page.getByTestId('confirm-text')).toContainText('dropped (1).txt');
  await page.getByTestId('confirm-other').click();
  await expect(page.locator('[data-testid=tree-node][data-path="sub/dropped (1).txt"]')).toBeVisible({ timeout: 15_000 });
  // Elsewhere in the tree (its empty room): the workspace's own folder.
  await dropFiles(page, page.getByRole('tree').first(), [{ name: 'top.txt', text: 'top' }]);
  await expect(page.locator('[data-testid=tree-node][data-path="top.txt"]')).toBeVisible({ timeout: 15_000 });
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('the tree shows files made elsewhere without a reload, and Read again does it at once (report 905455)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/proj-fresh && mkdir -p ~/proj-fresh && echo a > ~/proj-fresh/a.txt' });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-fresh' });
  await page.goto(`/#/ws/${ws.id}`);
  await expect(page.locator('[data-testid=tree-node][data-path="a.txt"]')).toBeVisible();
  // Made in a terminal (here: a command): there within the tree's own round, no reload.
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'echo b > ~/proj-fresh/made-elsewhere.txt' });
  await expect(page.locator('[data-testid=tree-node][data-path="made-elsewhere.txt"]')).toBeVisible({ timeout: 15_000 });
  // At once with the button.
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'echo c > ~/proj-fresh/right-now.txt' });
  await page.getByTestId('ws-refresh').click();
  await expect(page.locator('[data-testid=tree-node][data-path="right-now.txt"]')).toBeVisible({ timeout: 3000 });
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('a right click on the tree: the menu of the file, its Edit in a tab here, a rename seen in the tree', async ({ page }) => {
  // Reported (80a8ce): the right mouse button did nothing in a workspace.
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "rm -rf ~/proj-menu && mkdir -p ~/proj-menu && printf 'one\\n' > ~/proj-menu/first.txt" });
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester`);
  await page.getByRole('button', { name: 'Menu for proj-menu', exact: true }).click();
  await page.getByTestId('open-workspace').click();
  const node = page.getByTestId('tree-node').filter({ hasText: 'first.txt' });
  await node.click({ button: 'right' });
  const sheet = page.getByRole('dialog', { name: 'first.txt' });
  await expect(sheet).toBeVisible();
  // No "Select" here: choosing several is the Files page's.
  await expect(sheet.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'first.txt' })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('one');
  await expect(page).toHaveURL(/#\/ws\//);
  // A rename from the menu: the tree reads the folder again.
  await page.getByTestId('tree-node').filter({ hasText: 'first.txt' }).click({ button: 'right' });
  await sheet.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.locator('dialog[open]').getByRole('textbox').first().fill('second.txt');
  await page.locator('dialog[open]').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByTestId('tree-node').filter({ hasText: 'second.txt' })).toBeVisible();
  // A new file in a folder from the tree's menu opens in a tab; its path copied (review 2026-10-24).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('tree-node').filter({ hasText: 'second.txt' }).click({ button: 'right' });
  await page.getByRole('dialog', { name: 'second.txt' }).getByTestId('copy-path').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/home/tester/proj-menu/second.txt');
  // Its open tab follows the new name (review 2026-10-24: it stayed on the old one, and a save said "deleted").
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'second.txt' })).toBeVisible();
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'first.txt' })).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('one');
  // Deleted from the menu: its tab closes.
  await page.getByTestId('tree-node').filter({ hasText: 'second.txt' }).click({ button: 'right' });
  await page.getByRole('dialog', { name: 'second.txt' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('ws-tabbar-item')).toHaveCount(0);
  // A new file in a folder, from the folder's menu: made there and open in a tab.
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'mkdir -p ~/proj-menu/sub' });
  await page.getByTestId('ws-refresh').click();
  await page.getByTestId('tree-node').filter({ hasText: 'sub' }).click({ button: 'right' });
  await page.getByRole('dialog', { name: 'sub' }).getByTestId('new-file-in').click();
  await page.locator('dialog[open]').getByRole('textbox').fill('made.txt');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'made.txt' })).toBeVisible();
  // And a folder.
  await page.getByTestId('tree-node').filter({ hasText: 'sub' }).first().click({ button: 'right' });
  await page.getByRole('dialog', { name: 'sub' }).getByTestId('new-folder-in').click();
  await page.locator('dialog[open]').getByRole('textbox').fill('deeper');
  await page.getByTestId('confirm-ok').click();
  await expect
    .poll(async () => (await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'ls -F ~/proj-menu/sub' }))[0]!.stdout)
    .toMatch(/deeper\/[\s\S]*made\.txt|made\.txt[\s\S]*deeper\//);
});

test('a root file anyone may read: read only at once with Edit with sudo, saved as root keeping its mode (W-FUNC-01)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "printf '%s\\n' burrow-test-password | sudo -S -p '' sh -c \"printf 'werk=1\\n' > /etc/werk.conf && chmod 644 /etc/werk.conf\"" });
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/etc/werk.conf')}`);
  await expect(page.locator('.cm-content')).toContainText('werk=1');
  // Said before any typing (it let you type, then refused the save).
  await expect(page.getByTestId('root-only-bar')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');
  await page.getByTestId('edit-sudo').click();
  const pw = page.getByRole('dialog', { name: 'sudo password' });
  await pw.getByLabel('sudo password').fill('burrow-test-password');
  await pw.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('sudo-bar')).toBeVisible();
  await expect(page.getByTestId('root-only-bar')).toHaveCount(0);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('# via sudo\n');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);
  const [out] = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "stat -c '%U %a' /etc/werk.conf; tail -n 1 /etc/werk.conf" });
  expect(out!.stdout.trim()).toBe('root 644\n# via sudo');
});

test('root files through sudo; favourite folders across hosts', async ({ page }) => {
  await sayYes(page);
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/etc/burrowtest.conf')}`);
  await page.getByTestId('open-sudo').click();
  // This host has no stored password (a key replaced it): sudo asks for one.
  const pw = page.getByRole('dialog', { name: 'sudo password' });
  await expect(pw).toBeVisible();
  await shoot(page, 'desktop-sudo-password');
  // Not now: the file stays closed; asked again.
  await pw.getByRole('button', { name: 'Cancel' }).click();
  await expect(pw).toBeHidden();
  await page.getByTestId('open-sudo').click();
  await expect(pw).toBeVisible();
  await pw.getByLabel('sudo password').fill('burrow-test-password');
  await pw.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('sudo-bar')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('listen');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('# via sudo\n');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('editor-title').getByTestId('dirty')).toHaveCount(0);
  const out = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "sudo -n true 2>/dev/null; stat -c '%U %a' /etc/burrowtest.conf" });
  expect(out[0]!.stdout.trim()).toBe('root 600');
  // And what was typed is in the file, read as root on its own (AUDIT2 TEST-17: a save that wrote nothing passed).
  const [saved] = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "printf '%s\\n' burrow-test-password | sudo -S -p '' tail -n 1 /etc/burrowtest.conf" });
  expect(saved!.stdout.trim()).toBe('# via sudo');

  // A starred folder shows on the Files start page for any host.
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester%2Fproj`);
  const star = page.getByRole('button', { name: 'Bookmark this folder' });
  await expect(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'proj', exact: true })).toHaveAttribute('aria-current', 'page');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/#/files');
  await expect(page.getByTestId('favorites')).toContainText('test-sshd:/home/tester/proj');
  await page.getByTestId('favorites').getByRole('button').first().click();
  await expect(page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'proj', exact: true })).toHaveAttribute('aria-current', 'page');
  // And unstarred again.
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await page.goto('/#/files');
  await expect(page.getByTestId('favorites').getByText('test-sshd:/home/tester/proj')).toHaveCount(0);

  // Permissions: others may read the compose file no more.
  await page.goto(`/#/files/${sshd}?p=%2Fhome%2Ftester%2Fproj`);
  await page.getByRole('button', { name: 'Menu for compose.yaml' }).click();
  await page.getByRole('button', { name: 'Properties' }).click();
  const others = page.getByRole('checkbox', { name: 'other r' });
  if (!(await others.isChecked())) await others.check();
  await others.uncheck();
  await page.locator('dialog[open]').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.').first()).toBeVisible();
  const mode = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "stat -c '%a' ~/proj/compose.yaml" });
  expect(Number(mode[0]!.stdout.trim().slice(-1)) & 4).toBe(0);

  // A folder's owner for everything inside, the permissions left alone: a
  // private file inside stays private (AUDIT2 UI-01: its mode became the folder's).
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'printf s > ~/proj/app/secret.txt && chmod 600 ~/proj/app/secret.txt && chmod 755 ~/proj/app' });
  const sent: { url: string; body: unknown }[] = [];
  await page.route('**/api/files/*/ch*', (r) => (sent.push({ url: r.request().url(), body: r.request().postDataJSON() }), r.fallback()));
  await page.reload();
  await page.getByRole('button', { name: 'Menu for app' }).click();
  await page.getByRole('button', { name: 'Properties' }).click();
  await page.getByTestId('owner-recursive').check();
  await expect(page.getByTestId('perm-recursive')).not.toBeChecked();
  await page.locator('dialog[open]').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.').first()).toBeVisible();
  expect(sent.map((x) => x.url.replace(/.*\//, ''))).toEqual(['chown']);
  expect(sent[0]!.body).toMatchObject({ owner: 'tester', recursive: true });
  const inside = await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "stat -c '%a' ~/proj/app/secret.txt" });
  expect(inside[0]!.stdout.trim()).toBe('600');
  await page.unroute('**/api/files/*/ch*');
});

test('repositories below the workspace folder: chosen in Git, and the open file picks its own (report 91e73c)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: [
      'rm -rf ~/mono && mkdir -p ~/mono/svc-a ~/mono/libs/svc-b',
      'cd ~/mono/svc-a && git init -q -b main && printf "a\\n" > a.txt',
      'cd ~/mono/libs/svc-b && git init -q -b main && printf "b\\n" > b.txt',
    ].join(' && '),
  });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/mono', name: 'mono' });
  await page.goto(`/#/ws/${ws.id}`);
  await page.getByTestId('ws-tab-git').click();
  // The folder itself is no repository; the two below it can be chosen.
  const pick = page.getByTestId('ws-folder');
  await expect(pick.locator('option')).toHaveText(['/home/tester/mono', '/home/tester/mono/libs/svc-b', '/home/tester/mono/svc-a']);
  await pick.selectOption('/home/tester/mono/svc-a');
  await expect(page.getByTestId('git-file')).toHaveText(/a\.txt/);
  // A file of the other one opened (from the whole folder): its repository chosen by itself.
  await pick.selectOption('');
  await page.keyboard.press('Control+p');
  await page.getByTestId('quick-open').fill('b.txt');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'b.txt' })).toBeVisible();
  await expect(pick).toHaveValue('/home/tester/mono/libs/svc-b');
  await expect(page.getByTestId('git-file')).toHaveText(/b\.txt/);
  await page.evaluate((id) => fetch(`/api/workspaces/${id}`, { method: 'DELETE' }), ws.id);
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/mono' });
});

test('a save refused as changed on the host, and its new version not readable: said, the text kept (AUDIT2 UI-17)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await page.evaluate((id) => fetch('/api/snippets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostIds: [id], command: "printf 'one\\n' > ~/conflict-unread.txt" }) }), sshd);
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent('/home/tester/conflict-unread.txt')}`);
  await expect(page.locator('.cm-content')).toContainText('one');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('two');
  await page.route(`**/api/files/${sshd}/text**`, (r) =>
    r.request().method() === 'PUT' ? r.fulfill({ status: 409, json: { error: 'conflict', message: 'changed' } }) : r.fulfill({ status: 500, json: { error: 'internal', message: 'not read' } }),
  );
  await page.keyboard.press('Control+s');
  await expect(page.getByText('The file changed on the host, and its new version could not be read.')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('two');
  await expect(page.locator('dialog[open][data-tour=editor-conflict]')).toHaveCount(0);
  await page.unroute(`**/api/files/${sshd}/text**`);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('dirty')).toHaveCount(0);
});

test('Go to file closed while its list still loads: an Enter typed before opens nothing (AUDIT2 UI-14)', async ({ page }) => {
  await signIn(page);
  const ws = (await page.evaluate(async () => (await (await fetch('/api/workspaces')).json()) as { id: number; root: string }[])).find((w) => w.root.endsWith('/proj'))!;
  await page.goto(`/#/ws/${ws.id}`);
  await expect(page.getByTestId('ws-root').or(page.getByTestId('tree-node')).first()).toBeVisible();
  const tabs = await page.getByTestId('ws-tabbar-item').count();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/workspace/*/files?*', async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.keyboard.press('Control+p');
  await page.getByTestId('quick-open').fill('mainpy');
  await page.keyboard.press('Enter');
  // Its close button (Escape first empties the search field).
  await page.locator('dialog[open][data-tour=quick-open]').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('dialog[open][data-tour=quick-open]')).toHaveCount(0);
  const isList = (url: string) => /\/api\/workspace\/\d+\/files\?/.test(url);
  const listed = Promise.race([page.waitForResponse((r) => isList(r.url())), page.waitForEvent('requestfailed', (r) => isList(r.url()))]);
  release();
  await settled(page, listed);
  await expect(page.getByTestId('ws-tabbar-item')).toHaveCount(tabs);
  await page.unroute('**/api/workspace/*/files?*');
});

test("a tap on the number of a line that starts a block folds it, a second unfolds it; a line without one stays as it is", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const path = '/tmp/fold-me.json';
  await api(page, 'PUT', `/api/files/${sshd}/text`, { path, content: '{\n  "a": {\n    "b": 1,\n    "c": 2\n  },\n  "d": 3\n}\n', baseHash: null }).catch(() => {});
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent(path)}`);
  const editor = page.getByTestId('editor');
  const content = editor.locator('.cm-content');
  await expect(content).toContainText('"c": 2');
  const lineNumber = (n: number) => editor.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${n}$`) });
  await lineNumber(2).click();
  await expect(editor.locator('.cm-foldPlaceholder')).toHaveCount(1);
  await expect(content).not.toContainText('"c": 2');
  await lineNumber(2).click();
  await expect(editor.locator('.cm-foldPlaceholder')).toHaveCount(0);
  await expect(content).toContainText('"c": 2');
  await lineNumber(6).click();
  await expect(editor.locator('.cm-foldPlaceholder')).toHaveCount(0);
  await expect(content).toContainText('"d": 3');
});

test('open files reordered: a tab dragged onto another, or moved with Ctrl+Shift and an arrow; kept after a reload (report 50a6f6)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/tab-order && mkdir -p ~/tab-order && for f in one two three; do echo $f > ~/tab-order/$f.txt; done' });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/tab-order' });
  await page.evaluate((id) => localStorage.setItem(`burrow.ws.${id}`, JSON.stringify({ tabs: ['one.txt', 'two.txt', 'three.txt'], current: 'one.txt' })), ws.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/ws/${ws.id}`);
  const tabs = page.getByTestId('ws-tab');
  await expect(tabs).toHaveText(['one.txt', 'two.txt', 'three.txt']);
  // Dragged, as in VS Code: three onto one goes before it.
  await page.getByTestId('ws-tabbar-item').nth(2).dragTo(page.getByTestId('ws-tabbar-item').nth(0));
  await expect(tabs).toHaveText(['three.txt', 'one.txt', 'two.txt']);
  // By keyboard: the focused tab one place to the right, then back.
  await tabs.filter({ hasText: 'three.txt' }).focus();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect(tabs).toHaveText(['one.txt', 'three.txt', 'two.txt']);
  await expect(tabs.filter({ hasText: 'three.txt' })).toBeFocused();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect(tabs).toHaveText(['one.txt', 'two.txt', 'three.txt']);
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await expect(tabs).toHaveText(['one.txt', 'three.txt', 'two.txt']);
  // Kept on this device, as the open tabs are.
  await page.reload();
  await expect(tabs).toHaveText(['one.txt', 'three.txt', 'two.txt']);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('a file with Windows line ends keeps them; an open file changed on the host is read again; Ctrl+S saves from the tabs too (review 2026-10-24)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const sh = async (command: string) => (await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command }))[0]!.stdout;
  await sh("rm -rf ~/proj-eol && mkdir -p ~/proj-eol && printf 'one\\r\\ntwo\\r\\n' > ~/proj-eol/win.txt && echo first > ~/proj-eol/plain.txt");
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-eol' });
  await page.goto(`/#/ws/${ws.id}`);
  // The tab in front: every open tab keeps an editor of its own.
  const editor = page.locator('.cm-content:visible');
  // Windows line ends: no line marked changed, typed and undone is not unsaved, saved with "\r\n" still.
  await page.locator('[data-testid=tree-node][data-path="win.txt"]').click();
  await expect(editor).toContainText('two');
  await expect(page.locator('.cm-change')).toHaveCount(0);
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('three');
  await expect(page.getByTestId('dirty')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('dirty')).toHaveCount(0);
  await page.keyboard.type('three');
  // Saved with the focus on the tab, not in the text: Burrow's save, not the browser's "Save page".
  await page.getByTestId('ws-tab').filter({ hasText: 'win.txt' }).focus();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('dirty')).toHaveCount(0);
  expect(await sh("tr -cd '\\r' < ~/proj-eol/win.txt | wc -c")).toMatch(/^\s*2\s*$/);
  expect(await sh('cat ~/proj-eol/win.txt')).toContain('three');
  // Changed on the host (a git pull, another program) while open and unchanged here: read again.
  await page.locator('[data-testid=tree-node][data-path="plain.txt"]').click();
  await expect(editor).toContainText('first');
  // At once after it was opened (a change in the second it was read in is compared by its text).
  await sh('echo changed-on-the-host > ~/proj-eol/plain.txt');
  await expect(editor).toContainText('changed-on-the-host', { timeout: 20_000 });
  // A picture from the tree is shown, not opened as a tab that says "binary".
  await sh('printf iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg== | base64 -d > ~/proj-eol/dot.png');
  await page.getByTestId('ws-refresh').click();
  await page.locator('[data-testid=tree-node][data-path="dot.png"]').click();
  await expect(page.getByTestId('viewer-image')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ws-tab').filter({ hasText: 'dot.png' })).toHaveCount(0);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('the command palette: every command of the workspace and the file in front, by a few letters (F1, Ctrl+Shift+P)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "rm -rf ~/proj-cmd && mkdir -p ~/proj-cmd && printf 'a: 1\\nb:\\n  c: 2\\n  d: 3\\n' > ~/proj-cmd/conf.yaml" });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-cmd' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/ws/${ws.id}`);
  await page.locator('[data-testid=tree-node][data-path="conf.yaml"]').click();
  await expect(page.locator('.cm-content:visible')).toContainText('d: 3');
  // F1: the file's own commands too, with their keys.
  await page.keyboard.press('F1');
  const box = page.getByTestId('command-palette');
  await expect(box).toBeFocused();
  await expect(page.getByTestId('command').filter({ hasText: 'Go to line' })).toContainText('Ctrl+Alt+G');
  await shoot(page, 'command-palette');
  await box.fill('fold every');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(1);
  // Ctrl+Shift+P too; the one used last comes first.
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command').first()).toHaveText('Fold everything');
  await box.fill('git');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-tab-git')).toHaveAttribute('aria-selected', 'true');
  // From its button, a name it does not know.
  await page.getByTestId('ws-commands').click();
  await box.fill('zzzz');
  await expect(page.getByText('No command by that name')).toBeVisible();
  await page.keyboard.press('Escape');
  // A tab closed, and opened again from the palette.
  await page.getByTestId('ws-tab-close').click();
  await expect(page.getByTestId('ws-tab')).toHaveCount(0);
  await page.keyboard.press('F1');
  await box.fill('reopen');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-tab').filter({ hasText: 'conf.yaml' })).toBeVisible();
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('git as in VS Code: the change marks against the last commit, changes thrown away, another branch (review 2026-10-24)', async ({ page }) => {
  await sayYes(page);
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const sh = async (command: string) => (await api<{ stdout: string }[]>(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command }))[0]!.stdout;
  await sh("rm -rf ~/proj-git && mkdir -p ~/proj-git && cd ~/proj-git && git init -q -b main && printf 'one\\ntwo\\n' > f.txt && git add f.txt && git -c user.name=t -c user.email=t@example.com commit -qm first && git branch other && printf 'one\\nTWO\\n' > f.txt");
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-git' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/ws/${ws.id}`);
  await page.locator('[data-testid=tree-node][data-path="f.txt"]').click();
  await expect(page.locator('.cm-content:visible')).toContainText('TWO');
  // Nothing typed, yet line 2 is marked: it differs from the commit.
  await expect(page.locator('.cm-change-mod')).toHaveCount(1);
  await expect(page.getByTestId('dirty')).toHaveCount(0);
  // Thrown away from the Git side: the file as committed, read again in its tab.
  await page.getByTestId('ws-tab-git').click();
  await page.getByTestId('git-discard').click();
  await expect(page.locator('.cm-content:visible')).toContainText('two', { timeout: 20_000 });
  await expect(page.locator('.cm-change')).toHaveCount(0);
  expect(await sh('cat ~/proj-git/f.txt')).toBe('one\ntwo\n');
  // All at once: a change and a new file.
  await sh("cd ~/proj-git && echo three >> f.txt && echo new > g.txt");
  await page.getByRole('button', { name: 'Reload' }).first().click();
  await page.getByTestId('git-discard-all').click();
  await expect.poll(() => sh('cd ~/proj-git && git status --porcelain')).toBe('');
  // Another branch, from the branch's name.
  await page.getByTestId('git-branch').click();
  await shoot(page, 'git-branches');
  await page.getByTestId('git-branch-item').filter({ hasText: 'other' }).click();
  await expect(page.getByTestId('git-branch')).toContainText('other');
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test("the outline of the file in front, and the open files' problems in one list (review 2026-10-24)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', {
    hostIds: [sshd],
    command: "rm -rf ~/proj-outline && mkdir -p ~/proj-outline && printf 'services:\\n  web:\\n    image: nginx\\n  db:\\n    image: postgres\\n' > ~/proj-outline/compose.yaml && printf 'FROM debian:12\\nRUN apt-get update && apt-get install -y curl\\n' > ~/proj-outline/Dockerfile",
  });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-outline' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/ws/${ws.id}`);
  await page.locator('[data-testid=tree-node][data-path="compose.yaml"]').click();
  await page.getByTestId('ws-tab-outline').click();
  const items = page.getByTestId('outline-item');
  await expect(items).toHaveCount(5);
  await expect(items.nth(3)).toContainText('db');
  await shoot(page, 'workspace-outline');
  await items.nth(3).click();
  await expect(page.locator('.cm-activeLine:visible')).toContainText('db:');
  // Typed: the outline follows a moment later.
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('  cache:\n    image: redis\n');
  await expect(items).toHaveCount(7);
  // A second file with a problem: the badge counts every open file's, its list says whose.
  await page.getByTestId('ws-tab-files').click();
  await page.locator('[data-testid=tree-node][data-path="Dockerfile"]').click();
  await expect(page.getByTestId('problems-badge')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('ws-tab').filter({ hasText: 'compose.yaml' }).click();
  // Its linter's answer may come a moment after the badge: the list as it is when opened.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await page.getByTestId('problems-badge').click();
    await expect(page.getByTestId('ws-problems')).toContainText('Dockerfile', { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await shoot(page, 'workspace-problems');
  await page.getByTestId('ws-problem').filter({ hasText: 'DL3008' }).click();
  await expect(page.getByTestId('ws-tab').filter({ hasText: 'Dockerfile' })).toHaveAttribute('aria-current', 'true');
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('two files side by side on a wide screen: moved with their unsaved text, kept after a reload, one side on a phone (review 2026-10-24)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/proj-split && mkdir -p ~/proj-split && echo left > ~/proj-split/a.txt && echo right > ~/proj-split/b.txt' });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-split' });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`/#/ws/${ws.id}`);
  await page.locator('[data-testid=tree-node][data-path="a.txt"]').dblclick();
  await page.locator('[data-testid=tree-node][data-path="b.txt"]').dblclick();
  // Typed in b, not saved, then b to the other side: the same editor, its text still there.
  await page.locator('.cm-content:visible').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' typed');
  await page.keyboard.press('F1');
  await page.getByTestId('command-palette').fill('other side');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-tabbar')).toHaveCount(2);
  const editors = page.locator('.cm-content:visible');
  await expect(editors).toHaveCount(2);
  await expect(editors.nth(0)).toContainText('left');
  await expect(editors.nth(1)).toContainText('right typed');
  await expect(page.getByTestId('ws-tabbar').nth(1).getByTestId('dirty')).toHaveCount(1);
  await shoot(page, 'workspace-split');
  // A click in the left one puts it in front: its tab is the current one.
  await editors.nth(0).click();
  await expect(page.getByTestId('ws-tab').filter({ hasText: 'a.txt' })).toHaveAttribute('aria-current', 'true');
  // Kept after a reload (the typed text was saved first).
  await page.getByTestId('ws-tab').filter({ hasText: 'b.txt' }).click();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('dirty')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('ws-tabbar')).toHaveCount(2);
  // Renamed from the tree: its tab follows the new name on the same side (audit 2026-11-05: it went back to the left).
  await page.locator('[data-testid=tree-node][data-path="b.txt"]').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'b.txt' }).getByRole('button', { name: 'Rename', exact: true }).click();
  await page.locator('dialog[open]').getByRole('textbox').first().fill('c.txt');
  await page.locator('dialog[open]').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByTestId('ws-tabbar').nth(1).getByTestId('ws-tab').filter({ hasText: 'c.txt' })).toBeVisible();
  await expect(page.getByTestId('ws-tabbar')).toHaveCount(2);
  // Narrow: one side, every tab in one bar.
  await page.setViewportSize({ width: 412, height: 800 });
  await expect(page.getByTestId('ws-tabbar')).toHaveCount(1);
  await expect(page.getByTestId('ws-tab')).toHaveCount(2);
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test("a language server not connected says what that means and why, and connects again; one that went comes back by itself (report 76bcda)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "rm -rf ~/proj-lsp && mkdir -p ~/proj-lsp && printf 'a: 1\\n' > ~/proj-lsp/conf.yaml" });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-lsp' });
  // Refused first, as the bridge does at its limit per person.
  let refuse = true;
  let opened = 0;
  await page.routeWebSocket(/\/api\/lsp\//, (r) => {
    if (refuse) return void r.close({ code: 4404, reason: 'Close an editor first.' });
    opened++;
    const server = r.connectToServer();
    // The first that opens goes again after a moment (Burrow restarting): the editor connects again by itself.
    if (opened === 1) setTimeout(() => void server.close(), 1500);
  });
  await page.goto(`/#/ws/${ws.id}`);
  // A page of its own: a socket is routed only in a page loaded after the route was set.
  await page.reload();
  await page.locator('[data-testid=tree-node][data-path="conf.yaml"]').click();
  await page.getByTestId('editor-menu').click();
  await expect(page.getByTestId('lsp-off')).toContainText('too many open files with a language server');
  await expect(page.getByTestId('lsp-off')).toContainText('The editor works on without it');
  refuse = false;
  await page.getByTestId('lsp-retry').click();
  await expect.poll(() => opened, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await page.getByTestId('editor-menu').click();
  await expect(page.getByTestId('lsp-off')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Format' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('ask AI about the selected lines or the whole file: masked, answered, asked further, kept for the file (report 76bcda)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "rm -rf ~/proj-ask && mkdir -p ~/proj-ask && printf 'name: web\\nport: 8080\\npassword: hunter2-in-file\\n' > ~/proj-ask/app.yaml" });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-ask' });
  type Ai = { provider: string; ollama: { url: string; model: string }; anthropic: { model: string }; openai: { url: string; model: string }; timeoutMinutes: number; prices: { input: number | null; output: number | null; currency: string } };
  const before = await api<Ai>(page, 'GET', '/api/settings/ai');
  const input = (a: Ai) => ({ provider: a.provider, ollama: a.ollama, anthropic: { model: a.anthropic.model }, openai: { url: a.openai.url, model: a.openai.model }, timeoutMinutes: a.timeoutMinutes, prices: a.prices });
  const llm = process.env.LLM_URL ?? 'http://burrow-e2e-llm:8000/v1';
  await api(page, 'PUT', '/api/settings/ai', input({ ...before, provider: 'openai', openai: { url: llm, model: 'fake-model' } }));
  // As with a Claude key set too: "Ask Claude instead" offered.
  await page.route('**/api/ai/analyze/options', async (r) => r.fulfill({ json: { ...((await (await r.fetch()).json()) as object), deep: true } }));
  try {
    await page.goto(`/#/ws/${ws.id}`);
    await page.locator('[data-testid=tree-node][data-path="app.yaml"]').click();
    const editor = page.locator('.cm-content').first();
    await expect(editor).toContainText('port: 8080');
    // Lines 2 and 3 selected.
    await page.locator('.cm-line', { hasText: 'port: 8080' }).first().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+End');
    await page.getByTestId('editor-menu').click();
    await page.getByTestId('editor-ask-ai').click();
    const dialog = page.getByRole('dialog', { name: 'Ask AI about this file' });
    await expect(dialog.getByTestId('file-ask-chosen')).toBeChecked();
    await expect(dialog.getByTestId('file-ask-sends')).toContainText('lines 2-3 of app.yaml');
    await expect(dialog.getByTestId('file-ask-sends')).toContainText('fake-model');
    await expect(dialog.getByTestId('file-ask-run')).toBeDisabled();
    // Claude named while ticked, the model set up again when not.
    const deep = dialog.getByRole('checkbox', { name: 'Ask Claude instead (more thorough)' });
    await deep.check();
    await expect(dialog.getByTestId('file-ask-sends')).toContainText('your question to Claude');
    await deep.uncheck();
    await expect(dialog.getByTestId('file-ask-sends')).toContainText('your question to openai:fake-model');
    await dialog.getByTestId('file-ask-question').fill('What does this set?');
    await dialog.getByTestId('file-ask-run').click();
    await expect(dialog.getByTestId('file-ask-answer')).toContainText('Line 2 reads: port: 8080', { timeout: 30_000 });
    await expect(dialog.getByTestId('file-ask-asked')).toContainText('What does this set?');
    // The password in the file never went to the model.
    const seen = (await (await page.request.get(`${process.env.APPS_BASE ?? 'http://localhost:8191'}/llm-seen?q=hunter2-in-file`)).json()) as { requests: number; with: number };
    expect(seen.requests).toBeGreaterThan(0);
    expect(seen.with).toBe(0);
    await shoot(page, 'desktop-file-ask-answer');
    // Asked further, with the answer before.
    await dialog.getByTestId('file-ask-further').fill('And the name?');
    await dialog.getByTestId('file-ask-further-send').click();
    await expect(dialog.getByTestId('analysis-reply')).toContainText('Asked further: And the name?', { timeout: 30_000 });
    // A new question about the whole file: from line 1.
    await dialog.getByTestId('file-ask-new').click();
    await dialog.getByTestId('file-ask-whole').check();
    await expect(dialog.getByTestId('file-ask-sends')).toContainText('all 3 lines of app.yaml');
    await dialog.getByTestId('file-ask-chosen').check();
    await expect(dialog.getByTestId('file-ask-sends')).toContainText('lines 2-3 of app.yaml');
    await dialog.getByTestId('file-ask-whole').check();
    await expect(dialog.getByTestId('file-ask-sends')).toContainText('all 3 lines of app.yaml');
    await dialog.getByTestId('file-ask-question').fill('Summary?');
    await dialog.getByTestId('file-ask-run').click();
    await expect(dialog.getByTestId('file-ask-answer')).toContainText('Line 1 reads: name: web', { timeout: 30_000 });
    // Both kept for this file, the question named.
    await expect(dialog.getByTestId('file-ask-history')).toContainText('Earlier questions about this file (2)');
    await dialog.getByTestId('file-ask-history').locator('summary').click();
    await dialog.getByTestId('file-ask-history').getByRole('button', { name: /What does this set\?/ }).click();
    await expect(dialog.getByTestId('file-ask-answer')).toContainText('Line 2 reads');
    await expect(dialog.getByTestId('file-ask-asked')).toContainText('What does this set?');
    // The one shown, chosen again: read again, still that one.
    await dialog.getByTestId('file-ask-history').locator('summary').click();
    await dialog.getByTestId('file-ask-history').locator('.list-item.cur').click();
    await expect(dialog.getByTestId('file-ask-answer')).toContainText('Line 2 reads');
    await expect(dialog.getByTestId('file-ask-history')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toBeHidden();
    // Nothing in the file changed.
    await expect(editor).toContainText('password: hunter2-in-file');
    await expect(page.getByTestId('dirty')).toHaveCount(0);
    // Without a model: said, nothing to send.
    await api(page, 'PUT', '/api/settings/ai', input({ ...before, provider: 'none' }));
    await page.getByTestId('editor-menu').click();
    await page.getByTestId('editor-ask-ai').click();
    await expect(dialog.getByTestId('file-ask-no-model')).toContainText('Settings -> AI');
    await expect(dialog.getByTestId('file-ask-run')).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    await page.unroute('**/api/ai/analyze/options');
    await api(page, 'PUT', '/api/settings/ai', input(before));
    await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
  }
});

test("copy and paste in a workspace's tree: copied from a file's menu, pasted from a folder's or a file's, cut moves it (report 67d3e6)", async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: "rm -rf ~/proj-paste && mkdir -p ~/proj-paste/a ~/proj-paste/b ~/proj-paste/c && printf 'PNG' > ~/proj-paste/a/pic.png && : > ~/proj-paste/c/keep.txt" });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-paste' });
  const names = async (dir: string) => (await api<{ entries: { name: string }[] }>(page, 'GET', `/api/files/${sshd}/list?path=${encodeURIComponent(`/home/tester/proj-paste/${dir}`)}`)).entries.map((e) => e.name).sort();
  await page.goto(`/#/ws/${ws.id}`);
  await page.locator('[data-testid=tree-node][data-path="a"]').click();
  // Copied from the file's menu: said where it can go.
  await page.locator('[data-testid=tree-node][data-path="a/pic.png"]').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'pic.png' }).getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByText("Paste in a folder's menu").first()).toBeVisible();
  // Pasted from the folder b's menu: there, and still in a.
  await page.locator('[data-testid=tree-node][data-path="b"]').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'b' }).getByTestId('sheet-paste').click();
  await expect.poll(() => names('b')).toEqual(['pic.png']);
  expect(await names('a')).toEqual(['pic.png']);
  // Cut, then pasted from the menu of a file in c: into c, gone from a.
  await page.locator('[data-testid=tree-node][data-path="a/pic.png"]').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'pic.png' }).getByRole('button', { name: 'Cut', exact: true }).click();
  await page.locator('[data-testid=tree-node][data-path="c"]').click();
  await page.locator('[data-testid=tree-node][data-path="c/keep.txt"]').click({ button: 'right' });
  const sheet = page.getByRole('dialog', { name: 'keep.txt' });
  await expect(sheet.getByTestId('sheet-paste')).toHaveText('Paste into c');
  await sheet.getByTestId('sheet-paste').click();
  await expect.poll(() => names('c')).toEqual(['keep.txt', 'pic.png']);
  expect(await names('a')).toEqual([]);
  // Moved: nothing left to paste.
  await page.locator('[data-testid=tree-node][data-path="c/keep.txt"]').click({ button: 'right' });
  await expect(page.getByRole('dialog', { name: 'keep.txt' }).getByTestId('sheet-paste')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('one click in the tree opens a preview, the next one takes its place; a double click, a change or a double click on its tab keeps it (report 96a655)', async ({ page }) => {
  await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: 'rm -rf ~/proj-preview && mkdir -p ~/proj-preview && for f in a b c d; do echo $f > ~/proj-preview/$f.txt; done' });
  const ws = await api<{ id: number }>(page, 'POST', '/api/workspaces', { hostId: sshd, root: '/home/tester/proj-preview' });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`/#/ws/${ws.id}`);
  const node = (f: string) => page.locator(`[data-testid=tree-node][data-path="${f}"]`);
  const tabs = page.getByTestId('ws-tab');
  // One click: a preview, in italics; the next one in its place.
  await node('a.txt').click();
  await expect(tabs).toHaveText(['a.txt']);
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'a.txt' })).toHaveClass(/preview/);
  expect(await tabs.first().evaluate((e) => getComputedStyle(e).fontStyle)).toBe('italic');
  await node('b.txt').click();
  await expect(tabs).toHaveText(['b.txt']);
  // A double click on its tab keeps it: the next opens beside it.
  await tabs.filter({ hasText: 'b.txt' }).dblclick();
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'b.txt' })).not.toHaveClass(/preview/);
  await node('c.txt').click();
  await expect(tabs).toHaveText(['b.txt', 'c.txt']);
  // A change keeps it too.
  await page.locator('.cm-content:visible').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('more');
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'c.txt' })).not.toHaveClass(/preview/);
  // A double click in the tree: kept at once.
  await node('d.txt').dblclick();
  await expect(tabs).toHaveText(['b.txt', 'c.txt', 'd.txt']);
  await expect(page.getByTestId('ws-tabbar-item').filter({ hasText: 'd.txt' })).not.toHaveClass(/preview/);
  await page.getByTestId('ws-tabbar-item').filter({ hasText: 'c.txt' }).getByTestId('ws-tab-close').click();
  await page.getByTestId('confirm-ok').click();
  await api(page, 'DELETE', `/api/workspaces/${ws.id}`);
});

test('signed out with text not saved in the editor: the page stays behind the sign-in, and is saved once signed in again (audit 2026-11-05)', async ({ page }) => {
  const a = await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  const path = '/home/tester/kept-unsaved.txt';
  await api(page, 'POST', '/api/snippets/run', { hostIds: [sshd], command: `printf 'first\\n' > ${path}` });
  await page.goto(`/#/edit/${sshd}?p=${encodeURIComponent(path)}`);
  await expect(page.locator('.cm-content')).toContainText('first');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('typed before the sign-in ran out');
  // The sign-in gone, as when it runs out or is ended from another device: the save is refused.
  await page.context().clearCookies();
  await page.getByTestId('save').click();
  const over = page.getByTestId('signin-over');
  await expect(over).toBeVisible();
  await expect(over.getByTestId('login-kept')).toContainText('still here');
  await lookAt(page, 'desktop-signin-kept');
  // Escape does not take the sign-in away.
  await page.keyboard.press('Escape');
  await expect(over).toBeVisible();
  await over.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(over).toHaveCount(0);
  await saveCredential(a);
  // The same editor, its text still there, and saved now.
  await expect(page.locator('.cm-content')).toContainText('typed before the sign-in ran out');
  await page.getByTestId('save').click();
  await expect.poll(async () => (await api<{ content: string }>(page, 'GET', `/api/files/${sshd}/text?path=${encodeURIComponent(path)}`)).content).toContain('typed before the sign-in ran out');
});
