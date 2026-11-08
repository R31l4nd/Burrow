import { shellQuote } from '../ssh/quote.js';

// Burrow's own tmux on a host (terminal/manager.ts): a server of its own
// (`tmux -L burrow`) and no config file, so it never touches the person's
// own tmux sessions or ~/.tmux.conf.

export const TMUX = 'tmux -L burrow -f /dev/null';
// Exit code of the attach script when the tmux session no longer exists.
export const GONE = 44;
// Exit code when the attach ended but the session lives on (detached on the host): kept, not ended.
export const DETACHED = 46;

/**
 * Attach; its end is the session's only when the session is gone too (its
 * shell exited). Detached on the host (`tmux -L burrow detach`), it lives on:
 * kept for the next viewer, never left running unknown to Burrow.
 */
const attach = (name: string) => `${TMUX} attach-session -t ${name}; R=$?; [ $R -ne 0 ] && exit $R; ${TMUX} has-session -t ${name} 2>/dev/null && exit ${DETACHED}; exit 0`;

/** Script that creates the tmux session, configures it and attaches. */
export function tmuxCreateScript(name: string, cols: number, rows: number, startup: string | null, command?: string, cwd?: string): string {
  const lines = [
    // Server options first, before the real session exists: its shell prints
    // the first prompt (with the integration's escape sequences) straight
    // away. A throwaway session starts the server so options can be set.
    `${TMUX} new-session -d -s burrow-init 2>/dev/null || true`,
    // No status bar (Burrow has its own tabs), a short escape delay for vim,
    // and no alternate screen so output scrolls into the viewer's
    // scrollback, which is how scrolling on a phone works.
    `${TMUX} set-option -s escape-time 10 \\; set-option -g status off \\; set-option -g history-limit 10000 \\; set-option -sa terminal-overrides ',*:smcup@:rmcup@' >/dev/null`,
    // Lets the shell integration's escape sequences through (tmux 3.3+;
    // older versions pass them anyway and reject the option, hence apart).
    `${TMUX} set-option -g allow-passthrough on >/dev/null 2>&1`,
    // No prefix key: Burrow's tmux is invisible, so Ctrl+B belongs to the
    // shell and to a tmux of the person's own inside it (it went to this one:
    // Ctrl+B d detached the whole session). $TMUX stays: the integration
    // needs it, and so do .bashrc lines that start tmux when it is empty.
    `${TMUX} set-option -g prefix None \\; set-option -g prefix2 None >/dev/null`,
    // $TMUX names tmux's default server, the person's own, not Burrow's: a plain `tmux ls`,
    // `tmux attach -t main` (typed, or the host's start command) and `tmux kill-server` reach
    // their sessions, not Burrow's (kill-server ended every Burrow session). Still set, so a
    // .bashrc that starts tmux when it is empty starts none, and tmux sees no nesting: the
    // shell's terminal is a pane of Burrow's server, not of the one $TMUX names.
    `D="\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/default"; ${TMUX} set-option -g default-command "exec env TMUX='$D,0,0' '\${SHELL:-/bin/sh}' -l" >/dev/null`,
    // A command of its own (a container's shell) instead of the login shell.
    // In the folder asked for (a workspace's) from its start, not a `cd` typed: typed before the shell's prompt
    // it showed twice, echoed and then drawn again (report 597e6b).
    `${TMUX} new-session -d -s ${name} -x ${cols} -y ${rows}${cwd ? ` -c ${shellQuote(cwd)}` : ''}${command ? ` ${shellQuote(command)}` : ''} || exit 45`,
    `${TMUX} kill-session -t burrow-init 2>/dev/null || true`,
  ];
  if (startup) lines.push(`${TMUX} send-keys -t ${name} -l -- ${shellQuote(startup)} \\; send-keys -t ${name} Enter`);
  lines.push(attach(name));
  return lines.join('\n');
}

export const tmuxAttachScript = (name: string) =>
  `${TMUX} has-session -t ${name} 2>/dev/null || exit ${GONE}\n${attach(name)}`;
