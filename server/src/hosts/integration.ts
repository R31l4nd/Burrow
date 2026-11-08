import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from 'ssh2';
import { exec } from '../ssh/connect.js';

// Installing the shell integration on a host: the script goes to
// ~/.burrow/shell-integration.sh and one line in ~/.bashrc and ~/.zshrc
// sources it. Idempotent, and removable with the same care.

const SCRIPT_PATH = fileURLToPath(new URL('../../assets/shell-integration.sh', import.meta.url));
const MARK = '# Burrow shell integration';
const SOURCE_LINE = '[ -f "$HOME/.burrow/shell-integration.sh" ] && . "$HOME/.burrow/shell-integration.sh"';
const EOF_MARK = 'BURROW_SHELL_INTEGRATION_EOF';

export const integrationScript = (): string => readFileSync(SCRIPT_PATH, 'utf8');

export function installCommand(script = integrationScript()): string {
  if (script.includes(EOF_MARK)) throw new Error('script contains the heredoc marker');
  return [
    'set -e',
    'umask 022',
    'mkdir -p "$HOME/.burrow"',
    `cat > "$HOME/.burrow/shell-integration.sh" <<'${EOF_MARK}'`,
    script.replace(/\n?$/, '\n') + EOF_MARK,
    // bash: always (create ~/.bashrc if missing); zsh: only if the user has one.
    'for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do',
    '  if [ "$rc" = "$HOME/.zshrc" ] && [ ! -f "$rc" ]; then continue; fi',
    `  grep -qF '.burrow/shell-integration.sh' "$rc" 2>/dev/null || printf '\\n%s\\n%s\\n' '${MARK}' '${SOURCE_LINE}' >> "$rc"`,
    'done',
    'echo installed',
  ].join('\n');
}

// Each step must succeed before "removed" is said: a read-only .bashrc
// still sourced it while Burrow reported it gone (AUDIT2 MON-25).
export const uninstallCommand = (): string =>
  [
    'set -e',
    'for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do',
    '  [ -f "$rc" ] || continue',
    `  sed -i -e '/^${MARK}$/d' -e '/\\.burrow\\/shell-integration\\.sh/d' "$rc"`,
    // set -e ignores a "!" command: an if it is.
    `  if grep -qF '.burrow/shell-integration.sh' "$rc"; then echo "still in $rc" >&2; exit 1; fi`,
    'done',
    'rm -f "$HOME/.burrow/shell-integration.sh"',
    '[ ! -e "$HOME/.burrow/shell-integration.sh" ]',
    'rmdir "$HOME/.burrow" 2>/dev/null || true',
    'echo removed',
  ].join('\n');

export async function setIntegration(client: Client, on: boolean): Promise<void> {
  const r = await exec(client, on ? installCommand() : uninstallCommand(), 20_000);
  if (r.code !== 0 || !r.stdout.includes(on ? 'installed' : 'removed')) {
    throw new Error(r.stderr.trim() || `exit code ${r.code}`);
  }
}
