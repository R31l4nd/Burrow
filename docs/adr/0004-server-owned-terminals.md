# 4. Server-owned terminals, tmux on a private server

Date: 2026-09-26 - Status: accepted

## Context

Sessions must survive closed tabs, work from several devices at once and, if
possible, survive a restart of Burrow. A device that reconnects must see the
current screen.

## Decision

- The server holds the SSH connection, the PTY and a headless xterm; viewers
  are thin. A reconnect receives a serialized snapshot, not a byte replay.
- When the host has tmux, the shell runs inside `tmux -L burrow -f /dev/null`.
  A private tmux server means Burrow's options (no status bar, no alternate
  screen, short escape time) never leak into the user's own tmux, and the
  user's config cannot break Burrow. Users can still join with
  `tmux -L burrow attach -t burrow-<id>`.
- Without tmux the session lives in memory and the UI says so.
- The last active device decides the size.

## Consequences

tmux sessions outlive Burrow and are re-attached on demand; an explicit close
kills them on the host. Scrollback before a re-attach is whatever tmux
redraws, not the full history.
