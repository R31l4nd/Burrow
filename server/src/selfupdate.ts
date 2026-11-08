import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import type { LastUpdate, UpdateCheck, UpdateTarget } from '@burrow/shared';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import type { DockerMonitor } from './docker/monitor.js';
import { selfContainerId } from './docker/stacks.js';
import type { SftpPool } from './files/pool.js';
import { getHost, listHosts } from './hosts/service.js';
import { actor, HttpError } from './http.js';
import { exec, type ExecResult } from './ssh/connect.js';
import { shellQuote } from './ssh/quote.js';
import { git, UNSAFE_CONFIG_EXIT } from './workspace/git.js';

// Burrow updates itself: on the host where its own container runs (found by
// the compose labels, service "burrow"), in the compose project's folder.
// A git checkout pulls (when it has an upstream) and builds; otherwise the
// image is pulled. The backup service of the same project goes along (built
// or pulled, and started again once Burrow is healthy). The old image is kept
// as burrow-rollback:<container> first; when the
// new container is not healthy within two minutes, the old commit and image
// come back. The script runs detached from the SSH session, because Burrow
// itself restarts halfway; it leaves its state in ~/.burrow-update.json.

const SERVER_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const STATE = '"$HOME/.burrow-update.json"';

/** The commands that tell what an update would bring (read-only, apart from git fetch). */
export function checkScript(dir: string, running: string = SERVER_VERSION): string {
  return [
    `cd ${shellQuote(dir)} || exit 1`,
    `v() { sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' | head -1; }`,
    // The CHANGELOG's "### Breaking" items of every version after the running
    // one, one line each ("breaking 1.5.0: text"); a bullet's wrapped lines joined.
    // It stops at the first version not newer than the running one, also when
    // the running one is not named there (a build of one's own, a patch between).
    `cl() { awk -v run=${shellQuote(running)} 'function newer(a, b, x, y, i) { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) return 1; if (x[i] + 0 < y[i] + 0) return 0 } return 0 } /^## \\[/ { if (item != "") print "breaking " ver ": " item; item = ""; v = $2; gsub(/[][]/, "", v); if (v ~ /^[0-9]+[.][0-9]+[.][0-9]+$/ && !newer(v, run)) exit; ver = v; inb = 0; next } /^### / { if (item != "") print "breaking " ver ": " item; item = ""; inb = ($0 ~ /^### Breaking/); next } inb && /^- / { if (item != "") print "breaking " ver ": " item; item = substr($0, 3); next } inb && /^  +[^ ]/ { sub(/^ +/, ""); item = item " " $0; next } END { if (item != "") print "breaking " ver ": " item }'; }`,
    'if [ -d .git ]; then',
    '  echo "mode git"',
    '  if git rev-parse --abbrev-ref "@{u}" >/dev/null 2>&1; then',
    // The fetch as Burrow's git runs it (A3-SRV-04): nothing of the checkout's own config runs, and
    // one whose .git/config would run a command is not fetched at all (audit 2026-11-05).
    `    e=$( ( ${git(dir, ['fetch', '-q'])} ) 2>&1 >/dev/null ); c=$?`,
    `    if [ "$c" = ${UNSAFE_CONFIG_EXIT} ]; then echo "problem git fetch refused: the checkout's own config runs a command (\${e##*@@unsafe-config })"; elif [ "$c" != 0 ]; then echo "problem git fetch failed"; fi`,
    '    echo "behind $(git rev-list --count "HEAD..@{u}")"',
    '    echo "version $(git show "@{u}:server/package.json" 2>/dev/null | v)"',
    '    echo "subject $(git log -1 --format=%s "@{u}")"',
    '    git show "@{u}:CHANGELOG.md" 2>/dev/null | cl',
    '  else',
    '    echo "version $(v < server/package.json)"',
    '    echo "subject $(git log -1 --format=%s)"',
    '    [ -f CHANGELOG.md ] && cl < CHANGELOG.md',
    '  fi',
    'else echo "mode image"; fi',
    `[ -f ${STATE} ] && echo "last $(cat ${STATE})"`,
    'true',
  ].join('\n');
}

export function parseCheck(out: string): Omit<UpdateCheck, 'target' | 'running'> {
  const r: Omit<UpdateCheck, 'target' | 'running'> = { mode: null, available: null, behind: null, subject: null, last: null, problem: null, breaking: [] };
  for (const line of out.split('\n')) {
    const i = line.indexOf(' ');
    const [k, v] = i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1).trim()];
    if (k === 'mode' && (v === 'git' || v === 'image')) r.mode = v;
    else if (k === 'version') r.available = v || null;
    else if (k === 'behind') r.behind = Number.isFinite(Number(v)) && v !== '' ? Number(v) : null;
    else if (k === 'subject') r.subject = v || null;
    else if (k === 'problem') r.problem = v;
    else if (k === 'breaking' && v && r.breaking.length < 20) r.breaking.push(v.slice(0, 300));
    else if (k === 'last') {
      try {
        r.last = JSON.parse(v) as LastUpdate;
      } catch {
        // A half-written state: as if there were none.
      }
    }
  }
  return r;
}

/**
 * What the check said, and why it says little when it failed: a folder gone
 * (its cd) or a connection lost read as "nothing to tell" (audit 2026-11-05).
 */
export function readCheck(r: Pick<ExecResult, 'code' | 'stdout' | 'stderr'>): Omit<UpdateCheck, 'target' | 'running'> {
  const c = parseCheck(r.stdout);
  if (r.code !== 0) c.problem = r.stderr.trim().split('\n').pop()?.slice(0, 300) || (r.code === null ? 'The check ended without an exit code (the connection to the host was lost).' : `The check ended with exit code ${r.code}.`);
  return c;
}

/** The update itself, run on the host with sh. */
export function updateScript(t: { dir: string; container: string; service: string; project?: string | null; configFiles?: string[] }): string {
  const c = shellQuote(t.container);
  const s = shellQuote(t.service);
  // The old image kept under a name of its own: "<image>-rollback" was no
  // valid name for an image started by digest (AUDIT2 DO-14).
  const rb = shellQuote(`burrow-rollback:${t.container.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100) || 'burrow'}`);
  // The project and files this container was started with (-p, -f): an override file is not left out.
  const compose = ['docker compose', ...(t.project ? [`-p ${shellQuote(t.project)}`] : []), ...(t.configFiles ?? []).map((f) => `-f ${shellQuote(f)}`)].join(' ');
  return [
    'set -u',
    `cd ${shellQuote(t.dir)} || exit 1`,
    `st=${STATE}`,
    `dc() { ${compose} "$@"; }`,
    // A code for the page to say in its language; the message for the log.
    'state() { printf \'{"state":"%s","at":"%s","code":"%s","message":"%s"}\\n\' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" "$2" > "$st"; }',
    `healthy() { for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' ${c} 2>/dev/null)" = healthy ] && return 0; sleep 2; done; return 1; }`,
    // The old version back and seen running: its image (by id) in the container, and healthy.
    // Never pulled again on the way back: a pull policy fetched the bad image (AUDIT2 DO-15).
    // A name by digest needs no retag (it names the old image already).
    `restored() { [ -n "$prev" ] && { git reset -q --keep "$prev" || return 1; }; case "$img" in *@*) ;; *) docker image tag ${rb} "$img" || return 1 ;; esac; dc up -d --no-build --pull never ${s} && healthy && [ "$(docker inspect -f '{{.Image}}' ${c} 2>/dev/null)" = "$id" ]; }`,
    'state running "Updating" running',
    `img=$(docker inspect -f '{{.Config.Image}}' ${c}) || { state failed ${shellQuote(`The container ${t.container} was not found`)} not_found; exit 1; }`,
    // The running image by its id: the name may point at a newer build already.
    `id=$(docker inspect -f '{{.Image}}' ${c})`,
    `docker image tag "$id" ${rb} || { state failed "Could not keep the old image" keep_failed; exit 1; }`,
    // The backup service of this project (compose profile "backup"), when it
    // exists: built or pulled with Burrow, so its scripts and its list of
    // migrations are this Burrow's, and started again after Burrow when it
    // ran. Left behind, its restore refused every backup taken after an
    // update that added a migration, as "from a newer Burrow" (A3-OPS-05).
    'bk=""; dc ps -a --services 2>/dev/null | grep -qx backup && bk=backup',
    'bkrun=""; dc ps --status running --services 2>/dev/null | grep -qx backup && bkrun=1',
    'prev=""',
    'if [ -d .git ]; then',
    '  prev=$(git rev-parse HEAD)',
    '  if git rev-parse --abbrev-ref "@{u}" >/dev/null 2>&1; then git pull -q --ff-only || { state failed "git pull failed (local changes, or not a fast-forward)" pull_failed; exit 1; }; fi',
    // Today's packages for the backup image (its apk layer), not an old build's cache, as make deploy does (AUDIT OP-09).
    '  PKG_DATE=$(date +%F); export PKG_DATE',
    `  dc build -q ${s} $bk || { git reset -q --keep "$prev"; state failed "The build failed; nothing changed" build_failed; exit 1; }`,
    'else',
    `  dc pull -q ${s} || { state failed "docker compose pull failed; nothing changed" pull_failed; exit 1; }`,
    // A backup image built on this machine (no registry has it) cannot be pulled: then it stays as it is.
    '  [ -z "$bk" ] || dc pull -q backup >/dev/null 2>&1 || true',
    'fi',
    // The backup service again on its new image; says so when it does not start.
    'upbackup() { [ -z "$bkrun" ] || dc up -d --no-build backup; }',
    // The same image as the one running: nothing to restart, and said so.
    // Compared with the image compose wants now (the file may name another
    // version), not the old name: that still pointed at the running image
    // and said "nothing new" (AUDIT2 DO-14).
    `want=$(dc config --images ${s} 2>/dev/null | head -n 1); [ -n "$want" ] || want="$img"`,
    '[ "$(docker image inspect -f \'{{.Id}}\' "$want" 2>/dev/null)" = "$id" ] && { upbackup >/dev/null 2>&1 || { state done "Nothing new for Burrow, but its backup service did not start again: docker compose up -d backup on the host" backup_not_started; exit 0; }; state done "Nothing new: the running version is current" nothing_new; exit 0; }',
    // A backup first, when the backup service runs (as make deploy does).
    'if [ -n "$bkrun" ]; then dc run --rm backup /app/scripts/backup/backup.sh >/dev/null 2>&1 || { state failed "The backup before the update failed; nothing changed" backup_failed; exit 1; }; fi',
    // Compose could not start it (a port taken, a bad .env), maybe after
    // stopping the old one: the old version back, and only said when seen.
    `dc up -d --no-build ${s} || { if restored; then state failed "docker compose up failed; the old version runs again" up_failed; else state failed "docker compose up failed, and the old version did not come back" both_unhealthy; fi; exit 1; }`,
    // Healthy, and the new image is the one running (not the old one still).
    `if healthy && [ "$(docker inspect -f '{{.Image}}' ${c} 2>/dev/null)" != "$id" ]; then upbackup || { state done "Updated, but the backup service did not start again: docker compose up -d backup on the host" backup_not_started; exit 0; }; state done "Updated" updated; exit 0; fi`,
    // Not healthy: the old commit and image back.
    'if restored; then state rolledback "The new version did not become healthy; the old one runs again" rolled_back; else state failed "The new version did not become healthy, and neither did the old one" both_unhealthy; exit 1; fi',
  ].join('\n');
}

/**
 * Starts the update detached, one at a time on the host: a lock folder
 * taken in one step (mkdir), with the update's process id in it, freed when
 * it ends. A lock whose process is gone and that is older than a minute was
 * left behind and is taken. The state file's "running" with a 15-minute
 * expiry let two updates overlap (AUDIT2 DO-16). Prints @@busy when held.
 */
export function launchScript(t: Parameters<typeof updateScript>[0]): string {
  const run = `echo $$ > "$HOME/.burrow-update.lock/pid"; sh -c ${shellQuote(updateScript(t))}; rm -rf "$HOME/.burrow-update.lock"`;
  return [
    // A folder that is gone fails here, before the lock and the state (AUDIT2 DO-17).
    `[ -d ${shellQuote(t.dir)} ] || { echo @@nodir; exit 1; }`,
    'l="$HOME/.burrow-update.lock"',
    'if ! mkdir "$l" 2>/dev/null; then',
    '  p=$(cat "$l/pid" 2>/dev/null)',
    '  if { [ -n "$p" ] && kill -0 "$p" 2>/dev/null; } || [ -z "$(find "$l" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then echo @@busy; exit 0; fi',
    '  rm -rf "$l"; mkdir "$l" 2>/dev/null || { echo @@busy; exit 0; }',
    'fi',
    // setsid where there is one: the update outlives this session either way (nohup).
    'if command -v setsid >/dev/null 2>&1; then d="setsid nohup"; else d="nohup"; fi',
    `$d sh -c ${shellQuote(run)} </dev/null >/dev/null 2>&1 &`,
    // Started is what the update says itself (its process id in the lock), not that a background job was forked.
    'i=0; while [ ! -s "$l/pid" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
    'if [ -s "$l/pid" ]; then echo @@started; else rm -rf "$l"; echo @@nostart; exit 1; fi',
  ].join('\n');
}

/**
 * Burrow's own container: in a container, the one this process runs in (by
 * its id), never another Burrow; with its project and compose files. Not in
 * a container (run by hand): the one container of service "burrow" there
 * is; several: none. `installs`: the compose folder of every Burrow found
 * (service "burrow", this one among them), which the file access guard
 * closes to operators whichever is this one. `unreadable`: the hosts with
 * Docker whose containers could not be read, where one may be all the same
 * (the guard refuses there, A3-SRV-01).
 */
export async function locateTarget(ctx: Ctx, docker: DockerMonitor, me: string | null = selfContainerId()): Promise<{ target: UpdateTarget | null; installs: { hostId: number; dir: string }[]; unreadable: number[] }> {
  const candidates: UpdateTarget[] = [];
  const installs: { hostId: number; dir: string }[] = [];
  const unreadable: number[] = [];
  let own: UpdateTarget | null = null;
  // All hosts at once: one after another took 3 s for 51 hosts, and a hung one added its timeout (OPS-W-11).
  const dockerHosts = listHosts(ctx).filter((h) => h.facts?.hasDocker);
  const read = await Promise.all(dockerHosts.map((h) => docker.recent(h.id, 120_000).catch(() => null)));
  for (const [i, h] of dockerHosts.entries()) {
    const r = read[i];
    if (!r || r.error) unreadable.push(h.id);
    for (const c of r?.containers ?? []) {
      if (!c.workingDir) continue;
      if (c.service === 'burrow' || (me && c.id === me)) {
        if (!installs.some((x) => x.hostId === h.id && x.dir === c.workingDir)) installs.push({ hostId: h.id, dir: c.workingDir });
      }
      const mine = me ? c.id === me : c.service === 'burrow' && (c.name === 'burrow' || c.project === 'burrow');
      if (!mine) continue;
      const t: UpdateTarget = { hostId: h.id, hostName: h.name, dir: c.workingDir, container: c.name, service: c.service ?? 'burrow', project: c.project, configFiles: (c.configFiles ?? '').split(',').map((f) => f.trim()).filter(Boolean) };
      if (me) own ??= t;
      else candidates.push(t);
    }
  }
  return { target: me ? own : candidates.length === 1 ? candidates[0]! : null, installs, unreadable };
}

/** Burrow's own container, or null when it was not found (also when a host could not be read). */
export async function findTarget(ctx: Ctx, docker: DockerMonitor, me: string | null = selfContainerId()): Promise<UpdateTarget | null> {
  return (await locateTarget(ctx, docker, me)).target;
}

/** How long "Burrow's own container was not found" holds before the hosts are read again. */
const NOT_FOUND_MS = 5 * 60_000;

/** Burrow's own update check, for the routes and the self-watch: null when its container is not found. */
export interface SelfUpdates {
  check(): Promise<UpdateCheck | null>;
}

export function registerSelfUpdateRoutes(app: FastifyInstance, ctx: Ctx, docker: DockerMonitor, pool: SftpPool): SelfUpdates {
  let target: UpdateTarget | null = null;
  // Not found is kept a while too (for the same hosts): every visit of Settings read every Docker host again (OPS-W-11).
  let missed: { at: number; hosts: string } | null = null;
  const hostsKey = () => listHosts(ctx).map((h) => h.id).join(',');
  const locate = async () => {
    if (target && listHosts(ctx).some((h) => h.id === target!.hostId)) return target;
    if (missed && ctx.now() - missed.at < NOT_FOUND_MS && missed.hosts === hostsKey()) return null;
    target = await findTarget(ctx, docker);
    missed = target ? null : { at: ctx.now(), hosts: hostsKey() };
    return target;
  };

  const checkNow = async (): Promise<UpdateCheck | null> => {
    const t = await locate();
    if (!t) return null;
    const r = await pool.with(t.hostId, ({ client }) => exec(client, checkScript(t.dir), 60_000));
    return { target: t, running: SERVER_VERSION, ...readCheck(r) };
  };

  app.get('/api/system/update', async (): Promise<UpdateCheck> => {
    return (await checkNow()) ?? { target: null, running: SERVER_VERSION, mode: null, available: null, behind: null, subject: null, last: null, problem: 'not_found', breaking: [] };
  });

  // Replaces what runs everything: confirmed as the person first (AUDIT2 AUTH-09).
  app.post('/api/system/update', { config: { stepUp: true } }, async (req) => {
    // Found again: the update goes to the container that is Burrow now.
    target = null;
    missed = null;
    const t = await locate();
    if (!t) throw new HttpError(409, 'not_found', "Burrow's own container was not found on any host.");
    const host = getHost(ctx, t.hostId);
    const check = parseCheck((await pool.with(t.hostId, ({ client }) => exec(client, checkScript(t.dir), 60_000))).stdout);
    // Detached: the session ends at once, the script outlives Burrow's restart; one at a time (the lock).
    const r = await pool.with(t.hostId, ({ client }) => exec(client, launchScript(t), 20_000));
    if (r.stdout.includes('@@busy')) throw new HttpError(409, 'update_running', 'An update is already running.');
    if (r.stdout.includes('@@nodir')) throw new HttpError(409, 'not_found', `Burrow's folder ${t.dir} is not on ${host.name} any more.`);
    if (r.stdout.includes('@@nostart')) throw new HttpError(502, 'update_failed', 'The update did not start on the host.');
    if (r.code !== 0 || !r.stdout.includes('@@started')) throw new HttpError(502, 'update_failed', (r.stderr || r.stdout).trim() || `exit ${r.code}`);
    audit(ctx, actor(req), 'burrow.update', host.name, { from: SERVER_VERSION, to: check.available, dir: t.dir });
    return { started: true, from: SERVER_VERSION };
  });
  return { check: checkNow };
}
