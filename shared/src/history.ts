// Which commands the history keeps, for auto-complete: on the server
// (server/src/history) and in the app's direct route (its own history on
// the phone), by the same rules. Not a command that starts with a space
// (the shell's HISTCONTROL=ignorespace), and not one that looks like it
// carries a secret.

const MAX_LENGTH = 2000;

// Patterns that suggest a secret on the command line. Better to lose a
// harmless command than to store a password.
const SECRET_PATTERNS: RegExp[] = [
  // key=value / --key value / KEY: value with a secret-ish name, also as a
  // JSON key ("password":"x", or with escaped quotes) (AUDIT2 AI-04)
  /(pass(word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|bearer)(\\?["'])?\s*[=:]\s*\S+/i,
  /--?[\w-]*(pass(word|wd)?|secret|token|api-?key|auth(-token)?|credentials?)(=|\s+)\S+/i,
  // environment assignments of secret-ish names
  /\b[A-Z0-9_]*(PASS|PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*=\S+/,
  // HTTP auth
  /authorization:\s*\S+/i,
  // curl -u user:pw, also written together (-uadmin:pw) or with = (AUDIT2 AI-04)
  /\bcurl\b.*\s(-u\s*|--user[=\s]+)[^\s:]+:(?!\/\/)\S+/i,
  /\b\w+:\/\/[^/\s:@]+:[^/\s@]+@/, // scheme://user:pass@host
  // mysql -pSECRET, sshpass -p x, htpasswd -b
  /\bmysql(dump)?\b.*\s-p\S+/,
  /\bsshpass\b/,
  // docker/podman/helm login -p secret
  /\blogin\b.*\s(-p|--password)(=|\s+)\S+/,
  /\bhtpasswd\b.*\s-\w*b/,
  /\b(echo|printf)\b.*\|\s*(sudo\s+)?(-S\b|.*\bchpasswd\b|.*\bpasswd\b)/,
  /\bsudo\s+-S\b/,
  // well-known token formats
  /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // long opaque strings (base64/hex blobs are usually keys)
  /\b[A-Za-z0-9+/]{40,}={0,2}(?=\s|$)/,
  /\b[a-f0-9]{40,}\b/i,
];

export type SkipReason = 'empty' | 'leading_space' | 'too_long' | 'secret';

/** Why a command must not be stored, or null if it may. */
export function skipReason(command: string): SkipReason | null {
  if (!command.trim()) return 'empty';
  if (/^\s/.test(command)) return 'leading_space';
  if (command.length > MAX_LENGTH) return 'too_long';
  if (SECRET_PATTERNS.some((re) => re.test(command))) return 'secret';
  return null;
}
