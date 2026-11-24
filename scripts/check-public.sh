#!/usr/bin/env bash
# scripts/check-public.sh <dir> - fails when the tree holds something that
# must not be published: secrets, keys, local environment files, and the
# names of your own installation listed in deploy/local/private-patterns.txt
# (git-ignored; one fixed string a line: host names, paths, addresses).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:?directory}"
fail=0
PATTERNS="${BURROW_PRIVATE_PATTERNS:-$ROOT/deploy/local/private-patterns.txt}"
# Without its patterns the check finds nothing private and passes (audit 2026-11):
# named but missing fails; none at all (CI, a fresh clone) is said as a note.
if [ -n "${BURROW_PRIVATE_PATTERNS:-}" ] && [ ! -s "$PATTERNS" ]; then
  echo "no private patterns: $PATTERNS is missing or empty"
  fail=1
elif [ ! -s "$PATTERNS" ]; then
  echo "NOTE: no private patterns (deploy/local/private-patterns.txt): only secrets, keys and placeholders looked for"
else
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if grep -rIlF --exclude-dir=node_modules --exclude-dir=.git -e "$p" "$DIR" >/dev/null; then
      echo "private: \"$p\" in:"; grep -rIlF --exclude-dir=node_modules --exclude-dir=.git -e "$p" "$DIR" | sed 's/^/  /'
      fail=1
    fi
  done < "$PATTERNS"
fi
for f in .env .env.build android/keystore secrets/backup_encryption_key backups artifacts data; do
  [ -e "$DIR/$f" ] && { echo "must not be public: $f"; fail=1; }
done
# An environment file anywhere (.env.production, server/.env), an example only allowed: only the two
# at the top were looked for (audit 2026-11-23).
while IFS= read -r f; do
  [ -n "$f" ] && [ "${f#"$DIR"/}" != .env ] && [ "${f#"$DIR"/}" != .env.build ] && { echo "must not be public: ${f#"$DIR"/}"; fail=1; }
done <<< "$(find "$DIR" \( -name node_modules -o -name .git \) -prune -o -type f -name '.env*' ! -name '*.example' -print)"
# Nothing in secrets/ but its README, whatever the secret's name (audit 2026-10-30).
for f in "$DIR"/secrets/* "$DIR"/secrets/.[!.]*; do
  [ -e "$f" ] && [ "${f##*/}" != README.md ] && { echo "must not be public: secrets/${f##*/}"; fail=1; }
done
# Private keys, whatever their name: PEM, OpenSSH and PGP's KEY BLOCK (audit 2026-11).
KEY_RE='-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----'
if grep -rIlE --exclude-dir=node_modules --exclude-dir=.git -e "$KEY_RE" "$DIR" >/dev/null; then
  echo "private keys in:"; grep -rIlE --exclude-dir=node_modules --exclude-dir=.git -e "$KEY_RE" "$DIR" | sed 's/^/  /'
  fail=1
fi
# API tokens and webhooks of well-known kinds (as shared/src/analysis.ts masks them): only keys and
# key files were looked for, a real token in a fixture or an example passed (audit 2026-11-23).
# Tests hold made-up ones on purpose: *.test.ts, *.spec.ts, server/test/.
TOKEN_RE='gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|sk-ant-[A-Za-z0-9_-]{20,}|(AKIA|ASIA)[0-9A-Z]{16}|xox[abpr]-[0-9A-Za-z-]{10,}|glpat-[A-Za-z0-9_-]{20}|[0-9]{8,10}:AA[A-Za-z0-9_-]{33}|discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]{30,}|hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]{20,}'
tokens="$(grep -rIlE --exclude-dir=node_modules --exclude-dir=.git --exclude='*.test.ts' --exclude='*.spec.ts' -e "$TOKEN_RE" "$DIR" | grep -v "^$DIR/server/test/" || true)"
if [ -n "$tokens" ]; then
  echo "API tokens in:"; while IFS= read -r f; do echo "  ${f#"$DIR"/}"; done <<< "$tokens"
  fail=1
fi
# Key stores and key files by their name: binary ones the grep above does not read (audit 2026-11).
keyfiles="$(find "$DIR" \( -name node_modules -o -name .git \) -prune -o -type f \( -iname '*.jks' -o -iname '*.keystore' -o -iname '*.p12' -o -iname '*.pfx' -o -iname '*.kdbx' -o -iname '*.ppk' -o -name 'id_rsa' -o -name 'id_dsa' -o -name 'id_ecdsa' -o -name 'id_ed25519' -o -name 'id_ecdsa_sk' -o -name 'id_ed25519_sk' \) -print)"
if [ -n "$keyfiles" ]; then
  echo "key files in:"; while IFS= read -r f; do echo "  ${f#"$DIR"/}"; done <<< "$keyfiles"
  fail=1
fi
# The repository's address filled in everywhere (issues and releases link to it), and the copyright holder.
# Written in two parts, so this script does not find itself.
for PH in 'OWNER''/burrow' 'COPYRIGHT''_HOLDER'; do
  if grep -rIl --exclude-dir=node_modules --exclude-dir=.git -e "$PH" "$DIR" >/dev/null; then
    echo "the placeholder $PH is still in:"; grep -rIl --exclude-dir=node_modules --exclude-dir=.git -e "$PH" "$DIR" | sed 's/^/  /'
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "public check: nothing private found"
exit "$fail"
