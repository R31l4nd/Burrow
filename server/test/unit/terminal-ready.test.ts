import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typeWhenReady } from '../../src/terminal/ready.js';

// A new shell's start-up line (a directory to go to, the host's start command) is typed once the shell
// is ready, not at once: the terminal echoed it before the shell's prompt and the shell showed it again (report 597e6b).
class Channel extends EventEmitter {
  typed: string[] = [];
  write(text: string) {
    this.typed.push(text);
  }
}

afterEach(() => vi.useRealTimers());

describe('typing into a new shell', () => {
  it('waits for its first output and a quiet moment after it', () => {
    vi.useFakeTimers();
    const ch = new Channel();
    typeWhenReady(ch, "cd -- '/data'\n");
    vi.advanceTimersByTime(1000);
    expect(ch.typed).toEqual([]);
    ch.emit('data', Buffer.from('Linux debian\n'));
    vi.advanceTimersByTime(200);
    ch.emit('data', Buffer.from('user@host:~$ '));
    vi.advanceTimersByTime(299);
    expect(ch.typed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ch.typed).toEqual(["cd -- '/data'\n"]);
    // Once: later output types nothing more.
    ch.emit('data', Buffer.from('more'));
    vi.advanceTimersByTime(5000);
    expect(ch.typed).toHaveLength(1);
    expect(ch.listenerCount('data')).toBe(0);
  });

  it('a viewer typing first: the line goes before what they type, once', () => {
    vi.useFakeTimers();
    const ch = new Channel();
    const now = typeWhenReady(ch, "cd -- '/data'\n");
    ch.emit('data', Buffer.from('Linux debian\n'));
    now();
    ch.write('ls\r');
    now();
    vi.advanceTimersByTime(5000);
    expect(ch.typed).toEqual(["cd -- '/data'\n", 'ls\r']);
  });

  it('a shell that says nothing, or never stops: typed at the latest after four seconds', () => {
    vi.useFakeTimers();
    const silent = new Channel();
    typeWhenReady(silent, 'x\n');
    vi.advanceTimersByTime(4000);
    expect(silent.typed).toEqual(['x\n']);
    const chatty = new Channel();
    typeWhenReady(chatty, 'y\n');
    for (let i = 0; i < 40; i++) {
      chatty.emit('data', Buffer.from('.'));
      vi.advanceTimersByTime(100);
    }
    expect(chatty.typed).toEqual(['y\n']);
  });
});
