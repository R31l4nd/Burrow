import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { releaseFlags, type ComposeCheck, type ConnectResult, type Host, type OpInfo, type OpOutcome, type OpServerMessage, type RunResult, type StackInfo, type StackUpdate, type TerminalSessionInfo, type UpdatesOverview } from '@burrow/shared';
import { ORIGIN, makeApp, openTerminal, setupAdmin, totpNow, waitForText, type TestApp } from '../helpers.js';

// Phase 8 against real Docker: the test sshd with the docker CLI and compose
// on this machine's Docker, and a registry on localhost:5001 with test
// images (server/test/sshd/registry.sh). Only stacks named burrowtest-*.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DOCKER_SSHD_PORT ?? 2297);
const REG = 'localhost:5001';
const APP_IMAGE = `${REG}/burrowtest-app:latest`;
const PROJECT = 'burrowtest-upd';
const DIR = '/home/tester/upd';

let t: TestApp;
let h: Host;
let port = 0;
let secret = '';

async function sh(command: string): Promise<string> {
  const [r] = await t.json<RunResult[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
  if (r!.exitCode !== 0) throw new Error(`${command}: ${r!.stderr}${r!.stdout}`);
  return r!.stdout;
}

/**
 * Push one of the test images as the stack's tag, as if someone released it.
 * Pushing needs the tag here too; it is set back to what runs, since only
 * the registry has the new release.
 */
async function publish(v: 'v1' | 'v2' | 'bad') {
  const running = await sh(`docker inspect --format '{{.Image}}' ${PROJECT}-app-1 2>/dev/null || true`);
  await sh(`docker tag burrowtest-app:${v} ${APP_IMAGE} && docker push -q ${APP_IMAGE} >/dev/null`);
  if (running.trim()) await sh(`docker tag ${running.trim()} ${APP_IMAGE}`);
}

/** Follows an operation to its end; returns the output and exit code. */
function follow(op: OpInfo, timeoutMs = 120_000): Promise<{ output: string; code: number; outcome?: OpOutcome }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/docker/ops/${op.id}/ws`, { headers: { origin: ORIGIN, cookie: t.cookie ?? '' } });
    let output = '';
    const timer = setTimeout(() => (ws.close(), reject(new Error(`timeout: ${output}`))), timeoutMs);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as OpServerMessage;
      if (m.t === 'output') output += m.d;
      if (m.t === 'exit') {
        clearTimeout(timer);
        resolve({ output, code: m.code, ...(m.outcome ? { outcome: m.outcome } : {}) });
      }
    });
    ws.on('error', reject);
  });
}

const runningImage = async () => (await sh(`docker inspect --format '{{index .Config.Labels "burrowtest.version"}}' ${PROJECT}-app-1`)).trim();

beforeAll(async () => {
  // Only the test's own image: this machine's Docker runs other containers too.
  t = await makeApp({ updater: { settleMs: 4000, healthWaitMs: 4000, pollMs: 1000 }, updateScope: (image) => image.startsWith(`${REG}/`) });
  ({ secret } = await setupAdmin(t));
  h = await t.json<Host>('POST', '/api/hosts', { name: 'docker-real', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: process.env.DOCKER_SSHD_PASSWORD ?? 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  // Once more with the key trusted: reads the facts (Docker), which the daily check goes by.
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  port = (t.app.server.address() as AddressInfo).port;
  await publish('v1');
  await sh(
    [
      `rm -rf ${DIR} && mkdir -p ${DIR}`,
      `printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    labels:\\n      burrow.ignore: "true"\\n' > ${DIR}/compose.yaml`,
      `cd ${DIR} && docker compose -p ${PROJECT} up -d --quiet-pull 2>&1`,
    ].join(' && '),
  );
}, 120_000);
afterAll(async () => {
  await sh(`cd ${DIR} && docker compose -p ${PROJECT} down -v 2>&1 || true`).catch(() => {});
  await t.close();
});

describe('a stack', () => {
  it('is read from the compose labels', async () => {
    const s = await t.json<StackInfo>('GET', `/api/docker/${h.id}/stacks/${PROJECT}`);
    expect(s).toMatchObject({ project: PROJECT, configFiles: [`${DIR}/compose.yaml`], workingDir: DIR, autoUpdate: false, self: false, deployed: null, running: null });
    expect(s.services).toEqual([expect.objectContaining({ service: 'app', container: `${PROJECT}-app-1`, image: APP_IMAGE, state: 'running' })]);
  });

  it('checks the compose file, and deploys a change with live output', async () => {
    expect(await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`)).toEqual({ ok: true, output: '', digest: expect.stringMatching(/^[0-9a-f]{64}$/), recreate: [] });
    await sh(`printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    labels:\\n      burrow.ignore: "true"\\n    environment:\\n      GREETING: hello\\n' > ${DIR}/compose.yaml`);
    const reviewed = (await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`)).digest!;
    // Without its review, or changed after it (here: a .env the file uses): not deployed.
    const unreviewed = await t.request('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'up', deployFile: `${DIR}/compose.yaml` });
    expect(unreviewed.json()).toMatchObject({ error: 'not_reviewed' });
    await sh(`printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    labels:\\n      burrow.ignore: "true"\\n    environment:\\n      GREETING: \\044{GREETING:-hello}\\n' > ${DIR}/compose.yaml`);
    const sameEffect = (await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`)).digest;
    expect(sameEffect).toBe(reviewed);
    await sh(`printf 'GREETING=sneaky\\n' > ${DIR}/.env`);
    const stale = await t.request('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'up', deployFile: `${DIR}/compose.yaml`, reviewed });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'review_stale' });
    expect(await sh(`docker inspect --format '{{json .Config.Env}}' ${PROJECT}-app-1`)).not.toContain('GREETING');
    await sh(`rm ${DIR}/.env && printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    labels:\\n      burrow.ignore: "true"\\n    environment:\\n      GREETING: hello\\n' > ${DIR}/compose.yaml`);
    const op = await t.json<OpInfo>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'up', deployFile: `${DIR}/compose.yaml`, reviewed });
    const { output, code } = await follow(op);
    expect(code, output).toBe(0);
    expect(output).toContain(`$ up ${PROJECT}`);
    expect(output).toMatch(/Recreat|Started|Running/);
    expect(await sh(`docker inspect --format '{{json .Config.Env}}' ${PROJECT}-app-1`)).toContain('GREETING=hello');
    const s = await t.json<StackInfo>('GET', `/api/docker/${h.id}/stacks/${PROJECT}`);
    expect(s.deployed?.content).toContain('GREETING: hello');

    // A .env too big to keep a copy of: nothing to put back after a deploy that does not run well, so not deployed (audit 2026-10-30).
    await sh(`head -c 3000000 /dev/zero | tr '\\0' '#' > ${DIR}/.env && printf '\\n' >> ${DIR}/.env`);
    const big = (await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`)).digest!;
    const notKept = await t.request('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'up', deployFile: `${DIR}/compose.yaml`, reviewed: big });
    expect(notKept.json()).toMatchObject({ error: 'not_kept' });
    await sh(`rm ${DIR}/.env`);

    // A broken file: the check says why.
    await sh(`printf 'services:\\n  app:\\n    image: [\\n' > ${DIR}/bad.yaml && cp ${DIR}/compose.yaml ${DIR}/good.yaml && cp ${DIR}/bad.yaml ${DIR}/compose.yaml`);
    const bad = await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`);
    expect(bad.ok).toBe(false);
    expect(bad.output).not.toBe('');
    await sh(`cp ${DIR}/good.yaml ${DIR}/compose.yaml`);
  }, 120_000);

  it('the review says which services a deploy would recreate or start when what runs differs from the compose files (W-FUNC-04)', async () => {
    const file = await sh(`cat ${DIR}/compose.yaml`);
    try {
      // Changed on the host, outside Burrow: compose would recreate app.
      await sh(`printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    labels:\\n      burrow.ignore: "true"\\n    environment:\\n      GREETING: hi\\n  side:\\n    image: ${APP_IMAGE}\\n    labels:\\n      burrow.ignore: "true"\\n' > ${DIR}/compose.yaml`);
      const check = await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`);
      expect(check.recreate).toEqual([
        { service: 'app', why: 'differs' },
        { service: 'side', why: 'missing' },
      ]);
    } finally {
      await sh(`cat > ${DIR}/compose.yaml <<'EOF'\n${file}EOF`);
    }
    expect((await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`)).recreate).toEqual([]);
  });

  it('a deploy that does not run well puts the previous deployment back; the file stays as it is (decision 11)', async () => {
    const good = await sh(`cat ${DIR}/compose.yaml`);
    try {
      await sh(`printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    command: ["sh", "-c", "exit 1"]\\n    labels:\\n      burrow.ignore: "true"\\n    environment:\\n      GREETING: broken\\n' > ${DIR}/compose.yaml`);
      const reviewed = (await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`)).digest!;
      const op = await t.json<OpInfo>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'up', deployFile: `${DIR}/compose.yaml`, reviewed });
      const { output, code, outcome } = await follow(op);
      expect(code, output).toBe(1);
      expect(outcome).toMatchObject({ kind: 'rolled_back', why: expect.stringMatching(/app: (exited|restarting|restarted)/) });
      expect(output).toContain('The previous deployment runs again, and runs well.');
      expect(await sh(`docker inspect --format '{{json .Config.Env}}' ${PROJECT}-app-1`)).toContain('GREETING=hello');
      expect((await sh(`docker inspect --format '{{.State.Status}}' ${PROJECT}-app-1`)).trim()).toBe('running');
      // The person's file is theirs; the deployed one is still the one before.
      expect(await sh(`cat ${DIR}/compose.yaml`)).toContain('GREETING: broken');
      expect((await t.json<StackInfo>('GET', `/api/docker/${h.id}/stacks/${PROJECT}`)).deployed?.content).toContain('GREETING: hello');
      expect(await sh(`ls -A ${DIR}`)).not.toContain('.burrow-yours');
      // Made from the stack's own file, as compose records it: the next operation finds it.
      expect((await sh(`docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' ${PROJECT}-app-1`)).trim()).toBe(`${DIR}/compose.yaml`);
    } finally {
      await sh(`cat > ${DIR}/compose.yaml <<'EOF'\n${good}EOF`);
    }
  }, 180_000);

  it('a deploy that does not run well puts the .env back too, as it was for the deployment before (review 2026-10-24)', async () => {
    const good = await sh(`cat ${DIR}/compose.yaml`);
    const deploy = async () => {
      const reviewed = (await t.json<ComposeCheck>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/check`)).digest!;
      return follow(await t.json<OpInfo>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'up', deployFile: `${DIR}/compose.yaml`, reviewed }));
    };
    try {
      // Deployed with its greeting from the .env.
      await sh(`printf 'GREETING=from-env\\n' > ${DIR}/.env && printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    labels:\\n      burrow.ignore: "true"\\n    environment:\\n      GREETING: \\044{GREETING}\\n' > ${DIR}/compose.yaml`);
      expect((await deploy()).code).toBe(0);
      expect(await sh(`docker inspect --format '{{json .Config.Env}}' ${PROJECT}-app-1`)).toContain('GREETING=from-env');
      // Then a .env and a command that do not run well: put back, the greeting of the .env before.
      await sh(`printf 'GREETING=broken\\n' > ${DIR}/.env && printf 'services:\\n  app:\\n    image: ${APP_IMAGE}\\n    restart: on-failure:3\\n    command: ["sh", "-c", "exit 1"]\\n    labels:\\n      burrow.ignore: "true"\\n    environment:\\n      GREETING: \\044{GREETING}\\n' > ${DIR}/compose.yaml`);
      const { code, outcome } = await deploy();
      expect(code).toBe(1);
      expect(outcome).toMatchObject({ kind: 'rolled_back' });
      expect(await sh(`docker inspect --format '{{json .Config.Env}}' ${PROJECT}-app-1`)).toContain('GREETING=from-env');
      // The person's own files stay as they are.
      expect(await sh(`cat ${DIR}/.env`)).toBe('GREETING=broken\n');
    } finally {
      await sh(`rm -f ${DIR}/.env && cat > ${DIR}/compose.yaml <<'EOF'\n${good}EOF`);
      await deploy();
    }
  }, 240_000);

  it('an operation still running on the host after a restart of Burrow is followed again and shown (OPS-W-05)', async () => {
    const { target } = await (await import('../../src/docker/stacks.js')).readStack(t.docker, h.id, PROJECT);
    const { OpRunner } = await import('../../src/docker/ops.js');
    const before = new OpRunner(t.ctx, t.files);
    const first = before.start(target, 'pull', (ctl) => ctl.run(`echo "\\$ pull ${PROJECT}"; sleep 6; echo pulled`));
    await new Promise((r) => setTimeout(r, 2000));
    // Burrow restarted: a new runner that knows nothing of it.
    const after = new OpRunner(t.ctx, t.files);
    expect(after.list()).toEqual([]);
    const second = after.start(target, 'restart', (ctl) => ctl.run('true'));
    expect(await second.done).toBe(1);
    expect(second.output).toContain('it is shown under Activity now');
    const shown = after.list();
    expect(shown).toEqual([expect.objectContaining({ project: PROJECT, op: 'pull', exitCode: null })]);
    // And once more from the start-up scan: followed already, not twice.
    expect(await after.adoptRunning([h.id])).toEqual([]);
    const adopted = after.get(shown[0]!.id)!;
    expect(await adopted.done).toBe(0);
    expect(adopted.output).toContain('pulled');
    expect(await first.done).toBe(0);
  }, 60_000);

  it('only one operation at a time', async () => {
    const op = await t.json<OpInfo>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'restart' });
    const second = await t.request('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'restart' });
    expect(second.statusCode, t.ops.get(op.id)?.output).toBe(409);
    const done = await follow(op);
    expect(done.code, done.output).toBe(0);
  }, 60_000);

  it('brought down from Burrow: still there, said to be down, and brought up again from Burrow (review 2026-10-24)', async () => {
    const down = await follow(await t.json<OpInfo>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'down' }));
    expect(down.code, down.output).toBe(0);
    expect((await sh(`docker ps -aq --filter label=com.docker.compose.project=${PROJECT}`)).trim()).toBe('');
    // No containers left to read it from: Burrow kept where its files are.
    const s = await t.json<StackInfo>('GET', `/api/docker/${h.id}/stacks/${PROJECT}`);
    expect(s).toMatchObject({ project: PROJECT, configFiles: [`${DIR}/compose.yaml`], workingDir: DIR, services: [], downAt: expect.any(String) });
    expect(await t.json('GET', '/api/docker/stacks/down')).toEqual([{ hostId: h.id, hostName: 'docker-real', project: PROJECT, downAt: s.downAt }]);
    const up = await follow(await t.json<OpInfo>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'up' }));
    expect(up.code, up.output).toBe(0);
    expect((await sh(`docker inspect --format '{{.State.Status}}' ${PROJECT}-app-1`)).trim()).toBe('running');
    expect((await t.json<StackInfo>('GET', `/api/docker/${h.id}/stacks/${PROJECT}`)).downAt).toBeNull();
    expect(await t.json('GET', '/api/docker/stacks/down')).toEqual([]);
  }, 120_000);
});

describe('containers', () => {
  it('stop, start, and a shell inside as a terminal session', async () => {
    const name = `${PROJECT}-app-1`;
    await t.json('POST', `/api/docker/${h.id}/containers/${name}/action`, { action: 'stop' });
    expect((await sh(`docker inspect --format '{{.State.Status}}' ${name}`)).trim()).toBe('exited');
    await t.json('POST', `/api/docker/${h.id}/containers/${name}/action`, { action: 'start' });
    expect((await sh(`docker inspect --format '{{.State.Status}}' ${name}`)).trim()).toBe('running');
    const ins = await t.json<{ json: string }>('POST', `/api/docker/${h.id}/containers/${name}/inspect`);
    expect(JSON.parse(ins.json)[0].Name).toBe(`/${name}`);

    const s = await t.json<TerminalSessionInfo>('POST', `/api/docker/${h.id}/containers/${name}/shell`, { cols: 80, rows: 24 });
    expect(s.title).toBe(name);
    const c = await openTerminal(t, s.id);
    c.send({ t: 'input', d: 'cat /etc/alpine-release; echo "in-$((6*7))"\n' });
    await waitForText(c, 'in-42');
    c.close();
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);

    const audit = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['container.stop', 'container.start', 'container.inspect']));
  }, 60_000);

  it('asks for a fresh step-up', async () => {
    t.advance(60 * 60_000);
    const r = await t.request('POST', `/api/docker/${h.id}/containers/${PROJECT}-app-1/action`, { action: 'restart' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('step_up_required');
  });
});

describe('image updates', () => {
  beforeAll(async () => {
    // The step-up above expired: confirm again.
    t.advance(30_000);
    await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
  });

  it('notices a newer image in the registry, and updates automatically', async () => {
    await t.json('POST', '/api/docker/updates/check', { hostIds: [h.id] });
    let o = await t.json<UpdatesOverview>('GET', '/api/docker/updates');
    expect(o.checks.find((c) => c.image === APP_IMAGE)).toMatchObject({ status: 'current', error: null });

    await publish('v2');
    o = await t.json<UpdatesOverview>('POST', '/api/docker/updates/check', { hostIds: [h.id] });
    const ch = o.checks.find((c) => c.image === APP_IMAGE)!;
    expect(ch.status).toBe('update');
    expect(ch.remoteDigest).not.toBe(ch.localDigest);
    expect(o.lastCheckAt).not.toBeNull();

    await t.json('PUT', `/api/docker/${h.id}/stacks/${PROJECT}/settings`, { autoUpdate: true });
    // While it runs, the overview says so, and a second start is refused (it answered "nothing to do").
    const running = t.json<{ updates: StackUpdate[] }>('POST', '/api/docker/updates/run');
    await expect.poll(async () => (await t.json<UpdatesOverview>('GET', '/api/docker/updates')).windowRunning).toBe(true);
    expect((await t.request('POST', '/api/docker/updates/run')).statusCode).toBe(409);
    const { updates } = await running;
    expect(updates).toEqual([expect.objectContaining({ project: PROJECT, auto: true, result: 'updated' })]);
    expect(updates[0]!.images[0]).toMatchObject({ image: APP_IMAGE, from: ch.localDigest, to: ch.remoteDigest });
    expect(await runningImage()).toBe('v2');
    o = await t.json<UpdatesOverview>('GET', '/api/docker/updates');
    expect(o.checks.find((c) => c.image === APP_IMAGE)?.status).toBe('current');
  }, 180_000);

  it('rolls back an update whose container does not stay up', async () => {
    await publish('bad');
    const { updates } = await t.json<{ updates: StackUpdate[] }>('POST', '/api/docker/updates/run');
    expect(updates).toEqual([expect.objectContaining({ project: PROJECT, result: 'rolled_back' })]);
    expect(updates[0]!.detail).toMatch(/app: (exited|restarting|restarted)/);
    expect(await runningImage()).toBe('v2');
    expect((await sh(`docker inspect --format '{{.State.Status}}' ${PROJECT}-app-1`)).trim()).toBe('running');

    const history = await t.json<StackUpdate[]>('GET', `/api/docker/${h.id}/stacks/${PROJECT}/history`);
    expect(history.map((u) => u.result)).toEqual(['rolled_back', 'updated']);
    const audit = await t.json<{ action: string }[]>('GET', '/api/audit');
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['stack.update', 'stack.rollback']));
  }, 180_000);

  it('a version rolled back is not tried again by the window, and says so; by hand it ends as "rolled back", not "failed" (W-FUNC-03, W-FUNC-10)', async () => {
    let o = await t.json<UpdatesOverview>('GET', '/api/docker/updates');
    const bad = o.checks.find((c) => c.image === APP_IMAGE)!;
    expect(bad).toMatchObject({ status: 'update', rolledBackAt: expect.any(String) });
    const before = (await t.json<StackUpdate[]>('GET', `/api/docker/${h.id}/stacks/${PROJECT}/history`)).length;
    expect((await t.json<{ updates: StackUpdate[] }>('POST', '/api/docker/updates/run')).updates).toEqual([]);
    expect(await t.json<StackUpdate[]>('GET', `/api/docker/${h.id}/stacks/${PROJECT}/history`)).toHaveLength(before);
    const op = await t.json<OpInfo>('POST', `/api/docker/${h.id}/stacks/${PROJECT}/ops`, { op: 'update', services: ['app'] });
    const { code, outcome, output } = await follow(op, 150_000);
    expect(code, output).toBe(1);
    expect(outcome).toMatchObject({ kind: 'rolled_back', why: expect.stringMatching(/app: (exited|restarting|restarted)/) });
    expect(await runningImage()).toBe('v2');
    o = await t.json<UpdatesOverview>('GET', '/api/docker/updates');
    expect(o.checks.find((c) => c.image === APP_IMAGE)?.rolledBackAt).toEqual(expect.any(String));
  }, 180_000);

  it('holds for a breaking release until someone read it, and shows its notes', async () => {
    // The release notes, as GitHub would give them (no network in tests).
    const notes = t.updater.notes;
    const log = { url: 'https://github.com/o/app/releases', matched: true, breaking: 1, releases: [{ tag: '3.0.0', name: '3.0.0', publishedAt: null, body: 'BREAKING: the config moved.', url: '', flags: releaseFlags('BREAKING: the config moved.', '3.0.0', '2.0.0') }] };
    t.updater.notes = async () => log;
    try {
      await t.json('POST', '/api/docker/updates/check', { hostIds: [h.id] });
      expect(await t.json('GET', `/api/docker/${h.id}/changelog?image=${encodeURIComponent(APP_IMAGE)}`)).toEqual(log);
      const base = `/api/docker/${h.id}/stacks/${PROJECT}/hold`;
      const hold = await t.json<{ held: string[]; released: boolean }>('GET', base);
      expect(hold).toEqual({ held: [`${APP_IMAGE} 3.0.0`], released: false });
      expect(await t.json('POST', `${base}/release`, { held: hold.held })).toEqual({ held: hold.held, released: true });
      expect(await t.json('GET', base)).toEqual({ held: hold.held, released: true });
      expect((await t.json<{ action: string }[]>('GET', '/api/audit')).map((a) => a.action)).toContain('stack.release');
    } finally {
      t.updater.notes = notes;
    }
  });

  it('runs in the maintenance window once a day', async () => {
    await t.json('PUT', '/api/docker/updates/settings', { enabled: true, windowStart: '03:00', windowHours: 1, timeZone: 'UTC' });
    const before = (await t.json<StackUpdate[]>('GET', `/api/docker/${h.id}/stacks/${PROJECT}/history`)).length;
    await t.updater.tick(Date.UTC(2026, 0, 2, 2, 0));
    // A release after the one rolled back: the window takes it.
    await publish('v1');
    await t.updater.tick(Date.UTC(2026, 0, 2, 3, 10));
    let after = await t.json<StackUpdate[]>('GET', `/api/docker/${h.id}/stacks/${PROJECT}/history`);
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ result: 'updated', auto: true });
    await t.updater.tick(Date.UTC(2026, 0, 2, 3, 40));
    after = await t.json<StackUpdate[]>('GET', `/api/docker/${h.id}/stacks/${PROJECT}/history`);
    expect(after.length).toBe(before + 1);

    // Turned off: the next day's window does nothing.
    const o = await t.json<UpdatesOverview>('PUT', '/api/docker/updates/settings', { enabled: false, windowStart: '03:00', windowHours: 1, timeZone: 'UTC' });
    expect(o.nextWindowAt).toBeNull();
    await t.updater.tick(Date.UTC(2026, 0, 3, 3, 10));
    after = await t.json<StackUpdate[]>('GET', `/api/docker/${h.id}/stacks/${PROJECT}/history`);
    expect(after.length).toBe(before + 1);
  }, 180_000);
});

describe('a newer version under another tag', () => {
  const VER = `${REG}/burrowtest-ver`;
  afterAll(async () => {
    await sh('docker rm -fv burrowtest-ver >/dev/null 2>&1 || true').catch(() => {});
  });

  it('is seen by the check (same shape only, the labels choose), told once, and never updated to by itself', async () => {
    for (const tag of ['1.0', '1.1', '1.2', '1.3-rc1', '2', 'latest']) await sh(`docker tag burrowtest-app:v1 ${VER}:${tag} && docker push -q ${VER}:${tag} >/dev/null`);
    await sh(`docker rm -fv burrowtest-ver >/dev/null 2>&1 || true; docker run -d --label burrow.ignore=true --name burrowtest-ver ${VER}:1.0 >/dev/null`);
    let o = await t.json<UpdatesOverview>('POST', '/api/docker/updates/check', { hostIds: [h.id], images: [`${VER}:1.0`] });
    expect(o.checks.find((c) => c.image === `${VER}:1.0`)).toMatchObject({ status: 'current', newerTag: '1.2' });

    // Told once on the updates topic, and not again for the same tag.
    const sent: { title: string; body: string }[] = [];
    t.updater.notifier = { notify: async (n: (typeof sent)[number]) => void sent.push(n) } as unknown as typeof t.updater.notifier;
    t.updater.tellNewTags();
    t.updater.tellNewTags();
    expect(sent).toEqual([expect.objectContaining({ title: '1 newer version available', body: `${VER}:1.0 -> 1.2 (docker-real)` })]);

    // A label leaves tags out: 1.2 excluded, 1.1 is the newest that counts.
    await sh(`docker rm -fv burrowtest-ver >/dev/null; docker run -d --label burrow.ignore=true --label 'burrow.tag.exclude=^1\\.2$' --name burrowtest-ver ${VER}:1.0 >/dev/null`);
    o = await t.json<UpdatesOverview>('POST', '/api/docker/updates/check', { hostIds: [h.id], images: [`${VER}:1.0`] });
    expect(o.checks.find((c) => c.image === `${VER}:1.0`)?.newerTag).toBe('1.1');
    expect(await sh(`docker inspect --format '{{.Config.Image}}' burrowtest-ver`)).toContain(`${VER}:1.0`);
  }, 120_000);
});
