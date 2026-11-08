#!/usr/bin/env bash
# scripts/gate-snapshot.sh - the gate on a snapshot of the working tree, in a
# worktree of its own, so the tree can change while it runs (an hour).
#
#   bash scripts/gate-snapshot.sh            # snapshot now (tracked + untracked, not ignored) and gate it
#   bash scripts/gate-snapshot.sh resume     # the same snapshot again: make gate RESUME=1 after a fix in it
#   bash scripts/gate-snapshot.sh commit -m "feat: ..."   # commit exactly what passed onto main
#   bash scripts/gate-snapshot.sh path       # where the snapshot is (for a fix, or the Android test)
#   bash scripts/gate-snapshot.sh prepare    # a snapshot without its gate (refused over one that passed and is not committed)
#   bash scripts/gate-snapshot.sh env        # the local .env files beside the snapshot, for the Android test there
#
# A fix for a red gate goes into the snapshot (bash scripts/gate-snapshot.sh
# path) and into the working tree both; `resume` gates the snapshot again.
# `commit` refuses when the snapshot's last gate did not pass or its tree
# changed since, and when main moved on since the snapshot was taken.
# Integration, e2e and the Android test use fixed container names: nothing
# of theirs runs beside a snapshot's gate (unit tests, lint and typecheck do).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP="${GATE_SNAPSHOT_DIR:-$(dirname "$ROOT")/$(basename "$ROOT")-gate}"
cd "$ROOT"

# The working tree as a commit (parent HEAD), untracked files included,
# ignored ones (node_modules, secrets, .env) not.
snapshot_commit() {
  local idx
  idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git read-tree HEAD
  GIT_INDEX_FILE="$idx" git add -A
  # Nothing big that is not tracked already goes in by itself: a crashed test
  # worker's core dump (5 GB) once went into a release this way.
  local big
  big="$(GIT_INDEX_FILE="$idx" git diff --cached --name-only --diff-filter=A HEAD | while IFS= read -r f; do [ -f "$f" ] && [ "$(stat -c %s "$f")" -gt 20971520 ] && echo "$f"; done)"
  if [ -n "$big" ]; then
    rm -f "$idx"
    echo "new files over 20 MB in the tree (delete them, or ignore them in .gitignore):" >&2
    echo "$big" | sed 's/^/  /' >&2
    exit 1
  fi
  local tree
  tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
  rm -f "$idx"
  git commit-tree "$tree" -p HEAD -m "gate snapshot $(date -u +%FT%TZ)"
}

prepare() {
  local commit="$1"
  if [ ! -e "$SNAP/.git" ]; then
    git worktree add -q --detach "$SNAP" "$commit" 2>/dev/null
  else
    git -C "$SNAP" checkout --detach --force -q "$commit"
    # What a former snapshot had and this one has not; installed packages and the gate's state stay.
    git -C "$SNAP" clean -fdq
  fi
  # Packages as the lock says, again only when it changed.
  if ! cmp -s "$SNAP/package-lock.json" "$SNAP/node_modules/.snapshot-lock" 2>/dev/null; then
    (cd "$SNAP" && bash scripts/node.sh npm ci --no-audit --no-fund >/dev/null)
    cp "$SNAP/package-lock.json" "$SNAP/node_modules/.snapshot-lock"
  fi
  # The local settings the Android test's compose file reads (git-ignored, so not in the
  # snapshot): copied beside it, on this machine only.
  for f in .env .env.build; do
    [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$SNAP/$f"
  done
  mkdir -p "$SNAP/.gate"
  echo "$commit" > "$SNAP/.gate/snapshot"
}

run_gate() {
  rm -f "$SNAP/.gate/snapshot-passed"
  # The snapshot's tree as it is now (a fix in it counts): what a pass is for.
  local now
  now="$(snapshot_tree_of "$SNAP")"
  if make -C "$SNAP" gate "$@"; then
    [ "$(snapshot_tree_of "$SNAP")" = "$now" ] && echo "$now" > "$SNAP/.gate/snapshot-passed"
    echo "snapshot passed: $now (commit it: bash scripts/gate-snapshot.sh commit -m ...)"
  else
    echo "snapshot gate failed; fix in $SNAP and here, then: bash scripts/gate-snapshot.sh resume"
    return 1
  fi
}

# A worktree's content as a tree id, uncommitted changes in it included.
snapshot_tree_of() {
  local dir="$1" idx
  idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git -C "$dir" read-tree HEAD
  GIT_INDEX_FILE="$idx" git -C "$dir" add -A
  GIT_INDEX_FILE="$idx" git -C "$dir" write-tree
  rm -f "$idx"
}

case "${1:-}" in
  "")
    c="$(snapshot_commit)"
    prepare "$c"
    echo "snapshot $c in $SNAP"
    run_gate
    ;;
  resume)
    [ -e "$SNAP/.gate/snapshot" ] || { echo "no snapshot yet: bash scripts/gate-snapshot.sh"; exit 1; }
    run_gate RESUME=1
    ;;
  path)
    echo "$SNAP"
    ;;
  prepare)
    # A snapshot without its gate (to look at it). Not over one that passed and waits for its
    # commit: that took the passed tree away once, for the tree as it was later (FORCE=1 to).
    if [ -z "${FORCE:-}" ] && [ -e "$SNAP/.gate/snapshot-passed" ] && [ "$(snapshot_tree_of "$SNAP")" = "$(cat "$SNAP/.gate/snapshot-passed")" ]; then
      echo "the snapshot in $SNAP passed its gate and is not committed: commit it first (or FORCE=1)"
      exit 1
    fi
    c="$(snapshot_commit)"
    prepare "$c"
    echo "snapshot $c in $SNAP"
    ;;
  env)
    # The Android test's local settings beside the snapshot as it is (a passed one stays as it is).
    for f in .env .env.build; do
      [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$SNAP/$f"
    done
    echo "local .env files copied to $SNAP"
    ;;
  commit)
    shift
    [ -e "$SNAP/.gate/snapshot-passed" ] || { echo "the snapshot has not passed its gate"; exit 1; }
    passed="$(cat "$SNAP/.gate/snapshot-passed")"
    [ "$(snapshot_tree_of "$SNAP")" = "$passed" ] || { echo "the snapshot changed since its gate passed: resume first"; exit 1; }
    base="$(git -C "$SNAP" rev-parse "$(cat "$SNAP/.gate/snapshot")^")"
    [ "$(git rev-parse HEAD)" = "$base" ] || { echo "main moved on since the snapshot ($base): take a new one"; exit 1; }
    msg="$(mktemp)"
    while [ $# -gt 0 ]; do
      case "$1" in
        -m) printf '%s\n\n' "$2" >> "$msg"; shift 2 ;;
        -F) cat "$2" >> "$msg"; shift 2 ;;
        *) echo "unknown: $1"; exit 1 ;;
      esac
    done
    [ -s "$msg" ] || { echo "a message: -m or -F"; exit 1; }
    new="$(git commit-tree "$passed" -p HEAD -F "$msg")"
    rm -f "$msg"
    git update-ref -m "commit (gate snapshot)" refs/heads/"$(git symbolic-ref --short HEAD)" "$new" "$base"
    # The index follows the new commit; the working tree keeps what was done since the snapshot.
    git reset -q
    git log --oneline -1
    ;;
  *)
    echo "usage: bash scripts/gate-snapshot.sh [resume|commit -m msg|path|prepare|env]"
    exit 1
    ;;
esac
