#!/usr/bin/env bash
# scripts/restore.sh - restore Burrow from an encrypted backup. DESTRUCTIVE:
# replaces the current database and master key.
#
# Check a backup first without touching anything:
#   docker compose run --rm backup /app/scripts/backup/verify.sh /backups/burrow-<ts>.tar.gz.enc
#
# Usage: scripts/restore.sh backups/burrow-<timestamp>.tar.gz.enc
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: scripts/restore.sh backups/burrow-<timestamp>.tar.gz.enc"
  echo "Available:"
  ls -1t backups/burrow-*.tar.gz.enc 2>/dev/null | head -10 || echo "  (none)"
  exit 1
fi

echo "!! DESTRUCTIVE: this replaces Burrow's database and master key with the backup."
read -r -p "Type 'restore' to continue: " answer
[ "$answer" = "restore" ] || { echo "Cancelled."; exit 1; }

( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" )
IN="$(cd "$(dirname "$ARCHIVE")" && pwd)"
NAME="$(basename "$ARCHIVE")"

backup() { docker compose --profile backup run --rm --no-deps -v "$IN":/in:ro --entrypoint "$1" backup "${@:2}"; }

# The backup image from this checkout first: an older one does not know the
# newest migrations and refuses the newest backups (A3-OPS-05). From the
# build cache when nothing changed; when it cannot build, the one there is used.
if [ -d .git ] && [ -f Dockerfile.backup ]; then
  docker compose --profile backup build -q backup || echo "Note: the backup image could not be built again; using the one there is."
fi

# 1. While Burrow runs: decrypt, check and stage (Burrow was down for all of
#    this before). The name goes in as an argument, not as shell code.
backup /app/scripts/backup/restore-stage.sh "/in/$NAME"

# 2. Burrow and the backup service stopped: the swap is renames, the files
#    from before kept in the data volume (.before-restore).
was_backup="$(docker compose --profile backup ps -q --status running backup 2>/dev/null || true)"
docker compose stop burrow
[ -z "$was_backup" ] || docker compose --profile backup stop backup
if ! backup /app/scripts/backup/restore-swap.sh; then
  echo "!! The swap failed. The files from before are in the data volume under .before-restore/;"
  echo "   move them back to the volume's top level before starting Burrow."
  exit 1
fi
docker compose start burrow
[ -z "$was_backup" ] || docker compose --profile backup start backup
# Started is not restored: Burrow healthy on the restored database, or said
# so with the way back (a database it cannot use read as "Restored";
# AUDIT2 OPS-08).
state=""
for _ in $(seq 1 90); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q burrow)" 2>/dev/null || true)"
  [ "$state" = healthy ] && break
  sleep 2
done
if [ "$state" != healthy ]; then
  echo "!! Burrow did not become healthy on the restored data (${state:-not running}); see: docker compose logs burrow"
  echo "   The database and key from before are in the data volume under .before-restore/:"
  echo "   stop Burrow, move them back to the volume's top level, and start it again."
  exit 1
fi
echo "Restored from $ARCHIVE. Sessions from before the backup are signed in again only if they still exist in it."
echo "The database and key from before are kept in the data volume under .before-restore/."
