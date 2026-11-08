import { describe, expect, it } from 'vitest';
import type { ShellState } from '@burrow/shared';
import { cursorLine, extractInput, inputAtCursor, type BufferView } from './line.js';

const shell = (s: Partial<ShellState>): ShellState => ({ integration: true, atPrompt: true, cwd: null, prompt: null, ...s });

describe('extractInput', () => {
  it('uses the reported prompt when the integration is on', () => {
    expect(extractInput('alice@server2:/data$ docker lo', shell({ prompt: 'alice@server2:/data$ ' }), false)).toEqual({ text: 'docker lo', limited: false });
    // A prompt with a # or > inside does not confuse it.
    expect(extractInput('[a#b>c] ~ % git ch', shell({ prompt: '[a#b>c] ~ % ' }), false)).toEqual({ text: 'git ch', limited: false });
  });

  it('offers nothing while a command runs or a full-screen program is open', () => {
    // The cursor is on the line below the running command, or in its output.
    expect(extractInput('', shell({ atPrompt: false, prompt: 'alice@x:~$ ' }), false)).toBeNull();
    expect(extractInput('Progress: 42% ', shell({ atPrompt: false, prompt: 'alice@x:~$ ' }), false)).toBeNull();
    // A tmux of your own, no longer on the alternate screen: its shell's prompt counts.
    expect(extractInput('ana@pi:~/data$ git sta', shell({ atPrompt: false }), false)).toEqual({ text: 'git sta', limited: true });
    expect(extractInput('│ > fix the tests', shell({ atPrompt: false }), false)).toBeNull();
    expect(extractInput('~ $ vim', null, true)).toBeNull();
    // In the person's own tmux (the alternate screen): a clear shell prompt
    // still counts; a program's own "> " input line does not.
    expect(extractInput('ana@pi:~/data$ tmux att', shell({ atPrompt: false }), true)).toEqual({ text: 'tmux att', limited: true });
    expect(extractInput('root@nas:/# systemctl sta', null, true)).toEqual({ text: 'systemctl sta', limited: true });
    expect(extractInput('│ > fix the tests', null, true)).toBeNull();
  });

  it('guesses from the prompt ending without the integration, and says so', () => {
    expect(extractInput('pi@raspberrypi:~ $ ls -l', null, false)).toEqual({ text: 'ls -l', limited: true });
    expect(extractInput('root@nas:~# systemctl sta', null, false)).toEqual({ text: 'systemctl sta', limited: true });
    expect(extractInput('❯ git', null, false)).toEqual({ text: 'git', limited: true });
    expect(extractInput('Loading, please wait...', null, false)).toBeNull();
  });
});

describe('cursorLine', () => {
  it('joins wrapped rows and stops at the cursor', () => {
    const rows = [
      { text: 'alice@x:~$ echo aaaaaaaaaa', wrapped: false },
      { text: 'bbbbb      ', wrapped: true },
    ];
    const buf: BufferView = {
      type: 'normal',
      baseY: 0,
      cursorX: 5,
      cursorY: 1,
      getLine: (y) => {
        const r = rows[y];
        return r && { isWrapped: r.wrapped, translateToString: (_t, s = 0, e) => r.text.slice(s, e) };
      },
    };
    expect(cursorLine(buf)).toBe('alice@x:~$ echo aaaaaaaaaabbbbb');
  });
});

describe('inputAtCursor', () => {
  const view = (rows: { text: string; wrapped: boolean }[], cursorX: number): BufferView => ({
    type: 'normal',
    baseY: 0,
    cursorX,
    cursorY: rows.length - 1,
    getLine: (y) => {
      const r = rows[y];
      return r && { isWrapped: r.wrapped, translateToString: (_t, s = 0, e) => r.text.slice(s, e) };
    },
  });

  it('a long line redrawn row by row (tmux after a resize): the rows are not marked wrapped, the input still found', () => {
    // 26 columns: the first row filled to its last column, the rest on the next.
    const rows = [
      { text: 'tester@x:~$ echo mx-tmuxke', wrapped: false },
      { text: 'yboardap                  ', wrapped: false },
    ];
    expect(inputAtCursor(view(rows, 8), 26, null, false)).toEqual({ text: 'echo mx-tmuxkeyboardap', limited: true });
    expect(inputAtCursor(view(rows, 8), 26, shell({ prompt: 'tester@x:~$ ' }), false)).toEqual({ text: 'echo mx-tmuxkeyboardap', limited: false });
  });

  it('a row not filled to its end is not taken as the line going on; a row with its own prompt is its own line', () => {
    const short = [
      { text: 'tester@x:~$ echo mx       ', wrapped: false },
      { text: 'yboardap                  ', wrapped: false },
    ];
    expect(inputAtCursor(view(short, 8), 26, null, false)).toBeNull();
    const own = [
      { text: 'output that fills the row!', wrapped: false },
      { text: 'tester@x:~$ git st        ', wrapped: false },
    ];
    expect(inputAtCursor(view(own, 18), 26, null, false)).toEqual({ text: 'git st', limited: true });
  });
});
