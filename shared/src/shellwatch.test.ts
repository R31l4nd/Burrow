import { describe, expect, it } from 'vitest';
import type { ShellState } from './terminal.js';
import { watchShell, type OscParser } from './shellwatch.js';

// The shell integration's marks, as the server and the direct route read them.
function fake() {
  const handlers = new Map<number, (d: string) => boolean | Promise<boolean>>();
  const parser: OscParser = { registerOscHandler: (id, cb) => handlers.set(id, cb) };
  let state: ShellState = { integration: false, atPrompt: false, cwd: null, prompt: null };
  const commands: string[] = [];
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  watchShell(parser, (x) => Buffer.from(x, 'base64').toString('utf8'), { patch: (p) => (state = { ...state, ...p }), command: (c) => commands.push(c) });
  return { osc: (id: number, d: string) => handlers.get(id)!(d), state: () => state, commands, b64 };
}

describe('watchShell', () => {
  it('follows prompt, working directory and the prompt line', () => {
    const f = fake();
    f.osc(133, 'A');
    f.osc(6973, `P;${f.b64('tester@pi:~$ ')}`);
    f.osc(133, 'B');
    f.osc(7, 'file://pi/home/tester/my%20dir');
    expect(f.state()).toEqual({ integration: true, atPrompt: true, cwd: '/home/tester/my dir', prompt: 'tester@pi:~$ ' });
    f.osc(133, 'C');
    expect(f.state().atPrompt).toBe(false);
  });

  it('reports each finished command once (bash repeats the last one after an ignored command)', () => {
    const f = fake();
    f.osc(6973, `E;41;${f.b64('ls -la')}`);
    f.osc(6973, `E;41;${f.b64('ls -la')}`);
    f.osc(6973, `E;42;${f.b64('docker ps')}`);
    f.osc(6973, `E;0;${f.b64('zsh command')}`);
    expect(f.commands).toEqual(['ls -la', 'docker ps', 'zsh command']);
  });

  it('with a gate, a report counts only right after a command start the gate let through (A3-SRV-13)', () => {
    const handlers = new Map<number, (d: string) => boolean | Promise<boolean>>();
    const commands: string[] = [];
    let tokens = 1;
    watchShell({ registerOscHandler: (id, cb) => handlers.set(id, cb) }, (x) => Buffer.from(x, 'base64').toString('utf8'), {
      patch: () => {},
      command: (c) => commands.push(c),
      commandStart: () => tokens-- > 0,
    });
    const osc = (id: number, d: string) => handlers.get(id)!(d);
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    osc(6973, `E;1;${b64('before any start')}`);
    osc(133, 'C');
    osc(6973, `E;2;${b64('typed')}`);
    osc(6973, `E;3;${b64('in the output')}`);
    osc(133, 'C');
    osc(6973, `E;4;${b64('no Enter left')}`);
    expect(commands).toEqual(['typed']);
  });
});
