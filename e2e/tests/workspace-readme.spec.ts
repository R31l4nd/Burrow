import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { hostNamed, signIn, stepUpAgain } from './passkey.js';

// The README's and F-Droid's pictures, with made-up hosts and containers of
// a homelab: never the test fixtures' names, and never this machine's own
// Docker (the test instance watches it, with other projects on it). Only when asked:
//   README_SHOTS=1 bash scripts/e2e.sh --no-deps --project=setup --project=desktop --grep "claims a fresh instance|builds a group|README|F-Droid"
// The pictures land in e2e/test-results/readme/; docs/screenshots/ and
// android/fastlane/metadata/android/en-US/images/phoneScreenshots/ hold the chosen ones.

test.skip(!process.env.README_SHOTS, 'README pictures only when asked (README_SHOTS=1)');

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'readme');
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const facts = (os: string, extra: Record<string, unknown> = {}) => ({ os, kernel: 'Linux 6.12.48', shell: '/bin/bash', hasTmux: true, hasDocker: true, hasShellIntegration: true, mac: null, proxmox: false, checkedAt: iso(60_000), ...extra });
const host = (id: number, name: string, address: string, groupId: number | null, tags: string[], f: ReturnType<typeof facts>) => ({
  id, name, address, groupId, port: null, username: null, authMethod: null, keyId: null, hasPassword: false, startupCommand: null, tmux: null, term: null, encoding: null, tags, color: null, icon: null, favorite: false, lastUsedAt: iso(2 * HOUR), facts: f,
});
const HOSTS = [
  host(901, 'nas', '10.0.0.10', 1, ['storage', 'docker'], facts('Debian GNU/Linux 13 (trixie)')),
  host(902, 'media', '10.0.0.20', 1, ['docker'], facts('Ubuntu 24.04.3 LTS')),
  host(903, 'pve', '10.0.0.5', 2, ['proxmox'], facts('Debian GNU/Linux 13 (trixie)', { hasDocker: false, proxmox: true })),
  host(904, 'pihole', '10.0.0.3', 2, ['dns'], facts('Raspbian GNU/Linux 12 (bookworm)', { hasDocker: false })),
  host(905, 'backup-box', '10.0.0.30', null, ['offsite'], facts('Alpine Linux v3.22', { hasDocker: false, shell: '/bin/ash' })),
];
const GROUPS = [
  { id: 1, name: 'Home', parentId: null, defaults: { username: 'admin' }, sort: 0 },
  { id: 2, name: 'Lab', parentId: null, defaults: { username: 'root' }, sort: 1 },
];

// A day of samples that looks like one: each container its own rhythm (seeded by its name).
const seedOf = (name: string) => [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
const wave = (base: number, seed: number, n = 24) => Array.from({ length: n }, (_, i) => Math.max(0, base * (1 + 0.45 * Math.sin(i / 2.3 + seed) + 0.25 * Math.sin(i * 1.7 + seed * 3))));
function container(name: string, image: string, project: string | null, opts: { state?: string; health?: string | null; up?: number; cpu?: number; mem?: number; restarts?: number } = {}) {
  return {
    info: {
      id: name, name, image, imageId: 'sha256:0', state: opts.state ?? 'running', health: opts.health ?? null, restarts: opts.restarts ?? 0,
      startedAt: iso(opts.up ?? 3 * DAY), finishedAt: opts.state === 'exited' ? iso(HOUR) : null, exitCode: opts.state === 'exited' ? 1 : 0, oomKilled: false, createdAt: iso(20 * DAY),
      project, service: project ? name.replace(`${project}-`, '') : null, configFiles: project ? `/srv/${project}/compose.yaml` : null, workingDir: project ? `/srv/${project}` : null,
    },
    cpu: opts.cpu ?? 0.4,
    mem: (opts.mem ?? 120) * 1024 * 1024,
  };
}
const DOCKER: Record<number, ReturnType<typeof container>[]> = {
  901: [
    container('nextcloud', 'nextcloud:31-apache', 'cloud', { health: 'healthy', cpu: 1.8, mem: 412 }),
    container('nextcloud-db', 'postgres:17', 'cloud', { health: 'healthy', cpu: 0.6, mem: 230 }),
    container('nextcloud-redis', 'redis:8-alpine', 'cloud', { cpu: 0.2, mem: 18 }),
    container('immich-server', 'ghcr.io/immich-app/immich-server:v2', 'photos', { health: 'healthy', cpu: 3.1, mem: 690 }),
    container('immich-ml', 'ghcr.io/immich-app/immich-machine-learning:v2', 'photos', { health: 'healthy', cpu: 0.4, mem: 1210 }),
    container('immich-postgres', 'ghcr.io/immich-app/postgres:16', 'photos', { health: 'healthy', cpu: 0.5, mem: 210 }),
    container('vaultwarden', 'vaultwarden/server:1.34', null, { health: 'healthy', cpu: 0.1, mem: 22 }),
    container('uptime-kuma', 'louislam/uptime-kuma:2', null, { health: 'healthy', cpu: 0.9, mem: 140 }),
  ],
  902: [
    container('jellyfin', 'jellyfin/jellyfin:10.11', 'media', { health: 'healthy', cpu: 4.2, mem: 830 }),
    container('sonarr', 'linuxserver/sonarr:4', 'media', { cpu: 0.3, mem: 210 }),
    container('radarr', 'linuxserver/radarr:5', 'media', { cpu: 0.3, mem: 230 }),
    container('prowlarr', 'linuxserver/prowlarr:2', 'media', { cpu: 0.1, mem: 150, state: 'exited', up: 0 }),
    container('qbittorrent', 'linuxserver/qbittorrent:5', 'media', { cpu: 2.4, mem: 310, restarts: 1 }),
    container('homeassistant', 'ghcr.io/home-assistant/home-assistant:2025.10', 'home', { health: 'healthy', cpu: 1.2, mem: 520 }),
    container('mosquitto', 'eclipse-mosquitto:2', 'home', { cpu: 0.1, mem: 8 }),
  ],
};

async function mockLab(page: Page) {
  await page.route('**/api/hosts', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: HOSTS }) : r.fallback()));
  await page.route('**/api/groups', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: GROUPS }) : r.fallback()));
  await page.route('**/api/hosts/status', (r) => r.fulfill({ json: HOSTS.map((h) => ({ hostId: h.id, reachable: h.name !== 'backup-box', latencyMs: 3, checkedAt: iso(30_000) })) }));
  await page.routeWebSocket(/\/api\/docker\/ws/, (ws) => {
    // Each host once a socket: the page asks again as hosts come and go.
    const sent = new Set<number>();
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { t: string; hostIds: number[] };
      if (m.t !== 'watch') return;
      for (const id of m.hostIds) {
        if (sent.has(id)) continue;
        sent.add(id);
        const list = DOCKER[id];
        const h = HOSTS.find((x) => x.id === id);
        if (!list || !h) continue;
        const at = Array.from({ length: 24 }, (_, i) => now - (23 - i) * 5 * 60_000);
        ws.send(
          JSON.stringify({
            t: 'host',
            host: {
              hostId: id,
              hostName: h.name,
              containers: list.map((c) => c.info),
              stats: Object.fromEntries(list.filter((c) => c.info.state === 'running').map((c) => [c.info.name, { cpu: c.cpu, memBytes: c.mem, memLimitBytes: 16 * 1024 ** 3 }])),
              history: Object.fromEntries(list.filter((c) => c.info.state === 'running').map((c) => [c.info.name, { at, cpu: wave(c.cpu, seedOf(c.info.name)), mem: wave(c.mem, seedOf(c.info.name) + 1).map((v) => v * 0.3 + c.mem * 0.7) }])),
              error: null,
              at: new Date().toISOString(),
            },
          }),
        );
      }
    });
  });
}

const shot = async (page: Page, name: string) => {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};

test('README pictures: hosts and containers of a made-up homelab, desktop and phone', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await mockLab(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/hosts');
  await page.reload();
  await expect(page.getByTestId('host-row').filter({ hasText: 'media' })).toBeVisible();
  await shot(page, 'desktop-hosts');

  await page.goto('/#/containers');
  await expect(page.getByTestId('container-row').filter({ hasText: 'jellyfin' })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'desktop-containers');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/containers');
  await expect(page.getByTestId('container-row').filter({ hasText: 'jellyfin' })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'phone-dark-containers');
  await page.goto('/#/hosts');
  await expect(page.getByTestId('host-row').filter({ hasText: 'media' })).toBeVisible();
  await shot(page, 'phone-dark-hosts');
});

// Media stack files on the test host, for the terminal and the editor.
const COMPOSE = `services:
  jellyfin:
    image: jellyfin/jellyfin:10.11
    restart: unless-stopped
    ports:
      - 8096:8096
    volumes:
      - ./config/jellyfin:/config
      - \${MEDIA}:/media:ro
    healthcheck:
      test: curl -fs http://localhost:8096/health
      interval: 30s

  sonarr:
    image: linuxserver/sonarr:4
    restart: unless-stopped
    environment:
      - PUID=\${PUID}
      - PGID=\${PGID}
      - TZ=\${TZ}
    volumes:
      - ./config/sonarr:/config
      - \${MEDIA}/tv:/tv

  qbittorrent:
    image: linuxserver/qbittorrent:5
    restart: unless-stopped
    environment:
      - WEBUI_PORT=8080
    ports:
      - 8080:8080
`;
const ENV = 'TZ=Europe/Amsterdam\nPUID=1000\nPGID=1000\nMEDIA=/mnt/media\n';

// A day of a stack's logs, as Docker sends them (made up).
function logLines(): { i: number; s: 'o' | 'e'; ts: string; text: string }[] {
  const lines: [number, string][] = [
    [0, '[INF] Startup complete'],
    [1, '[Info] RssSyncService: RSS Sync Completed. Reports found: 75, Reports grabbed: 1'],
    [2, 'Connection to tracker established, 14 peers'],
    [0, '[INF] Playback started: "The Expanse S02E04" on Living room TV'],
    [1, '[Info] DownloadDecisionMaker: Processing 75 releases'],
    [1, '[Warn] DiskSpaceService: Free space on /tv is below 10%'],
    [2, 'Torrent finished: ubuntu-24.04.3-desktop-amd64.iso'],
    [0, '[WRN] Transcoding is slow: 0.9x realtime (HEVC to H.264)'],
    [1, '[Info] EpisodeImportService: Import of The Expanse S02E05 complete'],
    [0, '[INF] Playback stopped after 41 minutes'],
    [2, 'Removed 3 finished torrents'],
    [1, '[Error] DownloadClient qBittorrent: Connection refused, retrying in 30s'],
    [2, 'WebUI: login from 10.0.0.42'],
    [1, '[Info] DownloadClient qBittorrent: connected again'],
    [0, '[INF] Library scan finished: 1 new item'],
  ];
  return lines.map(([i, text], n) => ({ i, s: text.includes('[Error]') ? 'e' : 'o', ts: new Date(now - (lines.length - n) * 7 * 60_000).toISOString().replace('Z', '000000Z'), text }));
}

test('F-Droid pictures: a phone, the made-up homelab, a terminal and the editor on one of its hosts', async ({ browser }) => {
  test.setTimeout(180_000);
  // 1080x2400, as a phone's own screenshots.
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const a = await signIn(page);
  const sshd = await hostNamed(page, 'test-sshd');
  // The test host under a homelab's name, prompt included: the terminal and the editor are real.
  await stepUpAgain(page, a);
  const nas = await page.evaluate(async ([id, files]) => {
    const json = (r: Response) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t))));
    const copy = await fetch(`/api/hosts/${id}/copy`, { method: 'POST' }).then(json);
    const { id: _id, facts: _f, lastUsedAt: _l, favorite: _fav, effective: _e, ...rest } = await fetch(`/api/hosts/${copy.id}`).then(json);
    await fetch(`/api/hosts/${copy.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...rest, name: 'nas', tags: ['storage', 'docker'], tmux: 'auto', startupCommand: "PS1='admin@nas:\\w\\$ '; clear" }) }).then(json);
    for (const path of ['/home/tester/stacks', '/home/tester/stacks/media']) await fetch(`/api/files/${copy.id}/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, kind: 'dir' }) });
    for (const [path, content] of files) {
      const r = await fetch(`/api/files/${copy.id}/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content, baseHash: null }) });
      if (!r.ok && r.status !== 409) throw new Error(await r.text());
    }
    return copy.id as number;
  }, [sshd, [['/home/tester/stacks/media/compose.yaml', COMPOSE], ['/home/tester/stacks/media/.env', ENV]]] as const);

  await page.goto('/#/hosts');
  await page.getByTestId('host-row').filter({ hasText: 'nas' }).first().click();
  await expect(page).toHaveURL(/#\/term\//, { timeout: 20_000 });
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('admin@nas', { timeout: 20_000 });
  await page.getByTestId('terminal').click();
  await page.keyboard.type('cd stacks/media && ls -A\n');
  await page.keyboard.type('cat .env\n');
  await page.keyboard.type('grep image: compose.yaml\n');
  await expect(rows).toContainText('qbittorrent:5');
  await page.locator('.xterm-helper-textarea').blur();
  // The click left the mouse over the terminal, which shows xterm's scroll bar; a finger leaves none.
  await page.mouse.move(180, 30);
  await expect(page.locator('.xterm .scrollbar.vertical')).toHaveCSS('opacity', '0');
  await shot(page, 'fdroid-3-terminal');

  await page.goto(`/#/edit/${nas}?p=${encodeURIComponent('/home/tester/stacks/media/compose.yaml')}`);
  await expect(page.locator('.cm-content')).toContainText('jellyfin');
  await shot(page, 'fdroid-4-editor');

  await mockLab(page);
  await page.goto('/#/hosts');
  await page.reload();
  await expect(page.getByTestId('host-row').filter({ hasText: 'media' })).toBeVisible();
  await shot(page, 'fdroid-1-hosts');

  await page.goto('/#/containers');
  await expect(page.getByTestId('container-row').filter({ hasText: 'jellyfin' })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'fdroid-2-containers');

  await page.routeWebSocket(/\/api\/docker\/logs\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: 'lines', lines: logLines() }));
  });
  await page.goto('/#/logs?t=902:jellyfin,902:sonarr,902:qbittorrent');
  await page.reload();
  await expect(page.getByTestId('log-line').filter({ hasText: 'Library scan finished' })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'fdroid-5-logs');

  const alert = (id: number, hostId: number, container: string, title: string, minsAgo: number, extra: Record<string, unknown> = {}) => ({
    id, ruleId: 1, ruleName: 'Crashes and failures', hostId, hostName: HOSTS.find((h) => h.id === hostId)!.name, container, title, detail: null, at: iso(minsAgo * 60_000), count: 1, read: minsAgo > 60, pushed: 'yes', ...extra,
  });
  await page.route('**/api/alerts', (r) => r.fulfill({ json: [
    alert(4, 902, 'qbittorrent', 'restart loop: 3 restarts in 10 minutes', 12, { count: 3 }),
    alert(3, 901, 'immich-ml', 'OOM killed', 95),
    alert(2, 902, 'prowlarr', 'exited with code 1', 60 * 5),
    alert(1, 901, 'nextcloud', 'unhealthy', 60 * 26, { count: 2 }),
  ] }));
  await page.route('**/api/alerts/status', (r) => r.fulfill({ json: { hostIds: [901, 902] } }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/alerts');
  await expect(page.getByText('OOM killed')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'fdroid-6-alerts-dark');
  await ctx.close();
});
