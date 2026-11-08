import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DETACHED, tmuxAttachScript, tmuxCreateScript } from '../../src/terminal/tmux.js';
import { deviceLabel } from '../../src/terminal/live.js';

describe('tmux scripts', () => {
  it("uses Burrow's own tmux server and never the user's", () => {
    const s = tmuxCreateScript('burrow-abc', 80, 24, null);
    for (const line of s.split('\n')) if (line.includes('tmux')) expect(line).toContain('tmux -L burrow -f /dev/null');
    expect(s).toContain('new-session -d -s burrow-abc -x 80 -y 24');
    expect(s).toContain('tmux -L burrow -f /dev/null attach-session -t burrow-abc;');
  });

  it('quotes the startup command so it is typed, not run by the wrapper', () => {
    const s = tmuxCreateScript('burrow-abc', 80, 24, `cd '/data' && echo "$HOME"; rm -rf x`);
    expect(s).toContain(`send-keys -t burrow-abc -l -- 'cd '\\''/data'\\'' && echo "$HOME"; rm -rf x'`);
  });

  it('starts in the folder asked for, quoted, instead of typing a cd before the prompt (report 597e6b)', () => {
    const s = tmuxCreateScript('burrow-abc', 80, 24, null, undefined, "/data/it's here");
    expect(s).toContain(`new-session -d -s burrow-abc -x 80 -y 24 -c '/data/it'\\''s here' || exit 45`);
    expect(s).not.toContain('send-keys');
  });

  it('attach reports a vanished session with its own exit code', () => {
    expect(tmuxAttachScript('burrow-x')).toContain('has-session -t burrow-x 2>/dev/null || exit 44');
  });

  it('an attach that ends while the session lives on (detached on the host) is not "ended"; one whose shell exited is (review 2026-10-24)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-tmux-'));
    try {
      // A stand-in tmux: attach ends as told, has-session says whether the session is still there.
      writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nfor a; do case "$a" in attach-session) exit "$ATTACH";; has-session) [ "$LIVES" = 1 ] && exit 0; exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
      const run = (attach: number, lives: boolean) => spawnSync('sh', ['-c', tmuxAttachScript('burrow-x').replace('has-session -t burrow-x 2>/dev/null || exit 44', 'true')], { env: { PATH: `${dir}:/usr/bin:/bin`, ATTACH: String(attach), LIVES: lives ? '1' : '0' } }).status;
      expect(run(0, true)).toBe(DETACHED);
      expect(run(0, false)).toBe(0);
      expect(run(1, true)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deviceLabel', () => {
  it('names a viewer as browser on system, so a list of viewers reads apart from the separators of the sessions list', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; CPH2551) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe('Edge on Windows');
    expect(deviceLabel('curl/8.0')).toBe('browser');
    expect(deviceLabel(null)).toBe('unknown');
  });
});

describe("a snapshot's screen modes (review 2026-10-24)", () => {
  it("keeps a full-screen program's scroll region and hidden cursor, the cursor where it was", async () => {
    const { default: headless } = await import('@xterm/headless');
    const { default: serialize } = await import('@xterm/addon-serialize');
    const { screenModes } = await import('../../src/terminal/live.js');
    const write = (t: InstanceType<typeof headless.Terminal>, d: string) => new Promise<void>((r) => t.write(d, r));
    const core = (t: InstanceType<typeof headless.Terminal>) => (t as unknown as { _core: { buffer: { scrollTop: number; scrollBottom: number }; coreService: { isCursorHidden: boolean } } })._core;
    const a = new headless.Terminal({ cols: 40, rows: 12, allowProposedApi: true });
    const s = new serialize.SerializeAddon();
    a.loadAddon(s);
    // A status line kept at the bottom, as a tmux or vim does: lines 1-11 scroll, line 12 stays.
    await write(a, 'hello\r\n\x1b[1;11r\x1b[?25l\x1b[5;3H');
    const snap = s.serialize() + screenModes(a);
    const b = new headless.Terminal({ cols: 40, rows: 12, allowProposedApi: true });
    await write(b, snap);
    expect([core(b).buffer.scrollTop, core(b).buffer.scrollBottom]).toEqual([0, 10]);
    expect(core(b).coreService.isCursorHidden).toBe(true);
    expect([b.buffer.active.cursorY, b.buffer.active.cursorX]).toEqual([4, 2]);
    // A plain shell: nothing added.
    const c = new headless.Terminal({ cols: 40, rows: 12, allowProposedApi: true });
    await write(c, 'ls\r\n');
    expect(screenModes(c)).toBe('');
  });
});
