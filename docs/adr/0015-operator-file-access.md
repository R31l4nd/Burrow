# 15. Which files an operator may open

Date: 2026-10-11 - Status: accepted

## Context

The third audit (A3-SRV-01) found the operator role ("looks, changes
nothing", ADR 14) much stronger than meant: every file route open to
operators read any path the host's SSH user could, on every host. In a
homelab that user is often root or in the docker group, so an operator
read private keys, compose `.env` files and database passwords,
`/etc/shadow`, and on the host that runs Burrow its own master key and
database, which open every stored credential.

## Decision

- **Per operator and host, two lists of folders**: allowed and denied.
  The longest folder that holds a path decides; a folder in both lists is
  denied. No rule on a host: no files there. Admins are not limited.
  Stored in `file_access` (migration 0040), set by an admin in
  Settings -> Users (a dialog per operator), with a fresh step-up.
- **Judged as the path really is.** The server resolves the path on the
  host (SFTP `realpath`; for a new file, its folder) and the rule's
  folders too, then decides. A link inside an allowed folder that points
  elsewhere counts as where it points.
- **Every file route an operator can reach**: listing, size, search,
  reading, downloading, the editor, workspaces (quick open, search, git
  status, repositories, a file's last committed version) and a stack's
  compose file as last deployed. Lists drop what is closed: a folder's
  entries, search results and their lines, bookmarks, workspaces. The
  writing routes call the same check (they are admin-only today).
- **Closed whatever is granted**: `.ssh` folders anywhere and host keys
  (`ssh_host_*_key`), `/etc/shadow` and `/etc/gshadow`, `/proc`, Burrow's
  master key (`secret.key`), database (`burrow.db` with its journal),
  backups (`burrow-*.tar.gz.enc`) and their key, any folder that holds a
  `burrow.db` (Burrow's data folder, a bind mount or a volume), and
  Burrow's own compose folder (its `.env`, secrets, backups) on the host
  that runs it, found the way the self-update finds it.
- **Step-up for writes that grant a shell** (A3-SRV-08), for admins:
  authorized keys, a shell's start-up files, cron, sudoers, systemd units,
  `ld.so.preload` and the like; also unpacking archives and copying or
  moving over existing files, like deleting.

## Consequences

- An operator sees no files until an admin allows folders; the refusal
  names the folders they may open on that host.
- The Burrow data check costs one `stat` per folder on a path (kept five
  minutes) and, for a search, one `find` for `burrow.db` below its root.
- A link swapped between the check and the read (a race) needs someone
  writing on the host already; reads by operators are checked, not
  sandboxed.
- Operators still cannot write files; letting them write in granted
  folders would be a choice of its own.
