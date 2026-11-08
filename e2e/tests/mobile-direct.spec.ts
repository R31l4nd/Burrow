import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DirectCache } from '@burrow/shared';
import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';
import { en, type MessageKey } from '../../web/src/lib/i18n/en.js';
import { nl } from '../../web/src/lib/i18n/nl.js';

// The Android app's direct route (web/src/direct): its host list, terminal
// and dialogs under the layout checks, in the passes the tour runs (a phone
// in English, Dutch at 343 px, dark; a tablet in Dutch, dark Dutch on its
// side). It runs only in the app, so nothing in checks.ts ever looked at it
// (UIA-17, UIA-23, UIB-02: its four dialogs in no web screenshot). The page
// is the one the app bundles (web/dist-direct, built by scripts/e2e.sh),
// served at the app's own origin; a stand-in for the app's bridge
// (BurrowDirect) answers as DirectActivity does.

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist-direct');
const ORIGIN = 'https://appassets.androidplatform.net';

// Looks: no coverage of its own (the bundle has no source maps); see `cover` in fixtures.ts.
test.use({ cover: false });

const PASSES = [
  { name: 'phone', size: { width: 390, height: 844 }, lang: 'en', mode: 'light' },
  { name: 'phone-nl', size: { width: 343, height: 711 }, lang: 'nl', mode: 'light' },
  { name: 'phone-dark', size: { width: 390, height: 844 }, lang: 'en', mode: 'dark' },
  { name: 'tablet-nl', size: { width: 820, height: 1180 }, lang: 'nl', mode: 'light' },
  { name: 'tablet-dark-nl', size: { width: 1280, height: 800 }, lang: 'nl', mode: 'dark' },
] as const;

const now = new Date().toISOString();
const host = (id: number, name: string, extra: Partial<DirectCache['hosts'][number]> = {}): DirectCache['hosts'][number] => ({
  id,
  name,
  address: `${name}.home.example.com`,
  port: 22,
  username: 'tester',
  groupId: null,
  favorite: false,
  color: null,
  encoding: null,
  hostKeys: [],
  history: [{ command: 'docker compose ps', count: 4, lastAt: now }],
  ...extra,
});
const CACHE: DirectCache = {
  generatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  deviceId: 1,
  hosts: [host(1, 'nas', { favorite: true, port: 2222 }), host(2, 'new-box'), host(3, 'moved-box'), host(4, 'media-server-in-the-attic-with-a-long-name')],
  snippets: [
    { id: 1, name: 'Disk usage', command: 'df -h /', description: null, hostId: null, groupId: null },
    { id: 2, name: 'Restart the media stack', command: 'docker compose -f /opt/media/compose.yaml restart', description: null, hostId: 1, groupId: null },
  ],
  groups: [],
};

/** The direct route's page as the app opens it, with the app's bridge stood in for. */
async function openDirect(page: Page, pass: (typeof PASSES)[number]) {
  expect(existsSync(join(DIST, 'direct.html')), 'web/dist-direct (scripts/e2e.sh builds it)').toBe(true);
  await page.setViewportSize(pass.size);
  await page.route(`${ORIGIN}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/direct\//, '');
    const file = join(DIST, path || 'direct.html');
    return existsSync(file) ? r.fulfill({ path: file }) : r.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(
    ({ cache, lang, mode }) => {
      type Msg = { id: number; method: string; params: Record<string, unknown> };
      const w = window as unknown as { BurrowDirect: unknown; __calls: string[] };
      const calls: string[] = (w.__calls = []);
      const trusted = new Set<number>();
      let forwards: { forwardId: string; hostName: string; localPort: number; targetHost: string; targetPort: number }[] = [];
      const port = {
        onmessage: null as ((e: { data: string }) => void) | null,
        postMessage(raw: string) {
          const { id, method, params } = JSON.parse(raw) as Msg;
          calls.push(method);
          const emit = (event: string, data: unknown) => port.onmessage?.({ data: JSON.stringify({ event, data }) });
          let result: unknown = null;
          let then: (() => void) | null = null;
          const h = cache.hosts.find((x) => x.id === params.hostId);
          if (method === 'info') result = { version: '2.1.0', uiPrefs: { 'burrow.locale': lang, 'burrow.appearance': JSON.stringify({ mode, accent: 'green' }) }, selectionMenu: true };
          else if (method === 'takeConnectTo') result = { hostId: null };
          else if (method === 'cache') result = cache;
          else if (method === 'connect') {
            if (h?.name === 'new-box' && !trusted.has(h.id)) result = { status: 'unknown_host_key', keyType: 'ssh-ed25519', fingerprint: 'SHA256:Xb3Ul8XGnYqKOMp9Bq6e2hVf0yFq5z1dS4c7mWnP2rE' };
            else if (h?.name === 'moved-box') result = { status: 'host_key_changed', keyType: 'ssh-ed25519', fingerprint: 'SHA256:9pQe1w2Vr7TzYx3c8K0aB5nM4hJ6gF2dS1lK0jH9gF8' };
            else result = { status: 'ok', sessionId: `s${String(params.hostId)}`, viaWireGuard: true, kept: h?.name === 'nas' };
          } else if (method === 'trust') trusted.add(Number(params.hostId));
          else if (method === 'attach') then = () => emit('output', { sessionId: params.sessionId, data: `Linux nas 6.12.0 x86_64\r\n\x1b[1;32mtester@nas\x1b[0m:~$ ` });
          else if (method === 'input') then = () => emit('output', { sessionId: params.sessionId, data: String(params.data).replace(/\r/g, '\r\n') });
          else if (method === 'forward') {
            const f = { forwardId: `f${forwards.length + 1}`, hostName: h?.name ?? '', localPort: 41000 + forwards.length, targetHost: String(params.targetHost), targetPort: Number(params.targetPort) };
            forwards = [...forwards, f];
            result = { status: 'ok', forwardId: f.forwardId, localPort: f.localPort, viaWireGuard: true };
          } else if (method === 'forwards') result = forwards;
          else if (method === 'stopForward') forwards = forwards.filter((f) => f.forwardId !== params.forwardId);
          else if (method === 'exec') result = { stdout: '' };
          else if (method === 'ls') result = { dir: '/home/tester', entries: [] };
          setTimeout(() => {
            port.onmessage?.({ data: JSON.stringify({ id, result }) });
            then?.();
          }, 5);
        },
      };
      w.BurrowDirect = port;
    },
    { cache: CACHE, lang: pass.lang, mode: pass.mode },
  );
  await page.goto(`${ORIGIN}/direct/direct.html`);
  await expect(page.getByTestId('direct-banner')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', pass.lang);
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
/** A text of the page in the pass's language, up to its first placeholder. */
const tr = (lang: string, key: MessageKey) => (lang === 'nl' ? nl : en)[key].split('{')[0]!.trim();

for (const pass of PASSES) {
  test(`the direct route's screens and dialogs: ${pass.name}`, async ({ page }) => {
    // Eight screens looked at (axe on each) beside the other browsers: past 30 s now and then (twice a retry in a gate).
    test.setTimeout(90_000);
    const shot = (what: string) => lookAt(page, `${pass.name}-direct-route-${what}`);
    await openDirect(page, pass);
    const hostRow = (name: string) => page.getByTestId('direct-host').filter({ hasText: name });

    // A port of a host forwarded to the phone: the dialog, then the list with it.
    await page.getByTestId('direct-forward').first().click();
    const fwd = page.locator('dialog[data-tour=direct-forward][open]');
    await expect(fwd).toBeVisible();
    await fwd.getByTestId('forward-port').fill('8096');
    await shot('forward');
    await fwd.getByRole('checkbox').check();
    await fwd.getByRole('checkbox').uncheck();
    await fwd.getByTestId('forward-start').click();
    await expect(page.getByTestId('forwards')).toContainText('127.0.0.1:8096');
    await expect.poll(() => calls(page)).toContain('openForward');
    await shot('list');
    if (pass.name === 'phone') {
      await page.getByTestId('forwards').getByRole('button', { name: en['direct.open'], exact: true }).click();
      await expect.poll(async () => (await calls(page)).filter((c) => c === 'openForward').length).toBe(2);
      await page.getByTestId('forwards').getByRole('button', { name: en['direct.stopForward'] }).click();
      await expect(page.getByTestId('forwards')).toHaveCount(0);
      // Asked and then not: nothing forwarded.
      await page.getByTestId('direct-forward').first().click();
      await fwd.getByRole('button', { name: en['common.cancel'] }).click();
      await expect(fwd).toBeHidden();
      await page.getByRole('button', { name: en['direct.back'] }).click();
      await expect.poll(() => calls(page)).toContain('backToBurrow');
    }

    // A host whose key the phone does not know: its fingerprint first.
    await hostRow('moved-box').click();
    const key = page.locator('dialog[data-tour=direct-host-key][open]');
    await expect(key).toContainText(tr(pass.lang, 'direct.keyChanged'));
    await shot('key-changed');
    await key.getByRole('button', { name: tr(pass.lang, 'common.cancel') }).click();
    await expect(key).toBeHidden();
    await hostRow('new-box').click();
    await expect(key).toContainText('SHA256:Xb3Ul8XGnYqKOMp9Bq6e2hVf0yFq5z1dS4c7mWnP2rE');
    await shot('key');
    await key.getByRole('button', { name: tr(pass.lang, 'direct.trust') }).click();
    await expect(page.getByTestId('route-direct')).toBeVisible();
    await page.getByRole('button', { name: tr(pass.lang, 'common.back') }).first().click();
    const ask = page.locator('dialog[data-tour=confirm][open]');
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: tr(pass.lang, 'term.close') }).last().click();
    await expect(page.getByTestId('direct-banner')).toBeVisible();

    // A session on a host with tmux: the terminal, its menu and the snippets.
    await hostRow('nas').click();
    await expect(page.locator('.xterm-rows')).toContainText('tester@nas:~$');
    await shot('terminal');
    await page.getByRole('button', { name: tr(pass.lang, 'term.snippets') }).click();
    const snippets = page.locator('dialog[data-tour=direct-snippets][open]');
    await expect(snippets).toContainText('Restart the media stack');
    await shot('snippets');
    await snippets.getByRole('button', { name: tr(pass.lang, 'snippets.paste') }).first().click();
    await expect(snippets).toBeHidden();
    await page.getByRole('button', { name: tr(pass.lang, 'term.sessions') }).click();
    const menu = page.locator('dialog[data-tour=direct-menu][open]');
    await expect(menu).toBeVisible();
    await shot('menu');
    if (pass.name === 'phone') {
      // Every control of the menu and of the key bar pressed once (the tour's rule: seen is pressed).
      await menu.getByTestId('keep-open').check();
      await expect.poll(() => calls(page)).toContain('keepAlive');
      await menu.getByRole('button', { name: en['term.larger'] }).click();
      await menu.getByRole('button', { name: en['term.smaller'] }).click();
      await menu.getByRole('button', { name: en['term.search'] }).click();
      await expect(menu).toBeHidden();
      await page.keyboard.press('Escape');
      for (const k of await page.locator('.keybar button:visible').all()) await k.click({ timeout: 2000 }).catch(() => {});
      await page.getByRole('button', { name: en['term.sessions'] }).click();
      await menu.getByRole('checkbox', { name: en['term.composeMode'] }).click();
      await expect(menu).toBeHidden();
      await page.getByRole('button', { name: en['term.sessions'] }).click();
      await menu.getByTestId('direct-end').click();
      await ask.getByRole('button', { name: en['direct.end'] }).click();
      await expect(page.getByTestId('direct-banner')).toBeVisible();
      expect(await calls(page)).toContain('close');
    } else {
      await menu.getByRole('button', { name: tr(pass.lang, 'common.close'), exact: true }).click();
      await expect(menu).toBeHidden();
      // Kept in tmux: leaving only detaches, said so.
      await page.getByRole('button', { name: tr(pass.lang, 'common.back') }).first().click();
      await expect(page.getByTestId('direct-kept')).toBeVisible();
    }
  });
}
