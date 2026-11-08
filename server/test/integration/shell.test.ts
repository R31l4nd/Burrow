import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectResult, Host, PathEntry, ServerMessage, ShellState, TerminalSessionInfo } from '@burrow/shared';
import { makeApp, openTerminal, setupAdmin, waitForText, type TestApp, type WsClient } from '../helpers.js';

// Shell integration, history capture and completion helpers against the
// throwaway sshd (bash, tmux and a stand-in docker CLI).
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);

let t: TestApp;

async function addHost(tmux: 'never' | 'auto', name: string): Promise<Host> {
  const h = await t.json<Host>('POST', '/api/hosts', {
    name,
    address: SSHD_HOST,
    port: SSHD_PORT,
    username: 'tester',
    authMethod: 'password',
    password: 'burrow-test-password',
    tmux,
  });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  return h;
}

const lastShell = (c: WsClient): ShellState | null => {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!;
    if (m.t === 'shell') return m.shell;
    if (m.t === 'snapshot') return m.shell;
  }
  return null;
};

async function waitShell(c: WsClient, pred: (s: ShellState) => boolean, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!(lastShell(c) && pred(lastShell(c)!))) {
    if (Date.now() > until) throw new Error(`shell state not reached; last: ${JSON.stringify(lastShell(c))}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return lastShell(c)!;
}

async function openSession(host: Host) {
  const s = await t.json<TerminalSessionInfo>('POST', '/api/terminal/sessions', { hostId: host.id, cols: 120, rows: 30 });
  const c = await openTerminal(t, s.id);
  await c.waitFor((m: ServerMessage) => m.t === 'snapshot');
  c.send({ t: 'resize', cols: 120, rows: 30, active: true });
  return { s, c };
}

const history = async (host: Host) => (await t.json<{ command: string }[]>('GET', `/api/hosts/${host.id}/history`)).map((e) => e.command);

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterAll(async () => {
  await t.close();
});

describe('with the shell integration', () => {
  let host: Host;

  it('installs idempotently and is detected', async () => {
    host = await addHost('never', 'integrated');
    for (let i = 0; i < 2; i++) {
      const r = await t.json<ConnectResult>('PUT', `/api/hosts/${host.id}/shell-integration`, { enabled: true });
      expect(r).toMatchObject({ status: 'ok', facts: { hasShellIntegration: true } });
    }
    const { c, s } = await openSession(host);
    await waitShell(c, (x) => x.integration && x.atPrompt);
    c.send({ t: 'input', d: 'grep -c "burrow/shell-integration" ~/.bashrc\r' });
    // The count follows either a newline or the BEL ending an escape sequence.
    // eslint-disable-next-line no-control-regex
    await waitForText(c, /[\n\x07]1\r\n/);
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });

  it('reports prompt, directory and commands; skips space-prefixed ones', async () => {
    const { c, s } = await openSession(host);
    const first = await waitShell(c, (x) => x.integration && x.atPrompt);
    expect(first.prompt).toMatch(/tester@/);

    c.send({ t: 'input', d: 'cd /tmp\r' });
    await waitShell(c, (x) => x.cwd === '/tmp' && x.atPrompt);
    c.send({ t: 'input', d: 'echo from-history-$((1+1))\r' });
    await waitForText(c, 'from-history-2');
    c.send({ t: 'input', d: ' echo hidden-command\r' });
    await waitForText(c, 'hidden-command\r\n');
    // Once more, after another command: bash's ignoredups (Debian's
    // default) does not add a direct repeat, so neither does Burrow.
    c.send({ t: 'input', d: 'true\r' });
    c.send({ t: 'input', d: 'echo from-history-$((1+1))\r' });
    await expect.poll(async () => (await history(host)).filter((x) => x.startsWith('echo from-history')).length).toBe(1);
    const h = await history(host);
    expect(h).toContain('cd /tmp');
    expect(h.join('\n')).not.toContain('hidden-command');
    await expect
      .poll(async () => (await t.json<{ command: string; count: number }[]>('GET', `/api/hosts/${host.id}/history`)).find((e) => e.command.startsWith('echo from-history'))?.count)
      .toBe(2);
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });

  it('runs completion generators and lists paths on the session connection', async () => {
    const { c, s } = await openSession(host);
    await waitShell(c, (x) => x.integration);
    const run = await t.json<{ stdout: string }>('POST', `/api/terminal/sessions/${s.id}/complete/run`, {
      script: ['docker', 'ps', '-a', '--format', '{{ json . }}'],
    });
    expect(run.stdout).toContain('"Names":"radarr"');
    // A string script runs through the shell, in the session's directory.
    c.send({ t: 'input', d: 'cd /etc\r' });
    await waitShell(c, (x) => x.cwd === '/etc');
    expect((await t.json<{ stdout: string }>('POST', `/api/terminal/sessions/${s.id}/complete/run`, { script: 'pwd' })).stdout.trim()).toBe('/etc');

    const ls = await t.json<{ dir: string; entries: PathEntry[] }>('GET', `/api/terminal/sessions/${s.id}/complete/ls?path=ssh`);
    expect(ls.dir).toBe('/etc/ssh');
    expect(ls.entries.find((e) => e.name === 'sshd_config.d')).toMatchObject({ dir: true });
    expect(ls.entries.find((e) => e.name === 'sshd_config')).toMatchObject({ dir: false });
    const home = await t.json<{ dir: string }>('GET', `/api/terminal/sessions/${s.id}/complete/ls?path=${encodeURIComponent('~/')}`);
    expect(home.dir).toBe('/home/tester/');
    // "~root" is root's home, not "/home/testerroot": left as typed.
    const other = await t.json<{ dir: string }>('GET', `/api/terminal/sessions/${s.id}/complete/ls?path=${encodeURIComponent('~root')}`);
    expect(other.dir).not.toBe('/home/testerroot');
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });

  it('works inside tmux too (passthrough)', async () => {
    const tmuxHost = await addHost('auto', 'integrated-tmux');
    const { c, s } = await openSession(tmuxHost);
    expect(s.mode).toBe('tmux');
    const st = await waitShell(c, (x) => x.integration && x.atPrompt && !!x.prompt);
    // No escape sequence may be left in the reported prompt.
    // eslint-disable-next-line no-control-regex
    expect(st.prompt).toMatch(/^tester@[^\x1b]*\$ $/);
    // The input starts right after the prompt: nothing leaks from the
    // wrapped escape sequences.
    c.send({ t: 'input', d: 'echo inside-tmux' });
    await waitForText(c, /\$ echo inside-tmux/);
    c.send({ t: 'input', d: '\r' });
    await expect.poll(async () => history(tmuxHost)).toContain('echo inside-tmux');
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });

  it('uninstalls cleanly', async () => {
    const r = await t.json<ConnectResult>('PUT', `/api/hosts/${host.id}/shell-integration`, { enabled: false });
    expect(r).toMatchObject({ status: 'ok', facts: { hasShellIntegration: false } });
  });
});

describe('without the shell integration', () => {
  it('records echoed typed lines, never an unechoed password', async () => {
    const host = await addHost('never', 'plain-typed');
    const { c, s } = await openSession(host);
    await waitForText(c, '$ ');
    expect(lastShell(c)?.integration).toBe(false);
    c.send({ t: 'input', d: 'echo typed-line\r' });
    await waitForText(c, 'typed-line\r\n');
    // A prompt that does not echo, like sudo's.
    c.send({ t: 'input', d: 'read -s -p "Password: " pw; echo; echo done-reading\r' });
    await waitForText(c, 'Password: ');
    c.send({ t: 'input', d: 'hunter2\r' });
    await waitForText(c, 'done-reading');
    // Tab completion changed the line: not trusted, not recorded.
    c.send({ t: 'input', d: 'ech\to tabbed\r' });
    await waitForText(c, 'tabbed\r\n');
    await expect.poll(() => history(host)).toContain('echo typed-line');
    // The echo check runs a moment after Enter; give the others the same time.
    await new Promise((r) => setTimeout(r, 600));
    const h = await history(host);
    expect(h.join('\n')).not.toContain('hunter2');
    expect(h.join('\n')).not.toContain('tabbed');
    await t.json('DELETE', `/api/terminal/sessions/${s.id}`);
  });
});

describe('history files on the host', () => {
  it("reads bash's and zsh's history into Burrow's", async () => {
    const host = await addHost('never', 'history-import');
    const sh = (command: string) => t.json('POST', '/api/snippets/run', { hostIds: [host.id], command });
    await sh(`echo 'echo from-bash-file' >> ~/.bash_history && printf ': 1767268800:0;echo from-zsh-file\\n' > ~/.zsh_history`);
    try {
      const r = await t.json<{ imported: number; skipped: number }>('POST', `/api/hosts/${host.id}/history/import`);
      expect(r.imported).toBeGreaterThanOrEqual(2);
      expect(await history(host)).toEqual(expect.arrayContaining(['echo from-bash-file', 'echo from-zsh-file']));
      // Twice: each command still once.
      await t.json('POST', `/api/hosts/${host.id}/history/import`);
      const h = await history(host);
      expect(h.filter((c) => c === 'echo from-zsh-file')).toHaveLength(1);
    } finally {
      await sh(`rm -f ~/.zsh_history; sed -i '/^echo from-bash-file$/d' ~/.bash_history`);
    }
  });
});

describe('closing a session whose tmux session cannot be ended (AUDIT2 FS-14)', () => {
  it('a host away: said, the session stays; forgotten only when asked to', async () => {
    const { terminalSessions, users } = await import('../../src/db/schema.js');
    const away = await t.json<Host>('POST', '/api/hosts', { name: 'away', address: '127.0.0.1', port: 1, username: 'tester', authMethod: 'password', password: 'x' });
    const id = 'fs14-away';
    const now = Date.now();
    t.ctx.db.insert(terminalSessions).values({ id, hostId: away.id, userId: t.ctx.db.select().from(users).get()!.id, mode: 'tmux', tmuxName: 'burrow-fs14', title: null, createdAt: now, lastActivityAt: now }).run();
    const r = await t.request('DELETE', `/api/terminal/sessions/${id}`);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: 'host_unreachable' });
    expect((await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions')).some((s) => s.id === id)).toBe(true);
    expect((await t.request('DELETE', `/api/terminal/sessions/${id}?force=1`)).statusCode).toBe(204);
    expect((await t.json<TerminalSessionInfo[]>('GET', '/api/terminal/sessions')).some((s) => s.id === id)).toBe(false);
    await t.json('DELETE', `/api/hosts/${away.id}`);
  });
});
