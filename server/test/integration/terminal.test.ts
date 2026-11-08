import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, Host, RunResult, ServerMessage, TerminalSessionInfo } from '@burrow/shared';
import { makeApp, openTerminal, setupAdmin, totpNow, waitForText, type TestApp } from '../helpers.js';

// Against the throwaway sshd from test/sshd, which has tmux.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

const dbFile = join(mkdtempSync(join(tmpdir(), 'burrow-term-')), 'burrow.db');
let t: TestApp;
let host: Host;
let secret = '';

async function addHost(app: TestApp, tmux: 'never' | 'auto', name: string): Promise<Host> {
  const h = await app.json<Host>('POST', '/api/hosts', {
    name,
    address: SSHD_HOST,
    port: SSHD_PORT,
    username: 'tester',
    authMethod: 'password',
    password: 'burrow-test-password',
    tmux,
  });
  const r = await app.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') {
    await app.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  }
  return h;
}

const isExit = (m: ServerMessage): m is Extract<ServerMessage, { t: 'exit' }> => m.t === 'exit';

beforeAll(async () => {
  t = await makeApp({ dbFile });
  ({ secret } = await setupAdmin(t));
  host = await addHost(t, 'never', 'plain');
});
afterAll(async () => {
  await t.close();
});

describe('this once, unlike the host', () => {
  it('starts with tmux on a host set to never, and without on one set to auto', async () => {
    const withTmux = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, tmux: 'always' });
    expect(withTmux.mode).toBe('tmux');
    await t.request('DELETE', `/api/terminal/sessions/${withTmux.id}`);
    const auto = await addHost(t, 'auto', 'auto-host');
    const plain = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: auto.id, tmux: 'never' });
    expect(plain.mode).toBe('memory');
    await t.request('DELETE', `/api/terminal/sessions/${plain.id}`);
  });
});

describe('the list of sessions', () => {
  it('keeps the order they were opened in, whatever was used last', async () => {
    const first = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
    t.advance(1000);
    const second = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
    // The second one used last: the first stays first (tabs swapped places before).
    t.advance(60_000);
    const a = await openTerminal(t, second.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'input', d: 'true\r' });
    await expect.poll(async () => (await t.json<TerminalSessionInfo>('GET', `/api/terminal/sessions/${second.id}`)).lastActivityAt > first.lastActivityAt).toBe(true);
    expect((await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions')).map((x) => x.id)).toEqual([first.id, second.id]);
    a.close();
    await a.closed;
    await t.request('DELETE', `/api/terminal/sessions/${first.id}`);
    await t.request('DELETE', `/api/terminal/sessions/${second.id}`);
  });
});

describe('tmux by default (decision 21)', () => {
  it('a host that says nothing about tmux gets its sessions in tmux where the host has it: they outlive a restart of Burrow', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'unset', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
    expect(h.tmux).toBeNull();
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: h.id });
    expect(s.mode).toBe('tmux');
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
    await t.json('DELETE', `/api/hosts/${h.id}`);
  });
});

describe('memory mode', () => {
  it('two viewers share one shell; the late one gets the current screen', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 100, rows: 30 });
    expect(s).toMatchObject({ mode: 'memory', attached: true, cols: 100 });

    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 100, rows: 30, active: true });
    a.send({ t: 'input', d: 'echo burrow-$((40+2))\r' });
    await waitForText(a, 'burrow-42');

    // A second device attaches later and sees what is on the screen now.
    const b = await openTerminal(t, s.id);
    const snap = await b.waitFor((m): m is Extract<ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(snap.data).toContain('burrow-42');
    expect(snap.cols).toBe(100);

    // The second device's terminal answering a program's question (as every browser does), and its
    // focus going: not typing; the program gets none of it (review 2026-10-24: vim got them as keys).
    a.send({ t: 'input', d: 'read -t 2 -rsn3 x; echo "got:[${#x}]"\r' });
    await new Promise((r) => setTimeout(r, 300));
    b.send({ t: 'input', d: '\x1b[>0;276;0c' });
    b.send({ t: 'input', d: '\x1b[O' });
    await waitForText(a, 'got:[0]');

    // A program that takes the mouse (a tmux of your own: SGR encoding):
    // a device that comes back gets the mouse in that encoding too, or tmux
    // misreads a finger's scroll.
    a.send({ t: 'input', d: "printf '\\033[?1000h\\033[?1006h'; echo mouse-$((1+1))on\r" });
    await waitForText(a, 'mouse-2on');
    const c = await openTerminal(t, s.id);
    const again = await c.waitFor((m): m is Extract<ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(again.data).toContain('\x1b[?1000h');
    expect(again.data).toContain('\x1b[?1006h');
    a.send({ t: 'input', d: "printf '\\033[?1006l\\033[?1000l'\r" });
    c.close();
    await c.closed;

    // What B types, A sees.
    b.send({ t: 'input', d: 'echo from-b-$((2*3))\r' });
    await waitForText(a, 'from-b-6');

    // Typing made B the active device: its size wins, A is told.
    b.send({ t: 'resize', cols: 60, rows: 20, active: true });
    await a.waitFor((m) => m.t === 'size' && m.cols === 60 && !m.owner);

    const list = await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions');
    expect(list[0]?.viewers).toHaveLength(2);

    // Closing a tab detaches; the session keeps running.
    a.close();
    await a.closed;
    await expect
      .poll(async () => (await t.json<TerminalSessionInfo>('GET', `/api/terminal/sessions/${s.id}`)).viewers.length)
      .toBe(1);

    // An explicit close ends it for everyone.
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
    expect(await b.waitFor(isExit)).toMatchObject({ reason: 'closed' });
    expect(await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions')).toHaveLength(0);
  });

  it("a directory asked for is gone to once, the line not shown twice (report 597e6b: typed before the prompt, echoed and shown again)", async () => {
    // Without tmux the cd is typed once the shell is ready; in tmux the session starts there, nothing typed.
    for (const [tmux, times] of [['never', 1], ['always', 0]] as const) {
      const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 100, rows: 30, cwd: '/tmp', tmux });
      const a = await openTerminal(t, s.id);
      await a.waitFor((m) => m.t === 'snapshot');
      // As a person types: once the prompt is there (a key sooner sends the cd at once, before it).
      await new Promise((r) => setTimeout(r, 1500));
      a.send({ t: 'input', d: 'echo "at:$(pwd)"\r' });
      await waitForText(a, 'at:/tmp');
      const b = await openTerminal(t, s.id);
      const snap = await b.waitFor((m): m is Extract<ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot');
      expect(snap.data.split("cd -- '/tmp'").length - 1, tmux).toBe(times);
      a.close();
      b.close();
      await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
    }
  });

  it('`exit` in the shell ends the session', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'input', d: 'exit\r' });
    expect(await a.waitFor(isExit)).toMatchObject({ reason: 'ended' });
    expect((await t.request('GET', `/api/terminal/sessions/${s.id}`)).statusCode).toBe(404);
  });

  it('signing out closes the sockets but not the terminal', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    const cookie = t.cookie;
    await t.request('POST', '/api/auth/logout');
    expect(await a.closed).toBe(4401);
    // The old cookie is dead too.
    t.cookie = cookie;
    expect((await t.request('GET', '/api/terminal/sessions')).statusCode).toBe(401);
  });
});

describe('tmux mode', () => {
  it('survives a restart of Burrow and is killed on the host by an explicit close', async () => {
    // New app, same DB: the earlier sign-out test left us signed out.
    await t.close();
    t = await makeApp({ dbFile });
    await signInAgain(t);

    const tmuxHost = await addHost(t, 'auto', 'with-tmux');
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: tmuxHost.id, cols: 90, rows: 25 });
    expect(s.mode).toBe('tmux');
    // Its own name, trimmed; kept over the restart below.
    expect(await t.json<TerminalSessionInfo>('PUT', `/api/terminal/sessions/${s.id}/title`, { title: '  build  ' })).toMatchObject({ id: s.id, title: 'build' });
    expect((await t.request('PUT', `/api/terminal/sessions/${s.id}/title`, { title: 'x'.repeat(41) })).statusCode).toBe(400);
    expect((await t.request('PUT', '/api/terminal/sessions/nope/title', { title: 'x' })).statusCode).toBe(404);
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 90, rows: 25, active: true });
    a.send({ t: 'input', d: 'echo before-restart-$((7*6))\r' });
    await waitForText(a, 'before-restart-42');

    // "Restart": the process goes away, tmux keeps the shell on the host.
    const cookie = t.cookie;
    await t.close();
    t = await makeApp({ dbFile });
    t.cookie = cookie;
    const listed = await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions');
    expect(listed.find((x) => x.id === s.id)).toMatchObject({ attached: false, mode: 'tmux', title: 'build' });
    // Empty: the host's name again.
    expect(await t.json<TerminalSessionInfo>('PUT', `/api/terminal/sessions/${s.id}/title`, { title: '' })).toMatchObject({ title: null });

    const b = await openTerminal(t, s.id);
    // At the size it had, not 80x24 first: a full-screen program drew itself twice (review 2026-10-24).
    const back = await b.waitFor((m): m is Extract<ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot');
    expect([back.cols, back.rows]).toEqual([90, 25]);
    b.send({ t: 'resize', cols: 90, rows: 25, active: true });
    // tmux redraws its screen on attach: the old output is back.
    await waitForText(b, 'before-restart-42');
    b.send({ t: 'input', d: 'echo after-restart\r' });
    await waitForText(b, 'after-restart');

    // Burrow's tmux has no prefix key: Ctrl+B d reaches the program (here
    // cat -v shows it), it does not detach the session.
    b.send({ t: 'input', d: 'cat -v\r' });
    await new Promise((r) => setTimeout(r, 300));
    b.send({ t: 'input', d: '\x02d\r' });
    await waitForText(b, '^Bd');
    b.send({ t: 'input', d: '\x03' });
    b.send({ t: 'input', d: 'echo still-attached\r' });
    await waitForText(b, 'still-attached');

    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
    await b.waitFor(isExit);
    const check = await t.json<RunResult[]>('POST', '/api/snippets/run', {
      command: 'tmux -L burrow ls 2>&1 || true',
      hostIds: [tmuxHost.id],
    });
    expect(check[0]?.stdout).not.toContain(s.id.replace(/[^A-Za-z0-9]/g, 'x'));
  });
});

describe("the person's own tmux from inside Burrow's", () => {
  it('tmux ls and tmux attach reach the sessions started outside Burrow; $TMUX stays set for a .bashrc (review 2026-10-24)', async () => {
    const run = (command: string) => t.json<RunResult[]>('POST', '/api/snippets/run', { command, hostIds: [host.id] });
    // Started by hand over plain ssh, on tmux's own default server.
    await run("tmux new-session -d -s main 'echo own-$((40+2)); exec sh'");
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'always' });
    expect(s.mode).toBe('tmux');
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    a.send({ t: 'input', d: '[ -n "$TMUX" ] && echo set-$((1+1))\r' });
    await waitForText(a, 'set-2');
    a.send({ t: 'input', d: 'tmux ls\r' });
    await waitForText(a, 'main: 1 windows');
    a.send({ t: 'input', d: 'tmux attach -t main\r' });
    await waitForText(a, 'own-42');
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
    // Burrow's own server is untouched by it, and the person's is still there.
    expect((await run('tmux ls'))[0]?.stdout).toContain('main:');
    await run('tmux kill-server');
  });
});

describe("a finger's scroll in Burrow's tmux", () => {
  it("goes through tmux's own history, and typing after it reaches the shell", async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'always' });
    expect(s.mode).toBe('tmux');
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    // Fast output: tmux redraws the screen rather than scrolling it.
    a.send({ t: 'input', d: 'seq 1 500\r' });
    // Its output, not the echo of the command ("seq 1 500" has 500 in it): on a busy machine the
    // scroll came before the lines, into an empty history.
    await waitForText(a, '499');
    // Back 100 lines: tmux's copy mode, its position in the corner ("[100/...]").
    a.send({ t: 'scroll', lines: 100 });
    await waitForText(a, '[100/');
    // A fast swipe: many small steps at once. One tmux command at a time on
    // the host, the rest gathered into the next; none is lost.
    for (let i = 0; i < 30; i++) a.send({ t: 'scroll', lines: 5 });
    await waitForText(a, '[250/');
    for (let i = 0; i < 10; i++) a.send({ t: 'scroll', lines: -5 });
    await waitForText(a, '[200/');
    // Typed now, a key at a time as a keyboard does: out of copy mode first,
    // then the shell gets every key in order (the first one waited for tmux,
    // and the next ones overtook it), and the history the whole line.
    for (const ch of 'echo after-$((40+2))\r') a.send({ t: 'input', d: ch });
    await waitForText(a, 'after-42');
    // Learnt a moment after the echo is checked (300 ms, then the write): more
    // than the poll's default second when the machine is busy.
    const commands = async () => (await t.json<{ command: string }[]>('GET', `/api/hosts/${host.id}/history`)).map((e) => e.command);
    await expect.poll(commands, { timeout: 20_000, message: 'the whole line in the history' }).toContain('echo after-$((40+2))');
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  });
});

describe("the history layer: a session's whole history at once (2.19.0)", () => {
  it("is tmux's history with its colours in Burrow's tmux, the server's copy without it, and says so for a program on tmux's alternate screen", async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'always' });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    // Fast output: tmux redraws the screen rather than scrolling it, so only its own history has the first lines.
    a.send({ t: 'input', d: "seq 1 500; printf '\\033[32mgreen-%s\\033[0m\\n' 42\r" });
    await waitForText(a, 'green-42');
    a.send({ t: 'history' });
    const h = (await a.waitFor((m) => m.t === 'history')) as Extract<ServerMessage, { t: 'history' }>;
    expect(h.alt ?? false).toBe(false);
    expect(h.failed ?? false).toBe(false);
    const lines = h.data.split('\n');
    // All of it, in order, the first lines too, and the colour kept.
    expect(lines.indexOf('1')).toBeGreaterThan(-1);
    expect(lines.indexOf('500')).toBeGreaterThan(lines.indexOf('1'));
    expect(h.data).toContain('\x1b[32mgreen-42');
    // Nothing on the host changed: no pane of Burrow's tmux went into a mode.
    const modes = await t.json<RunResult[]>('POST', '/api/snippets/run', { command: "tmux -L burrow list-panes -a -F '#{pane_in_mode}'", hostIds: [host.id] });
    expect(modes[0]?.stdout.split('\n').filter(Boolean)).not.toContain('1');

    // A program on its alternate screen (a pager): no history of its own there, scrolled as before.
    a.send({ t: 'input', d: "printf '\\033[?1049h'; read -rsn1 k; printf '\\033[?1049l'; echo done-$((40+2))\r" });
    await new Promise((r) => setTimeout(r, 800));
    a.send({ t: 'history' });
    const alt = (await a.waitFor((m) => m.t === 'history' && m !== h)) as Extract<ServerMessage, { t: 'history' }>;
    expect(alt.alt).toBe(true);
    a.send({ t: 'input', d: 'q' });
    await waitForText(a, 'done-42');
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);

    // Without tmux: the server's own copy of the screen and what scrolled off it.
    const m = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'never' });
    const b = await openTerminal(t, m.id);
    await b.waitFor((x) => x.t === 'snapshot');
    b.send({ t: 'input', d: 'seq 1001 1300\r' });
    await waitForText(b, '1299');
    b.send({ t: 'history' });
    const mh = (await b.waitFor((x) => x.t === 'history')) as Extract<ServerMessage, { t: 'history' }>;
    const ml = mh.data.replace(/\r/g, '').split('\n');
    expect(ml).toContain('1001');
    expect(ml).toContain('1300');
    await t.request('DELETE', `/api/terminal/sessions/${m.id}`);
  });

  it("is the history of a tmux of the person's own attached in it (Claude Code in it), with the mouse too; a program with the mouse elsewhere keeps its wheel", async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'always' });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    await waitForText(a, '$');
    const ask = async (mouse: boolean) => {
      const seen = new Set(a.messages.filter((m) => m.t === 'history'));
      a.send({ t: 'history', mouse });
      return (await a.waitFor((m) => m.t === 'history' && !seen.has(m))) as Extract<ServerMessage, { t: 'history' }>;
    };
    // A program that took the mouse in Burrow's own pane: its wheel, as before.
    expect((await ask(true)).alt).toBe(true);
    // The person's own tmux, mouse on as they set it, and output in it that Burrow's pane only has the screen of.
    a.send({ t: 'input', d: "tmux -f /dev/null new-session -s mine \\; set -g mouse on\r" });
    await new Promise((r) => setTimeout(r, 1500));
    a.send({ t: 'input', d: 'seq 1 300; echo own-$((40+2))\r' });
    await waitForText(a, 'own-42');
    for (const mouse of [true, false]) {
      const h = await ask(mouse);
      expect(h.alt ?? false, `mouse ${mouse}`).toBe(false);
      const lines = h.data.replace(/\r/g, '').split('\n');
      expect(lines, `mouse ${mouse}`).toContain('1');
      expect(lines.indexOf('300')).toBeGreaterThan(lines.indexOf('1'));
    }
    // A pager in it: its alternate screen, scrolled as before.
    a.send({ t: 'input', d: "printf '\\033[?1049h'; read -rsn1 k; printf '\\033[?1049l'\r" });
    await new Promise((r) => setTimeout(r, 1000));
    expect((await ask(true)).alt).toBe(true);
    a.send({ t: 'input', d: 'q' });
    await t.json('POST', '/api/snippets/run', { command: 'tmux kill-server; true', hostIds: [host.id] });
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  });

  it("is the history of a tmux of the person's own attached in a session without Burrow's tmux, the mouse on or off; not another session's (2026-11-07)", async () => {
    const open = async () => {
      const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'never' });
      const c = await openTerminal(t, s.id);
      await c.waitFor((m) => m.t === 'snapshot');
      c.send({ t: 'resize', cols: 80, rows: 20, active: true });
      await waitForText(c, '$');
      return { s, c };
    };
    const ask = async (c: Awaited<ReturnType<typeof openTerminal>>, mouse: boolean) => {
      const seen = new Set(c.messages.filter((m) => m.t === 'history'));
      c.send({ t: 'history', mouse });
      return (await c.waitFor((m) => m.t === 'history' && !seen.has(m))) as Extract<ServerMessage, { t: 'history' }>;
    };
    const { s, c: a } = await open();
    const { s: s2, c: b } = await open();
    // A program that took the mouse, no tmux of the person's own: its wheel, as before.
    b.send({ t: 'input', d: "printf '\\033[?1000h'; read -rsn1 k; printf '\\033[?1000l'\r" });
    await new Promise((r) => setTimeout(r, 800));
    expect((await ask(b, true)).alt).toBe(true);
    for (const mouse of ['on', 'off']) {
      a.send({ t: 'input', d: `tmux -f /dev/null new-session -s mine-${mouse} \\; set -g mouse ${mouse}\r` });
      await new Promise((r) => setTimeout(r, 1500));
      a.send({ t: 'input', d: `seq 1 300; echo own-${mouse}-$((40+2))\r` });
      await waitForText(a, `own-${mouse}-42`);
      const h = await ask(a, mouse === 'on');
      expect(h.alt ?? false, `mouse ${mouse}`).toBe(false);
      expect(h.failed ?? false, `mouse ${mouse}`).toBe(false);
      const lines = h.data.replace(/\r/g, '').split('\n');
      expect(lines, `mouse ${mouse}`).toContain('1');
      expect(lines.indexOf('300')).toBeGreaterThan(lines.indexOf('1'));
      // The other session, its program still holding the mouse, is not shown this tmux.
      expect((await ask(b, true)).alt).toBe(true);
      // A pager in it: its alternate screen, scrolled as before.
      a.send({ t: 'input', d: "printf '\\033[?1049h'; read -rsn1 k; printf '\\033[?1049l'\r" });
      await new Promise((r) => setTimeout(r, 1000));
      expect((await ask(a, mouse === 'on')).alt, `pager, mouse ${mouse}`).toBe(true);
      a.send({ t: 'input', d: 'q' });
      await new Promise((r) => setTimeout(r, 500));
      a.send({ t: 'input', d: 'tmux kill-session\r' });
      await new Promise((r) => setTimeout(r, 1000));
    }
    b.send({ t: 'input', d: 'q' });
    await t.json('POST', '/api/snippets/run', { command: 'tmux kill-server; true', hostIds: [host.id] });
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
    await t.request('DELETE', `/api/terminal/sessions/${s2.id}`);
  });
});

describe("a finger's scroll over a full-screen program in Burrow's tmux", () => {
  it('reaches the program as arrow keys (less, man, vim without the mouse), not tmux history from before it (review 2026-10-24)', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'always' });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    // On its alternate screen, reading three keys as a pager would.
    a.send({ t: 'input', d: "printf '\\033[?1049h'; read -rsn6 k; printf '\\033[?1049l'; printf 'got:%q\\n' \"$k\"\r" });
    await new Promise((r) => setTimeout(r, 800));
    a.send({ t: 'scroll', lines: 2 });
    await waitForText(a, "got:$'\\E[A\\E[A'");
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  });
});

describe("typing straight after a finger's swipe in Burrow's tmux", () => {
  it('reaches the shell: no scroll step still on its way puts tmux back in its history', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'always' });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    a.send({ t: 'input', d: 'seq 1 500\r' });
    // Its output, not the echo of the command ("seq 1 500" has 500 in it): on a busy machine the
    // scroll came before the lines, into an empty history.
    await waitForText(a, '499');
    // A swipe, and typing at once: the keys came while tmux still had scroll
    // steps to do, and the next step took the pane back into copy mode.
    for (let i = 0; i < 20; i++) a.send({ t: 'scroll', lines: 5 });
    for (const ch of 'echo swiped-$((40+2))\r') a.send({ t: 'input', d: ch });
    await waitForText(a, 'swiped-42');
    // And out of copy mode for good: no pane of Burrow's tmux is in a mode.
    await new Promise((r) => setTimeout(r, 1000));
    const modes = await t.json<RunResult[]>('POST', '/api/snippets/run', { command: "tmux -L burrow list-panes -a -F '#{pane_in_mode}'", hostIds: [host.id] });
    expect(modes[0]?.stdout.split('\n').filter(Boolean)).not.toContain('1');
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  });
});

describe('the history without the shell integration', () => {
  it('keeps what was echoed, a long wrapped line too, and not what was typed at a silent prompt', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20 });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    const history = async () => (await t.json<{ command: string }[]>('GET', `/api/hosts/${host.id}/history`)).map((e) => e.command);
    // A secret printed (as pwgen does), then typed at a prompt that does not
    // echo: the same text is on the screen above, but it is not an echo.
    a.send({ t: 'input', d: 'echo Zq7-$((6*7))-secret\r' });
    await waitForText(a, 'Zq7-42-secret');
    a.send({ t: 'input', d: 'read -s pw; echo "len:${#pw}"\r' });
    await new Promise((r) => setTimeout(r, 400));
    a.send({ t: 'input', d: 'Zq7-42-secret\r' });
    await waitForText(a, 'len:13');
    // Longer than the 80 columns: wrapped over two rows, still one command.
    const long = `echo ${'w'.repeat(90)}-end`;
    a.send({ t: 'input', d: `${long}\r` });
    await waitForText(a, '-end');
    await expect.poll(history).toContain(long);
    const kept = await history();
    expect(kept).toContain('echo Zq7-$((6*7))-secret');
    expect(kept).not.toContain('Zq7-42-secret');
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });
});

describe("the stored password in tmux's history", () => {
  it('leaves the history first, then reaches the prompt', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 80, rows: 20, tmux: 'always' });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    a.send({ t: 'resize', cols: 80, rows: 20, active: true });
    a.send({ t: 'input', d: 'seq 1 200; echo seq-$((3*7)); read -s pw; echo "got:${#pw}"\r' });
    // The output, not the echo of the command line ("200" is in both): with SSH's small writes no
    // longer held back (OPS-W-01) the scroll came before the lines were in tmux's history.
    await waitForText(a, 'seq-21');
    // Scrolled back by a finger: tmux's copy mode.
    a.send({ t: 'scroll', lines: 50 });
    await waitForText(a, '[50/');
    a.send({ t: 'password' });
    await a.waitFor((m) => m.t === 'notice' && m.code === 'password_sent');
    a.send({ t: 'input', d: '\r' });
    await waitForText(a, 'got:20');
    await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
  });
});

describe('snippets on several hosts', () => {
  it('a command that waits for input gets none and ends at once', async () => {
    const started = Date.now();
    const r = await t.json<RunResult[]>('POST', '/api/snippets/run', { command: 'read answer; echo "got:[$answer]"', hostIds: [host.id] });
    expect(r[0]?.stdout).toContain('got:[]');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('runs a command per host and reports exit codes', async () => {
    const r = await t.json<RunResult[]>('POST', '/api/snippets/run', { command: 'echo hi-$(whoami); exit 3', hostIds: [host.id] });
    expect(r[0]).toMatchObject({ hostName: 'plain', status: 'failed', exitCode: 3 });
    expect(r[0]?.stdout).toContain('hi-tester');
  });
});

describe('password paste', () => {
  it('types the stored password without Enter and audits it', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    // `read -s` behaves like a sudo prompt: no echo, then we print what came in.
    a.send({ t: 'input', d: 'read -s pw; echo "got:${#pw}:$pw"\r' });
    await new Promise((r) => setTimeout(r, 300));
    a.send({ t: 'password' });
    await a.waitFor((m) => m.t === 'notice' && m.code === 'password_sent');
    // Nothing happens until Enter.
    await new Promise((r) => setTimeout(r, 300));
    expect(a.text()).not.toContain('got:20');
    a.send({ t: 'input', d: '\r' });
    await waitForText(a, 'got:20:burrow-test-password');
    const audit = await t.json<{ action: string; details: unknown }[]>('GET', '/api/audit');
    const entry = audit.find((e) => e.action === 'terminal.password_paste');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('burrow-test-password');
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });
});

describe('socket hygiene', () => {
  it('refuses a WebSocket from another origin or without a session', async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
    await expect(openTerminal(t, s.id, { origin: 'https://evil.example' })).rejects.toThrow();
    await expect(openTerminal(t, s.id, { cookie: null })).rejects.toThrow();
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });

  it("completion runs only for a sign-in that has the session open: not out of sight of the session's viewers (audit 2026-10-30)", async () => {
    const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
    // Live on the host, but no viewer of this sign-in: refused, nothing run.
    const before = await t.request('POST', `/api/terminal/sessions/${s.id}/complete/run`, { script: ['echo', 'unseen'] });
    expect(before.json()).toMatchObject({ error: 'not_viewing' });
    expect((await t.request('GET', `/api/terminal/sessions/${s.id}/complete/ls?path=/`)).json()).toMatchObject({ error: 'not_viewing' });
    // Open on screen (a viewer, in the session's list): run.
    const a = await openTerminal(t, s.id);
    await a.waitFor((m) => m.t === 'snapshot');
    expect(await t.json('POST', `/api/terminal/sessions/${s.id}/complete/run`, { script: ['echo', 'seen'] })).toEqual({ stdout: 'seen\n' });
    a.close();
    await a.closed;
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });

  it('a new session needs a fresh step-up', async () => {
    t.advance(16 * 60_000);
    const r = await t.request('POST', '/api/terminal/sessions', { hostId: host.id });
    expect(r.json()).toMatchObject({ error: 'step_up_required' });
  });
});

/** The logout test ended the session; sign in again with a recovery code. */
async function signInAgain(app: TestApp) {
  app.cookie = null;
  // setupAdmin stored codes only in the first app; generate fresh ones directly.
  const { regenerateRecoveryCodes } = await import('../../src/auth/recovery.js');
  const codes = regenerateRecoveryCodes(app.ctx, 1);
  await app.json('POST', '/api/auth/recovery', { username: 'admin', code: codes[0] });
}

describe('the session limit', () => {
  it('holds when several sessions are opened at once (audit BE-26)', async () => {
    const own = await makeApp({ dbFile: join(mkdtempSync(join(tmpdir(), 'burrow-limit-')), 'burrow.db'), env: { TERMINAL_MAX_SESSIONS: '2' } });
    try {
      await setupAdmin(own);
      const h = await addHost(own, 'never', 'limited');
      // Four at once: each was checked against the open ones before any was made.
      const all = await Promise.all([1, 2, 3, 4].map(() => own.request('POST', '/api/terminal/sessions', { hostId: h.id })));
      expect(all.map((r) => r.statusCode).sort()).toEqual([200, 200, 409, 409]);
      const open = await own.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions');
      expect(open).toHaveLength(2);
      for (const s of open) await own.request('DELETE', `/api/terminal/sessions/${s.id}`);
    } finally {
      await own.close();
    }
  });
});

describe("the AI dialog's conversation, kept with the session (report 411dbe)", () => {
  it('earlier turns go along masked and come back on any device; forgotten when cleared and when the session ends', async () => {
    // A stand-in OpenAI-compatible model: answers with the request it was asked last.
    const { createServer } = await import('node:http');
    const asked: string[] = [];
    const llm = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        asked.push(raw);
        const text = JSON.stringify(JSON.parse(raw || '{}'));
        const n = asked.length;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ command: `echo turn-${n}`, explanation: text.includes('Earlier in this conversation') ? 'with context' : 'alone', risk: 'low', risk_reason: '' }) } }] }));
      });
    });
    await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
    try {
      const port = (llm.address() as { port: number }).port;
      // Confirmed again: the tests before took longer than a step-up lasts.
      t.advance(30_000);
      await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
      await t.json('PUT', '/api/settings/ai', { provider: 'openai', ollama: { url: 'http://127.0.0.1:1', model: '' }, anthropic: { model: 'claude-sonnet-5' }, openai: { url: `http://127.0.0.1:${port}/v1`, model: 'm' } });
      const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id });
      expect(await t.json('GET', `/api/terminal/sessions/${s.id}/ai`)).toEqual([]);
      const first = await t.json<{ command: string; explanation: string }>('POST', '/api/ai/command', { hostId: host.id, prompt: 'list files with password=hunter2', sessionId: s.id });
      expect(first).toMatchObject({ command: 'echo turn-1', explanation: 'alone' });
      const second = await t.json<{ explanation: string }>('POST', '/api/ai/command', { hostId: host.id, prompt: 'make it recursive', sessionId: s.id });
      expect(second.explanation).toBe('with context');
      // The first turn went along with the second, masked, and was kept masked.
      expect(asked[1]).toContain('list files with password=');
      expect(asked.join('')).not.toContain('hunter2');
      const turns = await t.json<{ prompt: string; command: string }[]>('GET', `/api/terminal/sessions/${s.id}/ai`);
      expect(turns.map((x) => x.command)).toEqual(['echo turn-1', 'echo turn-2']);
      expect(turns[0]!.prompt).not.toContain('hunter2');
      expect(turns[1]!.prompt).toBe('make it recursive');
      // Asked from a session on another host: refused, not mixed in.
      const other = await addHost(t, 'never', 'other-ai');
      expect((await t.request('POST', '/api/ai/command', { hostId: other.id, prompt: 'x', sessionId: s.id })).statusCode).toBe(400);
      // Start over.
      expect((await t.request('DELETE', `/api/terminal/sessions/${s.id}/ai`)).statusCode).toBe(204);
      expect(await t.json('GET', `/api/terminal/sessions/${s.id}/ai`)).toEqual([]);
      await t.json('POST', '/api/ai/command', { hostId: host.id, prompt: 'again', sessionId: s.id });
      // The session ends: its conversation goes with it.
      await t.request('DELETE', `/api/terminal/sessions/${s.id}`);
      expect((await t.request('GET', `/api/terminal/sessions/${s.id}/ai`)).statusCode).toBe(404);
      expect((await t.request('POST', '/api/ai/command', { hostId: host.id, prompt: 'x', sessionId: s.id })).statusCode).toBe(404);
    } finally {
      llm.close();
    }
  });
});
