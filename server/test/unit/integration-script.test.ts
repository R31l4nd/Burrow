import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uninstallCommand } from '../../src/hosts/integration.js';

describe('taking the shell integration off', () => {
  it('says removed only when it is gone: a .bashrc it cannot change fails it (AUDIT2 MON-25)', () => {
    const home = mkdtempSync(join(tmpdir(), 'burrow-int-'));
    try {
      mkdirSync(join(home, '.burrow'));
      writeFileSync(join(home, '.burrow', 'shell-integration.sh'), '# x\n');
      const rc = join(home, '.bashrc');
      writeFileSync(rc, 'alias ll="ls -l"\n# Burrow shell integration\n[ -f "$HOME/.burrow/shell-integration.sh" ] && . "$HOME/.burrow/shell-integration.sh"\n');
      // A folder sed cannot write its new file into.
      chmodSync(home, 0o500);
      const ro = spawnSync('sh', ['-c', uninstallCommand()], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
      chmodSync(home, 0o700);
      expect(ro.status).not.toBe(0);
      expect(ro.stdout).not.toContain('removed');
      const ok = spawnSync('sh', ['-c', uninstallCommand()], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
      expect(ok.stdout.trim()).toBe('removed');
      expect(readFileSync(rc, 'utf8')).toBe('alias ll="ls -l"\n');
    } finally {
      chmodSync(home, 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
