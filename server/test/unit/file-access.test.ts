import { describe, expect, it } from 'vitest';
import { closedToOperators, grantsAShell } from '../../src/files/access.js';

describe('files closed to operators whatever was granted (A3-SRV-01)', () => {
  it('keys, shadow files, Burrow\'s own secrets and every process environment', () => {
    for (const p of [
      '/home/me/.ssh/id_ed25519',
      '/root/.ssh',
      '/srv/backup/home/.ssh/config',
      '/etc/ssh/ssh_host_ed25519_key',
      '/etc/shadow',
      '/srv/appdata/burrow/secret.key',
      '/var/lib/docker/volumes/burrow-data/_data/burrow.db-wal',
      '/data/Burrow/backups/burrow-20261011-0300.tar.gz.enc',
      '/data/Burrow/secrets/backup_encryption_key',
      '/proc/1/environ',
    ])
      expect(closedToOperators(p), p).toBe(true);
    for (const p of ['/etc/ssh/sshd_config', '/etc/ssh/ssh_host_ed25519_key.pub', '/etc/hostname', '/srv/app/.env', '/home/me/.sshrc-notes']) expect(closedToOperators(p), p).toBe(false);
  });
});

describe('files whose new content grants a shell (A3-SRV-08)', () => {
  it('keys, start-up files of a shell, cron, sudoers, units', () => {
    for (const p of ['/home/me/.ssh/authorized_keys', '/root/.bashrc', '/home/me/.profile', '/home/me/.config/fish/config.fish', '/home/me/.config/systemd/user/x.service', '/etc/cron.d/job', '/var/spool/cron/crontabs/root', '/etc/sudoers.d/me', '/etc/profile.d/x.sh', '/etc/systemd/system/x.service', '/etc/ld.so.preload'])
      expect(grantsAShell(p), p).toBe(true);
    for (const p of ['/srv/app/compose.yaml', '/home/me/notes.txt', '/etc/nginx/nginx.conf', '/home/me/.bashrc.bak']) expect(grantsAShell(p), p).toBe(false);
  });

  it('files that run code too: aliases a .bashrc loads, login messages, log rotation, APT hooks, the loader (audit 2026-10-30)', () => {
    for (const p of ['/home/me/.bash_aliases', '/etc/update-motd.d/50-news', '/etc/logrotate.d/app', '/etc/logrotate.conf', '/etc/apt/apt.conf.d/99hook', '/etc/ld.so.conf.d/x.conf', '/etc/ld.so.conf'])
      expect(grantsAShell(p), p).toBe(true);
  });

  it("what Burrow and git run later: the shell integration, git's config and a repository's hooks (audit 2026-11-05)", () => {
    for (const p of ['/home/me/.burrow/shell-integration.sh', '/home/me/.gitconfig', '/home/me/.config/git/config', '/etc/gitconfig', '/srv/app/.git/config', '/srv/app/.git/config.worktree', '/srv/app/.git/hooks/pre-commit', '/srv/app/.git/modules/lib/hooks/post-checkout', '/srv/app/.git/modules/lib/config'])
      expect(grantsAShell(p), p).toBe(true);
    for (const p of ['/srv/app/.gitignore', '/srv/app/.gitattributes', '/srv/app/.git/HEAD', '/srv/app/.git/description', '/srv/app/src/config', '/home/me/.config/app/config.yaml', '/home/me/hooks/pre-commit']) expect(grantsAShell(p), p).toBe(false);
  });

  it('the folders that hold them, for a folder renamed onto one that is not there yet (audit 2026-11-05)', () => {
    for (const p of ['/home/me/.config', '/home/me/.config/systemd', '/home/me/.config/git', '/home/me/.burrow', '/srv/app/.git', '/srv/app/.git/hooks', '/srv/app/.git/modules/lib'])
      expect(grantsAShell(p), p).toBe(true);
  });
});
