#!/usr/bin/env bash
# scripts/install-hooks.sh - install the pre-push hook that runs
# scripts/gate.sh. Hooks are not versioned, so run this once per clone:
#
#   make hooks
#
# `git push --no-verify` skips the gate: an emergency exit, not a habit.
#
# Pushes to a backup remote skip the gate on purpose (see the hook below).
# Name yours once per clone: git config burrow.backupRemotes "backup offsite"
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "Not a git repository."; exit 1; }
HOOKS="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS"

cat > "$HOOKS/pre-push" <<'HOOK'
#!/usr/bin/env bash
# Runs the gate before every push. Skip: git push --no-verify
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"

# Remotes that only keep a copy and publish nothing. Git passes the remote
# name as $1. A nightly mirror push that had to run the full gate (including
# the end-to-end tests) would soon stop being run at all, and the copy would
# silently go stale. The gate guards what you publish, not your own backup.
BACKUP_REMOTES="${BACKUP_REMOTES:-$(git config --get burrow.backupRemotes || true)}"
for remote in $BACKUP_REMOTES; do
  if [ "${1:-}" = "$remote" ]; then
    echo "pre-push: '$remote' is a backup remote - gate skipped." >&2
    exit 0
  fi
done

# The gate tests the working tree: only a push of the checked-out commit,
# from a clean tree, is the code it tested (AUDIT2 OPS-15). Git passes the
# refs on stdin: <local ref> <local sha> <remote ref> <remote sha>.
head="$(git rev-parse HEAD)"
while read -r lref lsha _rref _rsha; do
  case "$lsha" in *[!0]*) ;; *) continue ;; esac   # a deletion
  if [ "$(git rev-parse "$lsha^{commit}")" != "$head" ]; then
    echo "pre-push: $lref is not the checked-out commit, and the gate tests what is checked out. Check it out first." >&2
    exit 1
  fi
done
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "pre-push: the working tree has changes the push does not carry; commit or stash them, so the gate tests what is pushed." >&2
  exit 1
fi

echo "pre-push: running scripts/gate.sh ..."
bash "$ROOT/scripts/gate.sh"
HOOK

chmod +x "$HOOKS/pre-push"
echo "pre-push hook installed in $HOOKS/pre-push"
