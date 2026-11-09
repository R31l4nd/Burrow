import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkScript, findTarget, imageUpdate, launchScript, locateTarget, parseCheck, pinnedImage, readCheck, updateScript } from '../../src/selfupdate.js';

// The update script runs for real, with sh, against a stand-in docker that
// writes down what it was asked and says "healthy" or not as told.

let dir: string;
let home: string;
let bin: string;

const DOCKER = `#!/bin/sh
echo "$*" >> "$HOME/calls"
# Which day's packages a build fetches (PKG_DATE, the backup image's apk layer).
[ "$1 $2" = "compose build" ] && echo "PKG_DATE=\${PKG_DATE:-}" >> "$HOME/calls"
case "$1 $2" in
  "inspect -f")
    case "$3" in
      # The old version (not upped) is healthy unless told otherwise.
      *Health*) if [ -f "$HOME/alwaysbad" ]; then echo unhealthy; elif [ -f "$HOME/upped" ]; then cat "$HOME/health"; else echo healthy; fi ;;
      *Config.Image*) if [ -f "$HOME/digestref" ]; then echo "burrow@sha256:$(printf %064d 7)"; else echo burrow:local; fi ;;
      # The container runs the new image once compose up started it.
      *.Image*) if [ -f "$HOME/upped" ]; then cat "$HOME/built"; else echo sha256:0ld; fi ;;
    esac ;;
  "image inspect")
    # The old name still on the old image when compose now wants another one.
    if [ "$5" = burrow:local ] && [ -f "$HOME/wants" ]; then echo sha256:0ld; else cat "$HOME/built" 2>/dev/null || echo sha256:0ld; fi ;;
  "compose config") [ -f "$HOME/wants" ] && cat "$HOME/wants" ;;
  # The project's services: those that run, or (-a) that exist at all.
  "compose ps") case "$*" in *--status*) cat "$HOME/running" 2>/dev/null ;; *) cat "$HOME/running" "$HOME/stopped" 2>/dev/null ;; esac ;;
  # The name back on the old image: what compose starts next is the old one.
  "image tag") case "$3" in burrow-rollback:*) rm -f "$HOME/built" "$HOME/upped" ;; esac ;;
  "compose up")
    [ -f "$HOME/upfailall" ] && exit 1
    [ -f "$HOME/upfail" ] && { rm "$HOME/upfail"; echo "Error response from daemon: port is already allocated" >&2; exit 1; }
    [ -f "$HOME/built" ] && cp "$HOME/built" "$HOME/upped" ;;
esac
exit 0
`;

// A checkout at commit abc123 with an upstream three commits ahead, at 9.9.10.
const GIT = `#!/bin/sh
echo "git $*" >> "$HOME/calls"
case "$*" in
  "rev-parse HEAD") echo abc123 ;;
  "rev-parse --abbrev-ref @{u}") echo origin/main ;;
  "rev-list --count HEAD..@{u}") echo 3 ;;
  "show @{u}:server/package.json") printf '{\\n  "version": "9.9.10"\\n}\\n' ;;
  "show @{u}:CHANGELOG.md") printf '# Changelog\\n\\n## [9.9.10] - 2026-10-01\\n\\n### Breaking\\n\\n- BURROW_PORT is now PORT: change it\\n  in your .env first.\\n\\n### Fixed\\n\\n- Not this one.\\n\\n## [9.9.9] - 2026-09-30\\n\\n### Breaking\\n\\n- Already running, not shown.\\n' ;;
  log*) echo "feat: something new" ;;
esac
exit 0
`;

const sh = (script: string, extra: Record<string, string> = {}) =>
  execFileSync('sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...extra }, encoding: 'utf8' });

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'burrow-update-'));
  dir = join(root, 'app');
  home = join(root, 'home');
  bin = join(root, 'bin');
  for (const d of [dir, home, bin]) mkdirSync(d);
  writeFileSync(join(bin, 'docker'), DOCKER);
  writeFileSync(join(bin, 'git'), GIT);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'git'), 0o755);
  // seq and sleep as they are; sleep made instant so a failing health check is quick.
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'sleep'), 0o755);
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server', 'package.json'), '{\n  "name": "@burrow/server",\n  "version": "9.9.9"\n}\n');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

const calls = () => readFileSync(join(home, 'calls'), 'utf8').trim().split('\n');
const state = () => JSON.parse(readFileSync(join(home, '.burrow-update.json'), 'utf8')) as { state: string; message: string; code: string };
const target = () => ({ dir, container: 'burrow', service: 'burrow' });
const failing = (script: string) => {
  try {
    sh(script);
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
};

describe('self-update', () => {
  it('pulls the new image, keeps the old one, and is done when healthy', () => {
    writeFileSync(join(home, 'health'), 'healthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    sh(updateScript(target()));
    expect(calls()).toEqual([
      'inspect -f {{.Config.Image}} burrow',
      'inspect -f {{.Image}} burrow',
      'image tag sha256:0ld burrow-rollback:burrow',
      'compose ps -a --services',
      'compose ps --status running --services',
      'compose pull -q burrow',
      'compose config --images burrow',
      'image inspect -f {{.Id}} burrow:local',
      'compose up -d --no-build burrow',
      'inspect -f {{.State.Health.Status}} burrow',
      // The new image is the one running.
      'inspect -f {{.Image}} burrow',
    ]);
    expect(state().state).toBe('done');
  });

  it('says so when compose could not start the new version (the old one, healthy, said "updated")', () => {
    writeFileSync(join(home, 'health'), 'healthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    writeFileSync(join(home, 'upfail'), '');
    expect(failing(updateScript(target()))).toBe(1);
    expect(state()).toMatchObject({ state: 'failed', code: 'up_failed', message: 'docker compose up failed; the old version runs again' });
    // The name points at the old version, started again and seen running.
    const c = calls();
    expect(c).toContain('image tag burrow-rollback:burrow burrow:local');
    // Started again without pulling: a pull policy cannot fetch the new image back (AUDIT2 DO-15).
    expect(c).toContain('compose up -d --no-build burrow');
    expect(c).toContain('compose up -d --no-build --pull never burrow');
  });

  it('never says the old version runs again when it did not come back', () => {
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    writeFileSync(join(home, 'upfailall'), '');
    expect(failing(updateScript(target()))).toBe(1);
    expect(state()).toMatchObject({ state: 'failed', code: 'both_unhealthy' });
  });

  it('rolled back only when the old version is healthy again; otherwise failed', () => {
    writeFileSync(join(home, 'health'), 'unhealthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    writeFileSync(join(home, 'alwaysbad'), '');
    expect(failing(updateScript(target()))).toBe(1);
    expect(state()).toMatchObject({ state: 'failed', code: 'both_unhealthy' });
  });

  it('compares with the image compose wants now, not the old name, and keeps the old one under a valid name, also for a digest reference (AUDIT2 DO-14)', () => {
    writeFileSync(join(home, 'health'), 'healthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    // The compose file now names burrow:2.0; burrow:local is still the old image.
    writeFileSync(join(home, 'wants'), 'burrow:2.0\n');
    sh(updateScript(target()));
    expect(calls()).toContain('image inspect -f {{.Id}} burrow:2.0');
    expect(state()).toMatchObject({ state: 'done', code: 'updated' });
    // Started from a digest reference: "<ref>-rollback" is no valid name.
    rmSync(join(home, 'calls'));
    rmSync(join(home, 'wants'));
    writeFileSync(join(home, 'digestref'), '');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    rmSync(join(home, 'upped'), { force: true });
    sh(updateScript(target()));
    expect(calls()).toContain('image tag sha256:0ld burrow-rollback:burrow');
    expect(calls().some((l) => l.includes('-rollback') && l.includes('@'))).toBe(false);
  });

  it('one update at a time on the host, whatever asked: a lock held by a running update refuses, a stale one is taken (AUDIT2 DO-16)', () => {
    const lock = join(home, '.burrow-update.lock');
    const launch = launchScript(target());
    // Held by a process that runs (this one).
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(process.pid));
    expect(sh(launch)).toContain('@@busy');
    // Just taken, its process not written yet: held too.
    rmSync(join(lock, 'pid'));
    expect(sh(launch)).toContain('@@busy');
    // Left by a process that is gone, a while ago: taken, and the update starts.
    writeFileSync(join(lock, 'pid'), '999999');
    execFileSync('touch', ['-d', '5 minutes ago', lock]);
    expect(sh(launch)).not.toContain('@@busy');
  });

  it('says started only once the update runs; a folder that is gone fails at once, the lock not taken (AUDIT2 DO-17)', () => {
    const lock = join(home, '.burrow-update.lock');
    rmSync(lock, { recursive: true, force: true });
    const r = spawnSync('sh', ['-c', launchScript({ ...target(), dir: join(dir, 'gone') })], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    const gone = r.stdout;
    expect(gone).toContain('@@nodir');
    expect(gone).not.toContain('@@started');
    expect(existsSync(lock)).toBe(false);
  });

  it("uses the container's own compose project and files", () => {
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    failing(updateScript({ ...target(), project: 'burrow', configFiles: ['/srv/b/compose.yaml', '/srv/b/override.yaml'] }));
    expect(calls()).toContain('compose -p burrow -f /srv/b/compose.yaml -f /srv/b/override.yaml pull -q burrow');
  });

  it('puts the old image back when the new one does not become healthy', () => {
    writeFileSync(join(home, 'health'), 'unhealthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    sh(updateScript(target()));
    const c = calls();
    expect(c).toContain('image tag burrow-rollback:burrow burrow:local');
    expect(c).toContain('compose up -d --no-build burrow');
    expect(c).toContain('compose up -d --no-build --pull never burrow');
    expect(state()).toMatchObject({ state: 'rolledback', code: 'rolled_back' });
  });

  it('builds a git checkout, and goes back to the old commit when unhealthy', () => {
    writeFileSync(join(home, 'health'), 'unhealthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    mkdirSync(join(dir, '.git'));
    sh(updateScript(target()));
    const c = calls();
    expect(c).toContain('compose build -q burrow');
    expect(c).toContain('git pull -q --ff-only');
    expect(c).toContain('git reset -q --keep abc123');
  });

  it('restarts nothing when the build gives the image that runs', () => {
    writeFileSync(join(home, 'health'), 'healthy\n');
    mkdirSync(join(dir, '.git'));
    sh(updateScript(target()));
    const c = calls();
    expect(c).toContain('compose build -q burrow');
    expect(c.filter((l) => l.startsWith('compose up'))).toEqual([]);
    expect(state()).toMatchObject({ state: 'done', code: 'nothing_new', message: 'Nothing new: the running version is current' });
  });

  it('builds the backup service with Burrow, with fresh packages, and starts it again after Burrow is healthy (A3-OPS-05)', () => {
    writeFileSync(join(home, 'health'), 'healthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    writeFileSync(join(home, 'running'), 'burrow\nbackup\n');
    mkdirSync(join(dir, '.git'));
    sh(updateScript(target()));
    const c = calls();
    // One build for both: the backup image's scripts and its list of migrations are this Burrow's.
    expect(c).toContain('compose build -q burrow backup');
    expect(c[c.indexOf('compose build -q burrow backup') + 1]).toMatch(/^PKG_DATE=\d{4}-\d{2}-\d{2}$/);
    // Its backup before the update, then Burrow, then the backup service once Burrow is seen healthy.
    const run = c.indexOf('compose run --rm backup /app/scripts/backup/backup.sh');
    const up = c.indexOf('compose up -d --no-build burrow');
    const upBackup = c.indexOf('compose up -d --no-build backup');
    expect(run).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(run);
    expect(upBackup).toBeGreaterThan(up);
    expect(state()).toMatchObject({ state: 'done', code: 'updated' });
  });

  it('pulls the backup image too, and a stopped backup service is updated but not started (A3-OPS-05)', () => {
    writeFileSync(join(home, 'health'), 'healthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    writeFileSync(join(home, 'stopped'), 'backup\n');
    sh(updateScript(target()));
    const c = calls();
    expect(c).toContain('compose pull -q burrow');
    expect(c).toContain('compose pull -q backup');
    expect(c.filter((l) => l.startsWith('compose up'))).toEqual(['compose up -d --no-build burrow']);
    expect(state()).toMatchObject({ state: 'done', code: 'updated' });
  });

  it('says so when Burrow updated but its backup service did not start again (A3-OPS-05)', () => {
    writeFileSync(join(home, 'health'), 'healthy\n');
    writeFileSync(join(home, 'built'), 'sha256:n3w\n');
    writeFileSync(join(home, 'running'), 'burrow\nbackup\n');
    // Burrow's up works; the backup's then fails.
    writeFileSync(join(bin, 'docker'), DOCKER.replace('"compose up")', '"compose up")\n    case "$*" in *backup*) exit 1 ;; esac'));
    sh(updateScript(target()));
    expect(state()).toMatchObject({ state: 'done', code: 'backup_not_started' });
  });

  it('a check that failed says why, not "nothing to tell": its folder gone, the connection lost (audit 2026-11-05)', () => {
    const r = spawnSync('sh', ['-c', checkScript(join(dir, 'gone'))], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(readCheck({ code: r.status, stdout: r.stdout, stderr: r.stderr }).problem).toMatch(/gone/);
    expect(readCheck({ code: null, stdout: '', stderr: '' }).problem).toMatch(/connection to the host was lost/);
    expect(readCheck({ code: 0, stdout: sh(checkScript(dir)), stderr: '' }).problem).toBeNull();
  });

  it('tells what the folder would start', () => {
    const out = sh(checkScript(dir));
    expect(parseCheck(out)).toMatchObject({ mode: 'image', available: null, last: null });
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(home, '.burrow-update.json'), '{"state":"done","at":"2026-09-28T10:00:00Z","message":"Updated"}\n');
    expect(parseCheck(sh(checkScript(dir, '9.9.9')))).toMatchObject({ mode: 'git', available: '9.9.10', behind: 3, subject: 'feat: something new', last: { state: 'done' } });
    // What the CHANGELOG calls breaking between the running version and the new one, and only that.
    expect(parseCheck(sh(checkScript(dir, '9.9.9'))).breaking).toEqual(['9.9.10: BURROW_PORT is now PORT: change it in your .env first.']);
    // A running version the CHANGELOG does not name (a patch between, a build of one's own):
    // still only what came after it, not every release's breaking changes.
    expect(parseCheck(sh(checkScript(dir, '9.9.11'))).breaking).toEqual([]);
    expect(parseCheck(sh(checkScript(dir, '9.9.8'))).breaking).toEqual(['9.9.10: BURROW_PORT is now PORT: change it in your .env first.', '9.9.9: Already running, not shown.']);
    expect(parseCheck(sh(checkScript(dir, '9.9.10'))).breaking).toEqual([]);
  });

  it("fetches with the repository's own commands off, and not at all when its config runs one (audit 2026-11-05)", () => {
    mkdirSync(join(dir, '.git'));
    sh(checkScript(dir, '9.9.9'));
    const fetch = calls().filter((l) => l.includes('fetch'));
    expect(fetch).toHaveLength(1);
    expect(fetch[0]).toContain('-c core.hooksPath=/dev/null');
    expect(fetch[0]).toContain('-c core.fsmonitor=false');
    // A checkout whose .git/config names an ssh command: no fetch, and said why.
    rmSync(join(home, 'calls'));
    writeFileSync(join(bin, 'git'), GIT.replace('case "$*" in', 'case "$*" in\n  *"config --local"*) printf \'core.sshcommand\\nid > /tmp/burrow-ran\\0\' ;;'));
    const r = parseCheck(sh(checkScript(dir, '9.9.9')));
    expect(calls().filter((l) => l.includes('fetch'))).toEqual([]);
    expect(r.problem).toMatch(/core\.sshcommand/);
    // The rest is still told.
    expect(r).toMatchObject({ mode: 'git', available: '9.9.10', behind: 3 });
  });
});

describe('an install on the prebuilt images', () => {
  // GitHub's releases of Burrow as its API gives them, newest first; each body is its CHANGELOG section.
  const releases = [
    { tag_name: 'v2.23.0-rc.1', name: 'Burrow 2.23.0-rc.1', body: '### Breaking\n\n- Not out yet.\n', prerelease: true },
    { tag_name: 'v2.22.0', name: 'Burrow 2.22.0', body: '### Breaking\n\n- BURROW_PORT is now PORT: change it\n  in your .env first.\n\n### Fixed\n\n- Not this one.\n', prerelease: false },
    { tag_name: 'v2.21.1', name: 'Burrow 2.21.1', body: '### Fixed\n\n- A fix.\n', prerelease: false },
    { tag_name: 'v2.21.0', name: 'Burrow 2.21.0', body: '### Breaking\n\n- Already running, not shown.\n', prerelease: false },
  ];
  let asked: string[] = [];
  const github = (status = 200) => (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify(releases), { status });
  }) as typeof fetch;
  // Each case later than the hour GitHub's answer is kept.
  let now = Date.parse('2026-12-01T00:00:00Z');
  const later = () => (now += 2 * 3600_000);

  it("tells the newest release on GitHub, its title and the breaking changes since the running one, not a pre-release's", async () => {
    asked = [];
    expect(await imageUpdate('2.21.0', { fetch: github(), now: later() })).toEqual({
      available: '2.22.0',
      subject: 'Burrow 2.22.0',
      breaking: ['2.22.0: BURROW_PORT is now PORT: change it in your .env first.'],
      problem: null,
    });
    expect(asked).toEqual(['https://api.github.com/repos/R31l4nd/Burrow/releases?per_page=100']);
    // The newest running: nothing newer, it is current.
    expect(await imageUpdate('2.22.0', { fetch: github(), now: later() })).toMatchObject({ available: '2.22.0', breaking: [], problem: null });
    // GitHub refusing: said, not "current".
    expect(await imageUpdate('2.21.0', { fetch: github(403), now: later() })).toMatchObject({ available: null, problem: expect.stringMatching(/GitHub limits/) });
  });

  it('tells the image it was started with, and the tag that reaches a newer version when its tag does not', () => {
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\n[ "$1 $2 $3" = "inspect -f {{.Config.Image}}" ] && [ "$4" = burrow ] && echo ghcr.io/r31l4nd/burrow:2.21\nexit 0\n');
    expect(parseCheck(sh(checkScript(dir, '2.21.0', 'burrow')))).toMatchObject({ mode: 'image', image: 'ghcr.io/r31l4nd/burrow:2.21' });
    // A minor line follows its fixes, not the next line; a whole version only itself; latest and a digest everything.
    expect(pinnedImage('ghcr.io/r31l4nd/burrow:2.21', '2.21.1')).toBeNull();
    expect(pinnedImage('ghcr.io/r31l4nd/burrow:2.21', '2.22.0')).toEqual({ image: 'ghcr.io/r31l4nd/burrow:2.21', next: 'ghcr.io/r31l4nd/burrow:2.22' });
    expect(pinnedImage('ghcr.io/r31l4nd/burrow:v2.21.0', '2.21.1')).toEqual({ image: 'ghcr.io/r31l4nd/burrow:v2.21.0', next: 'ghcr.io/r31l4nd/burrow:2.21.1' });
    expect(pinnedImage('localhost:5000/burrow:2.21', '3.0.0')).toEqual({ image: 'localhost:5000/burrow:2.21', next: 'localhost:5000/burrow:3.0' });
    expect(pinnedImage('ghcr.io/r31l4nd/burrow:latest', '2.22.0')).toBeNull();
    expect(pinnedImage('ghcr.io/r31l4nd/burrow@sha256:' + '0'.repeat(64), '2.22.0')).toBeNull();
    expect(pinnedImage('burrow:local', '2.22.0')).toBeNull();
    expect(pinnedImage(null, '2.22.0')).toBeNull();
  });
});

describe('which Burrow to update', () => {
  it('in a container: its own, never another Burrow; by hand: the only one', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { setFacts } = await import('../../src/hosts/service.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'u', authMethod: 'password', password: 'x' });
    setFacts(t.ctx, h.id, { hasDocker: true } as never);
    const box = (id: string, name: string, files: string) => ({ id, name, service: 'burrow', project: name, workingDir: `/srv/${name}`, configFiles: files });
    let containers = [box('other', 'burrow', '/srv/burrow/compose.yaml'), box('me', 'burrow2', '/srv/burrow2/compose.yaml,/srv/burrow2/override.yaml')];
    const docker = { recent: async () => ({ containers }) } as never;
    expect(await findTarget(t.ctx, docker, 'me')).toMatchObject({ container: 'burrow2', project: 'burrow2', configFiles: ['/srv/burrow2/compose.yaml', '/srv/burrow2/override.yaml'] });
    containers = [box('other', 'burrow', '')];
    expect(await findTarget(t.ctx, docker, 'me')).toBeNull();
    expect(await findTarget(t.ctx, docker, null)).toMatchObject({ container: 'burrow' });
    containers = [box('a', 'burrow', ''), { ...box('b', 'x', ''), project: 'burrow' }];
    expect(await findTarget(t.ctx, docker, null)).toBeNull();
    await t.close();
  });

  it('names every Burrow it finds, also when which one to update is not clear (none is chosen then)', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { setFacts } = await import('../../src/hosts/service.js');
    const t = await makeApp();
    await setupAdmin(t);
    const a = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'a', address: 'a.lan', username: 'u' });
    const b = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'b', address: 'b.lan', username: 'u' });
    for (const h of [a, b]) setFacts(t.ctx, h.id, { hasDocker: true } as never);
    const box = (id: string, name: string) => ({ id, name, service: 'burrow', project: name, workingDir: `/srv/${name}`, configFiles: '' });
    const on: Record<number, object[]> = { [a.id]: [box('x', 'burrow'), { id: 'web', name: 'web', service: 'web', project: 'app', workingDir: '/srv/app' }], [b.id]: [box('y', 'burrow'), box('me', 'burrow-test')] };
    const docker = { recent: async (id: number) => ({ containers: on[id] ?? [], error: null }) } as never;
    // By hand: two named "burrow", so none to update; all three are Burrow's.
    const byHand = await locateTarget(t.ctx, docker, null);
    expect(byHand.target).toBeNull();
    expect(byHand.installs).toEqual([{ hostId: a.id, dir: '/srv/burrow' }, { hostId: b.id, dir: '/srv/burrow' }, { hostId: b.id, dir: '/srv/burrow-test' }]);
    // In a container: its own to update, the others still named.
    const inBox = await locateTarget(t.ctx, docker, 'me');
    expect(inBox.target).toMatchObject({ hostId: b.id, dir: '/srv/burrow-test' });
    expect(inBox.installs).toHaveLength(3);
    await t.close();
  });

  it("tells \"not found\" from \"could not read\": the hosts whose containers could not be read are named", async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { setFacts } = await import('../../src/hosts/service.js');
    const t = await makeApp();
    await setupAdmin(t);
    const a = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'a', address: 'a.lan', username: 'u' });
    const b = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'b', address: 'b.lan', username: 'u' });
    const c = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'c', address: 'c.lan', username: 'u' });
    for (const h of [a, b, c]) setFacts(t.ctx, h.id, { hasDocker: true } as never);
    const mine = { id: 'me', name: 'burrow', service: 'burrow', project: 'burrow', workingDir: '/srv/burrow', configFiles: '' };
    let onC: object[] = [];
    // a: read, nothing of Burrow's; b: the read failed; c: read with an error said.
    const docker = {
      recent: async (id: number) => {
        if (id === b.id) throw new Error('ssh: timeout');
        return id === c.id ? { containers: onC, error: onC.length ? null : 'docker: permission denied' } : { containers: [], error: null };
      },
    } as never;
    expect(await locateTarget(t.ctx, docker, 'me')).toEqual({ target: null, installs: [], unreadable: [b.id, c.id] });
    expect(await findTarget(t.ctx, docker, 'me')).toBeNull();
    // Found: this one is updated; b is still named, another install may be there.
    onC = [mine];
    expect(await locateTarget(t.ctx, docker, 'me')).toMatchObject({ target: { hostId: c.id, dir: '/srv/burrow' }, installs: [{ hostId: c.id, dir: '/srv/burrow' }], unreadable: [b.id] });
    await t.close();
  });
});

describe('looking for Burrow on many hosts (OPS-W-11)', () => {
  it('reads the hosts at once, and keeps "not found" a while: the next visit reads none of them', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { setFacts } = await import('../../src/hosts/service.js');
    const t = await makeApp();
    await setupAdmin(t);
    for (let i = 0; i < 6; i++) {
      const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: `d${i}`, address: `d${i}.lan`, username: 'u' });
      setFacts(t.ctx, h.id, { hasDocker: true } as never);
    }
    let reads = 0;
    let atOnce = 0;
    let most = 0;
    t.docker.recent = async (hostId: number) => {
      reads++;
      most = Math.max(most, ++atOnce);
      await new Promise((r) => setTimeout(r, 30));
      atOnce--;
      return { hostId, hostName: '', containers: [], stats: {}, history: {}, error: null, at: '' };
    };
    const first = await t.json<{ problem: string }>('GET', '/api/system/update');
    expect(first.problem).toBe('not_found');
    expect([reads, most]).toEqual([6, 6]);
    expect((await t.json<{ problem: string }>('GET', '/api/system/update')).problem).toBe('not_found');
    expect(reads).toBe(6);
    // A while later, or with another host: looked for again.
    t.advance(6 * 60_000);
    await t.json('GET', '/api/system/update');
    expect(reads).toBe(12);
    await t.close();
  });
});
