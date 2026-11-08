# 10. Workspaces: the host's own tools, the editor we have

Date: 2026-09-27 - Status: accepted

## Context

For 0.8.0: a folder on a host as a project (tree, tabs, quick open), search
and replace across its files, basic git, and saving files only root may
write - the part of code-server that matters for server work.

## Decision

- **Everything runs on the host over SSH**: ripgrep (grep when the host has
  no rg) for search and the file list, the host's git and its credentials
  for status, commit, pull and push. Nothing is copied to Burrow. Commands
  close stdin (rg reads it when no path is given and it is not a terminal).
- **Replace is done by Burrow file by file**, through the same atomic,
  conflict-checked save as the editor, so a file that changed in between is
  skipped, not overwritten. JavaScript regex semantics; close to rg's for the
  patterns people use.
- **One editor component** (`EditorPane`) for single files and workspace
  tabs; hidden tabs keep their state.
- **sudo like sudoedit**: after a step-up, the file is read with `sudo cat`
  and saved by writing a private temporary file and `sudo sh -c 'cat tmp >
  file'`, which keeps owner and mode. The sudo password is the one given in
  the dialog or the host's stored password, never stored for this.
  Amended 2026-10 (AUDIT2 P0, FS-26): `cat > file` truncated the file before
  writing, so a failure half way left it cut off. A save now writes a
  staging file beside the target (umask 077, made exclusively), gives it the
  target's owner and mode, and replaces the target in one `mv`; a read goes
  through base64 so text that is not UTF-8 is refused, not mangled
  (`server/src/workspace/sudo.ts`).
- **git identity per workspace**, asked once when git on the host has none,
  passed with `-c user.name/-c user.email`.

## Consequences

- Search depends on the host's tools; results are capped (2000 matches,
  20 000 files for quick open).
- Pull and push never prompt: a remote that asks for a password fails with
  git's message.
