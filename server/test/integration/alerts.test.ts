import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Alert, AlertMute, ConnectResult, Host, RunResult } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Phase 9 against real Docker: a container that crashes, a pattern in the
// logs of the test stack, push through a real ntfy server on localhost:5002
// (server/test/sshd/ntfy.sh), and the analysis through a stand-in model
// server that records what it was sent.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DOCKER_SSHD_PORT ?? 2297);
const NTFY = process.env.NTFY_URL ?? 'http://127.0.0.1:5002';
const TOPIC = `burrowtest-${Date.now().toString(36)}`;

let t: TestApp;
let h: Host;
let model: Server;
let modelUrl = '';
const modelSaw: string[] = [];

async function sh(command: string): Promise<string> {
  const [r] = await t.json<RunResult[]>('POST', '/api/snippets/run', { hostIds: [h.id], command });
  if (r!.exitCode !== 0) throw new Error(`${command}: ${r!.stderr}${r!.stdout}`);
  return r!.stdout;
}

/** The engine's next alert that matches. */
function nextAlert(match: (a: Alert) => boolean, timeoutMs = 30_000): Promise<Alert> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no alert')), timeoutMs);
    t.alerts.onAlert = (a) => {
      if (!match(a)) return;
      clearTimeout(timer);
      t.alerts.onAlert = null;
      resolve(a);
    };
  });
}

async function pushes(): Promise<{ title: string; message: string; click?: string; actions?: { url: string }[] }[]> {
  const res = await fetch(`${NTFY}/${TOPIC}/json?poll=1&since=all`);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; title: string; message: string; click?: string; actions?: { url: string }[] })
    .filter((m) => m.event === 'message');
}

beforeAll(async () => {
  // A model server that streams a fixed answer and keeps the prompts.
  model = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      modelSaw.push(body);
      res.setHeader('content-type', 'text/event-stream');
      for (const piece of ['## Likely cause\n', 'The database ', 'refused connections.\n']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

  t = await makeApp();
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'docker-real', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password', password: process.env.DOCKER_SSHD_PASSWORD ?? 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
  await t.json('POST', '/api/channels', { kind: 'ntfy', name: 'phone', enabled: true, topics: ['alerts'], lang: 'en', ntfy: { url: NTFY, topic: TOPIC, openIn: 'browser' } });
  await t.alerts.reconcile();
  // The events stream needs a moment to start on the host.
  await new Promise((r2) => setTimeout(r2, 1500));
}, 60_000);

afterAll(async () => {
  if (!t) return;
  await sh('docker rm -fv burrowtest-crash burrowtest-stopme burrowtest-sick >/dev/null 2>&1; true').catch(() => {});
  t.alerts.stop();
  await t.close();
  model.close();
});

describe('alerts', () => {
  it('a crash arrives as an alert and a push with a link to the logs', async () => {
    const got = nextAlert((a) => a.container === 'burrowtest-crash');
    await sh(`docker rm -fv burrowtest-crash >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name burrowtest-crash alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f sh -c 'echo "ERROR could not connect: password=hunter2"; sleep 1; exit 3' >/dev/null`);
    const a = await got;
    expect(a).toMatchObject({ ruleName: 'Crashes', title: 'exited with code 3', hostName: 'docker-real', pushed: 'yes', count: 1 });
    // Its last lines go along, masked.
    expect(a.detail).toBe('ERROR could not connect: password=<secret>');
    const p = (await pushes()).find((m) => m.title.startsWith('burrowtest-crash'))!;
    expect(p.title).toBe('burrowtest-crash on docker-real: exited with code 3');
    expect(p.message).toBe('ERROR could not connect: password=<secret>');
    expect(p.click).toContain(`#/logs?t=${h.id}:burrowtest-crash&at=`);
    expect(p.actions?.map((x) => x.url)).toEqual([p.click, `${p.click}&analyze=1`]);
    // For the Android app: a burrow:// link it opens itself.
    const { pageLink } = await import('../../src/notify/ntfy.js');
    expect(pageLink('https://b', '/logs?t=1:web&at=x', 'app')).toBe('burrow://open?to=%2Flogs%3Ft%3D1%3Aweb%26at%3Dx');
    // This machine's Docker runs other projects too: one of theirs that stops meanwhile is an alert as well, so look for ours by name.
    const list = await t.json<Alert[]>('GET', '/api/alerts');
    expect(list.find((a) => a.container === 'burrowtest-crash')).toMatchObject({ read: false });
    const counts = await t.json<{ n: number; total: number }>('GET', '/api/alerts/unread');
    expect(counts.n).toBe(list.filter((a) => !a.read).length);
    // All of them, for "clear all": the list stops at 200 (AUDIT2 PAGE-24).
    expect(counts.total).toBe(list.length < 200 ? list.length : counts.total);
    expect(counts.total).toBeGreaterThanOrEqual(list.length);
  }, 60_000);

  it('a crash in a stack Burrow is working on (an update, a deploy) is no alert; once it is done, it counts again', async () => {
    const run = (name: string) =>
      sh(`docker rm -fv ${name} >/dev/null 2>&1; docker run -d --label burrow.ignore=true --label com.docker.compose.project=burrowtest-quiet --label com.docker.compose.service=${name} --name ${name} alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f sh -c 'sleep 1; exit 4' >/dev/null`);
    const seen: string[] = [];
    t.alerts.onAlert = (a) => void seen.push(a.container);
    let finish!: (code: number) => void;
    const op = t.ops.start({ hostId: h.id, project: 'burrowtest-quiet', workingDir: null, configFiles: [] }, 'update', () => new Promise<number>((r) => (finish = r)));
    await run('burrowtest-quiet-a');
    await new Promise((r) => setTimeout(r, 4000));
    expect(seen).not.toContain('burrowtest-quiet-a');
    // Done, and its settling time over: a crash is news again.
    t.ops.quietMs = 0;
    finish(0);
    await op.done;
    const got = nextAlert((a) => a.container === 'burrowtest-quiet-b');
    await run('burrowtest-quiet-b');
    expect(await got).toMatchObject({ title: 'exited with code 4' });
    t.ops.quietMs = 120_000;
    await sh('docker rm -fv burrowtest-quiet-a burrowtest-quiet-b >/dev/null 2>&1; true');
  }, 60_000);

  it('an unhealthy container', async () => {
    const got = nextAlert((a) => a.container === 'burrowtest-sick');
    await sh(
      `docker rm -fv burrowtest-sick >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name burrowtest-sick --health-cmd false --health-interval 1s --health-retries 1 alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f sleep 300 >/dev/null`,
    );
    expect(await got).toMatchObject({ title: 'turned unhealthy', ruleName: 'Crashes' });
  }, 30_000);

  it('a container someone stops is no crash', async () => {
    await sh(`docker rm -fv burrowtest-stopme >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name burrowtest-stopme alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f sleep 300 >/dev/null`);
    let fired = false;
    t.alerts.onAlert = (a) => (fired ||= a.container === 'burrowtest-stopme');
    await sh('docker stop -t 1 burrowtest-stopme >/dev/null');
    await new Promise((r) => setTimeout(r, 3000));
    t.alerts.onAlert = null;
    expect(fired).toBe(false);
  }, 30_000);

  it('a pattern in the logs; repeats are bundled; a muted container is not pushed', async () => {
    // Listened for first: saving the rule follows the log at once, and a round asked for meanwhile
    // waits for the one under way (audit 2026-11-05), so the alert can come before reconcile returns.
    const first = nextAlert((x) => x.ruleName === 'Timeouts', 20_000);
    await t.json('POST', '/api/alerts/rules', { name: 'Timeouts', kind: 'pattern', hostId: h.id, container: 'burrowtest-web', project: null, pattern: 'upstream timeout' });
    await t.alerts.reconcile();
    const a = await first;
    expect(a).toMatchObject({ container: 'burrowtest-web', pushed: 'yes' });
    expect(a.detail).toMatch(/ERROR upstream timeout \d+/);
    // The web container logs a timeout every 1.5 s: the next ones add to the count.
    await new Promise((r) => setTimeout(r, 4000));
    const same = (await t.json<Alert[]>('GET', '/api/alerts')).filter((x) => x.ruleName === 'Timeouts');
    expect(same).toHaveLength(1);
    expect(same[0]!.count).toBeGreaterThan(1);
    expect((await pushes()).filter((m) => m.title.includes('upstream timeout'))).toHaveLength(1);

    // Ten minutes on, muted: a new alert, not pushed.
    await t.json('POST', '/api/alerts/mutes', { hostId: h.id, container: 'burrowtest-web', minutes: 60 });
    t.advance(11 * 60_000);
    const m = await nextAlert((x) => x.ruleName === 'Timeouts', 20_000);
    expect(m.pushed).toBe('muted');

    // One alert deleted, then all.
    await t.json('DELETE', `/api/alerts/${m.id}`);
    expect((await t.json<Alert[]>('GET', '/api/alerts')).some((x) => x.id === m.id)).toBe(false);
    await t.json('DELETE', '/api/alerts');
    expect(await t.json<Alert[]>('GET', '/api/alerts')).toEqual([]);
  }, 60_000);

  it("a pattern in a container's log file, and in a file on the host for a rule on the whole host", async () => {
    await sh("docker exec burrowtest-web sh -c ': > /tmp/app.log' && : > /tmp/burrowtest-host.log");
    await t.json('POST', `/api/docker/${h.id}/logfiles`, { container: 'burrowtest-web', path: '/tmp/app.log' });
    await t.json('POST', `/api/docker/${h.id}/logfiles`, { container: '', path: '/tmp/burrowtest-host.log' });
    await t.json('POST', '/api/alerts/rules', { name: 'Disk errors', kind: 'pattern', hostId: h.id, container: null, project: null, pattern: 'disk write failed' });
    const seen: Alert[] = [];
    const both = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`alerts: ${JSON.stringify(seen.map((a) => a.container))}`)), 30_000);
      t.alerts.onAlert = (a) => {
        if (a.ruleName !== 'Disk errors') return;
        seen.push(a);
        if (seen.some((x) => x.container.startsWith('burrowtest-web:')) && seen.some((x) => x.container.startsWith(':'))) {
          clearTimeout(timer);
          t.alerts.onAlert = null;
          resolve();
        }
      };
    });
    await t.alerts.reconcile();
    await new Promise((r) => setTimeout(r, 2500));
    await sh("docker exec burrowtest-web sh -c \"echo '2026-10-04T12:00:00Z ERROR disk write failed in app' >> /tmp/app.log\" && echo 'Oct  4 12:00:01 host kernel: disk write failed on sdb' >> /tmp/burrowtest-host.log");
    await both;
    expect(seen.find((x) => x.container.startsWith('burrowtest-web:'))).toMatchObject({ container: `burrowtest-web:${encodeURIComponent('/tmp/app.log')}`, detail: expect.stringContaining('disk write failed in app') });
    expect(seen.find((x) => x.container.startsWith(':'))!.container).toBe(`:${encodeURIComponent('/tmp/burrowtest-host.log')}`);
    // A file can be muted like a container (it could not, audit BE-25).
    const fileSubject = `:${encodeURIComponent('/tmp/burrowtest-host.log')}`;
    expect((await t.request('POST', '/api/alerts/mutes', { hostId: h.id, container: fileSubject, minutes: 60 })).statusCode).toBe(200);
    expect((await t.request('POST', '/api/alerts/mutes', { hostId: h.id, container: 'web:notapath', minutes: 60 })).statusCode).toBe(400);
    // A new alert, not one added to the last: the old ones go first.
    await t.json('DELETE', '/api/alerts');
    const muted = new Promise<Alert>((resolve) => {
      t.alerts.onAlert = (a) => a.ruleName === 'Disk errors' && a.container === fileSubject && ((t.alerts.onAlert = null), resolve(a));
    });
    await sh("echo 'Oct  4 12:00:09 host kernel: disk write failed on sdc' >> /tmp/burrowtest-host.log");
    expect((await muted).pushed).toBe('muted');
    await t.request('DELETE', `/api/alerts/mutes/${h.id}/${encodeURIComponent(fileSubject)}`);
    // A long path, its characters the widest once encoded: muted and unmuted too (AUDIT2 AI-13).
    const longSubject = `:${encodeURIComponent(`/var/log/${'\u00e9'.repeat(1000)}.log`)}`;
    expect((await t.request('POST', '/api/alerts/mutes', { hostId: h.id, container: longSubject, minutes: 60 })).statusCode).toBe(200);
    expect((await t.request('DELETE', `/api/alerts/mutes/${h.id}/${encodeURIComponent(longSubject)}`)).statusCode).toBe(204);
    expect((await t.json<AlertMute[]>('GET', '/api/alerts/mutes')).some((m) => m.container === longSubject)).toBe(false);
    await t.json('DELETE', '/api/alerts');
    await sh('docker exec burrowtest-web rm -f /tmp/app.log; rm -f /tmp/burrowtest-host.log');
  }, 60_000);

  it('a container made anew under its name is followed again (AUDIT2 MON-13: its log was never read again)', async () => {
    const ALPINE = 'alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f';
    const start = (word: string) => sh(`docker rm -fv burrowtest-again >/dev/null 2>&1; docker run -d --label burrow.ignore=true --name burrowtest-again ${ALPINE} sh -c 'while true; do echo "ERROR ${word} again"; sleep 1; done' >/dev/null`);
    await start('first');
    // Another container followed on the same host keeps the host's log stream open: only this
    // container's part of it ends when it goes (the stream ending re-followed it before).
    await t.json('POST', '/api/alerts/rules', { name: 'Keep open', kind: 'pattern', hostId: h.id, container: 'burrowtest-web', project: null, pattern: 'never-in-these-logs' });
    const first = nextAlert((a) => a.ruleName === 'Again' && !!a.detail?.includes('first'), 20_000);
    await t.json('POST', '/api/alerts/rules', { name: 'Again', kind: 'pattern', hostId: h.id, container: 'burrowtest-again', project: null, pattern: 'again' });
    try {
      await t.alerts.reconcile();
      await first;
      await t.json('DELETE', '/api/alerts');
      // Listened for first: the log follows the new container by itself now (review 2026-10-24),
      // its lines can come before the next round.
      const next = nextAlert((x) => x.ruleName === 'Again' && !!x.detail?.includes('second'), 20_000);
      await start('second');
      await new Promise((r) => setTimeout(r, 1500));
      await t.alerts.reconcile();
      const a = await next;
      expect(a.container).toBe('burrowtest-again');
    } finally {
      await sh('docker rm -fv burrowtest-again >/dev/null 2>&1; true');
      const rules = await t.json<{ id: number; name: string }[]>('GET', '/api/alerts/rules');
      for (const r of rules.filter((x) => x.name === 'Again' || x.name === 'Keep open')) await t.request('DELETE', `/api/alerts/rules/${r.id}`);
      await t.json('DELETE', '/api/alerts');
    }
  }, 60_000);

  it('a followed stream stopped and started again leaves nothing running on the host: sshd kept each quiet one as a session, and refused the 11th', async () => {
    // A rule's files changed (as a container made anew, a rule saved) stops the host's stream and starts it
    // again on the pooled connection. A quiet file's tail never wrote again to find its channel gone.
    await sh(': > /tmp/burrowtest-quiet.log');
    const rule = await t.json<{ id: number }>('POST', '/api/alerts/rules', { name: 'Quiet host', kind: 'pattern', hostId: h.id, container: null, project: null, pattern: 'never-in-this-file' });
    const quiet = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: '', path: '/tmp/burrowtest-quiet.log' });
    const tails = async () => Number((await sh("ps -eo args | grep -c '^tail .*burrowtest-quiet.lo[g]' || true")).trim());
    try {
      for (let i = 0; i < 12; i++) {
        const extra = await t.json<{ id: number }>('POST', `/api/docker/${h.id}/logfiles`, { container: '', path: `/tmp/burrowtest-extra-${i}.log` });
        await t.alerts.reconcile();
        await t.request('DELETE', `/api/docker/${h.id}/logfiles/${extra.id}`);
      }
      await t.alerts.reconcile();
      await expect.poll(tails, { timeout: 10_000 }).toBe(1);
    } finally {
      await t.request('DELETE', `/api/docker/${h.id}/logfiles/${quiet.id}`);
      await t.request('DELETE', `/api/alerts/rules/${rule.id}`);
      await t.alerts.reconcile();
    }
  }, 120_000);
});

describe('analysis', () => {
  it('masks secrets, groups repeats, and streams the answer', async () => {
    // Said to run on the admin's own network: IP addresses stay (A3-SRV-20; masked by default, below).
    await t.json('PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: modelUrl, model: 'fake', local: true } });
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => ({ i: 0, ts: `2026-09-27T10:00:${String(i).padStart(2, '0')}Z`, text: `INFO request ${i} took ${i * 3} ms` })),
      { i: 0, ts: '2026-09-27T10:01:00Z', text: 'ERROR could not connect to db at 10.0.0.5: password=hunter2 user admin@example.com' },
    ];
    const answer = async () => {
      const { id } = await t.json<{ id: number }>('POST', '/api/ai/analyses', { targets: [{ hostId: h.id, container: 'burrowtest-web' }], lines, lang: 'en' });
      await expect.poll(async () => (await t.json<{ status: string }>('GET', `/api/ai/analyses/${id}`)).status).toBe('done');
      return (await t.json<{ text: string }>('GET', `/api/ai/analyses/${id}`)).text;
    };
    expect(await answer()).toBe('## Likely cause\nThe database refused connections.\n');
    const sent = modelSaw.at(-1)!;
    expect(sent).not.toContain('hunter2');
    expect(sent).not.toContain('admin@example.com');
    expect(sent).toContain('password=<secret>');
    // A model on this network: IP addresses stay, they help.
    expect(sent).toContain('10.0.0.5');
    // 50 similar lines are one group; the error comes first.
    expect(sent).toMatch(/50x info/);
    expect(sent.indexOf('ERROR could not connect')).toBeLessThan(sent.indexOf('INFO request'));
    // The container's state goes along.
    expect(sent).toMatch(/burrowtest-web on docker-real: image alpine/);
    const audit = await t.json<{ action: string; details: string | null }[]>('GET', '/api/audit');
    expect(audit.find((x) => x.action === 'ai.analyze')).toBeTruthy();
    // Not said: the same server, by the same name, gets the addresses masked.
    await t.json('PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: modelUrl, model: 'fake' } });
    await answer();
    expect(modelSaw.at(-1)).not.toContain('10.0.0.5');
    expect(modelSaw.at(-1)).toContain('<ip>');
  });

  it('an analysis can be deleted, and is gone (report aafaba)', async () => {
    const [newest] = await t.json<{ id: number; status: string }[]>('GET', '/api/ai/analyses');
    expect(newest).toBeTruthy();
    await expect.poll(async () => (await t.json<{ status: string }>('GET', `/api/ai/analyses/${newest!.id}`)).status).not.toBe('running');
    expect((await t.request('DELETE', `/api/ai/analyses/${newest!.id}`)).statusCode).toBe(204);
    expect((await t.request('GET', `/api/ai/analyses/${newest!.id}`)).statusCode).toBe(404);
    expect((await t.request('DELETE', `/api/ai/analyses/${newest!.id}`)).statusCode).toBe(404);
  });

  it('a file read from the host, asked about: masked, numbered, kept for the file and asked further (report 76bcda)', async () => {
    await t.json('PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: modelUrl, model: 'fake' } });
    const path = '/home/tester/ask-ai.conf';
    await t.json('PUT', `/api/files/${h.id}/text`, { path, content: 'listen 8080\ntoken = s3cr3t-value-here\nupstream 10.0.0.7\n', baseHash: null });
    const file = await t.json<{ content: string }>('GET', `/api/files/${h.id}/text?path=${encodeURIComponent(path)}`);
    const { id } = await t.json<{ id: number }>('POST', '/api/ai/file', { hostId: h.id, path, text: file.content.trimEnd(), totalLines: 3, question: 'What listens?', lang: 'en' });
    await expect.poll(async () => (await t.json<{ status: string }>('GET', `/api/ai/analyses/${id}`)).status).toBe('done');
    const sent = modelSaw.at(-1)!;
    expect(sent).toContain(`File ${path} on host docker-real, all 3 lines`);
    expect(sent).toContain('1| listen 8080');
    expect(sent).not.toContain('s3cr3t-value-here');
    expect(sent).not.toContain('10.0.0.7');
    expect((await t.json<{ id: number }[]>('GET', `/api/ai/analyses?kind=file&hostId=${h.id}&file=${encodeURIComponent(path)}`)).map((a) => a.id)).toEqual([id]);
    await t.json('POST', `/api/ai/analyses/${id}/ask`, { question: 'And the upstream?', lang: 'en' });
    await expect.poll(async () => (await t.json<{ followUps: { status: string }[] }>('GET', `/api/ai/analyses/${id}`)).followUps.map((q) => q.status)).toEqual(['done']);
    expect(modelSaw.at(-1)).toContain('about a file on one of their hosts');
    const audit = await t.json<{ action: string; target: string | null }[]>('GET', '/api/audit');
    expect(audit.find((x) => x.action === 'ai.file')).toBeTruthy();
    expect((await t.request('DELETE', `/api/ai/analyses/${id}`)).statusCode).toBe(204);
  });
});

describe('a host that refuses Burrow (2026-11-07 audit)', () => {
  it('a wrong password: one failed login, then a wait instead of a try every ten seconds (fail2ban banned Burrow), said once; the right password connects again within seconds', async () => {
    const password = process.env.DOCKER_SSHD_PASSWORD ?? 'burrow-test-password';
    const body = { name: 'docker-refusing', address: SSHD_HOST, port: PORT, username: 'tester', authMethod: 'password' };
    const w = await t.json<Host>('POST', '/api/hosts', { ...body, password });
    const r = await t.json<ConnectResult>('POST', `/api/hosts/${w.id}/test`);
    if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${w.id}/trust`, { fingerprint: r.fingerprint });
    expect(await t.json<ConnectResult>('POST', `/api/hosts/${w.id}/test`)).toMatchObject({ status: 'ok' });
    const connects = vi.spyOn(t.files, 'with');
    const tries = () => connects.mock.calls.filter(([id]) => id === w.id).length;
    const said = () => t.logEvents.list().filter((e) => e.example.includes('docker-refusing: cannot connect'));
    try {
      await t.json('PUT', `/api/hosts/${w.id}`, { ...body, password: 'not the password' });
      await t.alerts.reconcile();
      await expect.poll(() => said().length, { timeout: 15_000 }).toBe(1);
      const after = tries();
      // Longer than the ten seconds it used to try again after.
      await new Promise((res) => setTimeout(res, 12_000));
      expect(tries()).toBe(after);
      expect(said()[0]!.count).toBe(1);
      // The right password: worth a try at once, not after the wait.
      await t.json('PUT', `/api/hosts/${w.id}`, { ...body, password });
      await expect.poll(() => tries(), { timeout: 15_000 }).toBeGreaterThan(after);
    } finally {
      connects.mockRestore();
      await t.request('DELETE', `/api/hosts/${w.id}`);
      await t.alerts.reconcile();
    }
  }, 60_000);
});
