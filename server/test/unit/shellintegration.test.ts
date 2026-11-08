import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The shell integration as bash runs it (interactive, no rc files).
const SCRIPT = fileURLToPath(new URL('../../assets/shell-integration.sh', import.meta.url));
const bash = (script: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['--norc', '-i', '-c', script], { env: { PATH: process.env.PATH ?? '', HISTFILE: '/dev/null', ...env }, encoding: 'utf8' });

describe('the shell integration in bash', () => {
  it('keeps a PROMPT_COMMAND that ends in a semicolon, and an array one, working (AUDIT2 FS-22)', () => {
    for (const pc of ['echo one;', 'echo one ;  ', 'echo two', '']) {
      const r = bash(`source ${SCRIPT}; eval "$PROMPT_COMMAND" >/dev/null && echo ok`, { PROMPT_COMMAND: pc });
      expect(r.stdout.trim().split('\n').at(-1), pc).toBe('ok');
    }
    const arr = bash(`PROMPT_COMMAND=("echo a" "echo b"); source ${SCRIPT}; declare -p PROMPT_COMMAND`);
    expect(arr.stdout).toContain('declare -a PROMPT_COMMAND=([0]="__burrow_precmd" [1]="echo a" [2]="echo b" [3]="__burrow_postcmd")');
  });

  it('a command typed with a space in front is reported with it, so it is not kept (AUDIT2 FS-23)', () => {
    const r = bash(`history -s " secret thing"; source ${SCRIPT}; __burrow_preexec`);
    const m = /6973;E;\d+;([A-Za-z0-9+/=]+)/.exec(r.stdout);
    expect(Buffer.from(m![1]!, 'base64').toString()).toBe(' secret thing');
    const plain = bash(`history -s "ls -la"; source ${SCRIPT}; __burrow_preexec`);
    expect(Buffer.from(/6973;E;\d+;([A-Za-z0-9+/=]+)/.exec(plain.stdout)![1]!, 'base64').toString()).toBe('ls -la');
  });
});
