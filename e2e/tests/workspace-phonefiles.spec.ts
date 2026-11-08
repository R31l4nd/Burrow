import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { sayYes } from './confirm.js';
import { hostNamed, signIn } from './passkey.js';

// The phone's own files on the Files page, as the Android app shows them
// (report a9552e): a stand-in for the app's bridge (BurrowAndroid) answers
// like the app does, with a granted folder of its own. Its files open in
// Burrow's own views; one is copied to the test host for real, and a host's
// file is handed to the app to copy to the phone. Nothing of the phone's
// files goes to Burrow before that copy. The look: phone and tablet, light
// and dark, English and Dutch. The app's own side (Android's folder picker,
// its permission, the folders read for real) is DeviceTest's.

const ID = '0123456789abcdef';
const SECRET = `phone-only-${Math.random().toString(36).slice(2, 10)}`;
const LOG_SECRET = `log-only-${Math.random().toString(36).slice(2, 10)}`;
const NOTE = `phone-note-${Math.random().toString(36).slice(2, 8)}.txt`;

/** A small picture (PNG, 48x32, a gradient) for the viewer. */
function png(): string {
  const w = 48;
  const h = 32;
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    out.writeUInt32BE(crc(t), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([40 + x * 4, 120, 60 + y * 5], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

/** The stand-in for the app: the folder "Documents" with a few files, and what the page asked of it. */
function bridge(arg: { id: string; secret: string; logSecret: string; note: string; png: string; change?: boolean; archives?: boolean }) {
  type Node = { type: 'dir' | 'file'; text?: string; b64?: string; mime: string; writable: boolean };
  const w = window as unknown as { BurrowAndroid: unknown; __phone: unknown };
  const top = `/${arg.id}`;
  const fs: Record<string, Node> = {
    [top]: { type: 'dir', mime: 'vnd.android.document/directory', writable: true },
    [`${top}/Notes`]: { type: 'dir', mime: 'vnd.android.document/directory', writable: true },
    [`${top}/Notes/A very long name for a note kept on this phone for later reading.md`]: { type: 'file', text: '# Later\n', mime: 'text/markdown', writable: true },
    [`${top}/${arg.note}`]: { type: 'file', text: `shopping list\n${arg.secret}\n`, mime: 'text/plain', writable: true },
    [`${top}/app.log`]: { type: 'file', text: `2026-10-12T14:49:37Z INFO started\n2026-10-12T14:49:38Z ERROR ${arg.logSecret} went wrong\n2026-10-12T14:49:39Z WARN slow\n`, mime: 'text/plain', writable: false },
    [`${top}/photo.png`]: { type: 'file', b64: arg.png, mime: 'image/png', writable: true },
    [`${top}/report.pdf`]: { type: 'file', b64: btoa('%PDF-1.4\n'), mime: 'application/pdf', writable: true },
    [`${top}/.hidden`]: { type: 'file', text: 'x', mime: 'text/plain', writable: true },
  };
  // An archive, an app and a file of a kind Burrow does not know (report 99d993), on apps that show archives.
  const inArchive: Record<string, { path: string; type: 'dir' | 'file'; size: number }[]> = {
    [`${top}/backup.zip`]: [
      { path: 'docs', type: 'dir', size: 0 },
      { path: 'docs/readme.md', type: 'file', size: 5 },
      { path: 'top.txt', type: 'file', size: 1 },
    ],
  };
  if (arg.archives) {
    fs[`${top}/backup.zip`] = { type: 'file', b64: btoa('PK\x03\x04'), mime: 'application/zip', writable: true };
    fs[`${top}/tool.apk`] = { type: 'file', b64: btoa('PK\x03\x04'), mime: 'application/vnd.android.package-archive', writable: true };
    fs[`${top}/tune.xyz`] = { type: 'file', b64: btoa('ID3'), mime: 'audio/x-tune', writable: true };
  }
  const bytes = (n: Node) => (n.b64 !== undefined ? atob(n.b64) : String.fromCharCode(...new TextEncoder().encode(n.text ?? '')));
  const hash = (s: string) => `h${s.length}-${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
  // What the phone keeps (its granted folders, its files' text) outlives a reload of the page, as on a phone.
  const kept = JSON.parse(sessionStorage.getItem('__phone') ?? 'null') as { roots: { id: string; name: string; writable: boolean; lost: boolean }[]; texts: Record<string, string> } | null;
  for (const [k, v] of Object.entries(kept?.texts ?? {})) if (fs[k]) fs[k].text = v;
  const keep = () => sessionStorage.setItem('__phone', JSON.stringify({ roots: state.roots, texts: Object.fromEntries(Object.entries(fs).filter(([, n]) => n.text !== undefined).map(([k, n]) => [k, n.text])) }));
  const state = {
    roots: kept?.roots ?? ([] as { id: string; name: string; writable: boolean; lost: boolean }[]),
    calls: [] as string[],
    opened: [] as string[],
    saved: [] as { url: string; name: string; dir: string }[],
    held: {} as Record<string, { name: string; data: string; purpose: string }>,
    released: [] as string[],
    cancelNext: false,
    // Delete, rename, a new folder (report 6eaf00): what the app asked the person about, and their answer there.
    asked: [] as string[][],
    denyNext: false,
    // Open with (Android's list of apps), share, a file of an archive shown (report 99d993).
    choosers: [] as string[],
    shared: [] as string[][],
    fromArchive: [] as string[],
    // The unpack ends when the test says so (its progress looked at first).
    unpackGo: false,
    fs,
  };
  w.__phone = state;
  let tokens = 0;
  const entry = (path: string) => {
    const n = fs[path]!;
    return { name: path.split('/').pop()!, path, type: n.type, size: n.type === 'dir' ? 0 : bytes(n).length, mtime: '2026-10-12T14:49:37.000Z', mime: n.mime, writable: n.writable, deletable: n.writable, renamable: n.writable };
  };
  const named = (name: unknown) => {
    const n = String(name).trim();
    if (!n || n === '.' || n === '..' || n.includes('/')) throw new Error('bad_name');
    return n;
  };
  const under = (path: string) => Object.keys(fs).filter((k) => k === path || k.startsWith(`${path}/`));
  const answer: Record<string, (p: Record<string, unknown>) => unknown> = {
    info: () => ({ version: arg.archives ? '2.19.0' : arg.change ? '2.18.0' : '2.0.0', versionCode: arg.archives ? 21900 : arg.change ? 21800 : 20000, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false, phoneFiles: true, phoneChange: arg.change === true, phoneArchives: arg.archives === true }),
    phoneRoots: () => state.roots,
    phoneAddRoot: (p) => {
      if (state.cancelNext) {
        state.cancelNext = false;
        return { cancelled: true };
      }
      const name = p.start === 'downloads' ? 'Burrow' : 'Documents';
      if (!state.roots.some((r) => r.id === arg.id)) state.roots.push({ id: arg.id, name, writable: true, lost: false });
      keep();
      return { id: arg.id, name, writable: true };
    },
    phoneRemoveRoot: (p) => {
      state.roots = state.roots.filter((r) => r.id !== p.id);
      keep();
      return null;
    },
    phoneList: (p) => {
      const path = String(p.path);
      if (!state.roots.some((r) => path === `/${r.id}` || path.startsWith(`/${r.id}/`))) throw new Error('no_folder');
      if (fs[path]?.type !== 'dir') throw new Error('not_found');
      const names = path.split('/').slice(2);
      return {
        path,
        parent: names.length ? path.slice(0, path.lastIndexOf('/')) : '/',
        root: { id: arg.id, name: state.roots.find((r) => r.id === arg.id)!.name },
        names,
        canCreate: true,
        truncated: false,
        entries: Object.keys(fs)
          .filter((k) => k.slice(0, k.lastIndexOf('/')) === path)
          .map(entry),
      };
    },
    phoneText: (p) => {
      const n = fs[String(p.path)];
      if (!n) throw new Error('not_found');
      if (n.b64 !== undefined) throw new Error('binary');
      return { path: p.path, content: n.text, hash: hash(n.text!), size: n.text!.length, mtime: '2026-10-12T14:49:37.000Z', writable: n.writable };
    },
    phoneSaveText: (p) => {
      const n = fs[String(p.path)]!;
      if (hash(n.text!) !== p.baseHash) return { conflict: true };
      n.text = String(p.content);
      keep();
      return { path: p.path, content: n.text, hash: hash(n.text), size: n.text.length, mtime: '2026-10-12T15:00:00.000Z', writable: true };
    },
    phoneHold: (p) =>
      (p.paths as string[]).map((path) => {
        const token = `t${++tokens}`;
        const n = fs[path]!;
        state.held[token] = { name: path.split('/').pop()!, data: bytes(n), purpose: String(p.purpose) };
        return { token, name: state.held[token]!.name, mime: n.mime, size: state.held[token]!.data.length };
      }),
    sharedFiles: () =>
      Object.entries(state.held)
        .filter(([, h]) => h.purpose === 'upload')
        .map(([token, h]) => ({ token, name: h.name, mime: 'text/plain', size: h.data.length })),
    read: (p) => ({ data: btoa(state.held[String(p.token)]!.data.slice(Number(p.offset), Number(p.offset) + Number(p.length))) }),
    release: (p) => {
      state.released.push(String(p.token));
      delete state.held[String(p.token)];
      return null;
    },
    // The app asks the person itself (its own dialog), then deletes; the page asks nothing.
    phoneDelete: (p) => {
      const paths = p.paths as string[];
      state.asked.push(paths);
      if (state.denyNext) {
        state.denyNext = false;
        return { cancelled: true };
      }
      if (paths.some((x) => !fs[x]?.writable)) throw new Error('read_only');
      for (const x of paths) for (const k of under(x)) delete fs[k];
      return { deleted: paths.length };
    },
    phoneRename: (p) => {
      const from = String(p.path);
      const to = `${from.slice(0, from.lastIndexOf('/'))}/${named(p.name)}`;
      if (!fs[from]?.writable) throw new Error('read_only');
      if (fs[to]) throw new Error('exists');
      for (const k of under(from)) {
        fs[to + k.slice(from.length)] = fs[k]!;
        delete fs[k];
      }
      return { path: to };
    },
    phoneMkdir: (p) => {
      const to = `${String(p.dir)}/${named(p.name)}`;
      if (fs[to]) throw new Error('exists');
      fs[to] = { type: 'dir', mime: 'vnd.android.document/directory', writable: true };
      return { path: to };
    },
    phoneOpen: (p) => {
      state.opened.push(String(p.path));
      if (p.chooser) state.choosers.push(String(p.path));
      // Another app took it: an effect of the press (fixtures.ts counts it).
      dispatchEvent(new Event('burrow-test-effect'));
      return null;
    },
    phoneSaveFrom: (p) => {
      state.saved.push(p as { url: string; name: string; dir: string });
      dispatchEvent(new Event('burrow-test-effect'));
      return { id: 7 };
    },
    phoneShare: (p) => {
      state.shared.push(p.paths as string[]);
      dispatchEvent(new Event('burrow-test-effect'));
      return null;
    },
    phoneArchive: (p) => {
      const all = inArchive[String(p.path)];
      if (!all) throw new Error('not_an_archive');
      const dir = String(p.inner);
      if (dir && !all.some((e) => e.type === 'dir' && e.path === dir)) throw new Error('not_found');
      const entries = all
        .filter((e) => (dir ? e.path.startsWith(`${dir}/`) && !e.path.slice(dir.length + 1).includes('/') : !e.path.includes('/')))
        .map((e) => ({ name: e.path.split('/').pop()!, path: e.path, type: e.type, size: e.size, mtime: '2026-10-12T14:49:37.000Z', mime: e.path.endsWith('.md') ? 'text/markdown' : 'text/plain' }));
      return { path: p.path, inner: dir, name: String(p.path).split('/').pop(), truncated: false, entries };
    },
    phoneArchiveOpen: (p) => {
      state.fromArchive.push(`${String(p.inner)}${p.chooser ? ' (with)' : ''}`);
      dispatchEvent(new Event('burrow-test-effect'));
      return null;
    },
    // Unpacked beside it, with its progress on the way (the app's "phoneProgress" events).
    phoneUnpack: (p) =>
      new Promise((done) => {
        const send = (data: unknown) => port.onmessage?.({ data: JSON.stringify({ event: 'phoneProgress', data }) });
        setTimeout(() => send({ id: p.id, done: 3, total: 6 }), 50);
        const end = () => {
          if (!state.unpackGo) return void setTimeout(end, 50);
          const at = `${top}/backup`;
          fs[at] = { type: 'dir', mime: 'vnd.android.document/directory', writable: true };
          fs[`${at}/top.txt`] = { type: 'file', text: 't', mime: 'text/plain', writable: true };
          done({ path: at, files: 2 });
        };
        end();
      }),
    downloads: () => [],
  };
  const port = {
    onmessage: null as ((e: { data: string }) => void) | null,
    postMessage(raw: string) {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
      state.calls.push(method);
      // An answer may take a while (an archive unpacked): the reply when it is there.
      void Promise.resolve()
        .then(() => answer[method]?.(params))
        .then(
          (result) => ({ id, result: result ?? null }),
          (err: unknown) => ({ id, error: (err as Error).message }),
        )
        .then((reply) => setTimeout(() => port.onmessage?.({ data: JSON.stringify(reply) }), 5));
    },
  };
  w.BurrowAndroid = port;
}

type Phone = { choosers: string[]; shared: string[][]; fromArchive: string[]; roots: { id: string }[]; calls: string[]; opened: string[]; saved: { url: string; name: string; dir: string }[]; released: string[]; cancelNext: boolean; asked: string[][]; denyNext: boolean; fs: Record<string, { text?: string }> };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __phone: Phone }).__phone);

async function look(page: Page, vp: { width: number; height: number }, lang: 'en' | 'nl', dark: boolean) {
  await page.setViewportSize(vp);
  await page.evaluate(
    ([l, d]) => {
      localStorage.setItem('burrow.locale', l as string);
      localStorage.setItem('burrow.appearance', JSON.stringify({ mode: d ? 'dark' : 'light', accent: 'green' }));
    },
    [lang, dark] as const,
  );
}

test("the phone's own files in the app: folders granted, files opened in Burrow's views, a copy to a host and back", async ({ page }) => {
  test.setTimeout(180_000);
  // Nothing of the phone's files may reach Burrow before one is copied to a host.
  const sent: string[] = [];
  page.on('request', (r) => sent.push(`${r.url()}\n${r.postData() ?? ''}`));
  const leaked = (marker: string) => sent.filter((x) => x.includes(marker));

  await sayYes(page);
  await signIn(page);
  await page.addInitScript(bridge, { id: ID, secret: SECRET, logSecret: LOG_SECRET, note: NOTE, png: png() });
  await look(page, { width: 390, height: 844 }, 'en', false);
  await page.goto('/#/files');
  await page.reload();

  // Files: the phone beside the hosts.
  await expect(page.getByTestId('phone-files')).toContainText('This phone');
  await lookAt(page, 'phone-files-with-the-phone');
  await page.getByTestId('phone-files').click();
  await expect(page.getByTestId('phone-none')).toBeVisible();
  await lookAt(page, 'phone-phonefiles-none');

  // A folder added through Android's picker; a picker left without a choice adds nothing.
  await page.evaluate(() => ((window as unknown as { __phone: Phone }).__phone.cancelNext = true));
  await page.getByTestId('phone-add-other').click();
  await expect.poll(async () => (await state(page)).cancelNext).toBe(false);
  await expect(page.getByTestId('phone-none')).toBeVisible();
  await page.getByTestId('phone-add-downloads').click();
  await expect(page.getByTestId('phone-root')).toHaveText(/Burrow/);
  await page.getByTestId('phone-add-documents').click();
  await expect(page.getByTestId('phone-root')).toHaveCount(1);
  await lookAt(page, 'phone-phonefiles-folders');

  // Its files: folders first, the hidden one only when asked.
  await page.getByTestId('phone-root-open').click();
  const rows = page.getByTestId('phone-row');
  await expect(rows.first()).toContainText('Notes');
  await expect(page.getByTestId('phone-list')).toContainText(NOTE);
  await expect(page.getByTestId('phone-list')).not.toContainText('.hidden');
  await lookAt(page, 'phone-phonefiles-list');
  await page.getByTestId('phone-folder-menu').click();
  await lookAt(page, 'phone-phonefiles-folder-menu');
  await page.getByTestId('phone-hidden').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('phone-list')).toContainText('.hidden');
  // The path's first step goes back to the folders granted, and in again.
  await page.getByRole('navigation').getByRole('button', { name: 'This phone' }).click();
  await expect(page.getByTestId('phone-root')).toHaveCount(1);
  await expect(page.getByTestId('phone-list')).toHaveCount(0);
  await page.getByTestId('phone-root-open').click();
  await expect(page.getByTestId('phone-list')).toContainText(NOTE);

  // A folder in it, and back by the path.
  await rows.filter({ hasText: 'Notes' }).getByTestId('phone-open').click();
  await expect(page.getByTestId('phone-list')).toContainText('A very long name');
  await page.getByRole('navigation', { name: 'Path' }).getByRole('button', { name: 'Burrow' }).click();
  await expect(page.getByTestId('phone-list')).toContainText(NOTE);

  // A text file: the editor, saved back to the phone.
  const row = (name: string) => rows.filter({ hasText: name });
  await row(NOTE).getByTestId('phone-menu').click();
  await lookAt(page, 'phone-phonefiles-file-menu');
  // An app before 2.18.0 cannot delete or rename: not offered (report 6eaf00).
  await expect(page.getByTestId('phone-rename')).toHaveCount(0);
  await expect(page.getByTestId('phone-delete')).toHaveCount(0);
  await page.getByTestId('phone-edit').click();
  await expect(page.getByTestId('editor')).toContainText(SECRET);
  await expect(page.getByTestId('editor-title')).toHaveText(NOTE);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('bread\n');
  await page.getByTestId('save').click();
  await expect.poll(async () => (await state(page)).fs[`/${ID}/${NOTE}`]!.text).toContain('bread');
  await expect(page.getByTestId('dirty')).toHaveCount(0);
  await lookAt(page, 'phone-phonefiles-editor');
  await page.getByRole('button', { name: 'Back' }).click();

  // Read only when opened to read: no saving.
  await row(NOTE).getByTestId('phone-menu').click();
  await page.getByTestId('phone-read-only').click();
  await expect(page.getByTestId('readonly-bar')).toContainText('opened to read');
  await page.getByRole('button', { name: 'Back' }).click();

  // A log file of the phone: Burrow's log view, its lines read here.
  await row('app.log').getByTestId('phone-menu').click();
  await page.getByTestId('phone-as-log').click();
  await expect(page.getByTestId('log-line')).toHaveCount(3);
  await expect(page.getByTestId('log-line').nth(1)).toContainText(LOG_SECRET);
  await lookAt(page, 'phone-phonefiles-log');
  // Its search as a regular expression, and the lines saved through the app.
  const rx = page.getByRole('button', { name: 'Regular expression' });
  await rx.click();
  await expect(rx).toHaveAttribute('aria-pressed', 'true');
  await rx.click();
  await expect(rx).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByText('Saved in Downloads/Burrow.')).toBeVisible();
  expect((await state(page)).calls).toContain('saveText');
  await page.getByRole('button', { name: 'Back' }).click();

  // A picture: the viewer, from the app's bytes (let go after).
  await row('photo.png').getByTestId('phone-open').click();
  await expect(page.getByTestId('viewer-image')).toBeVisible();
  expect(await page.getByTestId('viewer-image').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(48);
  await lookAt(page, 'phone-phonefiles-picture');
  await page.locator('dialog.viewer').getByRole('button', { name: 'Close' }).click();
  await expect.poll(async () => (await state(page)).released.length).toBeGreaterThan(0);
  await row('photo.png').getByTestId('phone-menu').click();
  await page.getByTestId('phone-view').click();
  await expect(page.getByTestId('viewer-image')).toBeVisible();
  await page.keyboard.press('Escape');

  // A PDF: the phone's own app shows it.
  await row('report.pdf').getByTestId('phone-open').click();
  await expect.poll(async () => (await state(page)).opened).toEqual([`/${ID}/report.pdf`]);
  await row('report.pdf').getByTestId('phone-menu').click();
  await page.getByTestId('phone-open-app').click();
  await expect.poll(async () => (await state(page)).opened.length).toBe(2);

  expect(leaked(SECRET), "the phone's file went to Burrow before it was copied").toEqual([]);
  expect(leaked(LOG_SECRET), "the phone's log went to Burrow").toEqual([]);

  // Several chosen, then none; one copied to the test host for real (into /tmp).
  await row('photo.png').getByTestId('phone-menu').click();
  await page.getByTestId('phone-select').click();
  await expect(page.getByTestId('phone-selection')).toContainText('1 selected');
  // In the title bar, as for a host's files (report 1d6881): nothing over the list at the bottom.
  await expect(page.getByTestId('phone-selection')).toHaveClass(/topbar/);
  await expect(page.locator('.actionbar')).toHaveCount(0);
  await page.getByTestId('phone-select-all').click();
  await expect(page.getByTestId('phone-selection')).toContainText('5 selected');
  await lookAt(page, 'phone-phonefiles-selected');
  // All chosen: the same place chooses none (report d6a5e3).
  await expect(page.getByTestId('phone-select-all')).toHaveCount(0);
  await page.getByTestId('phone-select-all-none').click();
  await expect(page.getByTestId('phone-selection')).toHaveCount(0);
  // Held down: chosen, not its menu as well (report fa1a85: Android's context menu after the hold).
  const held = row('photo.png').getByTestId('phone-open');
  await held.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(600);
  await held.dispatchEvent('contextmenu');
  await held.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  await expect(page.getByTestId('phone-selection')).toContainText('1 selected');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.getByTestId('phone-select-none').click();
  await expect(page.getByTestId('phone-selection')).toHaveCount(0);
  await row(NOTE).getByTestId('phone-menu').click();
  await page.getByTestId('phone-select').click();
  await page.getByTestId('phone-copy-selection').click();
  await expect(page).toHaveURL(/#\/share/);
  await page.getByRole('combobox', { name: 'Host' }).selectOption({ label: 'test-sshd' });
  const folders = page.locator('.folders');
  await folders.getByRole('button', { name: '..' }).click();
  await folders.getByRole('button', { name: '..' }).click();
  await folders.getByRole('button', { name: 'tmp', exact: true }).click();
  await page.getByRole('button', { name: /Upload 1 to \/tmp/ }).click();
  const sshd = await hostNamed(page, 'test-sshd');
  await expect
    .poll(() => page.evaluate(async (u) => (await fetch(u)).ok && (await (await fetch(u)).json()).content, `/api/files/${sshd}/text?path=${encodeURIComponent(`/tmp/${NOTE}`)}`), { timeout: 30_000 })
    .toBe(`shopping list\n${SECRET}\nbread\n`);
  expect(leaked(LOG_SECRET), "only the file copied went to Burrow").toEqual([]);

  // A host's file to the phone: a folder of the phone chosen, the app downloads it there.
  await page.goto(`/#/files/${sshd}?p=%2Ftmp`);
  await page.getByRole('button', { name: `Menu for ${NOTE}` }).click();
  await page.getByTestId('copy-to-phone').click();
  const pick = page.getByRole('dialog', { name: 'Copy to this phone' });
  await expect(pick).toContainText(NOTE);
  await expect(pick.getByTestId('phone-pick-roots')).toContainText('Burrow');
  await lookAt(page, 'phone-phonefiles-pick-folder');
  await pick.getByTestId('phone-pick-root').click();
  await pick.getByTestId('phone-pick-dir').filter({ hasText: 'Notes' }).click();
  await expect(pick.getByTestId('phone-pick-where')).toHaveText('Burrow / Notes');
  await pick.getByTestId('phone-pick-up').click();
  await expect(pick.getByTestId('phone-pick-where')).toHaveText('Burrow');
  await pick.getByTestId('phone-pick-here').click();
  await expect(pick).toBeHidden();
  const saved = (await state(page)).saved;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ name: NOTE, dir: `/${ID}` });
  // Burrow's own address for the file, the way a download link has it.
  expect(saved[0]!.url).toBe(new URL(`/api/files/${sshd}/raw?path=${encodeURIComponent(`/tmp/${NOTE}`)}&download=1`, page.url()).toString());
  // A folder added from the picker itself (here the same one again: the app keeps it once, as it was).
  await page.getByRole('button', { name: `Menu for ${NOTE}` }).click();
  await page.getByTestId('copy-to-phone').click();
  await pick.getByTestId('phone-pick-add').click();
  await expect(pick.getByTestId('phone-pick-where')).toHaveText('Burrow');
  expect((await state(page)).roots).toHaveLength(1);
  await pick.getByRole('button', { name: 'Close' }).click();

  // One file from its own menu: on the share page, held for the upload.
  await page.goto(`/#/files/phone?p=%2F${ID}`);
  await row('report.pdf').getByTestId('phone-menu').click();
  await page.getByTestId('phone-copy').click();
  await expect(page).toHaveURL(/#\/share/);
  await expect(page.locator('.list-item').filter({ hasText: 'report.pdf' })).toBeVisible();

  // Dutch on a tablet, dark on a phone, both on a dark tablet.
  for (const [vp, size, lang, dark] of [
    ['tablet-nl', { width: 820, height: 1180 }, 'nl', false],
    ['phone-dark-nl', { width: 390, height: 844 }, 'nl', true],
    ['tablet-dark', { width: 820, height: 1180 }, 'en', true],
  ] as const) {
    await look(page, size, lang, dark);
    await page.goto('/#/files');
    await page.reload();
    await expect(page.getByTestId('phone-files')).toBeVisible();
    await lookAt(page, `${vp}-files-with-the-phone`);
    await page.getByTestId('phone-files').click();
    await expect(page.getByTestId('phone-root')).toHaveCount(1);
    await lookAt(page, `${vp}-phonefiles-folders`);
    await page.getByTestId('phone-root-open').click();
    await expect(page.getByTestId('phone-list')).toContainText(NOTE);
    await lookAt(page, `${vp}-phonefiles-list`);
    await rows.filter({ hasText: NOTE }).getByTestId('phone-menu').click();
    await lookAt(page, `${vp}-phonefiles-file-menu`);
    await page.getByTestId('phone-edit').click();
    await expect(page.getByTestId('editor')).toContainText('bread');
    await lookAt(page, `${vp}-phonefiles-editor`);
  }

  // Taken off Burrow's list: from the folder's menu, and from the list.
  await look(page, { width: 390, height: 844 }, 'en', false);
  await page.goto(`/#/files/phone?p=%2F${ID}`);
  await page.reload();
  await page.getByTestId('phone-folder-menu').click();
  await page.getByTestId('phone-remove-here').click();
  await expect(page.getByTestId('phone-none')).toBeVisible();
  expect((await state(page)).roots).toEqual([]);
  await page.getByTestId('phone-add-documents').click();
  await page.getByTestId('phone-root-remove').click();
  await expect(page.getByTestId('phone-none')).toBeVisible();
  // A folder no longer there: said, with the way back.
  await page.goto(`/#/files/phone?p=%2F${ID}`);
  await expect(page.getByTestId('phone-error')).toContainText("no longer on Burrow's list");
  await page.getByRole('button', { name: "To the phone's folders" }).click();
  await expect(page.getByTestId('phone-none')).toBeVisible();
});

test("in a browser (no app): no phone beside the hosts, and the phone's pages say where they work", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/files');
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByTestId('phone-files')).toHaveCount(0);
  await page.goto(`/#/files/phone?p=%2F${ID}`);
  await expect(page.getByText("The phone's own files are shown in Burrow's Android app.")).toBeVisible();
  await page.goto(`/#/edit/phone?p=%2F${ID}%2Fa.txt`);
  await expect(page.getByText("The phone's own files are shown in Burrow's Android app.")).toBeVisible();
});

test('"All files" in the app (report 862305): off until switched on after a warning and the permission of Android, its storage then listed; off again at once, here and in Settings', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    const w = window as unknown as { BurrowAndroid: unknown; __all: { on: boolean; granted: boolean; refuse: boolean; calls: string[] } };
    const kept = JSON.parse(sessionStorage.getItem('__all') ?? 'null') as { on: boolean; granted: boolean } | null;
    const st = { on: kept?.on ?? false, granted: kept?.granted ?? false, refuse: false, calls: [] as string[] };
    w.__all = st;
    const keep = () => sessionStorage.setItem('__all', JSON.stringify({ on: st.on, granted: st.granted }));
    const status = () => ({ available: true, granted: st.granted, on: st.on });
    const vol = { id: 'aaaabbbbccccdddd', name: 'Internal storage', writable: true, lost: false, all: true };
    const answer: Record<string, (p: Record<string, unknown>) => unknown> = {
      info: () => ({ version: '2.7.0', versionCode: 20700, deviceId: null, deviceName: 'Pixel', profiles: true, screenshots: false, screenshotsFixed: false, shake: false, phoneFiles: true, phoneAllFiles: true }),
      phoneRoots: () => (st.on && st.granted ? [vol] : []),
      phoneAllFiles: status,
      phoneSetAllFiles: (p) => {
        // Android's screen: allowed there, or not.
        if (p.on) {
          if (!st.refuse) st.granted = true;
          st.on = st.granted;
        } else st.on = false;
        keep();
        return status();
      },
      phoneAllFilesSettings: () => {
        st.calls.push('settings');
        dispatchEvent(new Event('burrow-test-effect'));
        return null;
      },
      phoneList: (p) => {
        if (!(st.on && st.granted) || p.path !== `/${vol.id}`) throw new Error('no_folder');
        return { path: p.path, parent: '/', root: { id: vol.id, name: vol.name }, names: [], canCreate: true, truncated: false, entries: [{ name: 'Music', path: `/${vol.id}/Music`, type: 'dir', size: 0, mtime: '2026-10-27T20:00:00.000Z', mime: 'vnd.android.document/directory', writable: true }] };
      },
      downloads: () => [],
    };
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        let reply: { id: number; result?: unknown; error?: string };
        try {
          reply = { id, result: answer[method]?.(params) ?? null };
        } catch (err) {
          reply = { id, error: (err as Error).message };
        }
        setTimeout(() => port.onmessage?.({ data: JSON.stringify(reply) }), 5);
      },
    };
    w.BurrowAndroid = port;
  });
  const all = () => page.evaluate(() => (window as unknown as { __all: { on: boolean; granted: boolean; calls: string[] } }).__all);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/files/phone?p=${encodeURIComponent('/')}`);
  await page.reload();
  // Off: only the folders picked; "All files" offered.
  await expect(page.getByTestId('phone-none')).toBeVisible();
  const asked = await sayYes(page);
  await page.getByTestId('phone-all-on').click();
  await expect(page.getByTestId('phone-root')).toHaveCount(1);
  // Said what it gives before anything: the whole phone, and who could reach it.
  expect((await asked()).join('\n')).toContain('whoever controls that server could reach them too');
  await expect(page.getByTestId('phone-root')).toContainText('Internal storage');
  await expect(page.getByTestId('phone-root')).toContainText('All files of this phone');
  await expect(page.getByTestId('phone-all-on')).toHaveCount(0);
  await expect(page.getByText('all of them ("All files" is on)')).toBeVisible();
  await lookAt(page, 'phone-files-all-on');
  await page.getByTestId('phone-root-open').click();
  await expect(page.getByTestId('phone-row')).toContainText('Music');
  await page.goto(`/#/files/phone?p=${encodeURIComponent('/')}`);
  // Off again: no question, gone at once, and where Android's permission goes.
  await page.getByTestId('phone-all-off').click();
  await expect(page.getByTestId('phone-root')).toHaveCount(0);
  await expect(page.getByText('"All files" is off. Android\'s permission can be taken back in Settings -> Android app.')).toBeVisible();
  expect(await all()).toMatchObject({ on: false, granted: true });
  // Settings -> Android app: the same switch, and Android's permission still there to take back.
  await page.goto('/#/settings/android');
  const box = page.getByTestId('all-files');
  await expect(box).not.toBeChecked();
  await page.getByTestId('all-files-settings').click();
  expect((await all()).calls).toEqual(['settings']);
  await box.check();
  // After the warning (said yes to) and the switch: on in the app.
  await expect.poll(async () => (await all()).on).toBe(true);
  await expect(box).toBeChecked();
  await expect(page.getByTestId('all-files-settings')).toHaveCount(0);
  await box.uncheck();
  await expect.poll(async () => (await all()).on).toBe(false);
  await expect(box).not.toBeChecked();
  // Android says no: nothing changes, and that is said.
  await page.evaluate(() => {
    const st = (window as unknown as { __all: { granted: boolean; refuse: boolean } }).__all;
    st.granted = false;
    st.refuse = true;
  });
  await box.check();
  await expect(page.getByText('Android did not allow "All files access": nothing changed.')).toBeVisible();
  await expect(box).not.toBeChecked();
  await page.evaluate(() => sessionStorage.removeItem('__all'));
});

test("a folder of the phone as a favourite: starred there, listed on Files and This phone, kept on the phone only (report 9980fa)", async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => sent.push(`${r.method()} ${r.url()}\n${r.postData() ?? ''}`));
  await signIn(page);
  await page.addInitScript(bridge, { id: ID, secret: SECRET, logSecret: LOG_SECRET, note: NOTE, png: png() });
  await look(page, { width: 390, height: 844 }, 'en', false);
  await page.goto(`/#/files/phone?p=${encodeURIComponent('/')}`);
  await page.reload();
  await page.evaluate(() => localStorage.removeItem('burrow.phoneFavorites'));
  await page.getByTestId('phone-add-documents').click();
  await page.getByTestId('phone-root-open').click();
  await page.getByTestId('phone-row').filter({ hasText: 'Notes' }).getByTestId('phone-open').click();
  await expect(page.getByTestId('phone-row')).toHaveCount(1);
  // Starred: said, and yellow.
  const star = page.getByTestId('phone-bookmark');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Added to the favourites, on this phone only.')).toBeVisible();
  // On Files, and on This phone: one tap back into it.
  await page.goto('/#/files');
  await page.getByTestId('phone-favorite').filter({ hasText: 'Notes' }).click();
  await expect(page.getByTestId('phone-row')).toContainText('A very long name');
  await page.goto(`/#/files/phone?p=${encodeURIComponent('/')}`);
  await expect(page.getByTestId('phone-favorite')).toContainText('Notes');
  await lookAt(page, 'phone-phonefiles-favorites');
  // Kept after a reload; never sent to Burrow (its bookmarks are a host's).
  await page.reload();
  await expect(page.getByTestId('phone-favorite')).toContainText('Notes');
  expect(sent.filter((x) => x.includes('bookmarks') && !x.startsWith('GET'))).toEqual([]);
  expect(sent.filter((x) => x.includes(`/${ID}/Notes`))).toEqual([]);
  // Starred again: taken off, gone from both lists.
  await page.getByTestId('phone-favorite').click();
  await page.getByTestId('phone-bookmark').click();
  await expect(page.getByTestId('phone-bookmark')).toHaveAttribute('aria-pressed', 'false');
  await page.goto('/#/files');
  await expect(page.getByTestId('phone-favorite')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem('__phone'));
});

test("the phone's files changed in the app: a new folder, a file renamed, files deleted only after the app's own question (report 6eaf00)", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(bridge, { id: ID, secret: SECRET, logSecret: LOG_SECRET, note: NOTE, png: png(), change: true });
  await look(page, { width: 343, height: 711 }, 'en', false);
  await page.goto(`/#/files/phone?p=${encodeURIComponent('/')}`);
  await page.reload();
  await page.getByTestId('phone-add-documents').click();
  await page.getByTestId('phone-root-open').click();
  const rows = page.getByTestId('phone-row');
  const row = (name: string) => rows.filter({ hasText: name });
  await expect(page.getByTestId('phone-list')).toContainText(NOTE);
  const save = () => page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();

  // A new folder, from the folder's menu; a name taken is said in the dialog, which stays open.
  await page.getByTestId('phone-folder-menu').click();
  await page.getByTestId('phone-new-folder').click();
  await page.getByTestId('phone-name').fill('Notes');
  await save();
  await expect(page.getByTestId('phone-name-error')).toHaveText('There is already something with that name here.');
  await page.getByTestId('phone-name').fill('a/b');
  await save();
  await expect(page.getByTestId('phone-name-error')).toContainText('That name cannot be used');
  await lookAt(page, 'phone-phonefiles-new-folder');
  await page.getByTestId('phone-name').fill('Receipts');
  await save();
  await expect(page.getByText('Folder Receipts made.')).toBeVisible();
  await expect(row('Receipts')).toHaveCount(1);
  expect((await state(page)).fs[`/${ID}/Receipts`]).toBeTruthy();

  // Renamed, from the file's menu: its name to start from; Cancel changes nothing.
  // The toast of the folder just made leaves the field free (it lay over it, 2.18.0).
  await row(NOTE).getByTestId('phone-menu').click();
  await page.getByTestId('phone-rename').click();
  await expect(page.getByTestId('phone-name')).toHaveValue(NOTE);
  await expect(page.getByTestId('toasts')).toContainText('Folder Receipts made.');
  await lookAt(page, 'phone-phonefiles-rename');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('phone-name')).toBeHidden();
  await expect(row(NOTE)).toHaveCount(1);
  await row(NOTE).getByTestId('phone-menu').click();
  await lookAt(page, 'phone-phonefiles-file-menu-change');
  await page.getByTestId('phone-rename').click();
  await page.getByTestId('phone-name').fill('shopping.txt');
  await save();
  await expect(page.getByText('Renamed to shopping.txt.')).toBeVisible();
  await expect(row('shopping.txt')).toHaveCount(1);
  await expect(page.getByTestId('phone-list')).not.toContainText(NOTE);
  expect((await state(page)).fs[`/${ID}/shopping.txt`]?.text).toContain(SECRET);

  // A file the phone does not let Burrow change: neither in its menu.
  await row('app.log').getByTestId('phone-menu').click();
  await expect(page.getByTestId('phone-as-log')).toBeVisible();
  await expect(page.getByTestId('phone-rename')).toHaveCount(0);
  await expect(page.getByTestId('phone-delete')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // Deleted: the page asks nothing itself, the app does. No there: nothing goes.
  await page.evaluate(() => ((window as unknown as { __phone: Phone }).__phone.denyNext = true));
  await row('shopping.txt').getByTestId('phone-menu').click();
  await page.getByTestId('phone-delete').click();
  await expect.poll(async () => (await state(page)).asked).toEqual([[`/${ID}/shopping.txt`]]);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(row('shopping.txt')).toHaveCount(1);

  // Chosen, two at once: Delete in the title bar; yes in the app's question, both gone.
  await row('shopping.txt').getByTestId('phone-menu').click();
  await page.getByTestId('phone-select').click();
  await row('photo.png').getByTestId('phone-open').click();
  await expect(page.getByTestId('phone-selection')).toContainText('2 selected');
  await lookAt(page, 'phone-phonefiles-selection-delete');
  await page.getByTestId('phone-delete-selection').click();
  await expect(page.getByText('Deleted from this phone.')).toBeVisible();
  await expect(row('shopping.txt')).toHaveCount(0);
  await expect(row('photo.png')).toHaveCount(0);
  await expect(page.getByTestId('phone-selection')).toHaveCount(0);
  expect((await state(page)).asked[1]).toEqual([`/${ID}/shopping.txt`, `/${ID}/photo.png`]);

  // A folder, with what is in it, from its menu.
  await row('Notes').getByTestId('phone-menu').click();
  await page.getByTestId('phone-delete').click();
  await expect(row('Notes')).toHaveCount(0);
  expect(Object.keys((await state(page)).fs).filter((k) => k.startsWith(`/${ID}/Notes`))).toEqual([]);

  // Into the folder made, and back up through the path.
  await row('Receipts').getByTestId('phone-open').click();
  await expect(rows).toHaveCount(0);
  await page.locator('nav.crumbs').getByRole('button', { name: 'Documents' }).click();
  await expect(row('app.log')).toHaveCount(1);
  await expect(row('Receipts')).toHaveCount(1);

  // Chosen with a file that may not go: no Delete in the title bar.
  await row('app.log').getByTestId('phone-menu').click();
  await page.getByTestId('phone-select').click();
  await expect(page.getByTestId('phone-selection')).toContainText('1 selected');
  await expect(page.getByTestId('phone-delete-selection')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem('__phone'));
});

test("the phone's files as in Material Files: an app installs, an archive is a folder and unpacks beside itself, open with, share, properties (report 99d993)", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(bridge, { id: ID, secret: SECRET, logSecret: LOG_SECRET, note: NOTE, png: png(), change: true, archives: true });
  await look(page, { width: 343, height: 711 }, 'en', false);
  await page.goto(`/#/files/phone?p=${encodeURIComponent('/')}`);
  await page.reload();
  await page.getByTestId('phone-add-documents').click();
  await page.getByTestId('phone-root-open').click();
  const rows = page.getByTestId('phone-row');
  const row = (name: string) => rows.filter({ hasText: name });
  await expect(row('backup.zip')).toHaveCount(1);

  // An app: Android's installer (it went to the editor, which refused it as not text).
  await row('tool.apk').getByTestId('phone-open').click();
  await expect.poll(async () => (await state(page)).opened).toContain(`/${ID}/tool.apk`);
  // A kind Burrow does not know and the phone says is not text: another app, not the editor.
  await row('tune.xyz').getByTestId('phone-open').click();
  await expect.poll(async () => (await state(page)).opened).toContain(`/${ID}/tune.xyz`);
  await expect(page).not.toHaveURL(/#\/edit\//);
  expect((await state(page)).calls).not.toContain('phoneText');

  // An archive opens as a folder; a file in it is shown by another app, or one picked from the list.
  await row('backup.zip').getByTestId('phone-open').click();
  await expect(page).toHaveURL(/[?&]in=/);
  const inside = page.getByTestId('phone-archive-row');
  await expect(inside).toHaveText([/docs/, /top\.txt/]);
  await lookAt(page, 'phone-phonefiles-archive');
  await inside.filter({ hasText: 'docs' }).getByTestId('phone-archive-open').click();
  await expect(page.getByTestId('phone-archive-list')).toContainText('readme.md');
  await inside.filter({ hasText: 'readme.md' }).getByTestId('phone-archive-open').click();
  await expect.poll(async () => (await state(page)).fromArchive).toEqual(['docs/readme.md']);
  await inside.filter({ hasText: 'readme.md' }).getByTestId('phone-archive-menu').click();
  await lookAt(page, 'phone-phonefiles-archive-entry');
  await page.getByTestId('phone-archive-with').click();
  await expect.poll(async () => (await state(page)).fromArchive).toEqual(['docs/readme.md', 'docs/readme.md (with)']);
  await inside.filter({ hasText: 'readme.md' }).getByTestId('phone-archive-menu').click();
  await page.getByTestId('phone-archive-view').click();
  await expect.poll(async () => (await state(page)).fromArchive).toHaveLength(3);
  // The path's first part, the archive's name: back to its top.
  await page.locator('nav.crumbs').getByRole('button', { name: 'backup.zip', exact: true }).click();
  await expect(inside).toHaveText([/docs/, /top\.txt/]);
  await inside.filter({ hasText: 'docs' }).getByTestId('phone-archive-open').click();
  await expect(page.getByTestId('phone-archive-list')).toContainText('readme.md');
  // Back up inside it, then unpacked from here: how far it is, then the folder it went to.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(inside).toHaveText([/docs/, /top\.txt/]);
  await page.getByTestId('phone-unpack-here').click();
  await expect(page.getByTestId('phone-unpack-progress')).toContainText('50%');
  await lookAt(page, 'phone-phonefiles-unpacking');
  await page.evaluate(() => ((window as unknown as { __phone: { unpackGo: boolean } }).__phone.unpackGo = true));
  await expect(page.getByText('Unpacked into backup: 2 files.')).toBeVisible();
  await expect(page.getByTestId('phone-unpack-progress')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]in=/);
  await expect(row('backup')).toHaveCount(2);

  // The archive's own menu: what is in it, unpack, open with, share, properties.
  await row('backup.zip').getByTestId('phone-menu').click();
  await expect(page.getByTestId('phone-unpack')).toBeVisible();
  await lookAt(page, 'phone-phonefiles-archive-menu');
  await page.getByTestId('phone-share').click();
  await expect.poll(async () => (await state(page)).shared).toEqual([[`/${ID}/backup.zip`]]);
  // Unpack from its menu: the same unpack, from the folder's list.
  await row('backup.zip').getByTestId('phone-menu').click();
  await page.getByTestId('phone-unpack').click();
  await expect.poll(async () => (await state(page)).calls.filter((c) => c === 'phoneUnpack')).toHaveLength(2);
  await expect(page.getByTestId('phone-unpack-progress')).toHaveCount(0);
  await row('backup.zip').getByTestId('phone-menu').click();
  await page.getByTestId('phone-browse').click();
  await expect(inside).toHaveCount(2);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await row('report.pdf').getByTestId('phone-menu').click();
  await page.getByTestId('phone-open-app').click();
  await expect.poll(async () => (await state(page)).choosers).toEqual([`/${ID}/report.pdf`]);
  await row('photo.png').getByTestId('phone-menu').click();
  await page.getByTestId('phone-properties').click();
  const props = page.getByTestId('phone-props');
  await expect(props).toContainText('image/png');
  await expect(props).toContainText('bytes');
  await expect(props).toContainText('This phone / Documents / photo.png');
  await expect(props).toContainText('Read and change it');
  await lookAt(page, 'phone-phonefiles-properties');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  await expect(props).toHaveCount(0);
  // Two chosen, shared at once.
  await row('photo.png').getByTestId('phone-menu').click();
  await page.getByTestId('phone-select').click();
  await row(NOTE).getByTestId('phone-open').click();
  await page.getByTestId('phone-share-selection').click();
  await expect.poll(async () => (await state(page)).shared.at(-1)?.sort()).toEqual([`/${ID}/${NOTE}`, `/${ID}/photo.png`].sort());
  await page.evaluate(() => sessionStorage.removeItem('__phone'));
});
