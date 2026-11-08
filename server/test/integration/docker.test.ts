import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { applyDockerDelta, type ConnectResult, type DockerDelta, type Host, type HostContainers, type LogLine, type LogServerMessage, type RunResult } from '@burrow/shared';
import { ORIGIN, makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Containers and logs against real Docker output: the test sshd with the
// docker CLI on this machine's Docker, where scripts/test-integration.sh
// started a small "burrowtest" stack (server/test/sshd/testcontainers.sh).
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DOCKER_SSHD_PORT ?? 2297);

let t: TestApp;
let h: Host;
let port = 0;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'docker-real', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: process.env.DOCKER_SSHD_PASSWORD ?? 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  port = (t.app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await t.close();
});

function socket(path: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { origin: ORIGIN, cookie: t.cookie ?? '' } });
}

/** Collects log messages until `done` says so (or times out). */
function collect(path: string, done: (m: LogServerMessage[]) => boolean, timeoutMs = 20_000): Promise<LogServerMessage[]> {
  return new Promise((resolve, reject) => {
    const ws = socket(path);
    const got: LogServerMessage[] = [];
    const timer = setTimeout(() => (ws.close(), reject(new Error(`timeout: ${JSON.stringify(got).slice(0, 500)}`))), timeoutMs);
    ws.on('message', (raw) => {
      got.push(JSON.parse(String(raw)) as LogServerMessage);
      if (done(got)) {
        clearTimeout(timer);
        ws.close();
        resolve(got);
      }
    });
    ws.on('error', reject);
  });
}

const lines = (ms: LogServerMessage[]) => ms.flatMap((m) => (m.t === 'lines' ? m.lines : [])) as LogLine[];

describe('the test sshd with the Docker socket', () => {
  // It listens on 127.0.0.1 with this machine's Docker: the password in the
  // repository must not open it, only the run's own (A3-OPS-16).
  it('takes only the password of this run, not the one in the repository', async () => {
    const other = await t.json<Host>('POST', '/api/hosts', { name: 'docker-known-password', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
    let r = await t.json<ConnectResult>('POST', `/api/hosts/${other.id}/test`);
    if (r.status === 'unknown_host_key') {
      await t.json('POST', `/api/hosts/${other.id}/trust`, { fingerprint: r.fingerprint });
      r = await t.json<ConnectResult>('POST', `/api/hosts/${other.id}/test`);
    }
    expect(r.status).toBe('auth_failed');
    await t.json('DELETE', `/api/hosts/${other.id}`);
  });
});

describe("this machine's other containers", () => {
  // The test host reaches this machine's Docker through a filter: before, a
  // test instance listed, watched and reported on the live containers and
  // read their logs (A3-WEB-16, W-FUNC-17). This run's own plain sshd is on
  // the same Docker and stands in for them.
  it("are not seen, read or acted on: the tests' own only (W-FUNC-17)", async () => {
    const plain = process.env.SSHD_CONTAINER ?? 'burrow-test-sshd';
    const snap = await t.docker.poll(h.id);
    expect(snap.error).toBeNull();
    expect(snap.containers.map((c) => c.name)).toContain('burrowtest-web');
    expect(snap.containers.map((c) => c.name)).not.toContain(plain);
    const [r] = await t.json<RunResult[]>('POST', '/api/snippets/run', {
      hostIds: [h.id],
      command: `docker ps -a --format '{{.Names}}'; echo ---; docker logs ${plain} 2>&1; docker container inspect -f '{{.Name}}' ${plain} 2>&1; docker restart ${plain} 2>&1; docker image prune -f 2>&1`,
    });
    const [listed, rest] = r!.stdout.split('---\n');
    expect(listed!.split('\n').filter(Boolean)).not.toContain(plain);
    expect(listed).toContain('burrowtest-web');
    expect(rest!.match(/No such container/g)?.length).toBe(3);
    expect(rest).toContain('refused by the test filter: prune');
  });
});

describe('containers', () => {
  it('reads the stack with state, compose labels and live stats', async () => {
    const snap = await t.docker.poll(h.id);
    expect(snap.error).toBeNull();
    const web = snap.containers.find((c) => c.name === 'burrowtest-web')!;
    const worker = snap.containers.find((c) => c.name === 'burrowtest-worker')!;
    expect(web).toMatchObject({ state: 'running', project: 'burrowtest', service: 'web', configFiles: '/srv/burrowtest/compose.yaml' });
    expect(worker).toMatchObject({ state: 'exited', exitCode: 3, project: 'burrowtest' });
    expect(snap.stats[web.id]!.memBytes).toBeGreaterThan(0);
    expect(snap.stats[worker.id]).toBeUndefined();
  });

  it('streams snapshots with a growing history to a watching page', async () => {
    // State every poll, a stats sample every third: the history grows by
    // one each third snapshot.
    const snaps = await new Promise<HostContainers[]>((resolve, reject) => {
      const ws = socket('/api/docker/ws');
      const got: HostContainers[] = [];
      const timer = setTimeout(() => reject(new Error(`no second sample in ${got.length} snapshots`)), 35_000);
      const grown = (h: HostContainers) => {
        const web = h.containers.find((c) => c.name === 'burrowtest-web');
        return !!web && (h.history[web.id]?.cpu.length ?? 0) >= 2;
      };
      ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', hostIds: [h.id] })));
      ws.on('message', (raw) => {
        // The whole snapshot first, then what changed (decision 19).
        const m = JSON.parse(String(raw)) as { t: string; host?: HostContainers; d?: DockerDelta };
        if (m.t === 'host') got.push(m.host!);
        if (m.t === 'delta' && got.length) got.push(applyDockerDelta(got.at(-1)!, m.d!));
        if (got.length && grown(got.at(-1)!)) {
          clearTimeout(timer);
          ws.close();
          resolve(got);
        }
      });
    });
    // Between samples, the last one is carried: every snapshot has stats.
    const web = snaps[0]!.containers.find((c) => c.name === 'burrowtest-web')!;
    expect(snaps.every((x) => x.stats[web.id])).toBe(true);
    expect(snaps.length).toBeGreaterThanOrEqual(3);
  }, 45_000);
});

describe('logs', () => {
  it('follows two containers: stdout and stderr, with timestamps', async () => {
    const got = await collect(`/api/docker/logs/ws?t=${h.id}:burrowtest-web,${h.id}:burrowtest-worker&tail=200&follow=1`, (m) => {
      const l = lines(m);
      return l.some((x) => x.i === 0 && x.s === 'e') && l.some((x) => x.i === 1) && m.some((x) => x.t === 'end' && x.i === 1);
    });
    const l = lines(got);
    // Every line whole and in its own stream: through one channel, the
    // lines of stdout and stderr once came out mixed into each other.
    for (const x of l.filter((y) => y.i === 0)) expect(x.text).toMatch(x.s === 'o' ? /^\{"level":30,"msg":"request \d+"\}$/ : /^ERROR upstream timeout \d+$/);
    expect(l.filter((x) => x.i === 1).map((x) => x.text)).toEqual(['WARN worker starting', 'INFO job done']);
    for (const x of l) expect(x.ts).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  it('reports a container that does not exist', async () => {
    const got = await collect(`/api/docker/logs/ws?t=${h.id}:no-such-thing&follow=0`, (m) => m.some((x) => x.t === 'error' || x.t === 'end'));
    expect(got.find((x) => x.t === 'error')).toMatchObject({ i: 0, message: expect.stringMatching(/no such container/i) });
  });

  it('a log file on the host: its own times, a stack trace line under the line before, then followed', async () => {
    const sh = (command: string) => t.json<{ exitCode: number; stdout: string }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
    const file = '/tmp/burrowtest app.log';
    await sh(`printf '%s\\n' '2026-10-04T10:00:00.250Z INFO started' '2026-10-04 12:00:01,5+02:00 ERROR boom' '    at main (app.js:1)' '192.0.2.1 - - [04/Oct/2026:12:00:02 +0200] "GET / HTTP/1.1" 200' > '${file}'`);
    const target = `${h.id}::${encodeURIComponent(file)}`;
    const got = await collect(`/api/docker/logs/ws?t=${encodeURIComponent(target)}&tail=50&follow=0`, (m) => m.some((x) => x.t === 'end'));
    expect(lines(got).map((l) => [l.ts, l.text])).toEqual([
      ['2026-10-04T10:00:00.250Z', 'INFO started'],
      ['2026-10-04T10:00:01.500Z', 'ERROR boom'],
      ['2026-10-04T10:00:01.500Z', '    at main (app.js:1)'],
      ['2026-10-04T10:00:02.000Z', '192.0.2.1 - - [04/Oct/2026:12:00:02 +0200] "GET / HTTP/1.1" 200'],
    ]);
    // Followed: a line written after the start arrives (tail -F).
    const live = collect(`/api/docker/logs/ws?t=${encodeURIComponent(target)}&tail=0&follow=1`, (m) => lines(m).some((l) => l.text.includes('appended later')));
    await new Promise((r) => setTimeout(r, 1500));
    await sh(`echo '2026-10-04T10:00:05Z WARN appended later' >> '${file}'`);
    expect(lines(await live).at(-1)).toMatchObject({ i: 0, s: 'o', ts: '2026-10-04T10:00:05.000Z' });
    // --since applies to a file's lines as well.
    const since = await collect(`/api/docker/logs/ws?t=${encodeURIComponent(target)}&tail=50&follow=0&since=2026-10-04T10:00:02Z`, (m) => m.some((x) => x.t === 'end'));
    expect(lines(since).map((l) => l.text)).toEqual(['192.0.2.1 - - [04/Oct/2026:12:00:02 +0200] "GET / HTTP/1.1" 200', 'WARN appended later']);
    await sh(`rm -f '${file}'`);
  }, 60_000);

  it('an operator reads only the files an admin set up as log sources (AUDIT2 AUTH-10)', async () => {
    const { users } = await import('../../src/db/schema.js');
    const env = `${h.id}:burrowtest-web:${encodeURIComponent('/proc/1/environ')}`;
    const admin = t.ctx.db.select().from(users).get()!;
    let cleanup: (() => Promise<unknown>) | null = null;
    t.ctx.db.update(users).set({ role: 'operator' }).run();
    try {
      const got = await collect(`/api/docker/logs/ws?t=${encodeURIComponent(env)}&tail=5&follow=0`, (m) => m.some((x) => x.t === 'error' || x.t === 'end'));
      expect(got).toEqual([expect.objectContaining({ t: 'error', message: expect.stringContaining('not a log source') })]);
      // Set up by an admin: then it is read.
      t.ctx.db.update(users).set({ role: 'admin' }).run();
      const added = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: 'burrowtest-web', path: '/etc/hostname' });
      cleanup = () => t.json('DELETE', `/api/docker/${h.id}/logfiles/${added.id}`);
      t.ctx.db.update(users).set({ role: 'operator' }).run();
      const ok = await collect(`/api/docker/logs/ws?t=${encodeURIComponent(`${h.id}:burrowtest-web:${encodeURIComponent('/etc/hostname')}`)}&tail=5&follow=0`, (m) => m.some((x) => x.t === 'end' || x.t === 'error'));
      expect(ok.some((x) => x.t === 'error')).toBe(false);
    } finally {
      t.ctx.db.update(users).set({ role: admin.role }).run();
      await cleanup?.();
    }
  });

  it("a file in a container: through docker exec, or on the host through a mount (also of a container that is not running)", async () => {
    const sh = (command: string) => t.json<{ exitCode: number; stdout: string; stderr: string }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
    await sh(`docker exec burrowtest-web sh -c "echo '2026-10-04T11:00:00Z inside the container' > /tmp/in.log"`);
    const inside = await collect(`/api/docker/logs/ws?t=${encodeURIComponent(`${h.id}:burrowtest-web:${encodeURIComponent('/tmp/in.log')}`)}&tail=10&follow=0`, (m) => m.some((x) => x.t === 'end'));
    expect(lines(inside).map((l) => l.text)).toEqual(['inside the container']);
    // A stopped container with a bind mount: docker exec cannot reach it, the host's side can.
    const [made] = await sh(
      "mkdir -p /tmp/burrowtest-mnt && echo '2026-10-04T11:30:00Z on the host side' > /tmp/burrowtest-mnt/app.log && docker rm -fv burrowtest-mnt >/dev/null 2>&1; docker create --label burrow.ignore=true --name burrowtest-mnt -v /tmp/burrowtest-mnt:/data alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f true",
    );
    expect(made!.exitCode, made!.stderr).toBe(0);
    const mounted = await collect(`/api/docker/logs/ws?t=${encodeURIComponent(`${h.id}:burrowtest-mnt:${encodeURIComponent('/data/app.log')}`)}&tail=10&follow=0`, (m) => m.some((x) => x.t === 'end' || x.t === 'error'));
    expect(lines(mounted).map((l) => l.text)).toEqual(['on the host side']);
    await sh('docker rm -fv burrowtest-mnt; rm -rf /tmp/burrowtest-mnt');
  }, 60_000);

  it('log files kept with a container: added once, listed, suggested from its mounts and /var/log, removed', async () => {
    const sh = (command: string) => t.json<{ exitCode: number; stdout: string; stderr: string }[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
    await sh(
      "mkdir -p /tmp/burrowtest-sug/sub && touch /tmp/burrowtest-sug/a.log /tmp/burrowtest-sug/sub/b.log /tmp/burrowtest-sug/c.txt && docker rm -fv burrowtest-sug >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name burrowtest-sug -v /tmp/burrowtest-sug:/data alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f sh -c 'mkdir -p /var/log/app && touch /var/log/app/x.log && sleep 600' >/dev/null",
    );
    await new Promise((r) => setTimeout(r, 1500));
    const suggested = await t.json<string[]>('GET', `/api/docker/${h.id}/containers/burrowtest-sug/logfile-suggestions`);
    expect(suggested).toEqual(['/data/a.log', '/data/sub/b.log', '/var/log/app/x.log']);
    const added = await t.json<{ id: number; path: string }>('POST', `/api/docker/${h.id}/logfiles`, { container: 'burrowtest-sug', path: '/data/a.log' });
    expect((await t.request('POST', `/api/docker/${h.id}/logfiles`, { container: 'burrowtest-sug', path: '/data/a.log' })).statusCode).toBe(409);
    await t.json('POST', `/api/docker/${h.id}/logfiles`, { container: '', path: '/var/log/syslog' });
    expect((await t.json<{ path: string }[]>('GET', `/api/docker/${h.id}/logfiles?container=burrowtest-sug`)).map((f) => f.path)).toEqual(['/data/a.log']);
    expect((await t.json<{ container: string; path: string }[]>('GET', `/api/docker/${h.id}/logfiles`)).map((f) => `${f.container}:${f.path}`)).toEqual(['burrowtest-sug:/data/a.log', ':/var/log/syslog']);
    // Kept: no longer suggested.
    expect(await t.json<string[]>('GET', `/api/docker/${h.id}/containers/burrowtest-sug/logfile-suggestions`)).not.toContain('/data/a.log');
    for (const bad of [{ container: 'x;id', path: '/a.log' }, { container: '', path: 'a.log' }, { container: '', path: '/var/../etc/shadow' }]) {
      expect((await t.request('POST', `/api/docker/${h.id}/logfiles`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await t.request('DELETE', `/api/docker/${h.id}/logfiles/${added.id}`)).statusCode).toBe(200);
    expect((await t.request('DELETE', `/api/docker/${h.id}/logfiles/${added.id}`)).statusCode).toBe(404);
    expect((await t.request('GET', `/api/docker/${h.id}/containers/no-such-thing/logfile-suggestions`)).statusCode).toBe(404);
    await sh('docker rm -fv burrowtest-sug >/dev/null; rm -rf /tmp/burrowtest-sug');
  }, 60_000);

  it('a log file that is not there says so', async () => {
    const got = await collect(`/api/docker/logs/ws?t=${encodeURIComponent(`${h.id}::${encodeURIComponent('/tmp/no-such.log')}`)}&tail=10&follow=0`, (m) => m.some((x) => x.t === 'error'));
    expect(got.find((x) => x.t === 'error')).toMatchObject({ i: 0, message: expect.stringMatching(/No such file/i) });
  });

  it('refuses names that are not container names', async () => {
    const got = await collect(`/api/docker/logs/ws?t=${h.id}:${encodeURIComponent('x;id')}`, (m) => m.length > 0);
    expect(got[0]).toMatchObject({ t: 'error', i: -1 });
  });
});
