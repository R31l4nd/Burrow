import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitLine, fileCommand, zoneLine, journalCommand, journalText, OUTPUT_MARK, LineSplitter, logsCommand, logsScript, mountedPath, scriptLine, scriptLines, sinceLine, timeArgMs } from '../../src/docker/logs.js';
import { EXIT_NO_LIST, EXIT_NO_STATS, MONITOR_COMMAND, parseMonitor, parseSize, STATE_COMMAND } from '../../src/docker/parse.js';
import { parseTargets } from '../../src/docker/routes.js';

// Captured from docker 29 (inspect with our template, then docker stats);
// the second container has no healthcheck (no Health in its State).
const OUT = `{"id":"3597dcf4","name":"/burrow","image":"burrow:local","state":{"Status":"running","Running":true,"ExitCode":0,"OOMKilled":false,"StartedAt":"2026-09-27T07:25:25.809867786Z","FinishedAt":"0001-01-01T00:00:00Z","Health":{"Status":"healthy","FailingStreak":0}},"restarts":0,"created":"2026-09-27T07:25:25.6205763Z","labels":{"com.docker.compose.project":"burrow","com.docker.compose.service":"burrow","com.docker.compose.project.config_files":"/data/Burrow/compose.yaml"}}
{"id":"82b8df4c","name":"/old","image":"alpine","state":{"Status":"exited","Running":false,"ExitCode":137,"OOMKilled":true,"StartedAt":"2026-09-26T12:52:10.783170512Z","FinishedAt":"2026-09-26T13:00:00Z"},"restarts":3,"created":"2026-09-26T12:52:10.237749543Z","labels":null}
@@burrow-stats
{"BlockIO":"1.71MB / 32.8kB","CPUPerc":"1.21%","Container":"3597dcf4","ID":"3597dcf4","MemPerc":"0.27%","MemUsage":"87.32MiB / 31.1GiB","Name":"burrow","NetIO":"13.5kB / 10.2kB","PIDs":"18"}
`;

describe('reading containers', () => {
  it('parses inspect and stats output', () => {
    const { containers, stats } = parseMonitor(OUT);
    expect(containers.map((c) => c.name)).toEqual(['burrow', 'old']);
    expect(containers[0]).toMatchObject({ state: 'running', health: 'healthy', project: 'burrow', service: 'burrow', configFiles: '/data/Burrow/compose.yaml', finishedAt: null });
    expect(containers[1]).toMatchObject({ state: 'exited', health: null, restarts: 3, exitCode: 137, oomKilled: true, project: null });
    expect(stats.get('3597dcf4')).toEqual({ cpu: 1.21, memBytes: Math.round(87.32 * 1024 ** 2), memLimitBytes: Math.round(31.1 * 1024 ** 3) });
  });

  it("memory a host does not measure (a Raspberry Pi without the memory cgroup: 0B / 0B) is unknown, not 0 KB (the live Burrow's Pi)", () => {
    const pi = `@@burrow-stats\n{"CPUPerc":"0.40%","ID":"a1","MemUsage":"0B / 0B"}\n{"CPUPerc":"0.10%","ID":"b2","MemUsage":"0B / 1.8GiB"}\n`;
    const { stats } = parseMonitor(pi);
    expect(stats.get('a1')).toEqual({ cpu: 0.4, memBytes: 0, memLimitBytes: 0, memKnown: false });
    expect(stats.get('b2')?.memKnown).toBeUndefined();
  });

  it("the version a container runs, from its image's own label (report eaa986)", () => {
    const line = (labels: Record<string, string> | null) => `{"id":"1","name":"/t","image":"x","state":{"Status":"running"},"restarts":0,"created":"","labels":${JSON.stringify(labels)}}`;
    expect(parseMonitor(`${line({ 'org.opencontainers.image.version': 'v3.3.0' })}\n@@burrow-stats\n`).containers[0]?.version).toBe('v3.3.0');
    expect(parseMonitor(`${line(null)}\n@@burrow-stats\n`).containers[0]?.version).toBeNull();
  });

  it('marks containers labelled burrow.ignore=true', () => {
    const line = `{"id":"1","name":"/t","image":"alpine","state":{"Status":"exited","ExitCode":1},"restarts":0,"created":"","labels":{"burrow.ignore":"true"}}`;
    expect(parseMonitor(`${line}\n@@burrow-stats\n`).containers[0]?.ignored).toBe(true);
    expect(parseMonitor(OUT).containers.map((c) => c.ignored)).toEqual([false, false]);
  });

  it('a docker that cannot be read is a failure, not a host without containers', () => {
    // A stand-in docker: MODE says what fails.
    const dir = mkdtempSync(join(tmpdir(), 'burrow-docker-'));
    writeFileSync(
      join(dir, 'docker'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  ps) [ "$MODE" = ps ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }; echo c1; [ "$MODE" = gone ] && [ -e "$DIR/once" ] || echo c2; exit 0 ;;',
        '  inspect) if [ "$MODE" = gone ] && [ ! -e "$DIR/once" ]; then touch "$DIR/once"; echo "Error: No such object: c2" >&2; exit 1; fi; [ "$MODE" = partial ] && [ ! -e "$DIR/half" ] && { touch "$DIR/half"; echo \'{"id":"c1","name":"/a","image":"x","state":{"Status":"running"},"restarts":0,"created":"","labels":null}\'; exit 1; }; echo \'{"id":"c1","name":"/a","image":"x","state":{"Status":"running"},"restarts":0,"created":"","labels":null}\'; exit 0 ;;',
        '  stats) [ "$MODE" = stats ] && exit 1; exit 0 ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(join(dir, 'docker'), 0o755);
    const run = (cmd: string, mode: string) => {
      try {
        return { code: 0, out: execFileSync('sh', ['-c', cmd], { env: { PATH: `${dir}:/usr/bin:/bin`, MODE: mode, DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
      } catch (err) {
        const e = err as { status: number; stdout: string };
        return { code: e.status, out: e.stdout };
      }
    };
    expect(run(STATE_COMMAND, 'ps').code).toBe(EXIT_NO_LIST);
    expect(run(MONITOR_COMMAND, 'ps').code).toBe(EXIT_NO_LIST);
    // Only the stats sample failed: the list stands.
    const stats = run(MONITOR_COMMAND, 'stats');
    expect(stats.code).toBe(EXIT_NO_STATS);
    expect(parseMonitor(stats.out).containers.map((c) => c.id)).toEqual(['c1']);
    // A container removed between ps and inspect: read again, fine.
    const gone = run(STATE_COMMAND, 'gone');
    expect(gone.code).toBe(0);
    expect(parseMonitor(gone.out).containers.map((c) => c.id)).toEqual(['c1']);
    // A first try that printed half, then failed: the retry's list alone, each container once (AUDIT2 DO-10).
    const half = run(STATE_COMMAND, 'partial');
    expect(half.code).toBe(0);
    expect(half.out.split('\n').filter((l) => l.startsWith('{')).length).toBe(1);
    expect(parseMonitor(`${half.out}${half.out.split('@@burrow-stats')[0]}@@burrow-stats\n`).containers.map((c) => c.id)).toEqual(['c1']);
  });

  it('reads sizes in both unit systems', () => {
    expect(parseSize('512B')).toBe(512);
    expect(parseSize('1.5KiB')).toBe(1536);
    expect(parseSize('1.71MB')).toBe(1_710_000);
    expect(parseSize('nonsense')).toBe(0);
  });
});

describe('logs', () => {
  it('a long line goes through the shared pipe in parts small enough not to mix with another source, and comes out whole (review 2026-10-24)', () => {
    const long = 'x'.repeat(2500) + 'é'.repeat(1500) + 'end';
    const script = logsScript([
      { i: 0, command: `printf '%s\\n' '${long}'` },
      { i: 1, command: "printf 'short\\n'" },
    ]);
    const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' });
    // No part longer than a pipe writes at once (4096 bytes).
    for (const raw of out.split('\n')) expect(Buffer.byteLength(raw) + 1).toBeLessThanOrEqual(4096);
    const read = scriptLines();
    const got = out.split('\n').filter(Boolean).map(read).filter((l) => l && 'text' in l);
    expect(got).toContainEqual({ i: 0, s: 'o', text: long });
    expect(got).toContainEqual({ i: 1, s: 'o', text: 'short' });
  });

  it('a followed container restarted or made anew is followed on, from where it went; one that stays down ends (review 2026-10-24)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-follow-'));
    try {
      // The first docker logs ends (the container restarts); inspect says it runs again; the second is followed from then, and fails.
      writeFileSync(join(dir, 'docker'), `#!/bin/sh
n=$(cat "${'$'}D/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${'$'}D/n"
case "$1" in
  inspect) echo running ;;
  logs) if [ $n -eq 1 ]; then echo "first $*"; exit 0; fi; echo "again $*"; exit 3 ;;
esac
`);
      chmodSync(join(dir, 'docker'), 0o755);
      const r = spawnSync('sh', ['-c', logsCommand('web', { since: null, until: null, tail: 5, follow: true })], { env: { PATH: `${dir}:/usr/bin:/bin`, D: dir }, encoding: 'utf8' });
      const lines = r.stdout.trim().split('\n');
      expect(lines[0]).toBe('first logs -t --tail 5 -f -- web');
      expect(lines[1]).toMatch(/^again logs -t --since \d+(\.\d+)? -f -- web$/);
      expect(r.status).toBe(3);
      // Not followed: one docker logs, its end is the end.
      rmSync(join(dir, 'n'));
      expect(spawnSync('sh', ['-c', logsCommand('web', { since: null, until: null, tail: 5, follow: false })], { env: { PATH: `${dir}:/usr/bin:/bin`, D: dir }, encoding: 'utf8' }).stdout.trim()).toBe('first logs -t --tail 5 -- web');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a safe docker logs command', () => {
    expect(logsCommand('radarr', { since: '15m', until: null, tail: 200, follow: false })).toBe('docker logs -t --tail 200 --since 15m -- radarr');
    expect(logsCommand('radarr', { since: '15m', until: null, tail: 200, follow: true })).toMatch(/^docker logs -t --tail 200 --since 15m -f -- radarr;/);
    expect(() => logsCommand('x; rm -rf /', { since: null, until: null, tail: 1, follow: false })).toThrow();
    // Many containers in one channel: every line marked with whose and which stream.
    const o5 = { since: null, until: null, tail: 5, follow: true };
    const script = logsScript([{ i: 0, command: logsCommand('web', o5) }, { i: 7, command: logsCommand('db', o5) }]);
    expect(script).toContain("{ docker logs -t --tail 5 -f -- web; R=$?;");
    expect(script).toContain("(exit $R); } 2>&1 1>&3; echo \"@@burrow-exit $?\"; } | p '0 e'");
    expect(script).toContain("| p '7 o'; } 4>&1; echo '7 x' ) &");
    expect(scriptLine('7 o 2026-09-29T08:00:00.000000000Z GET / 200')).toEqual({ i: 7, s: 'o', text: '2026-09-29T08:00:00.000000000Z GET / 200' });
    expect(scriptLine('0 e ')).toEqual({ i: 0, s: 'e', text: '' });
    expect(scriptLine('3 x')).toEqual({ i: 3, end: true });
    expect(scriptLine('garbage')).toBeNull();
  });

  it('"since start" of many containers at once: each from its own last start, one never started or gone without a since (report c8d284)', () => {
    // A stand-in docker: inspect says each container's start, logs says what it was asked.
    const dir = mkdtempSync(join(tmpdir(), 'burrow-logs-'));
    try {
      writeFileSync(
        join(dir, 'docker'),
        ['#!/bin/sh', 'for c; do n=$c; done', 'case "$1 $n" in', '"inspect web") echo 2026-10-14T10:00:00.123456789Z ;;', '"inspect db") echo 2026-10-01T08:00:00Z ;;', '"inspect new") echo 0001-01-01T00:00:00Z ;;', '"inspect "*) echo "Error: No such object: $n" >&2; exit 1 ;;', '"logs "*) echo "2026-10-14T12:00:00.000000000Z $*" ;;', 'esac', ''].join('\n'),
        { mode: 0o755 },
      );
      const o = { since: 'start', until: null, tail: 5000, follow: false };
      const names = ['web', 'db', 'new', 'gone'];
      const out = execFileSync('sh', ['-c', logsScript(names.map((n, i) => ({ i, command: logsCommand(n, o) })))], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
      const said = (i: number) => out.split('\n').filter((l) => l.startsWith(`${i} o `)).map((l) => l.replace(/^\d o \S+ /, ''));
      expect(said(0)).toEqual(['logs -t --tail 5000 --since 2026-10-14T10:00:00.123456789Z -- web']);
      expect(said(1)).toEqual(['logs -t --tail 5000 --since 2026-10-01T08:00:00Z -- db']);
      expect(said(2)).toEqual(['logs -t --tail 5000 -- new']);
      expect(said(3)).toEqual(['logs -t --tail 5000 -- gone']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // A unit's journal: since the unit last started, else this boot; a log file: its container's start or the host's boot said first.
    const j = journalCommand('cron.service', { since: 'start', until: null, tail: 50, follow: true });
    expect(j).toContain("S=$(systemctl show -p ActiveEnterTimestamp --timestamp=unix --value -- 'cron.service' 2>/dev/null); case \"$S\" in @[0-9]*) B=\"--since $S\" ;; *) B=-b ;; esac;");
    expect(j).toContain("-u 'cron.service' -n 50 $B -f");
    const host = spawnSync('sh', ['-c', fileCommand({ container: '', file: '/etc/hostname' }, null, { since: 'start', until: null, tail: 1, follow: false })], { encoding: 'utf8' }).stdout.split('\n');
    expect(sinceLine(host[0]!)).toBeGreaterThan(Date.UTC(2000, 0, 1));
    expect(fileCommand({ container: 'web', file: '/app/a.log' }, null, { since: 'start', until: null, tail: 1, follow: false })).toMatch(/^S=\$\(docker inspect --format '\{\{\.State\.StartedAt\}\}' -- web 2>\/dev\/null\); .* echo "@@burrow-since \$S"; docker exec -- web /);
    expect(sinceLine('@@burrow-since 2026-10-14T10:00:00.123456789Z')).toBe(Date.UTC(2026, 9, 14, 10, 0, 0, 123));
    expect(sinceLine('@@burrow-since @1791459900')).toBe(1791459900_000);
    expect(sinceLine('@@burrow-since ')).toBeNull();
    expect(sinceLine('@@burrow-since @')).toBeNull();
    expect(sinceLine('2026-10-14 an ordinary line')).toBeUndefined();
  });

  it('keeps every line whole when stdout and stderr of several containers come at once', () => {
    // A stand-in docker that writes a burst to both streams, run by this
    // machine's own sh and awk (mawk on Debian wrote each piece of a line
    // on its own, and the lines of the two streams ran into each other).
    const dir = mkdtempSync(join(tmpdir(), 'burrow-logs-'));
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nfor c; do n=$c; done\ni=0; while [ $i -lt 300 ]; do i=$((i+1)); echo "2026-09-29T08:00:00.$i""Z out $n $i"; echo "2026-09-29T08:00:00.$i""Z err $n $i" >&2; done\n');
    chmodSync(join(dir, 'docker'), 0o755);
    const o300 = { since: null, until: null, tail: 300, follow: false };
    const script = logsScript([{ i: 0, command: logsCommand('web', o300) }, { i: 1, command: logsCommand('db', o300) }]);
    const out = execFileSync('sh', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', maxBuffer: 16 << 20 });
    const lines = out.trimEnd().split('\n').map(scriptLine);
    // Each source's exit status comes last on its stderr (AUDIT2 DO-19).
    const exits = lines.filter((l) => l && !('end' in l) && exitLine(l.text) !== null);
    expect(exits.map((l) => l && !('end' in l) && exitLine(l.text))).toEqual([0, 0]);
    expect(lines).toHaveLength(2 * 2 * 300 + 2 + 2);
    for (const l of lines) {
      expect(l).not.toBeNull();
      if (l && !('end' in l) && exitLine(l.text) === null) expect(l.text).toMatch(new RegExp(`Z ${l.s === 'o' ? 'out' : 'err'} ${l.i === 0 ? 'web' : 'db'} \\d+$`));
    }
  });

  it("a unit's journal: journalctl -u with its window; never a container's, never an odd name", () => {
    const o = { since: '15m', until: null, tail: 200, follow: true };
    const cmd = journalCommand('wg-quick@wg0.service', o, Date.UTC(2026, 9, 8, 12, 0, 0));
    expect(cmd).toContain("$J -q --no-pager -o short-iso-precise -u 'wg-quick@wg0.service' -n 200 --since @1791459900 -f");
    expect(fileCommand({ container: '', file: 'journal:cron.service' }, null, { ...o, since: null, follow: false })).toMatch(/\$J -q --no-pager -o short-iso-precise -u 'cron.service' -n 200 \)$/);
    expect(() => fileCommand({ container: 'web', file: 'journal:cron.service' }, null, o)).toThrow();
    expect(() => journalCommand("x';reboot", o)).toThrow();
    expect(journalText('nas cron[812]: (root) CMD (run-parts)')).toBe('cron[812]: (root) CMD (run-parts)');
  });

  it("a journal line drops its unit's own name (the label says it already), but keeps another's (systemd about the unit)", () => {
    expect(journalText('nas cron[812]: (root) CMD (run-parts)', 'cron.service')).toBe('(root) CMD (run-parts)');
    expect(journalText('nas burrowtest-app.service[100]: listening on :8080', 'burrowtest-app.service')).toBe('listening on :8080');
    expect(journalText('nas systemd[1]: Started cron.service.', 'cron.service')).toBe('systemd[1]: Started cron.service.');
    expect(journalText('nas wg-quick[90]: [#] ip link add wg0', 'wg-quick@wg0.service')).toBe('[#] ip link add wg0');
  });

  it("a unit's journal that cannot be read says why, never just nothing: no journalctl, no such unit, no permission; a narrow sudo and a removed unit's entries still read", () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-journal-'));
    const bin = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const run = (unit: string, env: Record<string, string> = {}) => {
      const r = spawnSync('sh', ['-c', journalCommand(unit, { since: null, until: null, tail: 5, follow: false })], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env }, encoding: 'utf8' });
      return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
    };
    try {
      expect(run('cron.service')).toMatchObject({ code: 1, err: 'burrow-journal: journalctl is not on this host (no systemd journal)' });
      // As the real one: outside the journal's groups a hint and no lines; entries for cron and for a removed unit.
      bin('journalctl', ['if [ -z "$READER" ]; then echo "Hint: You are currently not seeing messages from other users and the system." >&2; exit 0; fi', 'case "$*" in *cron.service*) echo "2026-10-08T12:00:00.000000+0000 nas cron[1]: hello" ;; *old.service*) echo "2026-10-01T12:00:00.000000+0000 nas old[1]: last words" ;; esac'].join('\n'));
      bin('systemctl', '[ "$3" = cron.service ]');
      // sudo that may run journalctl only (a narrow sudoers line), when SUDO_JOURNAL is set.
      bin('sudo', '[ "$1" = -n ] && [ "$2" = journalctl ] && [ -n "$SUDO_JOURNAL" ] || exit 1; shift; READER=1 exec "$@"');
      expect(run('cron.service')).toMatchObject({ code: 1, err: expect.stringMatching(/^burrow-journal: no permission to read the journal/) });
      expect(run('cron.service', { SUDO_JOURNAL: '1' })).toMatchObject({ code: 0, out: '2026-10-08T12:00:00.000000+0000 nas cron[1]: hello' });
      expect(run('cron.service', { READER: '1' })).toMatchObject({ code: 0, out: '2026-10-08T12:00:00.000000+0000 nas cron[1]: hello' });
      // Gone from systemd, still in the journal: read (AUDIT2 J-04). Never there: said.
      expect(run('old.service', { READER: '1' })).toMatchObject({ code: 0, out: '2026-10-01T12:00:00.000000+0000 nas old[1]: last words' });
      expect(run('gone.service', { READER: '1' })).toMatchObject({ code: 1, err: 'burrow-journal: no unit gone.service on this host, and nothing in the journal for it' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a log file that is a link to the container's own output (/dev/stderr, as nginx's images ship) says so, rather than hanging until it counts as unreadable (report 71d6c5)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-logfile-'));
    try {
      symlinkSync('/dev/stderr', join(dir, 'error.log'));
      writeFileSync(join(dir, 'app.log'), 'one\ntwo\n');
      const o = { since: null, until: null, tail: 5, follow: false };
      const run = (cmd: string) => spawnSync('sh', ['-c', cmd.replace(/^docker exec -- web /, '')], { encoding: 'utf8', timeout: 5000 });
      for (const container of ['', 'web']) {
        const out = run(fileCommand({ container, file: join(dir, 'error.log') }, null, o));
        expect(out.status).toBe(0);
        expect(out.stdout.trim()).toBe(OUTPUT_MARK);
        // First the zone of where the file is, for its times without one (AUDIT2 AI-12).
        expect(run(fileCommand({ container, file: join(dir, 'app.log') }, null, o)).stdout).toMatch(/^@@burrow-zone [+-]\d{4}\none\ntwo\n$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a container's file under a mount this user cannot read on the host (a Docker volume, not root): read inside the container (AUDIT2 DO-18)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-logfile-'));
    try {
      writeFileSync(join(dir, 'inside.log'), 'inside\n');
      writeFileSync(join(dir, 'host.log'), 'host\n');
      const o = { since: null, until: null, tail: 5, follow: false };
      const run = (cmd: string) => spawnSync('sh', ['-c', cmd.replace('docker exec -- web ', '')], { encoding: 'utf8', timeout: 5000 }).stdout.split('\n').slice(1).join('\n');
      expect(run(fileCommand({ container: 'web', file: join(dir, 'inside.log') }, { path: join(dir, 'host.log'), root: dir }, o))).toBe('host\n');
      expect(run(fileCommand({ container: 'web', file: join(dir, 'inside.log') }, { path: join(dir, 'unreadable', 'host.log'), root: dir }, o))).toBe('inside\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a container's file under a mount that is a link out of the mount (to the SSH user's keys): never read on the host, only inside the container (audit 2026-10-30)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-logfile-'));
    try {
      mkdirSync(join(dir, 'mount'));
      writeFileSync(join(dir, 'inside.log'), 'inside\n');
      writeFileSync(join(dir, 'secret'), 'host secret\n');
      writeFileSync(join(dir, 'mount', 'real.log'), 'real\n');
      symlinkSync(join(dir, 'secret'), join(dir, 'mount', 'app.log'));
      symlinkSync('real.log', join(dir, 'mount', 'current.log'));
      const o = { since: null, until: null, tail: 5, follow: false };
      const run = (cmd: string) => spawnSync('sh', ['-c', cmd.replace('docker exec -- web ', '')], { encoding: 'utf8', timeout: 5000 }).stdout.split('\n').slice(1).join('\n');
      expect(run(fileCommand({ container: 'web', file: join(dir, 'inside.log') }, { path: join(dir, 'mount', 'app.log'), root: join(dir, 'mount') }, o))).toBe('inside\n');
      // A link that stays inside the mount (a rotated log's "current"): read on the host as before.
      expect(run(fileCommand({ container: 'web', file: join(dir, 'inside.log') }, { path: join(dir, 'mount', 'current.log'), root: join(dir, 'mount') }, o))).toBe('real\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the zone line of a log file: its zone, '' when date could not say, null for any other line (AUDIT2 AI-12)", () => {
    expect(zoneLine('@@burrow-zone +0200')).toBe('+0200');
    expect(zoneLine('@@burrow-zone ')).toBe('');
    expect(zoneLine('2026-10-04 10:00:00 @@burrow-zone +0200')).toBeNull();
  });

  it('a log file: tail on the host, through the host side of a mount, or inside the container', () => {
    const o = { since: null, until: null, tail: 200, follow: true };
    expect(fileCommand({ container: '', file: "/var/log/it's.log" }, null, o)).toContain("exec tail -n 200 -F -- \"$1\"' sh '/var/log/it'\\''s.log'");
    expect(fileCommand({ container: 'web', file: '/app/logs/a.log' }, { path: '/srv/web/logs/a.log', root: '/srv/web' }, o)).toMatch(/^R=\$\(readlink -f -- '\/srv\/web\/logs\/a\.log' 2>\/dev\/null\); M=\$\(readlink -f -- '\/srv\/web' 2>\/dev\/null\); .*then sh -c '.*' sh "\$R"; else docker exec -- web sh -c '.*' sh '\/app\/logs\/a\.log'; fi$/);
    expect(fileCommand({ container: 'web', file: '/app/logs/a.log' }, null, { ...o, follow: false })).toMatch(/^docker exec -- web sh -c '.*exec tail -n 200 -- "\$1"' sh '\/app\/logs\/a\.log'$/);
    expect(() => fileCommand({ container: 'x;id', file: '/a' }, null, o)).toThrow();
    expect(() => fileCommand({ container: '', file: 'relative.log' }, null, o)).toThrow();
    // The deepest mount that holds the path; a path beside a mount is not under it.
    const mounts = [
      { Source: '/srv/web', Destination: '/app' },
      { Source: '/srv/web-logs/', Destination: '/app/logs/' },
      { Source: '/srv/x', Destination: '/applications' },
    ];
    expect(mountedPath(mounts, '/app/logs/a.log')).toEqual({ path: '/srv/web-logs/a.log', root: '/srv/web-logs' });
    expect(mountedPath(mounts, '/app/config.yml')).toEqual({ path: '/srv/web/config.yml', root: '/srv/web' });
    expect(mountedPath(mounts, '/app')).toEqual({ path: '/srv/web', root: '/srv/web' });
    expect(mountedPath(mounts, '/apparel/a.log')).toBeNull();
    expect(mountedPath([{ Destination: '/data' }], '/data/a.log')).toBeNull();
    // --since/--until for a file's lines.
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(timeArgMs('15m', now)).toBe(now - 15 * 60_000);
    expect(timeArgMs('2026-10-04T10:00:00Z', now)).toBe(Date.parse('2026-10-04T10:00:00Z'));
    expect(timeArgMs(null, now)).toBeNull();
  });

  it('parses targets and refuses anything else', () => {
    expect(parseTargets('1:radarr,2:sonarr')).toEqual([
      { hostId: 1, container: 'radarr' },
      { hostId: 2, container: 'sonarr' },
    ]);
    expect(() => parseTargets('1:$(id)')).toThrow();
    expect(parseTargets(`1::${encodeURIComponent('/var/log/syslog')},2:web:${encodeURIComponent('/app/a,b.log')}`)).toEqual([
      { hostId: 1, container: '', file: '/var/log/syslog' },
      { hostId: 2, container: 'web', file: '/app/a,b.log' },
    ]);
    expect(() => parseTargets(`1::${encodeURIComponent('/var/../etc/shadow')}`)).toThrow();
    expect(() => parseTargets('1::relative')).toThrow();
    expect(() => parseTargets('')).toThrow();
  });

  it('splits a byte stream into lines, also across chunks and multi-byte characters', () => {
    const s = new LineSplitter();
    const euro = Buffer.from('€');
    expect(s.push(Buffer.concat([Buffer.from('a\nb'), euro.subarray(0, 1)]))).toEqual(['a']);
    expect(s.push(Buffer.concat([euro.subarray(1), Buffer.from('c\r\nd')]))).toEqual(['b€c']);
    expect(s.end()).toEqual(['d']);
  });
});

describe("a host's many containers (OPS-W-10)", () => {
  it("inspect's healthcheck outputs are emptied on the host, whole JSON strings skipped; the rest is as it was", async () => {
    const { execFileSync } = await import('node:child_process');
    const { STRIP_HEALTH_LOG, parseMonitor } = await import('../../src/docker/parse.js');
    const out = (i: number) => `x] \\"quoted\\" [y ${'.'.repeat(4000)} ${i}`;
    const log = [1, 2, 3, 4, 5].map((i) => ({ Start: 't', End: 't', ExitCode: 0, Output: out(i) }));
    const line = JSON.stringify({ id: 'c1', name: '/web', image: 'nginx', imageId: 'sha256:1', state: { Status: 'running', ExitCode: 0, Health: { Status: 'healthy', FailingStreak: 0, Log: log } }, restarts: 0, created: '2026-01-01T00:00:00Z', labels: { 'a]': 'b"[' } });
    const stripped = execFileSync('sh', ['-c', STRIP_HEALTH_LOG], { input: `${line}\n${line}\n` }).toString();
    expect(stripped.length).toBeLessThan(2 * 600);
    const [c] = parseMonitor(stripped.split('\n')[0]!).containers;
    expect(c).toMatchObject({ id: 'c1', name: 'web', state: 'running', health: 'healthy' });
    expect(JSON.parse(stripped.split('\n')[1]!).labels).toEqual({ 'a]': 'b"[' });
  });
});

describe('a host log file that is a link (audit 2026-11-09)', () => {
  it('to a key or a secret is not read: operators stream every source, and the container behind the folder can make the link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-loglink-'));
    try {
      mkdirSync(join(dir, '.ssh'));
      writeFileSync(join(dir, '.ssh', 'id_ed25519'), 'PRIVATE-KEY-LINE\n');
      writeFileSync(join(dir, 'real.log'), 'a log line\n');
      symlinkSync(join(dir, '.ssh', 'id_ed25519'), join(dir, 'app.log'));
      symlinkSync(join(dir, 'real.log'), join(dir, 'rotated.log'));
      const o = { since: null, until: null, tail: 5, follow: false };
      const bad = spawnSync('sh', ['-c', fileCommand({ container: '', file: join(dir, 'app.log') }, null, o)], { encoding: 'utf8' });
      expect(bad.stdout).not.toContain('PRIVATE-KEY-LINE');
      expect(bad.stderr).toMatch(/^tail: .*kept from logs/m);
      // A link to an ordinary log is read as before.
      const ok = spawnSync('sh', ['-c', fileCommand({ container: '', file: join(dir, 'rotated.log') }, null, o)], { encoding: 'utf8' });
      expect(ok.stdout).toContain('a log line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
