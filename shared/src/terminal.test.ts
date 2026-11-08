import { describe, expect, it } from 'vitest';
import { clientMessage, createSessionInput, fillSnippet, isTermReply, sessionLabel, snippetDefaults, snippetReady, snippetVariables, type TerminalSessionInfo } from './terminal.js';
import { suggestedName, worthSuggesting } from './snippets.js';

describe('snippet variables', () => {
  it('finds each variable once, in order', () => {
    expect(snippetVariables('docker logs {{container}} --tail {{ lines }} | grep {{container}}').map((v) => v.name)).toEqual(['container', 'lines']);
    expect(snippetVariables('uptime')).toEqual([]);
  });

  it('reads defaults, choices and optional values', () => {
    const vars = snippetVariables('journalctl -u {{unit=docker}} -n {{lines=50|200|1000}} {{extra=}} {{since}}');
    expect(vars).toEqual([
      { name: 'unit', value: 'docker', choices: [], optional: false },
      { name: 'lines', value: '50', choices: ['50', '200', '1000'], optional: false },
      { name: 'extra', value: '', choices: [], optional: true },
      { name: 'since', value: '', choices: [], optional: false },
    ]);
    expect(snippetDefaults(vars)).toEqual({ unit: 'docker', lines: '50', extra: '', since: '' });
    expect(snippetReady(vars, snippetDefaults(vars))).toBe(false);
    expect(snippetReady(vars, { ...snippetDefaults(vars), since: 'today' })).toBe(true);
    // The one that says more wins, wherever it is.
    expect(snippetVariables('echo {{a}} {{a=x}}')[0]).toMatchObject({ value: 'x' });
    expect(snippetVariables('echo {{a=x}} {{a=y}}')[0]).toMatchObject({ value: 'x' });
  });

  it('fills every use of a variable, with or without its default', () => {
    expect(fillSnippet('docker logs {{container}} {{x}}', { container: 'radarr' })).toBe('docker logs radarr {{x}}');
    expect(fillSnippet('tail -n {{n=50|100}} f; echo {{n}}', { n: '100' })).toBe('tail -n 100 f; echo 100');
    expect(fillSnippet('ls {{flags=}}', { flags: '' })).toBe('ls ');
  });
});

describe('client messages', () => {
  it('accepts the protocol and rejects the rest', () => {
    expect(clientMessage.safeParse({ t: 'input', d: 'ls\r' }).success).toBe(true);
    expect(clientMessage.safeParse({ t: 'resize', cols: 80, rows: 24, active: true }).success).toBe(true);
    expect(clientMessage.safeParse({ t: 'resize', cols: 5000, rows: 24 }).success).toBe(false);
    expect(clientMessage.safeParse({ t: 'exec', d: 'x' }).success).toBe(false);
  });
});

describe('session names', () => {
  const s = (id: string, createdAt: string, title: string | null = null) => ({ id, hostId: 1, hostName: 'Debian', title, createdAt }) as TerminalSessionInfo;

  it('the first session on a host keeps its name when a second opens (newest listed first)', () => {
    const list = [s('new', '2026-09-30T10:00:00Z'), s('old', '2026-09-30T08:00:00Z')];
    expect(sessionLabel(list[1]!, list)).toBe('Debian');
    expect(sessionLabel(list[0]!, list)).toBe('Debian 2');
  });

  it('a name of its own is used as it is, and not counted', () => {
    const list = [s('a', '2026-09-30T08:00:00Z', 'build'), s('b', '2026-09-30T09:00:00Z')];
    expect(sessionLabel(list[0]!, list)).toBe('build');
    expect(sessionLabel(list[1]!, list)).toBe('Debian');
  });
});

describe('suggested snippets', () => {
  it('leaves out what is quicker to type than to pick', () => {
    for (const c of ['htop', 'git pull', 'ls -la /srv/media', 'cd /srv/media/compose', 'cat /etc/hosts.allow']) expect(worthSuggesting(c), c).toBe(false);
    for (const c of ['docker compose logs -f sonarr', 'sudo apt update && sudo apt upgrade -y', 'tail -f /var/log/syslog | grep wg0']) expect(worthSuggesting(c), c).toBe(true);
  });

  it('names one by its first words', () => {
    expect(suggestedName('docker compose -f /srv/media/compose.yaml logs -f sonarr')).toBe('docker compose -f /srv/media/compose.yaml');
    expect(suggestedName('systemctl status wg-quick@wg0')).toBe('systemctl status wg-quick@wg0');
    expect(suggestedName(`./${'x'.repeat(70)} --flag`)).toBe(`./${'x'.repeat(57)}...`);
  });
});

describe('a new terminal session', () => {
  it('a starting folder with a control character in its name is refused: it is typed into the shell, where a line break runs what follows (AUDIT2 FS-04)', () => {
    expect(createSessionInput.safeParse({ hostId: 1, cwd: '/srv/app' }).success).toBe(true);
    expect(createSessionInput.safeParse({ hostId: 1, cwd: '/srv/odd name (2)' }).success).toBe(true);
    for (const cwd of ['/tmp/x\necho ran', '/tmp/x\recho ran', '/tmp/x\x03', '/tmp/\x1b[A', '/tmp/x\x7f']) expect(createSessionInput.safeParse({ hostId: 1, cwd }).success, JSON.stringify(cwd)).toBe(false);
  });
});

describe("a terminal's own answers, not someone's typing (review 2026-10-24)", () => {
  it('knows the answers to queries: device attributes, cursor place, status, colours, focus, modes', () => {
    for (const d of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n', '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b]4;1;rgb:cdcd/0000/0000\x1b\\', '\x1b[I', '\x1b[O', '\x1b[?2004;1$y', '\x1bP>|xterm.js(5.5.0)\x1b\\']) expect(isTermReply(d), JSON.stringify(d)).toBe(true);
  });

  it('keys are typing: arrows, Esc, F-keys, a paste, letters', () => {
    for (const d of ['\x1b[A', '\x1bOB', '\x1b', '\x1b[15~', '\x1b[200~text\x1b[201~', 'ls\r', '\x1bb', '\x1b[1;5C']) expect(isTermReply(d), JSON.stringify(d)).toBe(false);
  });
});
