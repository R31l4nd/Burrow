# Burrow shell integration (bash and zsh).
#
# Installed by Burrow in ~/.burrow/ and sourced from ~/.bashrc / ~/.zshrc.
# It tells the terminal where the prompt is, which directory you are in and
# which command you ran, so Burrow can offer accurate completions and keep a
# history. Remove it from the host menu in Burrow, or delete this file and
# the line that sources it.
#
# Escape sequences (all invisible):
#   OSC 133;A / B / C / D;<exit>   prompt start, input start, command start, command end
#   OSC 7;file://<host><dir>       current directory
#   OSC 6973;P;<base64>            the prompt text (last line), to find the input
#   OSC 6973;E;<n>;<base64>        the command about to run (<n>: history number)
# Commands starting with a space are not reported, like HISTCONTROL=ignorespace.

case $- in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
[ -n "${BURROW_SHELL_INTEGRATION:-}" ] && return 0
BURROW_SHELL_INTEGRATION=1

# Inside tmux the sequence must be wrapped to reach the outer terminal.
__burrow_osc() {
  if [ -n "${TMUX:-}" ]; then
    printf '\033Ptmux;\033\033]%s\007\033\\' "$1"
  else
    printf '\033]%s\007' "$1"
  fi
}

__burrow_b64() {
  command -v base64 >/dev/null 2>&1 || return 1
  printf '%s' "$1" | base64 | tr -d '\n'
}

# Percent-encode what would break a file:// URL.
__burrow_urlpath() {
  printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/#/%23/g' -e 's/?/%3F/g'
}

# Printable prompt text: last line, without colour codes and \[ \] markers.
__burrow_clean() {
  printf '%s' "$1" | sed -e 's/\x1b\[[0-9;?]*[A-Za-z]//g' -e 's/\x1b\][^\x07]*\x07//g' | tr -d '\001\002'
}

if [ -n "${BASH_VERSION:-}" ]; then
  __burrow_marker_b="$(__burrow_osc '133;B')"
  # Inside tmux the marker ends in ESC-backslash; PS1 treats a backslash as an
  # escape, so it is doubled before going in (else a stray "]" is printed).
  __burrow_ps1_b="${__burrow_marker_b//\\/\\\\}"

  __burrow_precmd() {
    local ec=$?
    __burrow_osc "133;D;$ec"
    __burrow_osc "7;file://${HOSTNAME}$(__burrow_urlpath "$PWD")"
    return $ec
  }

  # Runs last, after other prompt tools (starship, ...) have set PS1.
  __burrow_postcmd() {
    local ec=$?
    case "$PS1" in *"$__burrow_ps1_b"*) ;; *) PS1="${PS1}\[${__burrow_ps1_b}\]" ;; esac
    if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }; then
      # The prompt as printed, without Burrow's own marker.
      local ps="${PS1//"\[${__burrow_ps1_b}\]"/}"
      local p="${ps@P}"
      p="${p##*$'\n'}"
      __burrow_osc "6973;P;$(__burrow_b64 "$(__burrow_clean "$p")")"
    fi
    __burrow_osc '133;A'
    return $ec
  }

  # PS0 (bash 4.4+) is printed after a command is read, before it runs. The
  # command is already in the history then; its number lets Burrow skip the
  # repeat that `history 1` shows when a command was not added (ignorespace).
  __burrow_preexec() {
    local h num cmd
    h="$(HISTTIMEFORMAT='' builtin history 1)"
    h="${h#"${h%%[![:space:]]*}"}"
    num="${h%%[!0-9]*}"
    cmd="${h#"$num"}"
    # history prints "<n>", "*" or a space, then one space: only those go.
    # A space the command itself starts with stays, so Burrow keeps it out
    # of its history also when HISTCONTROL does not (AUDIT2 FS-23).
    cmd="${cmd#?}"
    cmd="${cmd# }"
    __burrow_osc '133;C'
    [ -n "$num" ] && [ -n "$cmd" ] && __burrow_osc "6973;E;$num;$(__burrow_b64 "$cmd")"
  }

  # Around what is there: an array (bash 5.1+) gets two more elements; a
  # string loses its trailing ";" first, else ";;" broke it (AUDIT2 FS-22).
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__burrow_precmd "${PROMPT_COMMAND[@]}" __burrow_postcmd)
  else
    __burrow_pc="${PROMPT_COMMAND:-}"
    while [[ "$__burrow_pc" =~ [[:space:]\;]$ ]]; do __burrow_pc="${__burrow_pc%?}"; done
    PROMPT_COMMAND="__burrow_precmd${__burrow_pc:+;$__burrow_pc};__burrow_postcmd"
    unset __burrow_pc
  fi
  PS0='$(__burrow_preexec)'"${PS0:-}"
fi

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook

  __burrow_precmd() {
    local ec=$?
    __burrow_osc "133;D;$ec"
    __burrow_osc "7;file://${HOST}$(__burrow_urlpath "$PWD")"
    local p="${(%)PS1}"
    p="${p##*$'\n'}"
    __burrow_osc "6973;P;$(__burrow_b64 "$(__burrow_clean "$p")")"
    __burrow_osc '133;A'
  }

  __burrow_preexec() {
    __burrow_osc '133;C'
    case "$1" in ' '*) return ;; esac
    __burrow_osc "6973;E;0;$(__burrow_b64 "$1")"
  }

  add-zsh-hook precmd __burrow_precmd
  add-zsh-hook preexec __burrow_preexec
  PS1="${PS1}%{$(__burrow_osc '133;B')%}"
fi
