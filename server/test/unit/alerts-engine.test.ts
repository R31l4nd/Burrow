import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { AlertEngine, lineSplitter, MAX_LINE } from '../../src/alerts/engine.js';
import { retryAfter } from '../../src/ssh/retry.js';
import { alertCounts, alertMutes, alerts } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

let t: TestApp;
let host: Host;
let notify: ReturnType<typeof vi.fn>;
let engine: AlertEngine;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
  host = await t.json<Host>('POST', '/api/hosts', { name: 'h', address: 'h.lan', username: 'me' });
  notify = vi.fn(async () => ({ sent: 1, failed: [] }));
  engine = new AlertEngine(t.ctx, {} as never, {} as never, { notify, lang: () => 'en' } as never);
});
afterEach(async () => t.close());

const rule = () => engine.rules().find((r) => r.kind === 'event')!;
const at = () => new Date(t.clock.now).toISOString();
const rows = () => t.ctx.db.select().from(alerts).all();

describe('alerts bundled and told', () => {
  it('a crash and an unhealthy check are two alerts, each counted in its own minutes (AUDIT2 MON-11)', async () => {
    await engine.fire(rule(), host.id, 'web', 'exited with code 1', null, at());
    await engine.fire(rule(), host.id, 'web', 'unhealthy', null, at());
    t.clock.now += 6 * 60_000;
    await engine.fire(rule(), host.id, 'web', 'exited with code 137', null, at());
    expect(rows().map((a) => [a.title, a.count])).toEqual([
      ['exited with code 137', 2],
      ['unhealthy', 1],
    ]);
    const crash = rows()[0]!;
    // Per minute, so a report counts only what fell in its own period.
    expect(t.ctx.db.select().from(alertCounts).where(eq(alertCounts.alertId, crash.id)).all().map((c) => c.n)).toEqual([1, 1]);
  });

  it('still happening after its mute ended, or after a push that failed, it is told (AUDIT2 MON-12)', async () => {
    t.ctx.db.insert(alertMutes).values({ hostId: host.id, container: 'web', until: t.clock.now + 5 * 60_000 }).run();
    await engine.fire(rule(), host.id, 'web', 'unhealthy', null, at());
    expect(notify).not.toHaveBeenCalled();
    expect(rows()[0]!.pushed).toBe('muted');
    t.clock.now += 6 * 60_000;
    await engine.fire(rule(), host.id, 'web', 'unhealthy', null, at());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ pushed: 'yes', count: 2 });
    // A push that failed is tried again as it recurs, not at every line.
    notify.mockResolvedValue({ sent: 0, failed: [{ channel: 'c', error: 'down' }] });
    await engine.fire(rule(), host.id, 'db', 'unhealthy', null, at());
    expect(rows().find((a) => a.container === 'db')!.pushed).toBe('failed');
    await engine.fire(rule(), host.id, 'db', 'unhealthy', null, at());
    expect(notify).toHaveBeenCalledTimes(2);
    notify.mockResolvedValue({ sent: 1, failed: [] });
    t.clock.now += 5 * 60_000;
    await engine.fire(rule(), host.id, 'db', 'unhealthy', null, at());
    expect(notify).toHaveBeenCalledTimes(3);
    expect(rows().find((a) => a.container === 'db')!.pushed).toBe('yes');
  });

  it('a host deleted while its event was looked at stores nothing and throws nothing (AUDIT2 MON-14)', async () => {
    const r = rule();
    await t.json('DELETE', `/api/hosts/${host.id}`);
    await expect(engine.fire(r, host.id, 'web', 'unhealthy', null, at())).resolves.toBeUndefined();
    expect(rows()).toEqual([]);
  });

  it('a line without end is looked at by its start, not held whole (AUDIT2 MON-15)', () => {
    const seen: string[] = [];
    const push = lineSplitter((l) => seen.push(l));
    push(Buffer.from('first\n'));
    for (let i = 0; i < 40; i++) push(Buffer.alloc(16 * 1024, 'x'));
    push(Buffer.from('xxx\nnext\n'));
    expect(seen.map((l) => l.length)).toEqual([5, MAX_LINE, 4]);
    expect(seen.at(-1)).toBe('next');
  });
});

/** A pool whose host answers each command as `answer` says: its output and exit code. */
function fakePool(answer: (cmd: string) => { out: string; code: number }) {
  const channel = (cmd: string) => {
    // Answered once open: exec keeps the channel's stdin open while the command runs (it ends it on the host at a time-out).
    const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), end: () => {}, close: () => {} });
    setImmediate(() => {
      const a = answer(cmd);
      ch.emit('data', Buffer.from(a.out));
      ch.emit('close', a.code);
    });
    return ch;
  };
  return { with: async (_h: number, fn: (c: { client: unknown }) => unknown) => fn({ client: { exec: (cmd: string, _o: unknown, cb: (e: null, ch: unknown) => void) => cb(null, channel(cmd)) } }) };
}

const died = (name: string, extra: Record<string, string> = {}) => JSON.stringify({ Action: 'die', Actor: { ID: 'x', Attributes: { name, exitCode: '1', ...extra } }, timeNano: 1_000_000_000_000 });

describe('an exit as an alert', () => {
  it("a container gone before its last lines were read: Burrow says so, docker's error is not its output (W-FUNC-08)", async () => {
    const e = new AlertEngine(t.ctx, fakePool(() => ({ out: 'Error response from daemon: No such container: web\n', code: 1 })) as never, {} as never, { notify, lang: () => 'en' } as never);
    const got = new Promise<string | null>((r) => (e.onAlert = (a) => r(a.detail)));
    e.onEvent(host.id, died('web'));
    expect(await got).toBe('(Burrow could not read its last lines: the container is gone.)');
  });

  it('a container Docker named itself, outside compose, raises none; a named one or one of a stack does (decision 18)', async () => {
    const e = new AlertEngine(t.ctx, fakePool(() => ({ out: 'bye\n', code: 0 })) as never, {} as never, { notify, lang: () => 'en' } as never);
    const seen: string[] = [];
    e.onAlert = (a) => void seen.push(a.container);
    for (const name of ['unruffled_montalcini', 'boring_wozniak3', 'my_app', 'web']) e.onEvent(host.id, died(name));
    e.onEvent(host.id, died('nifty_turing', { 'com.docker.compose.project': 'shop' }));
    await vi.waitFor(() => expect([...new Set(seen)].sort()).toEqual(['my_app', 'nifty_turing', 'web']));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.filter((x) => /montalcini|wozniak/.test(x))).toEqual([]);
  });
});

describe('a log rule', () => {
  it("looks at the container's lines only: not docker's own complaint, nor Burrow's end mark (review 2026-10-24)", async () => {
    const { alertRules, hosts } = await import('../../src/db/schema.js');
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).run();
    t.ctx.db.insert(alertRules).values({ name: 'errors', kind: 'pattern', hostId: null, container: null, project: null, events: '[]', pattern: 'Error|ERROR|exit|cannot', threshold: null, windowMinutes: null, enabled: true, builtin: false, createdAt: t.clock.now } as typeof alertRules.$inferInsert).run();
    const monitor = { poll: async () => ({ error: null, containers: [{ id: 'c1', name: 'web', state: 'running', project: null }] }) };
    const out = ['0 e Error response from daemon: No such container: web', '0 e @@burrow-exit 1', '0 o 2026-10-24T10:00:00.000000000Z ERROR boom', '0 x', ''].join('\n');
    // A stream as #lines reads it: exec(command, cb), output as it comes, the logs once.
    let n = 0;
    const exec = (cmd: string, cb: (e: null, ch: unknown) => void) => {
      const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => ch.emit('close') });
      cb(null, ch);
      setImmediate(() => {
        if (cmd.includes('docker logs') && !n++) ch.emit('data', Buffer.from(out));
      });
    };
    const pool = { with: async (_h: number, fn: (c: { client: unknown }) => unknown) => fn({ client: { exec } }) };
    const e = new AlertEngine(t.ctx, pool as never, monitor as never, { notify, lang: () => 'en' } as never);
    const seen: string[] = [];
    e.onAlert = (a) => void seen.push(a.detail ?? '');
    await e.reconcile();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    e.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('boom');
  });
});

describe('a host with more containers than are followed (OPS-W-09)', () => {
  it('a log rule says how many of its containers it sees there, and the log says so once, not every minute', async () => {
    const { alertRules, hosts } = await import('../../src/db/schema.js');
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).run();
    t.ctx.db.insert(alertRules).values({ name: 'errors', kind: 'pattern', hostId: null, container: null, project: null, events: '[]', pattern: 'ERROR', threshold: null, windowMinutes: null, enabled: true, builtin: false, createdAt: t.clock.now } as typeof alertRules.$inferInsert).run();
    const box = (i: number) => ({ id: `c${i}`, name: `app-${i}`, state: 'running', project: i < 30 ? 'shop' : null });
    const monitor = { poll: async () => ({ error: null, containers: Array.from({ length: 100 }, (_, i) => box(i)) }) };
    const idle = { with: async () => new Promise(() => {}) };
    const e = new AlertEngine(t.ctx, idle as never, monitor as never, { notify, lang: () => 'en' } as never);
    const warn = vi.spyOn(t.ctx.log, 'warn');
    await e.reconcile();
    await e.reconcile();
    e.stop();
    expect(warn.mock.calls.filter((c) => String(c.at(-1)).includes('containers to follow'))).toHaveLength(1);
    const rule = e.rulesShown().find((r) => r.name === 'errors')!;
    expect(rule.partial).toEqual([{ hostId: host.id, hostName: 'h', following: 60, total: 100 }]);
    // A rule on the stack alone sees all of its 30.
    t.ctx.db.update(alertRules).set({ project: 'shop' }).run();
    expect(e.rulesShown().find((r) => r.name === 'errors')!.partial).toBeUndefined();
  });
});

describe('the log followers of a host', () => {
  /** A host whose log streams stay open until closed; how many were started, and stopped. */
  function streams() {
    const n = { started: 0, closed: 0 };
    const exec = (cmd: string, cb: (e: null, ch: unknown) => void) => {
      const logs = cmd.includes('docker logs');
      if (logs) n.started++;
      const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => (logs && n.closed++, ch.emit('close')) });
      cb(null, ch);
    };
    return { n, pool: { with: async (_h: number, fn: (c: { client: unknown }) => unknown) => fn({ client: { exec } }) } };
  }
  async function logRule() {
    const { alertRules, hosts } = await import('../../src/db/schema.js');
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).run();
    t.ctx.db.insert(alertRules).values({ name: 'errors', kind: 'pattern', hostId: null, container: null, project: null, events: '[]', pattern: 'ERROR', threshold: null, windowMinutes: null, enabled: true, builtin: false, createdAt: t.clock.now } as typeof alertRules.$inferInsert).run();
  }
  const web = { error: null, containers: [{ id: 'c1', name: 'web', state: 'running', project: null }] };

  it('stays when the containers cannot be read for a moment: stopped and started again at tail 0, what came in between was never looked at (audit 2026-11-05)', async () => {
    await logRule();
    const answers = [web, { error: 'ssh: handshake timed out', containers: [] }, web];
    const monitor = { poll: async () => answers.shift() ?? web };
    const { n, pool } = streams();
    const e = new AlertEngine(t.ctx, pool as never, monitor as never, { notify, lang: () => 'en' } as never);
    for (let i = 0; i < 3; i++) {
      await e.reconcile();
      await new Promise((r) => setTimeout(r, 20));
    }
    e.stop();
    expect(n.started).toBe(1);
  });

  it('one round at a time: a slow round ends after the one asked for since, and does not undo it (a rule switched off kept its follower)', async () => {
    await logRule();
    const { alertRules } = await import('../../src/db/schema.js');
    let calls = 0;
    // The first round's host answers slowly (a host that times out); the rule is switched off meanwhile.
    const monitor = { poll: async () => (calls++ === 0 && (await new Promise((r) => setTimeout(r, 50))), web) };
    const { n, pool } = streams();
    const e = new AlertEngine(t.ctx, pool as never, monitor as never, { notify, lang: () => 'en' } as never);
    const slow = e.reconcile();
    t.ctx.db.update(alertRules).set({ enabled: false }).where(eq(alertRules.name, 'errors')).run();
    await Promise.all([e.reconcile(), slow]);
    await new Promise((r) => setTimeout(r, 20));
    // Whatever the slow round started, the round after it stopped again.
    expect(n.closed).toBe(n.started);
    e.stop();
  });
});

describe('a host that does not let Burrow in', () => {
  /** A pool whose connects fail as `fail` says (null: connected, a stream that stays open); how many were tried, and when. */
  function failing(fail: () => { code: string; message: string } | null, identity: () => string = () => 'same') {
    const tries: number[] = [];
    const open: EventEmitter[] = [];
    let elapsed = 0;
    const pool = {
      identity,
      with: async (_h: number, fn: (c: { client: unknown }) => unknown) => {
        tries.push(elapsed);
        const f = fail();
        if (f) throw Object.assign(new Error(f.message), { code: f.code });
        return fn({ client: { exec: (_cmd: string, cb: (e: null, ch: unknown) => void) => cb(null, open[open.push(Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => {} })) - 1]) } });
      },
    };
    return { pool, tries, open, now: () => elapsed, tick: (ms: number) => (elapsed += ms) };
  }
  async function watched(pool: unknown) {
    const { hosts } = await import('../../src/db/schema.js');
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).run();
    const e = new AlertEngine(t.ctx, pool as never, { poll: async () => ({ error: 'down', containers: [] }) } as never, { notify, lang: () => 'en' } as never, { random: () => 0 });
    await e.reconcile();
    return e;
  }
  async function wait(f: { tick: (ms: number) => void }, minutes: number) {
    for (let s = 0; s < minutes * 6; s++) {
      f.tick(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
    }
  }
  afterEach(() => vi.useRealTimers());

  it('waits longer after each failed connect: ten seconds doubled up to half an hour, five minutes first when refused (fail2ban)', () => {
    expect([1, 2, 3, 4, 8, 9, 20].map((n) => retryAfter(n, 'unreachable', () => 0) / 1000)).toEqual([10, 20, 40, 80, 1280, 1800, 1800]);
    expect([1, 2, 3, 4].map((n) => retryAfter(n, 'auth_failed', () => 0) / 60_000)).toEqual([5, 10, 20, 30]);
    expect(retryAfter(1, 'host_key_mismatch', () => 0)).toBe(5 * 60_000);
    // Spread a little, never past the longest wait.
    expect(retryAfter(1, 'unreachable', () => 1)).toBe(11_000);
    expect(retryAfter(30, 'unreachable', () => 1)).toBe(30 * 60_000);
  });

  it('a wrong password is tried again after 5, 10, 20, 30 minutes, not every ten seconds, and said once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = failing(() => ({ code: 'auth_failed', message: 'The host rejected the credentials.' }));
    const warn = vi.spyOn(t.ctx.log, 'warn');
    const e = await watched(f.pool);
    await wait(f, 70);
    e.stop();
    expect(f.tries.map((ms) => ms / 60_000)).toEqual([0, 5, 15, 35, 65]);
    expect(warn.mock.calls.filter((c) => String(c.at(-1)).includes('rejected the credentials'))).toHaveLength(1);
  });

  it('a host that is off is tried less and less often; once it answers, the next failure starts from ten seconds again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let down = true;
    const f = failing(() => (down ? { code: 'unreachable', message: 'connect EHOSTUNREACH' } : null));
    const info = vi.spyOn(t.ctx.log, 'info');
    const e = await watched(f.pool);
    await wait(f, 10);
    expect(f.tries.map((ms) => ms / 1000)).toEqual([0, 10, 30, 70, 150, 310]);
    down = false;
    await wait(f, 11);
    expect(f.tries).toHaveLength(7);
    expect(info.mock.calls.filter((c) => String(c.at(-1)).includes('h: fine again'))).toHaveLength(1);
    // Off again: its stream ends, and the waits start over.
    down = true;
    const at = f.now();
    f.open.at(-1)!.emit('close');
    await wait(f, 1);
    expect(f.tries.slice(7).map((ms) => (ms - at) / 1000)).toEqual([10, 20, 40]);
    e.stop();
  });

  it('its two streams, Docker events and the logs followed, wait together: one try for both, not a wait each', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { alertRules } = await import('../../src/db/schema.js');
    t.ctx.db.insert(alertRules).values({ name: 'errors', kind: 'pattern', hostId: null, container: null, project: null, events: '[]', pattern: 'ERROR', threshold: null, windowMinutes: null, enabled: true, builtin: false, createdAt: t.clock.now } as typeof alertRules.$inferInsert).run();
    const f = failing(() => ({ code: 'unreachable', message: 'connect EHOSTUNREACH' }));
    const { hosts } = await import('../../src/db/schema.js');
    t.ctx.db.update(hosts).set({ facts: JSON.stringify({ hasDocker: true }) }).run();
    const polls: number[] = [];
    const monitor = { poll: async () => (polls.push(0), { error: null, containers: [{ id: 'c1', name: 'web', state: 'running', project: null }] }) };
    const e = new AlertEngine(t.ctx, f.pool as never, monitor as never, { notify, lang: () => 'en' } as never, { random: () => 0 });
    await e.reconcile();
    await wait(f, 1);
    // The logs' stream starts while the events' first try has failed already: it waits from the start.
    expect(f.tries.map((ms) => ms / 1000)).toEqual([0, 10, 10, 30, 30]);
    // A round meanwhile does not ask the waiting host for its containers either.
    await e.reconcile();
    expect(polls).toHaveLength(1);
    e.stop();
  });

  it('another password or key for the host is tried within ten seconds, whatever the wait was', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let who = 'old password';
    const f = failing(() => (who === 'old password' ? { code: 'auth_failed', message: 'The host rejected the credentials.' } : null), () => who);
    const e = await watched(f.pool);
    await wait(f, 1);
    expect(f.tries).toHaveLength(1);
    who = 'new password';
    await wait(f, 1 / 6);
    expect(f.tries).toHaveLength(2);
    e.stop();
  });
});
