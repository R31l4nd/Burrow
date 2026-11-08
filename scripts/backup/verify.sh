#!/usr/bin/env sh
# Proves that a backup can be restored, without touching the live data:
# checksum, decrypt, unpack, SQLite integrity check, expected tables present.
#
#   docker compose run --rm backup /app/scripts/backup/verify.sh /backups/burrow-<ts>.tar.gz.enc
set -eu
umask 077
file="${1:?usage: verify.sh /backups/burrow-<timestamp>.tar.gz.enc}"
work="$(mktemp -d /tmp/burrow-verify.XXXXXX)"
trap 'rm -rf "$work"' EXIT HUP INT TERM

(cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256")
python3 /app/scripts/backup/crypto.py decrypt "$file" "$work/backup.tar.gz" /run/secrets/backup_encryption_key
tar -xzf "$work/backup.tar.gz" -C "$work"
[ "$(sqlite3 "$work/burrow/burrow.db" 'PRAGMA integrity_check;')" = "ok" ]
for table in users sessions hosts ssh_keys known_hosts audit_log schema_migrations; do
  sqlite3 "$work/burrow/burrow.db" "SELECT 1 FROM $table LIMIT 1;" >/dev/null
done
echo "Backup OK: $file ($(sqlite3 "$work/burrow/burrow.db" 'SELECT count(*) FROM hosts;') hosts, secret.key $( [ -f "$work/burrow/secret.key" ] && echo present || echo absent ))"
