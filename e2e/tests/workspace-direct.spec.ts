import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from './fixtures.js';
import { lookAt } from './checks.js';

// The Android app's direct route (web/direct.html, built by scripts/e2e.sh into
// web/dist-direct): its page and dialogs, looked at like every other screen
// (UIA-17, UIB-02: they ran only in the app, where no layout check sees them).
// A stand-in for the app's bridge (BurrowDirect) answers as the app does.

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist-direct');
const ORIGIN = 'https://appassets.androidplatform.net';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

// It shows no page of the web app: nothing of its code to count.
test.use({ cover: false });

/** The page from its own origin, the app's stand-in in place before it starts. */
async function openDirect(page: Page, prefs: Record<string, string>) {
  await page.route(`${ORIGIN}/**`, (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/direct\//, '');
    const file = join(DIST, path === '' ? 'direct.html' : path);
    if (!file.startsWith(DIST) || !existsSync(file)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? 'application/octet-stream' });
  });
  await page.addInitScript((uiPrefs) => {
    const host = (id: number, name: string, address: string, favorite = false) => ({ id, name, address, port: 22, username: 'tester', groupId: null, favorite, color: null, encoding: null, hostKeys: [], history: [{ command: 'docker compose ps', count: 4, lastAt: new Date().toISOString() }] });
    const cache = {
      generatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      deviceId: 1,
      hosts: [host(1, 'nas', '10.0.0.20', true), host(2, 'pve-node-with-a-rather-long-name', '192.168.1.11'), host(3, 'pi', '192.168.1.12')],
      snippets: [{ id: 1, name: 'Disk space', command: 'df -h', description: null, hostId: null, groupId: null }],
      groups: [],
    };
    const w = window as unknown as { BurrowDirect: unknown };
    const port = {
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        let result: unknown = null;
        if (method === 'info') result = { version: '2.1.0', uiPrefs, selectionMenu: false };
        else if (method === 'takeConnectTo') result = { hostId: null };
        else if (method === 'cache') result = cache;
        else if (method === 'forwards') result = [];
        // pi: a host Burrow never saw; the others connect.
        else if (method === 'connect') result = params.hostId === 3 ? { status: 'unknown_host_key', keyType: 'ssh-ed25519', fingerprint: 'SHA256:q2Vz0mZ3x1fS3o8bQeR2n1v8sY4tW6uK9pL0aB7cD5E' } : { status: 'ok', sessionId: 's1', viaWireGuard: true, kept: true };
        else if (method === 'attach') setTimeout(() => port.onmessage?.({ data: JSON.stringify({ event: 'output', data: { sessionId: 's1', data: 'tester@nas:~$ ' } }) }), 20);
        else if (method === 'exec') result = { stdout: '' };
        else if (method === 'ls') result = { dir: '/home/tester', entries: [] };
        setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      },
    };
    w.BurrowDirect = port;
  }, prefs);
  await page.goto(`${ORIGIN}/direct/direct.html`);
  await expect(page.getByTestId('direct-banner')).toBeVisible();
}

// The phone's passes of the tour (and the tablet): its own language and theme come from the app at start.
const PASSES = [
  ['phone', { width: 390, height: 844 }, 'en', 'light'],
  ['phone-nl', { width: 343, height: 711 }, 'nl', 'light'],
  ['phone-dark', { width: 390, height: 844 }, 'en', 'dark'],
  ['tablet-nl', { width: 820, height: 1180 }, 'nl', 'light'],
] as const;

for (const [pass, size, lang, mode] of PASSES) {
  test(`the direct route's page and dialogs, looked at: ${pass}`, async ({ page }) => {
    await page.setViewportSize(size);
    const T = (en: string, nl: string) => (lang === 'nl' ? nl : en);
    await openDirect(page, { 'burrow.locale': lang, 'burrow.appearance': JSON.stringify({ mode, accent: 'green' }) });
    await lookAt(page, `${pass}-direct-hosts`, { passes: [] });

    // A port of a host on the phone.
    await page.getByTestId('direct-forward').first().click();
    await expect(page.getByTestId('forward-port')).toBeVisible();
    await lookAt(page, `${pass}-direct-forward`, { passes: [] });
    await page.keyboard.press('Escape');

    // A host Burrow never connected to: its key, to trust first.
    await page.getByTestId('direct-host').filter({ hasText: 'pi' }).click();
    await expect(page.locator('dialog[open]')).toContainText('SHA256:');
    await lookAt(page, `${pass}-direct-host-key`, { passes: [] });
    await page.locator('dialog[open]').getByRole('button', { name: T('Cancel', 'Annuleren') }).click();

    // A session: its menu and its snippets.
    await page.getByTestId('direct-host').filter({ hasText: 'nas' }).click();
    await expect(page.getByTestId('route-direct')).toBeVisible();
    await page.getByRole('button', { name: T('Snippets', 'Snippets'), exact: true }).click();
    await expect(page.locator('dialog[open]')).toContainText('df -h');
    await lookAt(page, `${pass}-direct-snippets`, { passes: [] });
    await page.keyboard.press('Escape');
    await page.locator('.term-top').getByRole('button').last().click();
    await expect(page.getByTestId('direct-end')).toBeVisible();
    await lookAt(page, `${pass}-direct-menu`, { passes: [] });
  });
}
