#!/bin/sh
# scripts/backup/restore-stage.sh <archive> - the first half of a restore,
# while Burrow still runs: decrypt the archive, check the database, and put
# the files ready on the data volume (/data/.restore). Nothing live changes.
# The archive's name is an argument, never part of a command (audit OP-04).
set -eu
ARCHIVE="$1"
KEY=/run/secrets/backup_encryption_key
STAGE=/data/.restore
rm -rf "$STAGE"
mkdir -p "$STAGE"
w=$(mktemp -d)
trap 'rm -rf "$w"' EXIT
python3 /app/scripts/backup/crypto.py decrypt "$ARCHIVE" "$w/b.tar.gz" "$KEY"
tar -xzf "$w/b.tar.gz" -C "$w"
# Burrow's own database, whole, from this Burrow or an older one; checked
# read-only. Opening a missing one made an empty database that passed, and
# any other program's database passed as well (AUDIT2 OPS-02).
DB="$w/burrow/burrow.db"
fail() { echo "$1" >&2; rm -rf "$STAGE"; exit 1; }
{ [ -f "$DB" ] && [ ! -L "$DB" ] && [ -s "$DB" ]; } || fail "the backup holds no Burrow database"
[ "$(sqlite3 -readonly "$DB" 'PRAGMA integrity_check;' 2>/dev/null)" = ok ] || fail "the database in the backup is damaged"
versions="$(sqlite3 -readonly "$DB" 'SELECT version FROM schema_migrations ORDER BY version;' 2>/dev/null)" || fail "the database in the backup is not Burrow's"
[ -n "$versions" ] || fail "the database in the backup is not Burrow's"
for v in $versions; do
  # Also when this backup image is older than Burrow: the self-update once left it behind (A3-OPS-05).
  [ -f "/app/migrations/$v" ] || fail "the backup comes from a newer Burrow than this backup image knows ($v): update Burrow first, or bring the backup image up to Burrow's version (docker compose --profile backup build backup, or pull)"
done
cp "$w/burrow/burrow.db" "$STAGE/burrow.db"
if [ -f "$w/burrow/secret.key" ]; then
  cp "$w/burrow/secret.key" "$STAGE/secret.key"
  chmod 600 "$STAGE/secret.key"
fi
echo "staged"
