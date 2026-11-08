import { afterEach, describe, expect, it } from 'vitest';
import { LiveSession, type Row } from '../../src/terminal/live.js';

// Without the shell integration a typed line is learnt only when the terminal echoed it (a password at
// sudo's prompt is not). tmux behind on fast output redraws its screen in place rather than scrolling
// it: the echo moves up over the row of the Enter, the server's copy never scrolls (a flaky
// integration test, "goes through tmux's own history", reproduced under load: 11 of 15 missed).
const row: Row = { id: 'x', hostId: 1, userId: 1, mode: 'tmux', tmuxName: 'burrow-x', title: null, createdAt: 0, lastActivityAt: 0, sharedWith: '[]', recording: false };
let live: LiveSession;
const out = (d: string) => new Promise<void>((r) => live.term.write(d, r));
// tmux's redraw: every row written again in place, no line feed.
const redraw = (rows: string[]) => out(rows.map((r, i) => `\x1b[${i + 1};1H\x1b[2K${r}`).join('') + `\x1b[${rows.length};${rows.at(-1)!.length + 1}H`);
const numbers = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));
const start = async () => {
  live = new LiveSession(row, 'h', 80, 20, 'utf-8');
  const got: string[] = [];
  live.onCommand = (c) => got.push(c);
  await redraw([...numbers(1, 19), '$ ']);
  return got;
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => live.term.dispose());

describe('a typed line learnt from its echo, tmux redrawing its screen', () => {
  it('is learnt when the echo came after the Enter and a redraw moved it up', async () => {
    const got = await start();
    live.trackTyped('echo after-42\r');
    await redraw([...numbers(3, 17), '$ echo after-42', 'after-42', '$ ']);
    expect(live.term.buffer.active.baseY).toBe(0);
    await expect.poll(() => got, { timeout: 2_000 }).toEqual(['echo after-42']);
  });

  it('is learnt when typed a key at a time, the echo there at Enter, and the output redrew it away', async () => {
    const got = await start();
    await out('seq 1 500');
    live.trackTyped('seq 1 500\r');
    await redraw([...numbers(482, 19), '$ ']);
    await expect.poll(() => got, { timeout: 2_000 }).toEqual(['seq 1 500']);
  });

  it('is not learnt when a password on the screen is pasted at a prompt that does not echo, and a redraw moves it', async () => {
    const got = await start();
    await redraw([...numbers(1, 16), '$ pwgen -s 16 1', 'Xk3sQ9vLp2', '$ sudo ls', '[sudo] password for t: ']);
    live.trackTyped('Xk3sQ9vLp2\r');
    await redraw([...numbers(2, 15), '$ pwgen -s 16 1', 'Xk3sQ9vLp2', '$ sudo ls', '[sudo] password for t: ', 'Sorry, try again.']);
    await pause(1_200);
    expect(got).toEqual([]);
  });

  it("held while tmux left its history: what tmux's screen showed before the keys is not their echo, what came after is", async () => {
    const got = await start();
    // The server's copy shows tmux's history; tmux's own screen, the password on it.
    const screen = [...numbers(1, 16), '$ pwgen -s 16 1', 'Xk3sQ9vLp2', '$ sudo ls', '[sudo] password for t: '];
    await redraw([...numbers(281, 19), '[sudo] password for t: '.replace(/./g, ' ')]);
    live.trackTyped('Xk3sQ9vLp2\r', { cursorY: 19, screen });
    await redraw([...screen.slice(1), 'Sorry, try again.']);
    live.trackTyped('echo after-42\r', { cursorY: 19, screen: [...numbers(2, 18), '$ '] });
    await redraw([...numbers(4, 17), '$ echo after-42', 'after-42', '$ ']);
    await expect.poll(() => got, { timeout: 2_000 }).toEqual(['echo after-42']);
    await pause(1_200);
    expect(got).toEqual(['echo after-42']);
  });

  it('is not learnt when what tmux showed is not known', async () => {
    const got = await start();
    live.trackTyped('echo after-42\r', null);
    await redraw([...numbers(3, 17), '$ echo after-42', 'after-42', '$ ']);
    await pause(1_200);
    expect(got).toEqual([]);
  });
});
